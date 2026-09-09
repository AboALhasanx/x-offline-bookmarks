import { Directory, File, Paths } from 'expo-file-system';
import { Share } from 'react-native';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { addPendingItem, getBookmarkByUrl, getBookmarks, getDb } from '../db/db';
import type { Bookmark } from '../types';
import { ensureDir } from './files';

export interface SyncManifest {
  version: number;
  exportedAt: number;
  device?: string;
  bookmarks: Bookmark[];
}

export interface LinksSyncPayload {
  version: number;
  exportedAt: number;
  type: 'links_sync';
  items: Array<{
    url: string;
    text?: string | null;
    title?: string;
  }>;
}

export interface SyncResult {
  imported: number;
  skipped: number;
  total: number;
}
/** Recursively collects all files from a directory into a zip object */
async function collectFilesRecursive(
  dir: Directory,
  basePath: string,
  out: Record<string, Uint8Array>,
): Promise<void> {
  if (!dir.exists) return;
  try {
    const items = dir.list();
    for (const item of items) {
      if (item instanceof Directory) {
        await collectFilesRecursive(item, `${basePath}${item.name}/`, out);
      } else if (item instanceof File) {
        try {
          const bytes = await item.bytes();
          out[`${basePath}${item.name}`] = bytes;
        } catch {
          // Skip unreadable file
        }
      }
    }
  } catch {
    // Directory unreadable
  }
}


/**
 * Instant lightweight sync: exports URLs and captions in milliseconds as .xlinks.
 * The receiving device queues them into pending_items to auto-download all media
 * and offline web bundles when online!
 */
export async function exportLinksPackage(): Promise<{ uri: string; count: number }> {
  const bookmarks = await getBookmarks();
  const payload: LinksSyncPayload = {
    version: 1,
    exportedAt: Date.now(),
    type: 'links_sync',
    items: bookmarks.map((b) => ({
      url: b.url,
      text: b.caption || b.title,
      title: b.title,
    })),
  };

  const exportFile = new File(Paths.cache, 'xbookmarks_links.xlinks');
  if (!exportFile.exists) exportFile.create();
  exportFile.write(JSON.stringify(payload, null, 2));

  try {
    await Share.share({
      title: 'Sync Bookmarks to Honor Pad',
      url: exportFile.uri,
      message: exportFile.uri,
    });
  } catch (e) {
    console.log('Share error:', e);
  }

  return { uri: exportFile.uri, count: payload.items.length };
}
/**
 * Packages all bookmarks, offline images, and web bundles into a single
 * compressed .xbook file and triggers the native Quick Share / Share sheet.
 */
export async function exportLibraryPackage(): Promise<{ uri: string; count: number }> {
  const bookmarks = await getBookmarks();
  const manifest: SyncManifest = {
    version: 1,
    exportedAt: Date.now(),
    device: 'X Bookmarks Device',
    bookmarks,
  };

  const zipObj: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  };

  // Collect images and offline link bundles
  const imagesDir = new Directory(Paths.document, 'images');
  await collectFilesRecursive(imagesDir, 'images/', zipObj);

  const linksDir = new Directory(Paths.document, 'links');
  await collectFilesRecursive(linksDir, 'links/', zipObj);

  const compressed = zipSync(zipObj, { level: 6 });

  const exportFile = new File(Paths.cache, 'xbookmarks_export.xbook');
  if (!exportFile.exists) exportFile.create();
  exportFile.write(compressed);

  try {
    await Share.share({
      title: 'Send to Honor Pad (Quick Share / Wi-Fi Direct)',
      url: exportFile.uri,
      message: exportFile.uri,
    });
  } catch (e) {
    console.log('Share error:', e);
  }

  return { uri: exportFile.uri, count: bookmarks.length };
}

/**
 * Unpacks an .xbook (or .zip) archive, restores images and web bundles,
 * and merges bookmarks into local SQLite without duplicating existing records.
 */
