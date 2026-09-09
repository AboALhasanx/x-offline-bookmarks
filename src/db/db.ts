import * as SQLite from 'expo-sqlite';
import type { Bookmark, BookmarkType, PendingItem, PendingStatus, TweetLink } from '../types';

const DB_NAME = 'xbookmarks.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS pending_items (
      id INTEGER PRIMARY KEY NOT NULL,
      url TEXT NOT NULL,
      raw_text TEXT,
      shared_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY NOT NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      html_content TEXT NOT NULL,
      image_paths TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',
      caption TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      saved_at INTEGER NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
  // Existing installs predate the links/caption columns.
  try {
    await db.execAsync(`
      ALTER TABLE bookmarks ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE bookmarks ADD COLUMN caption TEXT NOT NULL DEFAULT '';
    `);
  } catch {
    // Columns already exist.
  }
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

function toPendingItem(row: Record<string, unknown>): PendingItem {
  return {
    id: row.id as number,
    url: row.url as string,
    raw_text: (row.raw_text as string | null) ?? null,
    shared_at: row.shared_at as number,
    status: row.status as PendingStatus,
    error_message: (row.error_message as string | null) ?? null,
    updated_at: row.updated_at as number,
  };
}

function parseJsonArray<T>(value: unknown, guard: (v: unknown) => v is T): T[] {
  try {
    const parsed: unknown = JSON.parse((value as string) ?? '[]');
    if (Array.isArray(parsed)) return parsed.filter(guard);
  } catch {
    // Fall through to empty.
  }
  return [];
}

function isTweetLink(v: unknown): v is TweetLink {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.display === 'string' &&
    typeof o.resolved === 'string' &&
    typeof o.title === 'string' &&
    typeof o.domain === 'string' &&
    typeof o.bundleUri === 'string' &&
    (o.kind === undefined || o.kind === 'page' || o.kind === 'quote')
  );
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function toBookmark(row: Record<string, unknown>): Bookmark {
  return {
    id: row.id as number,
    url: row.url as string,
    title: row.title as string,
    type: row.type as BookmarkType,
    html_content: row.html_content as string,
    image_paths: parseJsonArray(row.image_paths, isString),
    links: parseJsonArray(row.links, isTweetLink),
    caption: (row.caption as string) ?? '',
    source_url: (row.source_url as string | null) ?? null,
    saved_at: row.saved_at as number,
    viewed: (row.viewed as number) === 1,
  };
}

export async function addPendingItem(url: string, rawText: string | null): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.runAsync(
    'INSERT INTO pending_items (url, raw_text, shared_at, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    [url, rawText, now, 'pending', now],
  );
  return result.lastInsertRowId;
}

export async function getPendingItems(): Promise<PendingItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM pending_items ORDER BY shared_at ASC',
  );
  return rows.map(toPendingItem);
}

export async function getPendingCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM pending_items WHERE status IN ('pending', 'processing')",
  );
  return row?.count ?? 0;
}

export async function updatePendingStatus(
  id: number,
  status: PendingStatus,
  errorMessage: string | null = null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE pending_items SET status = ?, error_message = ?, updated_at = ? WHERE id = ?', [
    status,
    errorMessage,
    Date.now(),
    id,
  ]);
}

export async function deletePendingItem(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM pending_items WHERE id = ?', [id]);
}

export async function saveBookmark(input: {
  url: string;
  title: string;
  type: BookmarkType;
  htmlContent: string;
  imagePaths: string[];
  links?: TweetLink[];
  caption?: string;
  sourceUrl?: string | null;
}): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    'INSERT OR REPLACE INTO bookmarks (url, title, type, html_content, image_paths, links, caption, source_url, saved_at, viewed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
    [input.url, input.title, input.type, input.htmlContent, JSON.stringify(input.imagePaths), JSON.stringify(input.links ?? []), input.caption ?? '', input.sourceUrl ?? null, Date.now()],
  );
  return result.lastInsertRowId;
}

export async function getBookmarks(): Promise<Bookmark[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM bookmarks ORDER BY saved_at DESC',
  );
  return rows.map(toBookmark);
}

export async function getBookmark(id: number): Promise<Bookmark | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM bookmarks WHERE id = ?', [
    id,
  ]);
  return row ? toBookmark(row) : null;
}

export async function getBookmarkByUrl(url: string): Promise<Bookmark | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM bookmarks WHERE url = ?', [
    url,
  ]);
  return row ? toBookmark(row) : null;
}

export async function markBookmarkViewed(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE bookmarks SET viewed = 1 WHERE id = ?', [id]);
}

export async function deleteBookmark(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [id]);
}

export async function getSetting(key: string, fallback: string): Promise<string> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?;', [key]);
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
    [key, value],
  );
}

export interface PreloadTarget {
  bookmarkId: number;
  url: string;
  bundleUri: string;
  title: string;
}

export async function getNextBookmarkNeedingPreload(): Promise<PreloadTarget | null> {
  const bookmarks = await getBookmarks();
  for (const b of bookmarks) {
    for (const l of b.links) {
      if (l.kind === 'page' && l.needsPreload && l.bundleUri) {
        return {
          bookmarkId: b.id,
          url: l.resolved,
          bundleUri: l.bundleUri,
          title: l.title || b.title,
        };
      }
    }
  }
  return null;
}

export async function markLinkPreloaded(
  bookmarkId: number,
  url: string,
  cleanUri?: string,
  frozenUri?: string,
): Promise<void> {
  const db = await getDb();
  const b = await getBookmark(bookmarkId);
  if (!b) return;
  const updatedLinks = b.links.map((l) => {
    if (l.resolved === url) {
      return {
        ...l,
        needsPreload: false,
        cleanUri: cleanUri || l.cleanUri,
        bundleUri: frozenUri ? frozenUri.replace(/\/frozen\.html$/, '') : l.bundleUri,
      };
    }
    return l;
  });
  await db.runAsync('UPDATE bookmarks SET links = ? WHERE id = ?;', [
    JSON.stringify(updatedLinks),
    bookmarkId,
  ]);
}
