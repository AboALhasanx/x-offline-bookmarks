import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Image,
  Keyboard,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
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
import { exportLibraryPackage, exportLinksPackage, getLocalDeviceIp, pickAndImportPackage } from '../services/syncPackage';
import { autoDiscoverAndSync, initLanAutoSync, refreshLanSyncPayload } from '../services/lanAutoSync';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);
  const [batchTotal, setBatchTotal] = useState(0);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0.3)).current;
  const alive = useRef(true);
  const insets = useSafeAreaInsets();
  const reload = useCallback(async () => {
    try {
      const currentBookmarks = await getBookmarks();
      const currentPending = await getPendingCount();
      setBookmarks(currentBookmarks);
      setPendingCount(currentPending);
      if (currentPending > 0) {
        setBatchTotal((prev) => (prev < currentPending ? currentPending : prev));
      } else {
        setBatchTotal(0);
      }
      refreshLanSyncPayload();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  function openSearch() {
    setSearchOpen(true);
    Animated.timing(searchAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: false,
    }).start(() => {
      searchInputRef.current?.focus();
    });
  }

  function closeSearch() {
    Keyboard.dismiss();
    setSearchQuery('');
    Animated.timing(searchAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: false,
    }).start(() => {
      setSearchOpen(false);
    });
  }

  useEffect(() => {
    alive.current = true;
    (async () => {
      await reload();
      if (!alive.current) return;
      setReady(true);
      // App opened with a backlog — process it without asking.
      if ((await getPendingCount()) > 0) setAutoKey((k) => k + 1);

      // Auto-start LAN peer server and scan for tablet/phone on same Wi-Fi
      initLanAutoSync(async (count) => {
        if (alive.current) {
          setStatus(`Received ${count} new bookmarks from peer device.`);
          await reload();
          setAutoKey((k) => k + 1);
        }
      });
      autoDiscoverAndSync((msg) => {
        if (alive.current) setStatus(msg);
      }).then(async ({ synced }) => {
        if (synced > 0 && alive.current) {
          await reload();
          setAutoKey((k) => k + 1);
        }
      });
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
    Alert.alert(
      'Device Sync (Phone & Tablet)',
      'Sync bookmarks automatically over Wi-Fi between your phone and tablet.',
      [
        {
          text: 'Auto-Sync Wi-Fi (Scan Now)',
          onPress: async () => {
            setStatus('Scanning Wi-Fi for peer device…');
            const res = await autoDiscoverAndSync((msg) => setStatus(msg));
            if (res.peerIp) {
              await reload();
              if (res.synced > 0) setAutoKey((k) => k + 1);
              Alert.alert('Auto-Sync Complete', `Connected with ${res.peerIp}.\nSynced ${res.synced} new items.`);
            } else {
              Alert.alert('No Peer Found', 'Make sure both your phone and tablet have the app open on the same Wi-Fi.');
            }
          },
        },
        {
          text: 'Sync Links (Quick Share)',
          onPress: async () => {
            try {
              setStatus('Sharing links…');
              const { count } = await exportLinksPackage();
              setStatus(`Shared ${count} links.`);
            } catch (e) {
              Alert.alert('Sync Error', String(e));
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
    Keyboard.dismiss();
    await markBookmarkViewed(item.id);
    setOpenStack((s) => [...s, item.id]);
    reload();
  }
  const { colors, isDark, toggleTheme } = useTheme();

  const completedCount = Math.max(0, batchTotal - pendingCount);
  const targetPercent =
    batchTotal > 0
      ? Math.min(100, Math.round((completedCount / batchTotal) * 100))
      : processing || pendingCount > 0
        ? 25
        : 0;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: targetPercent,
      duration: 350,
      useNativeDriver: false,
    }).start();
  }, [targetPercent, progressAnim]);

  useEffect(() => {
    if (processing || pendingCount > 0) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
  }, [processing, pendingCount, pulseAnim]);

  const filteredBookmarks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return bookmarks;
    const words = q.split(/\s+/).filter(Boolean);
    return bookmarks.filter((b) => {
      const text = `${b.title} ${b.caption} ${b.url} ${b.links.map((l) => `${l.title} ${l.domain}`).join(' ')}`.toLowerCase();
      return text.includes(q) || words.every((w) => text.includes(w));
    });
  }, [bookmarks, searchQuery]);

  const sections = useMemo(() => groupBookmarksByDate(filteredBookmarks), [filteredBookmarks]);

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
        {!searchOpen ? (
          <>
            <View style={styles.brandingGroup}>
              <Image source={require('../../assets/icon.png')} style={[styles.appLogo, { borderColor: colors.cardBorder }]} />
              <Text style={[styles.header, { color: colors.text }]}>Bookmarks</Text>
            </View>

            <View style={styles.topRightControls}>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={openSearch}
                style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
                accessibilityLabel="Search"
              >
                <Feather name="search" size={15} color={colors.text} />
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.7}
                onPress={openSyncDialog}
                style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
                accessibilityLabel="Sync"
              >
                <Feather name="share-2" size={15} color={colors.text} />
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.7}
                onPress={toggleTheme}
                style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
                accessibilityLabel="Toggle Theme"
              >
                <Feather name={isDark ? 'sun' : 'moon'} size={15} color={colors.text} />
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <Animated.View
            style={[
              styles.searchBarRow,
              {
                backgroundColor: colors.card,
                borderColor: colors.cardBorder,
                opacity: searchAnim,
                transform: [
                  {
                    translateY: searchAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-6, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <Feather name="search" size={15} color={colors.accent} style={styles.searchInnerIcon} />
            <TextInput
              ref={searchInputRef}
              style={[styles.searchInputField, { color: colors.text }]}
              placeholder="Search bookmarks by word, author…"
              placeholderTextColor={colors.sub}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onBlur={() => {
                if (searchQuery.trim().length === 0) closeSearch();
              }}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 ? (
              <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.searchClearBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="x-circle" size={14} color={colors.sub} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={closeSearch} style={styles.searchCancelBtn}>
              <Text style={[styles.searchCancelText, { color: colors.accent }]}>Cancel</Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </View>

      {/* Search Result Count Banner (only while searching) */}
      {searchOpen && searchQuery.trim().length > 0 ? (
        <View style={styles.searchResultBar}>
          <Text style={[styles.searchResultText, { color: colors.accent }]}>
            {filteredBookmarks.length} {filteredBookmarks.length === 1 ? 'match' : 'matches'} for "{searchQuery.trim()}"
          </Text>
        </View>
      ) : null}

      {processing || pendingCount > 0 ? (
        <View style={[styles.progressCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <View style={styles.progressTopRow}>
            <View style={styles.progressLabelGroup}>
              <Animated.View style={[styles.pulseIndicator, { backgroundColor: colors.accent, opacity: pulseAnim }]} />
              <Text style={[styles.progressTitle, { color: colors.text }]}>
                {tweetJob ? 'Saving Tweet' : preloadJob ? 'Archiving Web Docs' : 'Processing Queue'}
              </Text>
            </View>
            <Text style={[styles.progressCountBadge, { color: colors.accent }]}>
              {batchTotal > 0 ? `${completedCount} of ${batchTotal}` : `${pendingCount} pending`}
            </Text>
          </View>

          <Text style={[styles.progressStatusText, { color: colors.sub }]} numberOfLines={1}>
            {status || 'Downloading media and offline packages…'}
          </Text>

          <View style={[styles.progressTrack, { backgroundColor: colors.thumbBg }]}>
            <Animated.View
              style={[
                styles.progressBar,
                {
                  backgroundColor: colors.accent,
                  width: progressAnim.interpolate({
                    inputRange: [0, 100],
                    outputRange: ['6%', '100%'],
                    extrapolate: 'clamp',
                  }),
                },
              ]}
            />
          </View>
        </View>
      ) : null}

      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={() => Keyboard.dismiss()}
        ListEmptyComponent={
          searchQuery.trim().length > 0 ? (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconCircle, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
                <Feather name="search" size={28} color={colors.sub} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No Matches Found</Text>
              <Text style={[styles.emptySub, { color: colors.sub }]}>
                No saved tweets or articles matched "{searchQuery.trim()}". Try another keyword or handle.
              </Text>
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconCircle, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
                <Feather name="bookmark" size={30} color={colors.sub} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No Bookmarks Saved Yet</Text>
              <Text style={[styles.emptySub, { color: colors.sub }]}>
                Share any tweet from the X app or tap Sync to receive bookmarks from another device.
              </Text>
            </View>
          )
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
  progressCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    marginVertical: 10,
  },
  progressTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  progressLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pulseIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  progressTitle: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  progressCountBadge: {
    fontSize: 12,
    fontWeight: '700',
  },
  progressStatusText: {
    fontSize: 12,
    marginBottom: 10,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    width: '100%',
  },
  progressBar: {
    height: '100%',
    borderRadius: 3,
  },
  emptyContainer: {
    paddingVertical: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySub: {
    fontSize: 13.5,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  brandingGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  appLogo: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderWidth: 1,
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBarRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  searchInnerIcon: {
    marginRight: 8,
  },
  searchInputField: {
    flex: 1,
    fontSize: 14,
    padding: 0,
  },
  searchClearBtn: {
    padding: 4,
    marginRight: 4,
  },
  searchCancelBtn: {
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  searchCancelText: {
    fontSize: 13,
    fontWeight: '700',
  },
  searchResultBar: {
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  searchResultText: {
    fontSize: 12,
    fontWeight: '700',
  },
  container: { flex: 1, paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    minHeight: 40,
  },
  header: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  topRightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dim: { fontSize: 14 },
  error: { fontSize: 14, paddingHorizontal: 16 },
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