export async function importLibraryPackage(fileUri: string): Promise<SyncResult> {
  const sourceFile = new File(fileUri);
  if (!sourceFile.exists) {
    throw new Error('Sync package file not found');
  }

  // 1. Check for instant lightweight .xlinks or JSON payload
  if (fileUri.endsWith('.xlinks') || fileUri.endsWith('.json')) {
    try {
      const text = await sourceFile.text();
      const data = JSON.parse(text) as LinksSyncPayload;
      if (data.type === 'links_sync' && Array.isArray(data.items)) {
        let imported = 0;
        let skipped = 0;
        for (const item of data.items) {
          if (!item.url) continue;
          const existing = await getBookmarkByUrl(item.url);
          if (existing) {
            skipped++;
            continue;
          }
          await addPendingItem(item.url, item.text || null);
          imported++;
        }
        return { imported, skipped, total: data.items.length };
      }
    } catch (e) {
      console.log('Not a plain links_sync file, checking zip archive:', e);
    }
  }

  // 2. Otherwise unpack binary zip archive (.xbook)
  const zipBytes = await sourceFile.bytes();
  const unzipped = unzipSync(zipBytes);

  const manifestBytes = unzipped['manifest.json'];
  if (!manifestBytes) {
    throw new Error('Invalid package: manifest.json is missing');
  }

  const manifest = JSON.parse(strFromU8(manifestBytes)) as SyncManifest;
  if (!Array.isArray(manifest.bookmarks)) {
    throw new Error('Invalid package: bookmarks list missing in manifest');
  }

  // Restore asset files to Paths.document
  for (const [entryPath, fileBytes] of Object.entries(unzipped)) {
    if (entryPath === 'manifest.json' || entryPath.endsWith('/')) continue;
    try {
      const parts = entryPath.split('/');
      const fileName = parts.pop();
      if (!fileName) continue;

      let currentDir = new Directory(Paths.document);
      for (const p of parts) {
        currentDir = new Directory(currentDir, p);
        ensureDir(currentDir);
      }

      const destFile = new File(currentDir, fileName);
      if (!destFile.exists) destFile.create();
      destFile.write(fileBytes);
    } catch (e) {
      console.log('Failed to restore file entry:', entryPath, e);
    }
  }

  // Merge bookmarks into SQLite
  const db = await getDb();
  let imported = 0;
  let skipped = 0;

  for (const b of manifest.bookmarks) {
    try {
      const existing = await db.getFirstAsync<{ id: number }>(
        'SELECT id FROM bookmarks WHERE url = ? LIMIT 1;',
        [b.url],
      );

      if (existing) {
        skipped++;
        continue;
      }

      await db.runAsync(
        `INSERT INTO bookmarks (url, title, type, html_content, image_paths, links, caption, source_url, saved_at, viewed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          b.url,
          b.title,
          b.type,
          b.html_content,
          JSON.stringify(b.image_paths || []),
          JSON.stringify(b.links || []),
          b.caption || '',
          b.source_url || null,
          b.saved_at || Date.now(),
          b.viewed ? 1 : 0,
        ],
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  return {
    imported,
    skipped,
    total: manifest.bookmarks.length,
  };
}

/** Opens the system document picker to select an .xbook or .zip package */
export async function pickAndImportPackage(): Promise<SyncResult> {
  const result = await File.pickFileAsync();
  let selectedUri: string | null = null;

  if (Array.isArray(result) && result[0]?.uri) {
    selectedUri = result[0].uri;
  } else if (result && typeof result === 'object' && 'uri' in result) {
    const candidate = (result as { uri?: unknown }).uri;
    if (typeof candidate === 'string') {
      selectedUri = candidate;
    }
  }

  if (!selectedUri) {
    throw new Error('No file selected');
  }
  return importLibraryPackage(selectedUri);
}

/** Returns the local network label of the device */
export async function getLocalDeviceIp(): Promise<string> {
  return 'Local Wi-Fi Network';
}
