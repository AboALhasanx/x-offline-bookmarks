import { useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { TweetData } from '../types';

interface Props {
  url: string;
  onResult: (data: TweetData) => void;
  onError: (message: string) => void;
}

const SCRAPE_JS = `
(function() {
  function meta(name) {
    var el = document.querySelector('meta[property="' + name + '"]') ||
      document.querySelector('meta[name="' + name + '"]');
    return el && el.content ? el.content : null;
  }
  function scrape() {
    var article = document.querySelector('article[data-testid="tweet"]');
    if (article) {
      var textEl = article.querySelector('[data-testid="tweetText"]');
      var userEl = article.querySelector('[data-testid="User-Name"]');
      var timeEl = article.querySelector('time');
      var vids = Array.prototype.slice.call(article.querySelectorAll('video'))
        .map(function(v) { return { url: v.src || '', poster: v.poster || null }; })
        .filter(function(v) { return v.url && v.url.indexOf('http') === 0; });
      var imgs = Array.prototype.slice.call(article.querySelectorAll('img'))
        .map(function(i) { return i.src; })
        .filter(function(s) { return s && s.indexOf('http') === 0 && s.indexOf('profile_images') === -1; });
      var primaryVid = vids[0] ? vids[0].url : meta('og:video') || meta('og:video:url') || meta('twitter:player:stream');
      var primaryPoster = vids[0] ? vids[0].poster : null;
      var media = [];
      imgs.forEach(function(u) { media.push({ kind: 'image', url: u }); });
      vids.forEach(function(v) { media.push({ kind: 'video', url: v.url, posterUrl: v.poster }); });
      if (vids.length === 0 && primaryVid) {
        media.push({ kind: 'video', url: primaryVid, posterUrl: primaryPoster });
      }
      return {
        ok: true,
        author: userEl ? userEl.innerText : '',
        text: textEl ? textEl.innerText : '',
        createdAt: timeEl ? timeEl.getAttribute('datetime') : null,
        imageUrls: imgs,
        videoUrl: primaryVid,
        posterUrl: primaryPoster,
        media: media
      };
    }
    // Logged-out login wall: X still embeds the post text + preview image
    // in Open Graph meta tags for crawlers.
    var desc = meta('og:description');
    if (desc) {
      var preview = meta('og:image');
      var vid = meta('og:video') || meta('og:video:url') || meta('twitter:player:stream');
      var mediaFallback = [];
      if (preview) mediaFallback.push({ kind: 'image', url: preview });
      if (vid) mediaFallback.push({ kind: 'video', url: vid, posterUrl: preview });
      return {
        ok: true,
        author: meta('og:title') || '',
        text: desc,
        createdAt: null,
        imageUrls: preview ? [preview] : [],
        videoUrl: vid,
        posterUrl: preview,
        media: mediaFallback
      };
    }
    var login = document.body ? document.body.innerText.slice(0, 120) : '';
    return { ok: false, reason: 'no-tweet', hint: login };
  }
  setTimeout(function() {
    window.ReactNativeWebView.postMessage(JSON.stringify(scrape()));
  }, 4000);
})();
true;
`;
/**
 * Hidden WebView that loads a tweet URL and scrapes its content.
 * Falls back to Open Graph tags on the logged-out login wall.
 */
export default function HeadlessWebView({ url, onResult, onError }: Props) {
  const settled = useRef(false);

  function settle(fn: () => void) {
    if (settled.current) return;
    settled.current = true;
    fn();
  }

  function handleMessage(event: WebViewMessageEvent) {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as
        | {
            ok: true;
            author: string;
            text: string;
            createdAt: string | null;
            imageUrls: string[];
            videoUrl?: string | null;
            posterUrl?: string | null;
            media?: Array<{ kind: 'image' | 'video'; url: string; posterUrl?: string | null }>;
          }
        | { ok: false; reason: string; hint?: string };
      if (payload.ok) {
        settle(() =>
          onResult({
            author: payload.author,
            text: payload.text,
            createdAt: payload.createdAt,
            imageUrls: payload.imageUrls,
            videoUrl: payload.videoUrl ?? null,
            posterUrl: payload.posterUrl ?? null,
            media: payload.media,
          }),
        );
      } else {
        settle(() => onError(`tweet scrape failed (${payload.reason}): ${(payload.hint ?? '').slice(0, 80)}`));
      }
    } catch (e) {
      settle(() => onError(`tweet scrape parse error: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  return (
    <WebView
      style={styles.hidden}
      source={{ uri: url }}
      injectedJavaScript={SCRAPE_JS}
      onMessage={handleMessage}
      onError={(e) => settle(() => onError(`webview error: ${e.nativeEvent.description}`))}
      onHttpError={(e) => settle(() => onError(`webview HTTP ${e.nativeEvent.statusCode}`))}
      javaScriptEnabled
      domStorageEnabled
    />
  );
}

const styles = StyleSheet.create({
  hidden: { width: 0, height: 0, opacity: 0 },
});
