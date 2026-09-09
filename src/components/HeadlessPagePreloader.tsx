import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

interface Props {
  url: string;
  onResult: (renderedHtml: string, title: string) => void;
  onError: (message: string) => void;
  timeoutMs?: number;
}

const PRELOAD_JS = `
(function() {
  var sent = false;

  async function captureCompletePage() {
    if (sent) return;
    sent = true;
    try {
      // 1. Inline all external stylesheets directly into <style> blocks
      var links = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"]'));
      for (var i = 0; i < links.length; i++) {
        var l = links[i];
        if (!l.href) continue;
        try {
          var res = await fetch(l.href);
          if (res.ok) {
            var css = await res.text();
            if (css && css.length > 0) {
              var s = document.createElement('style');
              s.setAttribute('data-inlined-from', l.href);
              s.textContent = css;
              if (l.parentNode) {
                l.parentNode.replaceChild(s, l);
              }
            }
          }
        } catch(e) {}
      }

      // 2. Absolutize images
      var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
      for (var j = 0; j < imgs.length; j++) {
        if (imgs[j].src) imgs[j].src = imgs[j].src;
      }

      // 3. Clone and strip scripts to freeze the DOM safely for offline view
      var clone = document.documentElement.cloneNode(true);
      var scripts = Array.prototype.slice.call(clone.querySelectorAll('script, noscript, iframe, object, embed'));
      for (var k = 0; k < scripts.length; k++) {
        scripts[k].remove();
      }

      var head = clone.querySelector('head');
      if (head && !head.querySelector('base')) {
        var base = document.createElement('base');
        base.href = window.location.href;
        head.insertBefore(base, head.firstChild);
      }

      var html = '<!DOCTYPE html>\\n' + clone.outerHTML;
      var title = document.title || '';

      window.ReactNativeWebView.postMessage(JSON.stringify({
        ok: true,
        title: title,
        html: html
      }));
    } catch(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        ok: false,
        reason: String(e)
      }));
    }
  }

  setTimeout(captureCompletePage, 3500);

  if (document.readyState === 'complete') {
    setTimeout(captureCompletePage, 2500);
  } else {
    window.addEventListener('load', function() {
      setTimeout(captureCompletePage, 2500);
    });
  }
})();
true;
`;

export default function HeadlessPagePreloader({
  url,
  onResult,
  onError,
  timeoutMs = 15000,
}: Props) {
  const settled = useRef(false);

  function settle(fn: () => void) {
    if (settled.current) return;
    settled.current = true;
    fn();
  }

  useEffect(() => {
    settled.current = false;
    const timer = setTimeout(() => {
      settle(() => onError('page preload timed out'));
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [url, timeoutMs]);

  function handleMessage(event: WebViewMessageEvent) {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as
        | { ok: true; title: string; html: string }
        | { ok: false; reason: string };

      if (payload.ok) {
        settle(() => onResult(payload.html, payload.title));
      } else {
        settle(() => onError(`preload failed: ${payload.reason}`));
      }
    } catch (e) {
      settle(() => onError(`preload parse error: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  return (
    <WebView
      style={styles.hidden}
      source={{ uri: url }}
      injectedJavaScript={PRELOAD_JS}
      onMessage={handleMessage}
      onError={(e) => settle(() => onError(`webview error: ${e.nativeEvent.description}`))}
      onHttpError={(e) => settle(() => onError(`webview HTTP ${e.nativeEvent.statusCode}`))}
      javaScriptEnabled
      domStorageEnabled
      mixedContentMode="always"
      userAgent="Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    />
  );
}

const styles = StyleSheet.create({
  hidden: { width: 0, height: 0, opacity: 0, position: 'absolute' },
});
