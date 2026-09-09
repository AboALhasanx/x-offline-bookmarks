import { parseHTML } from 'linkedom';
import {
  deletePendingItem,
  getBookmarkByUrl,
  getPendingItems,
  saveBookmark,
  updatePendingStatus,
} from '../db/db';
import type { LocalMediaItem, PendingItem, ThreadPart, TweetData, TweetLink, TweetMedia } from '../types';
import { extractArticle } from './extractor';
import { downloadImages } from './imageDownloader';
import { bundleLinkPage, fetchPageText, fetchTweetApi, fetchTweetApiById, type FetchedPage } from './linkBundle';
import { CAROUSEL_CSS, CAROUSEL_SCRIPT, escapeHtml, styleArticle, THEME_CSS, ZOOM_CSS, ZOOM_HTML } from './html';

export interface ProcessSummary {
  done: number;
  failed: number;
}

const TWEET_HOST = /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i;
const STATUS_PATH = /\/status\/\d+/i;
const MAX_THREAD_DEPTH = 10;


function parseAuthor(author: string, url: string): { name: string; handle: string } {
  const handleMatch = url.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
  const handle = handleMatch ? `@${handleMatch[1]}` : '@x';
  const name = author.split(' on X')[0].replace(/\s*\(@[^)]+\)\s*$/, '').trim() || handle;
  return { name, handle };
}

/** pbs.twimg.com photo identity ignoring size suffixes (:large, ?name=orig). */
function mediaKey(url: string): string {
  return url.split('?')[0].replace(/:\w+$/, '');
}


function linkifyCaption(text: string, links: TweetLink[]): string {
  let html = escapeHtml(text);
  const ordered = [...links].sort((a, b) => b.display.length - a.display.length);
  for (const link of ordered) {
    const needle = escapeHtml(link.display);
    if (!needle || !html.includes(needle)) continue;
    const target =
      link.kind === 'quote' && link.tweetBookmarkId != null
        ? `quote:${link.tweetBookmarkId}`
        : link.resolved;
    const anchor = `<a class="tlink" href="${escapeHtml(target)}">${needle}</a>`;
    html = html.split(needle).join(anchor);
  }
  return html
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p>${line}</p>`)
    .join('');
}

function renderMediaBlock(media: LocalMediaItem[], idPrefix: string): string {
  if (media.length === 0) return '';
  if (media.length === 1) {
    const item = media[0];
    if (item.kind === 'video') {
      return `<div class="media"><video src="${escapeHtml(item.local)}" controls preload="metadata" playsinline${item.poster ? ` poster="${escapeHtml(item.poster)}"` : ''}></video></div>`;
    }
    return `<div class="media"><img src="${escapeHtml(item.local)}" onclick="zoomImg(this.src)" /></div>`;
  }
  const slides = media
    .map((item) => {
      if (item.kind === 'video') {
        return `<div class="carousel-slide"><video src="${escapeHtml(item.local)}" controls preload="metadata" playsinline${item.poster ? ` poster="${escapeHtml(item.poster)}"` : ''}></video></div>`;
      }
      return `<div class="carousel-slide"><img src="${escapeHtml(item.local)}" onclick="zoomImg(this.src)" /></div>`;
    })
    .join('');

  const dots = media
    .map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}"></span>`)
    .join('');

  return `<div class="carousel" id="${idPrefix}">
<div class="carousel-track">${slides}</div>
<div class="carousel-badge"><span class="cur">1</span> / <span class="tot">${media.length}</span></div>
<div class="carousel-dots">${dots}</div>
</div>`;
}

function threadHtml(thread: ThreadPart[]): string {
  if (thread.length === 0) return '';
  const parts = thread
    .map((part, pIdx) => {
      const initial = (part.name.trim()[0] ?? 'X').toUpperCase();
      const body = part.text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');
      const mediaHtml =
        part.media && part.media.length > 0
          ? renderMediaBlock(part.media, `th_c_${pIdx}`)
          : [
              ...part.images.map((src) => `<div class="media"><img src="${escapeHtml(src)}" onclick="zoomImg(this.src)" /></div>`),
              part.video ? `<div class="media"><video src="${escapeHtml(part.video)}" controls preload="metadata" playsinline></video></div>` : '',
            ].join('');
      return `<div class="tpart">
<div class="head"><div class="avatar">${escapeHtml(initial)}</div><div><div class="name">${escapeHtml(part.name)}</div><div class="handle">${escapeHtml(part.handle)}</div></div></div>
<div class="caption">${body}</div>
${mediaHtml}
</div>`;
    })
    .join('');
  return `<div class="threadlabel">Thread (${thread.length + 1})</div>${parts}`;
}

