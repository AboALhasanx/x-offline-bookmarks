import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { downloadImages, type DownloadedImage } from './imageDownloader';

export interface ArticleResult {
  title: string;
  html: string;
  images: DownloadedImage[];
}

const FETCH_TIMEOUT_MS = 30000;

function resolveUrl(src: string, base: string): string | null {
  try {
    const absolute = new URL(src, base).href;
    return absolute.startsWith('http') ? absolute : null;
  } catch {
    return null;
  }
}

/**
 * Article path: fetch raw HTML, clean it with Readability, download images
 * for offline viewing and rewrite <img src> to local file URIs.
 */
export async function extractArticle(url: string): Promise<ArticleResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) xbookmarks/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  if (!article?.content) throw new Error(`Readability found no content for ${url}`);
  const title = article.title?.trim() || url;

  // Collect + rewrite images in the cleaned HTML.
  const { document: cleanDoc } = parseHTML(article.content);
  const imgs = [...cleanDoc.querySelectorAll('img')] as unknown as Array<{
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  }>;
  const remoteSrcs: string[] = [];
  for (const img of imgs) {
    const raw = img.getAttribute('src');
    if (!raw) continue;
    const absolute = resolveUrl(raw, url);
    if (absolute) remoteSrcs.push(absolute);
  }

  const downloaded = await downloadImages(remoteSrcs, `a_${Date.now()}`);
  const localByOriginal: Record<string, string> = {};
  for (const d of downloaded) localByOriginal[d.original] = d.local;

  for (const img of imgs) {
    const raw = img.getAttribute('src');
    if (!raw) continue;
    const absolute = resolveUrl(raw, url);
    const local = absolute ? localByOriginal[absolute] : undefined;
    if (local) img.setAttribute('src', local);
  }

  return { title, html: cleanDoc.toString(), images: downloaded };
}

