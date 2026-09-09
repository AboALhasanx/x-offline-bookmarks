import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Image,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Swipeable } from 'react-native-gesture-handler';
import HeadlessWebView from '../components/HeadlessWebView';
import HeadlessPagePreloader from '../components/HeadlessPagePreloader';
import { useTheme } from '../theme/ThemeContext';
import {
  deleteBookmark,
  getBookmarks,
  getNextBookmarkNeedingPreload,
  getPendingCount,
  markBookmarkViewed,
  markLinkPreloaded,
  type PreloadTarget,
  updatePendingStatus,
} from '../db/db';
import { getNextPendingTweet, processPendingArticles, saveTweetBookmark } from '../services/queue';
import { updateBundleFromHtml } from '../services/linkBundle';
import { exportLibraryPackage, getLocalDeviceIp, pickAndImportPackage } from '../services/syncPackage';
import type { Bookmark, PendingItem, TweetData } from '../types';
import DetailScreen from './DetailScreen';

interface Props {
  refreshKey: number;
}

export default function HomeScreen({ refreshKey }: Props) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [autoKey, setAutoKey] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [tweetJob, setTweetJob] = useState<PendingItem | null>(null);
  const [preloadJob, setPreloadJob] = useState<PreloadTarget | null>(null);
  const [openStack, setOpenStack] = useState<number[]>([]);
  const alive = useRef(true);
  const insets = useSafeAreaInsets();

  const reload = useCallback(async () => {
    try {
      setBookmarks(await getBookmarks());
      setPendingCount(await getPendingCount());
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    (async () => {
      await reload();
      if (!alive.current) return;
      setReady(true);
      // App opened with a backlog — process it without asking.
      if ((await getPendingCount()) > 0) setAutoKey((k) => k + 1);
    })();
    return () => {
      alive.current = false;
    };
  }, [reload, refreshKey]);

  useEffect(() => {
    // Fresh share arrived — queue it, then save it automatically.
    if (refreshKey > 0) {
      (async () => {
        await reload();
        if ((await getPendingCount()) > 0) setAutoKey((k) => k + 1);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    if (autoKey > 0) processNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);

  async function pumpTweets(): Promise<void> {
    const next = await getNextPendingTweet();
    if (!next) {
      setTweetJob(null);
      return;
    }
    setStatus(`Saving tweet… (${next.url})`);
    setTweetJob(next);
  }

  async function pumpPreloads(): Promise<void> {
    const next = await getNextBookmarkNeedingPreload();
    if (!next) {
      setPreloadJob(null);
      setProcessing(false);
      return;
    }
    let domain = next.url;
    try {
      domain = new URL(next.url).hostname;
    } catch {}
    setStatus(`Pre-downloading offline docs… (${domain})`);
    setPreloadJob(next);
  }
  async function processNow() {
    if (processing) return;
    setProcessing(true);
    setError(null);
    try {
      setStatus('Processing articles…');
      const summary = await processPendingArticles();
      setStatus(`Articles: ${summary.done} saved, ${summary.failed} failed. Checking tweets…`);
      await reload();
      await pumpTweets();
      if (!(await getNextPendingTweet())) {
        await pumpPreloads();
        if (!(await getNextBookmarkNeedingPreload())) {
          setStatus(`Done. ${summary.done} saved, ${summary.failed} failed.`);
          setProcessing(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await reload();
      if (!(await getNextPendingTweet()) && !(await getNextBookmarkNeedingPreload())) {
        setProcessing(false);
      }
    }
  }

  async function handleTweetResult(data: TweetData) {
    const job = tweetJob;
    setTweetJob(null);
    if (!job) return;
    try {
      await saveTweetBookmark(job, data);
      setStatus('Tweet saved.');
    } catch (e) {
      setStatus(`Tweet failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await reload();
      if (alive.current) {
        const more = await getNextPendingTweet();
        if (more) {
          setTweetJob(more);
          setStatus(`Saving tweet… (${more.url})`);
        } else {
          await pumpPreloads();
        }
      }
    }
  }

  async function handleTweetError(message: string) {
    const job = tweetJob;
    setTweetJob(null);
    if (!job) return;
    await updatePendingStatus(job.id, 'failed', message);
    setStatus(`Tweet failed: ${message}`);
    await reload();
    if (alive.current) {
      const more = await getNextPendingTweet();
      if (more) {
        setTweetJob(more);
      } else {
        await pumpPreloads();
      }
    }
  }

  async function handlePreloadResult(html: string) {
    const job = preloadJob;
    setPreloadJob(null);
    if (!job) return;
    try {
      const res = await updateBundleFromHtml(job.bundleUri, job.url, html);
      await markLinkPreloaded(job.bookmarkId, job.url, res.cleanUri, res.frozenUri);
      setStatus('Pre-downloaded offline docs.');
    } catch (e) {
      console.log('Preload save error:', e);
      await markLinkPreloaded(job.bookmarkId, job.url);
    } finally {
      await reload();
      if (alive.current) {
        await pumpPreloads();
      }
    }
  }

  async function handlePreloadError(message: string) {
    const job = preloadJob;
    setPreloadJob(null);
    if (!job) return;
    console.log('Preload error:', message);
    await markLinkPreloaded(job.bookmarkId, job.url);
    await reload();
    if (alive.current) {
      await pumpPreloads();
    }
  }
  async function openSyncDialog() {
    const ip = await getLocalDeviceIp();
    Alert.alert(
      'Device Sync (Phone & Tablet)',
      `Local Wi-Fi IP: ${ip}\n\nSync bookmarks, photos, videos, and offline web bundles directly between devices.`,
      [
        {
          text: 'Send to Device (Quick Share)',
          onPress: async () => {
            try {
              setStatus('Exporting library package…');
              const { count } = await exportLibraryPackage();
              setStatus(`Shared ${count} bookmarks.`);
            } catch (e) {
              Alert.alert('Export Error', String(e));
            }
          },
        },
        {
          text: 'Import Package File',
          onPress: async () => {
            try {
              setStatus('Importing package…');
              const res = await pickAndImportPackage();
              await reload();
              setStatus(`Imported ${res.imported} new items (${res.skipped} already saved).`);
              Alert.alert('Sync Complete', `Successfully imported ${res.imported} bookmarks.`);
            } catch (e) {
              if (String(e).includes('No file selected')) return;
              Alert.alert('Import Error', String(e));
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  function confirmDelete(id: number) {
    Alert.alert('Delete bookmark?', 'This removes the saved offline copy.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteBookmark(id).then(reload) },
    ]);
  }

  async function openBookmark(item: Bookmark) {
    await markBookmarkViewed(item.id);
    setOpenStack((s) => [...s, item.id]);
    reload();
  }
  const { colors, isDark, toggleTheme } = useTheme();

  const sections = useMemo(() => groupBookmarksByDate(bookmarks), [bookmarks]);

  if (!ready) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Text style={[styles.dim, { color: colors.sub }]}>Loading…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Text style={[styles.error, { color: colors.danger }]}>DB error: {error}</Text>
      </View>
    );
  }

  const open = bookmarks.find((b) => b.id === openStack[openStack.length - 1]) ?? null;
  if (open) {
    return (
      <DetailScreen
        bookmark={open}
        onBack={() => setOpenStack((s) => s.slice(0, -1))}
        onOpenTweet={(id) => setOpenStack((s) => (s[s.length - 1] === id ? s : [...s, id]))}
      />
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top + 12 }]}>
      <View style={styles.topRow}>
        <View>
          <Text style={[styles.header, { color: colors.text }]}>Bookmarks</Text>
          <Text style={[styles.sub, { color: colors.sub }]}>
            {bookmarks.length} saved · {pendingCount} pending
          </Text>
        </View>
        <View style={styles.topRightControls}>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={openSyncDialog}
            style={[styles.syncButton, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Feather name="share-2" size={14} color={colors.text} />
            <Text style={[styles.themeText, { color: colors.text }]}>Sync</Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={toggleTheme}
            style={[styles.themeToggle, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Feather name={isDark ? 'sun' : 'moon'} size={14} color={colors.text} />
            <Text style={[styles.themeText, { color: colors.text }]}>{isDark ? 'Light' : 'Dark'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {status ? <Text style={[styles.status, { color: colors.status }]}>{status}</Text> : null}


      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.sub }]}>
              No bookmarks yet. Share a tweet or article to save it offline.
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View style={[styles.sectionHeader, { backgroundColor: colors.bg }]}>
            <View style={styles.sectionHeaderRow}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>{section.title}</Text>
              <Text style={[styles.sectionDate, { color: colors.sub }]}>• {section.subTitle}</Text>
            </View>
            <Text style={[styles.sectionCount, { color: colors.sub }]}>
              {section.data.length} {section.data.length === 1 ? 'item' : 'items'}
            </Text>
          </View>
        )}
        renderItem={({ item }) => {
          const meta = parseBookmarkMeta(item);
          const mediaCount = item.image_paths?.length ?? 0;
          return (
            <Swipeable
              friction={2}
              rightThreshold={40}
              overshootRight={false}
              containerStyle={styles.swipeContainer}
              renderRightActions={(progress, dragX) =>
                renderSwipeDeleteAction(progress, dragX, () => confirmDelete(item.id))
              }
            >
              <TouchableOpacity
                activeOpacity={0.85}
                style={[
                  styles.tweetCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.cardBorder,
                  },
                ]}
                onPress={() => openBookmark(item)}
              >
                {/* Header: Avatar, Name, Handle, Date, Unread */}
                <View style={styles.cardHeader}>
                  <View style={[styles.avatar, { backgroundColor: colors.thumbBg }]}>
                    <Text style={[styles.avatarText, { color: meta.isTweet ? colors.text : colors.accent }]}>
                      {meta.initial}
                    </Text>
                  </View>
                  <View style={styles.authorMeta}>
                    <View style={styles.authorLine}>
                      <Text style={[styles.authorName, { color: colors.text }]} numberOfLines={1}>
                        {meta.name}
                      </Text>
                      {meta.displayHandle ? (
                        <Text style={[styles.authorHandle, { color: colors.sub }]} numberOfLines={1}>
                          {meta.displayHandle}
                        </Text>
                      ) : null}
                    </View>
                  </View>

                  {!item.viewed ? <View style={[styles.unreadDot, { backgroundColor: colors.accent }]} /> : null}
                </View>
                <Text style={[styles.tweetText, { color: colors.text }]} numberOfLines={4}>
                  {item.caption || item.title}
                </Text>

                {/* Media Preview Box */}
                {item.image_paths[0] ? (
                  <View style={[styles.cardMediaWrapper, { borderColor: colors.border }]}>
                    <Image source={{ uri: item.image_paths[0] }} style={styles.cardMedia} resizeMode="cover" />
                    {mediaCount > 1 ? (
                      <View style={styles.cardMediaBadge}>
                        <Feather name="image" size={11} color="#fff" style={{ marginRight: 3 }} />
                        <Text style={styles.cardMediaBadgeText}>{mediaCount}</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </TouchableOpacity>
            </Swipeable>
          );
        }}
      />

      {tweetJob ? (
        <HeadlessWebView url={tweetJob.url} onResult={handleTweetResult} onError={handleTweetError} />
      ) : null}
      {preloadJob ? (
        <HeadlessPagePreloader
          url={preloadJob.url}
          onResult={handlePreloadResult}
          onError={handlePreloadError}
        />
      ) : null}
    </View>
  );
}

interface BookmarkSection {
  title: string;
  subTitle: string;
  data: Bookmark[];
}

function groupBookmarksByDate(items: Bookmark[]): BookmarkSection[] {
  const groups: Map<string, { title: string; subTitle: string; data: Bookmark[] }> = new Map();
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

  for (const item of items) {
    const d = new Date(item.saved_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!groups.has(key)) {
      const weekday = d.toLocaleDateString(undefined, { weekday: 'long' });
      const month = d.toLocaleDateString(undefined, { month: 'short' });
      const day = d.getDate();
      const year = d.getFullYear();
      let title = '';
      const subTitle = `${month} ${day}, ${year}`;
      if (key === todayKey) {
        title = 'Today';
      } else if (key === yesterdayKey) {
        title = 'Yesterday';
      } else {
        title = weekday;
      }
      groups.set(key, { title, subTitle, data: [] });
    }
    groups.get(key)!.data.push(item);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([_, val]) => val);
}

function parseBookmarkMeta(item: Bookmark) {
  if (item.type === 'tweet') {
    const handleMatch = item.url.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
    const handle = handleMatch ? `@${handleMatch[1]}` : '@x';
    let name = handle;
    const colonIdx = item.title.indexOf(':');
    if (colonIdx > 0 && colonIdx < 30) {
      const candidate = item.title.slice(0, colonIdx).replace(/\s*\(@[^)]+\)\s*$/, '').trim();
      if (candidate && candidate.toLowerCase() !== handle.toLowerCase()) {
        name = candidate;
      }
    }
    const displayHandle = name !== handle ? handle : '';
    const initial = (handle[1] || '𝕏').toUpperCase();
    return { name, displayHandle, initial, isTweet: true };
  }
  let domain = item.url;
  try {
    domain = new URL(item.url).hostname.replace(/^www\./, '');
  } catch {}
  const initial = (domain.charAt(0) || 'A').toUpperCase();
  return { name: domain, displayHandle: 'Article', initial, isTweet: false };
}


function renderSwipeDeleteAction(
  progress: Animated.AnimatedInterpolation<number>,
  dragX: Animated.AnimatedInterpolation<number>,
  onDelete: () => void,
) {
  const trans = dragX.interpolate({
    inputRange: [-92, 0],
    outputRange: [0, 92],
    extrapolate: 'clamp',
  });
  const scale = progress.interpolate({
    inputRange: [0, 0.4, 1],
    outputRange: [0.6, 0.85, 1],
    extrapolate: 'clamp',
  });
  const opacity = progress.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0, 0.6, 1],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View style={[styles.deleteActionContainer, { transform: [{ translateX: trans }] }]}>
      <TouchableOpacity activeOpacity={0.8} style={styles.deleteAction} onPress={onDelete}>
        <Animated.View style={[styles.deleteContent, { transform: [{ scale }], opacity }]}>
          <TrashIcon color="#fff" />
          <Text style={styles.deleteText}>Delete</Text>
        </Animated.View>
      </TouchableOpacity>
    </Animated.View>
  );
}

function TrashIcon({ color = '#fff' }: { color?: string }) {
  return (
    <View style={styles.trashIcon}>
      <View style={[styles.trashHandle, { borderColor: color }]} />
      <View style={[styles.trashLid, { backgroundColor: color }]} />
      <View style={[styles.trashBody, { borderColor: color }]}>
        <View style={[styles.trashRib, { backgroundColor: color }]} />
        <View style={[styles.trashRib, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  header: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  sub: { fontSize: 13, marginTop: 4 },
  topRightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  themeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  themeIcon: { fontSize: 14 },
  themeText: { fontSize: 13, fontWeight: '600' },
  dim: { fontSize: 14 },
  status: { fontSize: 13, marginVertical: 6 },
  error: { fontSize: 14, paddingHorizontal: 16 },

  emptyContainer: { paddingVertical: 48, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  sectionHeader: {
    paddingTop: 18,
    paddingBottom: 8,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  sectionDate: {
    fontSize: 13,
    fontWeight: '500',
  },
  sectionCount: {
    fontSize: 12,
    marginTop: 2,
  },
  swipeContainer: {
    marginBottom: 12,
  },
  tweetCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 15,
    fontWeight: '700',
  },
  authorMeta: {
    flex: 1,
  },
  authorLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  authorName: {
    fontSize: 14,
    fontWeight: '700',
    maxWidth: 120,
  },
  authorHandle: {
    fontSize: 13,
    maxWidth: 90,
  },
  metaDot: {
    fontSize: 12,
  },
  cardDate: {
    fontSize: 12,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tweetText: {
    fontSize: 14.5,
    lineHeight: 21,
    marginBottom: 10,
  },
  cardMediaWrapper: {
    height: 180,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    marginBottom: 10,
    position: 'relative',
  },
  cardMedia: {
    width: '100%',
    height: '100%',
  },
  cardMediaBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  cardMediaBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },

  deleteActionContainer: {
    width: 88,
    marginBottom: 12,
  },
  deleteAction: {
    flex: 1,
    backgroundColor: '#f4212e',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 16,
    marginLeft: 8,
  },
  deleteContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: { color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 3 },
  trashIcon: {
    width: 18,
    height: 20,
    alignItems: 'center',
  },
  trashHandle: {
    width: 8,
    height: 3,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  trashLid: {
    width: 18,
    height: 2,
    borderRadius: 1,
    marginBottom: 1,
  },
  trashBody: {
    width: 14,
    height: 13,
    borderWidth: 1.5,
    borderTopWidth: 0,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    paddingTop: 2,
    paddingBottom: 2,
  },
  trashRib: {
    width: 1.5,
    height: '100%',
    borderRadius: 1,
  },
});