/**
 * Offline tweet card styled after the X app (theme-aware). Ancestors render
 * above the post, page links open saved offline bundles, quote cards open
 * the quoted post, images tap to zoom, and multiple media items swipe in a carousel.
 */
function tweetToHtml(
  data: TweetData,
  mediaItems: LocalMediaItem[],
  links: TweetLink[],
  thread: ThreadPart[],
  url: string,
): string {
  const { name, handle } = parseAuthor(data.author, url);
  const initial = (name.trim()[0] ?? 'X').toUpperCase();
  const mediaContent = renderMediaBlock(mediaItems, 'main_carousel');
  const cards = links
    .map((link) => {
      if (link.kind === 'quote' && link.tweetBookmarkId != null) {
        return `<div class="card" onclick="window.ReactNativeWebView.postMessage('open-tweet:${link.tweetBookmarkId}')">
<span class="card-title">${escapeHtml(link.title)}</span>
${link.snippet ? `<span class="card-domain">${escapeHtml(link.snippet)}</span>` : ''}
</div>`;
      }
      return `<a class="card" href="${escapeHtml(link.resolved)}">
<span class="card-title">${escapeHtml(link.title)}</span>
<span class="card-domain">${escapeHtml(link.domain)}</span>
</a>`;
    })
    .join('');
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${THEME_CSS}
body{background:var(--bg,#000);color:var(--text,#e7e9ea);font-family:-apple-system,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:12px 16px 40px}
.head{display:flex;gap:12px;align-items:center}
.avatar{width:40px;height:40px;border-radius:50%;background:var(--avatar-bg,#333639);color:var(--text,#fff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;flex-shrink:0}
.name{font-weight:700;font-size:15px;color:var(--text,#e7e9ea)}
.handle{color:var(--sub,#71767b);font-size:14px}
.threadlabel{color:var(--link,#1d9bf0);font-size:14px;font-weight:700;margin:4px 0 12px}
.tpart{border-left:2px solid var(--border,#2f3336);padding-left:12px;margin-bottom:20px}
.caption{font-size:17px;line-height:1.45;margin:12px 0;overflow-wrap:anywhere;color:var(--text,#e7e9ea)}
.caption p{margin:0 0 12px}
.tlink{color:var(--link,#1d9bf0);text-decoration:none}
.media{margin:12px -16px;border-top:1px solid var(--border,#2f3336);border-bottom:1px solid var(--border,#2f3336)}
.media img,.media video{width:100%;display:block}
.tpart .media{margin:12px 0;border:1px solid var(--border,#2f3336);border-radius:12px;overflow:hidden}
.card{display:block;border:1px solid var(--border,#2f3336);background:var(--card,#16181c);border-radius:16px;padding:12px;margin:12px 0;text-decoration:none}
.card-title{display:block;color:var(--text,#e7e9ea);font-size:15px}
.card-domain{display:block;color:var(--sub,#71767b);font-size:13px;margin-top:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.meta{color:var(--sub,#71767b);font-size:13px;margin:12px 0}
.src{color:var(--sub,#71767b);font-size:12px;margin-top:16px;overflow-wrap:anywhere}
${ZOOM_CSS}
${CAROUSEL_CSS}
</style></head><body>
${threadHtml(thread)}
<div class="head"><div class="avatar">${escapeHtml(initial)}</div><div><div class="name">${escapeHtml(name)}</div><div class="handle">${escapeHtml(handle)}</div></div></div>
<div class="caption">${linkifyCaption(data.text, links)}</div>
${mediaContent}${cards}
${data.createdAt ? `<div class="meta">${escapeHtml(data.createdAt)}</div>` : ''}
${ZOOM_HTML}
${CAROUSEL_SCRIPT}
</body></html>`;
}


/**
 * Processes all pending article links. Tweet links are skipped here —
 * they need a mounted HeadlessWebView (see getNextPendingTweet).
 */
export async function processPendingArticles(): Promise<ProcessSummary> {
  const items = await getPendingItems();
  let done = 0;
  let failed = 0;
  for (const item of items.filter((i) => i.status === 'pending' && !TWEET_HOST.test(i.url))) {
    await updatePendingStatus(item.id, 'processing');
    try {
      const article = await extractArticle(item.url);
      await saveBookmark({
        url: item.url,
        title: article.title,
        type: 'article',
        htmlContent: styleArticle(article.title, article.html, item.url),
        imagePaths: article.images.map((i) => i.local),
      });
      await deletePendingItem(item.id);
      done++;
    } catch (e) {
      await updatePendingStatus(item.id, 'failed', e instanceof Error ? e.message : String(e));
      failed++;
    }
  }
  return { done, failed };
}

export async function getNextPendingTweet(): Promise<PendingItem | null> {
  const items = await getPendingItems();
  return items.find((i) => i.status === 'pending' && TWEET_HOST.test(i.url)) ?? null;
}

export async function saveTweetBookmark(item: PendingItem, data: TweetData): Promise<void> {
  await updatePendingStatus(item.id, 'processing');
  try {
    if (!data.text && data.imageUrls.length === 0 && !data.videoUrl && (!data.media || data.media.length === 0)) {
      throw new Error('empty tweet (login wall or deleted?)');
    }
    const api = await fetchTweetApi(item.url);
    // Long posts arrive truncated in og:description — prefer the fuller text.
    const caption = api?.text && api.text.length > data.text.length ? api.text : data.text;

    const rawMedia: TweetMedia[] = [];
    if (api?.media && api.media.length > 0) {
      for (const m of api.media) rawMedia.push({ kind: m.kind, url: m.url, posterUrl: m.posterUrl });
    } else if (data.media && data.media.length > 0) {
      for (const m of data.media) rawMedia.push({ kind: m.kind, url: m.url, posterUrl: m.posterUrl });
    } else {
      for (const u of data.imageUrls) rawMedia.push({ kind: 'image', url: u });
      if (data.videoUrl) rawMedia.push({ kind: 'video', url: data.videoUrl, posterUrl: data.posterUrl });
    }

    const localMedia: LocalMediaItem[] = [];
    const imagePaths: string[] = [];

    for (let idx = 0; idx < rawMedia.length; idx++) {
      const m = rawMedia[idx];
      if (m.kind === 'video') {
        const vids = await downloadImages([m.url], `t_${item.id}_v_${idx}`);
        const localVid = vids[0]?.local ?? null;
        if (localVid) {
          let localPoster: string | null = null;
          if (m.posterUrl) {
            const posters = await downloadImages([m.posterUrl], `t_${item.id}_p_${idx}`);
            localPoster = posters[0]?.local ?? null;
          }
          localMedia.push({ kind: 'video', local: localVid, poster: localPoster });
        }
      } else {
        const imgs = await downloadImages([m.url], `t_${item.id}_i_${idx}`);
        const localImg = imgs[0]?.local ?? null;
        if (localImg) {
          localMedia.push({ kind: 'image', local: localImg });
          imagePaths.push(localImg);
        }
      }
    }

    const links = await bundleTweetLinks(caption, item.id);
    const thread = await collectThread(api?.replyToId ?? null, item.id);
    await saveBookmark({
      url: item.url,
      title: caption.slice(0, 80) || item.url,
      type: 'tweet',
      htmlContent: tweetToHtml(
        { ...data, text: caption },
        localMedia,
        links,
        thread,
        item.url,
      ),
      imagePaths,
      links,
      caption,
    });
    await deletePendingItem(item.id);
  } catch (e) {
    await updatePendingStatus(item.id, 'failed', e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/**
 * Walks a post's reply chain upward and saves each ancestor for the offline
 * thread view. Downward replies (other people's responses) need a logged-in
 * session and are not available offline.
 */
async function collectThread(startReplyTo: string | null, itemId: number): Promise<ThreadPart[]> {
  const parts: ThreadPart[] = [];
  const seen = new Set<string>();
  let cursor = startReplyTo;
  let depth = 0;
  while (cursor && depth < MAX_THREAD_DEPTH && !seen.has(cursor)) {
    seen.add(cursor);
    const api = await fetchTweetApiById(cursor);
    if (!api?.text) break;

    const ancestorMedia: LocalMediaItem[] = [];
    if (api.media && api.media.length > 0) {
      for (let mIdx = 0; mIdx < api.media.length; mIdx++) {
        const m = api.media[mIdx];
        if (m.kind === 'video') {
          const vids = await downloadImages([m.url], `th_${itemId}_${depth}_v_${mIdx}`);
          if (vids[0]?.local) {
            let pLocal: string | null = null;
            if (m.posterUrl) {
              const p = await downloadImages([m.posterUrl], `th_${itemId}_${depth}_p_${mIdx}`);
              pLocal = p[0]?.local ?? null;
            }
            ancestorMedia.push({ kind: 'video', local: vids[0].local, poster: pLocal });
          }
        } else {
          const imgs = await downloadImages([m.url], `th_${itemId}_${depth}_i_${mIdx}`);
          if (imgs[0]?.local) {
            ancestorMedia.push({ kind: 'image', local: imgs[0].local });
          }
        }
      }
    } else {
      const imgs = await downloadImages(api.photos, `th_${itemId}_${depth}`);
      imgs.forEach((i) => ancestorMedia.push({ kind: 'image', local: i.local }));
      if (api.videoUrl) {
        const vids = await downloadImages([api.videoUrl], `th_${itemId}_${depth}_v`);
        if (vids[0]?.local) ancestorMedia.push({ kind: 'video', local: vids[0].local });
      }
    }

    parts.push({
      name: api.authorName,
      handle: api.authorHandle,
      text: api.text,
      images: ancestorMedia.filter((m) => m.kind === 'image').map((m) => m.local),
      video: ancestorMedia.find((m) => m.kind === 'video')?.local ?? null,
      media: ancestorMedia,
    });
    cursor = api.replyToId;
    depth++;
  }
  return parts.reverse();
}

/**
 * Finds URLs inside the caption and saves an offline bundle per link.
 * Links to other posts become quoted-tweet bookmarks; everything else
 * becomes an offline page bundle. Failures are skipped, never fatal.
 */
async function bundleTweetLinks(text: string, itemId: number): Promise<TweetLink[]> {
  const seen = new Set<string>();
  const urls = (text.match(/https?:\/\/[^\s)"']+/g) ?? [])
    .map((u) => u.replace(/[.,;:!?]+$/, ''))
    .filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  const links: TweetLink[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const page = await fetchPageText(urls[i]);
      if (STATUS_PATH.test(page.finalUrl)) {
        links.push(await bundleQuotedTweet(urls[i], page));
      } else {
        links.push(await bundleLinkPage(urls[i], `l_${itemId}_${Date.now()}_${i}`, page));
      }
    } catch (e) {
      console.log('queue: skip failed link bundle', urls[i], e);
    }
  }
  return links;
}

/**
 * Saves a quoted post as its own tweet bookmark (text + preview image,
 * no login needed) and returns a link card pointing at it.
 */
async function bundleQuotedTweet(displayUrl: string, page: FetchedPage): Promise<TweetLink> {
  const reused = await getBookmarkByUrl(page.finalUrl);
  if (reused) {
    return {
      display: displayUrl,
      resolved: page.finalUrl,
      title: reused.title,
      domain: 'x.com',
      bundleUri: '',
      kind: 'quote',
      snippet: reused.caption.slice(0, 180),
      tweetBookmarkId: reused.id,
    };
  }
  const { document } = parseHTML(page.text);
  const doc = document as unknown as Document;
  const meta = (name: string): string | null => {
    const el = doc.querySelector(`meta[property="${name}"]`) as unknown as {
      getAttribute(n: string): string | null;
    } | null;
    return el?.getAttribute('content') ?? null;
  };
  const text = meta('og:description') ?? '';
  const author = meta('og:title') ?? page.finalUrl;
  const preview = meta('og:image');
  const images = preview ? await downloadImages([preview], `q_${Date.now()}`) : [];
  const localMedia: LocalMediaItem[] = images.map((i) => ({ kind: 'image', local: i.local }));
  const id = await saveBookmark({
    url: page.finalUrl,
    title: text.slice(0, 80) || author,
    type: 'tweet',
    htmlContent: tweetToHtml(
      { author, text, createdAt: null, imageUrls: [], videoUrl: null, posterUrl: null },
      localMedia,
      [],
      [],
      page.finalUrl,
    ),
    imagePaths: images.map((i) => i.local),
    links: [],
    caption: text,
    sourceUrl: displayUrl,
  });
  return {
    display: displayUrl,
    resolved: page.finalUrl,
    title: author,
    domain: 'x.com',
    bundleUri: '',
    kind: 'quote',
    snippet: text.slice(0, 180),
    tweetBookmarkId: id,
  };
}
