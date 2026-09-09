import { Directory, File, Paths } from 'expo-file-system';
import { ensureDir } from './files';

export interface DownloadedImage {
  original: string;
  local: string;
}

function extensionFor(url: string, mimeFallback = 'jpg'): string {
  const match = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return (match?.[1] ?? mimeFallback).toLowerCase();
}

/**
 * Downloads remote images into the app's document directory for offline use.
 * Individual failures are skipped (never throws for a single bad URL).
 */
export async function downloadImages(urls: string[], album: string): Promise<DownloadedImage[]> {
  const unique = [...new Set(urls)].filter((u) => u.startsWith('http'));
  const root = new Directory(Paths.document, 'images');
  ensureDir(root);
  const dir = new Directory(root, album);
  ensureDir(dir);

  const results: DownloadedImage[] = [];
  for (let i = 0; i < unique.length; i++) {
    const original = unique[i];
    try {
      const dest = new File(dir, `img_${Date.now()}_${i}.${extensionFor(original)}`);
      const output = await File.downloadFileAsync(original, dest);
      results.push({ original, local: output.uri });
    } catch (e) {
      console.log('imageDownloader: skip failed download', original, e);
    }
  }
  return results;
}
