import type { Directory } from 'expo-file-system';

/**
 * Creates a directory (and only that level) if missing. Tolerates the
 * API rejecting when the directory appears between the check and the call.
 */
export function ensureDir(dir: Directory): void {
  if (dir.exists) return;
  try {
    dir.create();
  } catch {
    // Fall through to the re-check below.
  }
  if (!dir.exists) throw new Error(`cannot create directory ${dir.uri}`);
}
