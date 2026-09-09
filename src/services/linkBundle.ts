import { Directory, File, Paths } from 'expo-file-system';
import { parseHTML } from 'linkedom';
import type { TweetLink } from '../types';
import { ensureDir } from './files';
import { escapeHtml, styleArticle } from './html';
import { Readability } from '@mozilla/readability';

const FETCH_TIMEOUT_MS = 30000;
const MAX_STYLESHEETS = 8;
const MAX_IMAGES = 24;

export interface FetchedPage {
  finalUrl: string;
  text: string;
}

function resolveUrl(ref: string, base: string): string | null {
  try {
    const absolute = new URL(ref, base).href;
    return absolute.startsWith('http') ? absolute : null;
  } catch {
    return null;
  }
}

function extensionFor(url: string): string {
  const match = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return (match?.[1] ?? 'bin').toLowerCase();
}

/** Single GET that follows redirects and reports the final URL. */
export async function fetchPageText(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) xbookmarks/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return { finalUrl: res.url || url, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export function isSpaShell(html: string): boolean {
  const hasRoot =
    /id=["'](root|__next|app|__nuxt)["']/i.test(html) ||
    /umi\.js|bundle\.js|main\.[a-f0-9]+\.js|runtime\.[a-f0-9]+\.js/i.test(html);
  const textSample = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  return hasRoot && textSample.length < 400;
}

/**
 * Downloads a linked page for offline reading: HTML + stylesheets + images
 * saved as a self-contained bundle (index.html + css/ + img/).
 * Throws on failure — callers should skip failed links, never fail the tweet.
 */
export async function bundleLinkPage(
  displayUrl: string,
  slug: string,
  preloaded?: FetchedPage,
): Promise<TweetLink> {
  const { finalUrl, text } = preloaded ?? (await fetchPageText(displayUrl));
  const { document } = parseHTML(text);
  const doc = document as unknown as Document;

  const root = new Directory(Paths.document, 'links');
  ensureDir(root);
  const dir = new Directory(root, slug);
  ensureDir(dir);
  const cssDir = new Directory(dir, 'css');
  ensureDir(cssDir);
  const imgDir = new Directory(dir, 'img');
  ensureDir(imgDir);

  // Stylesheets → local files.
  const styleLinks = [...doc.querySelectorAll('link[rel="stylesheet"]')].slice(0, MAX_STYLESHEETS);
  let cssIndex = 0;
  for (const el of styleLinks) {
    const link = el as unknown as { getAttribute(n: string): string | null; setAttribute(n: string, v: string): void; remove(): void };
    const href = link.getAttribute('href');
    const absolute = href ? resolveUrl(href, finalUrl) : null;
    if (!absolute) {
      link.remove();
      continue;
    }
    try {
      const { text: css } = await fetchPageText(absolute);
      const file = new File(cssDir, `s${cssIndex++}.css`);
      file.create();
      file.write(css);
      link.setAttribute('href', `./css/${file.name}`);
    } catch {
      link.remove();
    }
  }

  // Images → local files.
  const imgs = [...doc.querySelectorAll('img')].slice(0, MAX_IMAGES);
  let imgIndex = 0;
  const pairs: Array<{ absolute: string; file: string }> = [];
  for (const el of imgs) {
    const img = el as unknown as {
      getAttribute(n: string): string | null;
      setAttribute(n: string, v: string): void;
      removeAttribute(n: string): void;
    };
    img.removeAttribute('srcset');
    const src = img.getAttribute('src');
    const absolute = src ? resolveUrl(src, finalUrl) : null;
    if (!absolute) continue;
    try {
      const dest = new File(imgDir, `i${imgIndex++}.${extensionFor(absolute)}`);
      const output = await File.downloadFileAsync(absolute, dest);
      pairs.push({ absolute, file: output.name });
      img.setAttribute('src', `./img/${output.name}`);
    } catch {
      // Keep remote src as-is; offline it just won't render.
    }
  }
  // Absolutize anchors so the in-app preview can intercept taps.
  for (const el of [...doc.querySelectorAll('a[href]')]) {
    const a = el as unknown as { getAttribute(n: string): string | null; setAttribute(n: string, v: string): void };
    const href = a.getAttribute('href');
    const absolute = href ? resolveUrl(href, finalUrl) : null;
    if (absolute) a.setAttribute('href', absolute);
  }

  // Strip all scripts, noscripts, and preloads to prevent SPA hydration crashes offline.
  const unwanted = [...doc.querySelectorAll('script, noscript, iframe, object, embed, link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"]')];
  for (const el of unwanted) {
    try {
      (el as unknown as { remove(): void }).remove();
    } catch {
      // Ignore removal failure
    }
  }

  // Ensure head has charset and mobile viewport
  let head = doc.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    doc.documentElement.insertBefore(head, doc.body);
  }
  if (!doc.querySelector('meta[charset]')) {
    const m = doc.createElement('meta');
    m.setAttribute('charset', 'utf-8');
    head.appendChild(m);
  }
  if (!doc.querySelector('meta[name="viewport"]')) {
    const vp = doc.createElement('meta');
    vp.setAttribute('name', 'viewport');
    vp.setAttribute('content', 'width=device-width, initial-scale=1');
    head.appendChild(vp);
  }

  const titleEl = doc.querySelector('title');
  const ogTitle = doc.querySelector('meta[property="og:title"]') as unknown as {
    getAttribute(n: string): string | null;
  } | null;
  const title = titleEl?.textContent?.trim() || ogTitle?.getAttribute('content')?.trim() || finalUrl;

  // Write both index.html and frozen.html (for backward and explicit dual-mode compatibility)
  const frozenContent = doc.toString();
  const index = new File(dir, 'index.html');
  if (!index.exists) index.create();
  index.write(frozenContent);

  const frozen = new File(dir, 'frozen.html');
  if (!frozen.exists) frozen.create();
  frozen.write(frozenContent);
  let domain = finalUrl;
  try {
    domain = new URL(finalUrl).hostname;
  } catch {
    // Keep full URL.
  }
  // Reader-clean version: raw pages render poorly offline (missing JS,
  // fonts, layout), so the preview shows a cleaned article instead.
  let cleanUri = '';
  try {
    const { document: rdoc } = parseHTML(text);
    const article = new Readability(rdoc as unknown as Document).parse();
    if (article?.content) {
      const { document: cdoc } = parseHTML(article.content);
      for (const el of [...cdoc.querySelectorAll('img')]) {
        const cimg = el as unknown as {
          getAttribute(n: string): string | null;
          setAttribute(n: string, v: string): void;
          remove(): void;
        };
        const csrc = cimg.getAttribute('src');
        const cabs = csrc ? resolveUrl(csrc, finalUrl) : null;
        const hit = cabs ? pairs.find((p) => p.absolute === cabs) : undefined;
        if (hit) cimg.setAttribute('src', `./img/${hit.file}`);
        else cimg.remove();
      }
      const clean = new File(dir, 'clean.html');
      if (!clean.exists) clean.create();
      clean.write(styleArticle(article.title || title, cdoc.toString(), finalUrl));
      cleanUri = clean.uri;
    }
  } catch {
    // Raw bundle still stands.
  }

  if (!cleanUri) {
    try {
      const bodyContent = doc.body ? doc.body.innerHTML : `<p>${escapeHtml(title)}</p>`;
      const clean = new File(dir, 'clean.html');
      if (!clean.exists) clean.create();
      clean.write(styleArticle(title, bodyContent, finalUrl));
      cleanUri = clean.uri;
    } catch {
      // Keep cleanUri empty if fallback fails
    }
  }

  const needsPreload = isSpaShell(text);

  return {
    display: displayUrl,
    resolved: finalUrl,
    title,
    domain,
    bundleUri: dir.uri.replace(/\/+$/, ''),
    cleanUri: cleanUri ? cleanUri.replace(/\/+$/, '') : undefined,
    kind: 'page',
    needsPreload: needsPreload || undefined,
  };
}
/**
 * Updates the local bundle (clean.html and frozen.html) using the fully
 * rendered HTML captured from the browser/WebView after client-side hydration.
 */
export async function updateBundleFromHtml(
  bundleUri: string,
  url: string,
  renderedHtml: string,
): Promise<{ cleanUri?: string; frozenUri?: string }> {
  try {
    const cleanBase = bundleUri
      .replace(/\/(frozen|clean|index)\.html.*$/, '')
      .replace(/\/+$/, '');
    const dir = new Directory(cleanBase);
    ensureDir(dir);

    // 1. Sanitize rendered HTML for frozen.html (strip scripts)
    const { document: fdoc } = parseHTML(renderedHtml);
    const unwanted = [
      ...fdoc.querySelectorAll(
        'script, noscript, iframe, object, embed, link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"]',
      ),
    ];
    for (const el of unwanted) {
      try {
        (el as unknown as { remove(): void }).remove();
      } catch {
        // Ignore removal error
      }
    }

    const frozenContent = fdoc.toString();
    const frozen = new File(dir, 'frozen.html');
    if (!frozen.exists) frozen.create();
    frozen.write(frozenContent);

    const index = new File(dir, 'index.html');
    if (!index.exists) index.create();
    index.write(frozenContent);

    // 2. Extract clean readability version from the fully hydrated DOM
    const { document: rdoc } = parseHTML(renderedHtml);
    const article = new Readability(rdoc as unknown as Document).parse();
    const title = article?.title || fdoc.querySelector('title')?.textContent?.trim() || url;
    let bodyContent = article?.content;
    if (!bodyContent || bodyContent.length < 200) {
      const mainEl =
        rdoc.querySelector('main, article, [role="main"], #root, .content, [class*="content"]') ||
        rdoc.body;
      bodyContent = mainEl ? mainEl.innerHTML : `<p>${escapeHtml(title)}</p>`;
    }
    const clean = new File(dir, 'clean.html');
    if (!clean.exists) clean.create();
    clean.write(styleArticle(title, bodyContent, url));

    return {
      cleanUri: clean.uri.replace(/\/+$/, ''),
      frozenUri: frozen.uri.replace(/\/+$/, ''),
    };
  } catch (e) {
    console.log('updateBundleFromHtml error:', e);
    return {};
  }
}

const STATUS_ID = /\/status\/(\d+)/i;

export interface TweetApiMediaItem {
  kind: 'image' | 'video';
  url: string;
  posterUrl?: string | null;
}

export interface TweetApiData {
  /** Full post text (X truncates og:description on long posts). */
  text: string | null;
  /** Best offline-sized mp4, if the post carries video. */
  videoUrl: string | null;
  /** Full-quality photo URLs. */
  photos: string[];
  /** Ordered collection of all media items (photos and videos). */
  media: TweetApiMediaItem[];
  /** Status id this post replies to (thread parent), if any. */
  replyToId: string | null;
  authorName: string;
  authorHandle: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function replyIdOf(v: unknown): string | null {
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    for (const key of ['id_str', 'idStr', 'id']) {
      const id = replyIdOf(o[key]);
      if (id) return id;
    }
  }
  return null;
}

/**
 * Resolves full text + media + thread parent via the public FxTwitter
 * embed API. X's logged-out pages truncate descriptions and expose no
 * video file, so this is the primary source. Returns null on any failure.
 */
export async function fetchTweetApi(tweetUrl: string): Promise<TweetApiData | null> {
  const match = tweetUrl.match(STATUS_ID);
  if (!match) return null;
  return fetchTweetApiById(match[1]);
}

export async function fetchTweetApiById(id: string): Promise<TweetApiData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://api.fxtwitter.com/i/status/${id}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      tweet?: {
        text?: unknown;
        replying_to_status?: unknown;
        replying_to?: unknown;
        author?: { name?: unknown; screen_name?: unknown };
        media?: {
          all?: Array<{
            type?: unknown;
            url?: unknown;
            thumbnail_url?: unknown;
            variants?: Array<{ url?: unknown; bitrate?: unknown }>;
          }>;
          photos?: Array<{ url?: unknown }>;
          videos?: Array<{ url?: unknown; thumbnail_url?: unknown; bitrate?: unknown; variants?: Array<{ url?: unknown; bitrate?: unknown }> }>;
        };
      };
    };
    const tweet = json.tweet;
    if (!tweet) return null;
    const text = str(tweet.text);

    const mediaList: TweetApiMediaItem[] = [];
    const photos: string[] = [];
    let primaryVideoUrl: string | null = null;

    const extractBestVideo = (variants?: Array<{ url?: unknown; bitrate?: unknown }>, directUrl?: unknown): string | null => {
      if (Array.isArray(variants) && variants.length > 0) {
        const candidates = variants
          .map((v) => ({
            url: typeof v.url === 'string' ? v.url : '',
            bitrate: typeof v.bitrate === 'number' ? v.bitrate : 0,
          }))
          .filter((v) => v.url.startsWith('http'));
        const ranked = candidates.filter((v) => v.bitrate > 0).sort((a, b) => a.bitrate - b.bitrate);
        const underCap = ranked.filter((v) => v.bitrate <= 3000000);
        const best = underCap[underCap.length - 1]?.url ?? ranked[0]?.url ?? candidates[0]?.url;
        if (best) return best;
      }
      return typeof directUrl === 'string' && directUrl.startsWith('http') ? directUrl : null;
    };

    if (Array.isArray(tweet.media?.all) && tweet.media.all.length > 0) {
      for (const item of tweet.media.all) {
        const type = String(item.type || '').toLowerCase();
        if (type === 'video' || type === 'gif') {
          const vUrl = extractBestVideo(item.variants, item.url);
          if (vUrl) {
            if (!primaryVideoUrl) primaryVideoUrl = vUrl;
            const poster = typeof item.thumbnail_url === 'string' ? item.thumbnail_url : null;
            mediaList.push({ kind: 'video', url: vUrl, posterUrl: poster });
          }
        } else {
          const pUrl = typeof item.url === 'string' ? item.url : null;
          if (pUrl && pUrl.startsWith('http')) {
            photos.push(pUrl);
            mediaList.push({ kind: 'image', url: pUrl });
          }
        }
      }
    } else {
      if (Array.isArray(tweet.media?.photos)) {
        for (const p of tweet.media.photos) {
          if (typeof p.url === 'string' && p.url.startsWith('http')) {
            photos.push(p.url);
            mediaList.push({ kind: 'image', url: p.url });
          }
        }
      }
      if (Array.isArray(tweet.media?.videos)) {
        for (const v of tweet.media.videos) {
          const vUrl = extractBestVideo(v.variants, v.url);
          if (vUrl) {
            if (!primaryVideoUrl) primaryVideoUrl = vUrl;
            const poster = typeof v.thumbnail_url === 'string' ? v.thumbnail_url : null;
            mediaList.push({ kind: 'video', url: vUrl, posterUrl: poster });
          }
        }
      }
    }

    const authorName = str(tweet.author?.name) ?? 'X';
    const handle = str(tweet.author?.screen_name);
    if (!text && mediaList.length === 0) return null;
    return {
      text,
      videoUrl: primaryVideoUrl,
      photos,
      media: mediaList,
      replyToId: replyIdOf(tweet.replying_to_status) ?? replyIdOf(tweet.replying_to),
      authorName,
      authorHandle: handle ? `@${handle}` : '@x',
    };
  } finally {
    clearTimeout(timer);
  }
}
