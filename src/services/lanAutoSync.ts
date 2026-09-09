import { NativeEventEmitter, NativeModules } from 'react-native';
import { addPendingItem, getBookmarkByUrl, getBookmarks } from '../db/db';

const { LanSyncModule } = NativeModules;
const SYNC_PORT = 8765;

export interface LanSyncItem {
  url: string;
  text?: string | null;
  title?: string;
  saved_at: number;
}

let isInitialized = false;

/** Updates the local server's payload with current bookmarks */
export async function refreshLanSyncPayload(): Promise<void> {
  if (!LanSyncModule?.setSyncPayload) return;
  try {
    const bookmarks = await getBookmarks();
    const payload: LanSyncItem[] = bookmarks.map((b) => ({
      url: b.url,
      text: b.caption || b.title,
      title: b.title,
      saved_at: b.saved_at,
    }));
    LanSyncModule.setSyncPayload(JSON.stringify(payload));
  } catch (e) {
    console.log('Failed to update sync payload:', e);
  }
}

/** Initializes the background LAN sync server and event listener */
export async function initLanAutoSync(
  onItemsReceived?: (count: number) => void,
): Promise<void> {
  if (isInitialized || !LanSyncModule) return;
  isInitialized = true;

  try {
    await LanSyncModule.startServer(SYNC_PORT);
    await refreshLanSyncPayload();

    const emitter = new NativeEventEmitter(LanSyncModule);
    emitter.addListener('onLanSyncReceived', async (payloadJson: string) => {
      try {
        const items = JSON.parse(payloadJson) as LanSyncItem[];
        if (Array.isArray(items)) {
          let count = 0;
          for (const item of items) {
            if (!item.url) continue;
            const existing = await getBookmarkByUrl(item.url);
            if (!existing) {
              await addPendingItem(item.url, item.text || null);
              count++;
            }
          }
          if (count > 0 && onItemsReceived) {
            onItemsReceived(count);
          }
        }
      } catch (e) {
        console.log('Error processing received sync payload:', e);
      }
    });
  } catch (e) {
    console.log('LanSyncModule startServer error:', e);
  }
}

/** Probes a single IP address for the x-bookmarks sync server */
async function probePeer(ip: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  try {
    const res = await fetch(`http://${ip}:${SYNC_PORT}/ping`, {
      signal: controller.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { app?: string; ok?: boolean };
      return data.app === 'x-bookmarks';
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scans the local Wi-Fi subnet in parallel batches to find the other device,
 * exchanges bookmarks automatically, and queues any new items!
 */
export async function autoDiscoverAndSync(
  onStatus?: (msg: string) => void,
): Promise<{ peerIp: string | null; synced: number }> {
  if (!LanSyncModule?.getLocalIp) {
    return { peerIp: null, synced: 0 };
  }

  const localIp: string | null = await LanSyncModule.getLocalIp();
  if (!localIp || !localIp.includes('.')) {
    return { peerIp: null, synced: 0 };
  }

  const parts = localIp.split('.');
  const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const ownLastByte = parseInt(parts[3], 10);

  if (onStatus) onStatus('Scanning Wi-Fi for peer device…');

  // Generate candidate IPs on the subnet, prioritizing nearby IPs
  const candidates: string[] = [];
  for (let i = 1; i <= 254; i++) {
    if (i !== ownLastByte) {
      candidates.push(`${subnet}.${i}`);
    }
  }

  // Sort candidates by proximity to current IP for fastest discovery
  candidates.sort((a, b) => {
    const aByte = parseInt(a.split('.')[3], 10);
    const bByte = parseInt(b.split('.')[3], 10);
    return Math.abs(aByte - ownLastByte) - Math.abs(bByte - ownLastByte);
  });

  // Scan in parallel batches of 25
  let foundPeerIp: string | null = null;
  const BATCH_SIZE = 25;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (ip) => {
        const ok = await probePeer(ip);
        return ok ? ip : null;
      }),
    );
    foundPeerIp = results.find((ip): ip is string => ip !== null) || null;
    if (foundPeerIp) break;
  }

  if (!foundPeerIp) {
    if (onStatus) onStatus('No peer device found on Wi-Fi.');
    return { peerIp: null, synced: 0 };
  }

  if (onStatus) onStatus(`Syncing with device at ${foundPeerIp}…`);

  let synced = 0;
  try {
    // 1. Fetch peer's bookmarks
    const res = await fetch(`http://${foundPeerIp}:${SYNC_PORT}/sync`);
    if (res.ok) {
      const peerItems = (await res.json()) as LanSyncItem[];
      if (Array.isArray(peerItems)) {
        for (const item of peerItems) {
          if (!item.url) continue;
          const existing = await getBookmarkByUrl(item.url);
          if (!existing) {
            await addPendingItem(item.url, item.text || null);
            synced++;
          }
        }
      }
    }

    // 2. Push local bookmarks to peer so peer is also updated
    const localBookmarks = await getBookmarks();
    const localPayload: LanSyncItem[] = localBookmarks.map((b) => ({
      url: b.url,
      text: b.caption || b.title,
      title: b.title,
      saved_at: b.saved_at,
    }));

    await fetch(`http://${foundPeerIp}:${SYNC_PORT}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(localPayload),
    });

    if (onStatus) {
      onStatus(
        synced > 0
          ? `Auto-synced ${synced} new items with peer (${foundPeerIp})`
          : `In sync with peer (${foundPeerIp})`,
      );
    }
  } catch (e) {
    console.log('Sync transfer error with peer:', e);
  }

  return { peerIp: foundPeerIp, synced };
}
