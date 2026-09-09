import { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, Linking, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as IntentLauncher from 'expo-intent-launcher';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import type { Bookmark } from '../types';
import { useTheme } from '../theme/ThemeContext';
import { updateBundleFromHtml } from '../services/linkBundle';
interface Props {
  bookmark: Bookmark;
  onBack: () => void;
  onOpenTweet: (id: number) => void;
}

interface Preview {
  cleanUri?: string;
  frozenUri: string;
  indexUri: string;
  mode: 'reader' | 'web';
  title: string;
  domain: string;
  url: string;
}

/**
 * Offline viewer. Tweets render as X-styled cards with a native action bar
 * (Copy caption, Open in X, Open in browser). Taps on page links open the
 * saved offline bundle, quote cards open the quoted post. Swipe right
 * anywhere goes back (preview first, then the list). No network leaves the
 * device — non-bundled links are blocked.
 */
export default function DetailScreen({ bookmark, onBack, onOpenTweet }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [webFallback, setWebFallback] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const isTweet = bookmark.type === 'tweet';

  const previewRef = useRef<Preview | null>(null);
  previewRef.current = preview;
  const isZoomedRef = useRef(false);
  isZoomedRef.current = isZoomed;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const mainWebviewRef = useRef<WebView>(null);
  const previewWebviewRef = useRef<WebView>(null);
  function goBack() {
    if (previewRef.current) setPreview(null);
    else onBackRef.current();
  }

  // System back (edge swipe / back key) walks zoom -> preview -> post -> home
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isZoomedRef.current) {
        setIsZoomed(false);
        const script = 'window.closeZoom ? window.closeZoom() : null; true;';
        mainWebviewRef.current?.injectJavaScript(script);
        previewWebviewRef.current?.injectJavaScript(script);
        return true;
      }
      if (previewRef.current) {
        setPreview(null);
        return true;
      }
      onBackRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        // Never intercept touch if image is zoomed
        if (isZoomedRef.current) return false;
        // Only allow back navigation if gesture started at the screen's left edge (<= 40px)
        const isLeftEdge = g.x0 <= 40;
        const isRightward = g.dx > 35 && Math.abs(g.dx) > Math.abs(g.dy) * 2;
        return isLeftEdge && isRightward;
      },
      onPanResponderRelease: (_, g) => {
        if (!isZoomedRef.current && g.x0 <= 40 && g.dx > 100) {
          goBack();
        }
      },
    }),
  ).current;
  async function copyCaption() {
    try {
      await Clipboard.setStringAsync(bookmark.caption || bookmark.title);
      showToast('Copied to clipboard');
    } catch {
      showToast('Copy failed');
    }
  }

  async function openInX() {
    try {
      await Linking.openURL(bookmark.url);
    } catch {
      showToast('Cannot open X app');
    }
  }

  async function openUrlInBrowser(targetUrl: string) {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: targetUrl,
        packageName: 'com.android.chrome',
        className: 'com.google.android.apps.chrome.Main',
      });
    } catch {
      Linking.openURL(targetUrl).catch(() => showToast('Cannot open browser'));
    }
  }

  async function openInBrowser() {
    await openUrlInBrowser(bookmark.url);
  }

  function showToast(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 1500);
  }
  function handleMessage(event: WebViewMessageEvent) {
    const data = event.nativeEvent.data;
    if (data.startsWith('open-tweet:')) {
      const id = Number(data.slice('open-tweet:'.length));
      if (Number.isInteger(id)) onOpenTweet(id);
    } else if (data.startsWith('{')) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ZOOM_OPEN') {
          setIsZoomed(true);
        } else if (msg.type === 'ZOOM_CLOSE') {
          setIsZoomed(false);
        } else if (msg.type === 'UPDATE_SNAPSHOT' && msg.html && previewRef.current) {
          const cur = previewRef.current;
          updateBundleFromHtml(cur.frozenUri, cur.url, msg.html).then((res) => {
            if (res.cleanUri) {
              setPreview((p) => (p ? { ...p, cleanUri: res.cleanUri, frozenUri: res.frozenUri || p.frozenUri } : null));
              showToast('Offline copy updated');
            }
          });
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  /** Route taps on bundled links to the offline preview; block the rest. */
  function intercept(request: WebViewNavigation): boolean {
    const url = request.url;
    if (!url.startsWith('http')) return true;
    const link = bookmark.links.find((l) => l.resolved === url);
    if (link && link.kind === 'page') {
      const base = link.bundleUri ? link.bundleUri.replace(/\/+$/, '') : '';
      const clean = link.cleanUri ? link.cleanUri.replace(/\/+$/, '') : (base ? `${base}/clean.html` : undefined);
      const frozen = base ? `${base}/frozen.html` : '';
      const index = base ? `${base}/index.html` : '';
      setWebFallback(false);
      setPreview({
        cleanUri: clean,
        frozenUri: frozen,
        indexUri: index,
        mode: clean ? 'reader' : 'web',
        title: link.title || link.domain,
        domain: link.domain,
        url: link.resolved,
      });
      return false;
    }
    return false;
  }

  const zoomMonitorJs = `
    (function() {
      function notify(open) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: open ? 'ZOOM_OPEN' : 'ZOOM_CLOSE'
          }));
        } catch(e) {}
      }
      function watchOverlay() {
        var ov = document.getElementById('zoomov');
        if (ov) {
          var obs = new MutationObserver(function() {
            notify(ov.classList.contains('open'));
          });
          obs.observe(ov, { attributes: true, attributeFilter: ['class'] });
        } else {
          setTimeout(watchOverlay, 200);
        }
      }
      watchOverlay();
      var oz = window.zoomImg;
      window.zoomImg = function(s) {
        notify(true);
        if (oz) oz(s);
      };
      var oc = window.closeZoom;
      window.closeZoom = function() {
        notify(false);
        if (oc) oc();
      };
    })();
    true;
  `;

  const themeScript = isDark
    ? `(function(){document.body.classList.remove('light-theme');})();true;\n${zoomMonitorJs}`
    : `(function(){
        document.body.classList.add('light-theme');
        var s = document.createElement('style');
        s.innerHTML = 'body,html{background:#fff!important;color:#0f1419!important}.name,h1,h2,h3,.caption,.card-title{color:#0f1419!important}.handle,.meta,.src,.card-domain{color:#536471!important}.card,.tpart,.media,.carousel{border-color:#eff3f4!important}.card{background:#f7f9f9!important}pre,code,.avatar{background:#e1e8ed!important;color:#0f1419!important}';
        document.head.appendChild(s);
      })();true;\n${zoomMonitorJs}`;
  const isOnlineWeb = preview?.mode === 'web' && !webFallback;
  const activePreviewSource =
    preview?.mode === 'reader'
      ? { uri: preview.cleanUri || preview.frozenUri || preview.indexUri || '' }
      : isOnlineWeb
        ? { uri: preview.url }
        : { uri: preview?.frozenUri || preview?.indexUri || preview?.cleanUri || '' };

  const webviewInjectedJs = isOnlineWeb
    ? `
      (function() {
        async function captureAndInline() {
          try {
            // 1. Inline all external stylesheets
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
                    if (l.parentNode) l.parentNode.replaceChild(s, l);
                  }
                }
              } catch(e) {}
            }

            // 2. Absolutize images
            var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
            for (var j = 0; j < imgs.length; j++) {
              if (imgs[j].src) imgs[j].src = imgs[j].src;
            }

            // 3. Clone and strip scripts
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

            var finalHtml = '<!DOCTYPE html>\\n' + clone.outerHTML;
            if (finalHtml.length > 1000) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'UPDATE_SNAPSHOT',
                html: finalHtml
              }));
            }
          } catch(err) {}
        }
        setTimeout(captureAndInline, 3000);
      })();
      true;
    `
    : themeScript;
  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]} {...pan.panHandlers}>
      {preview ? (
        <View style={[styles.previewBar, { backgroundColor: colors.barBg, borderBottomColor: colors.border, paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={() => setPreview(null)} style={styles.previewBackBtn}>
            <Text style={[styles.previewBackText, { color: colors.accent }]}>← Back</Text>
          </TouchableOpacity>

          <View style={[styles.previewDomainPill, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="lock" size={11} color={colors.sub} style={{ marginRight: 4 }} />
            <Text style={[styles.previewDomainText, { color: colors.sub }]} numberOfLines={1}>
              {preview.domain}
            </Text>
          </View>

          <View style={styles.previewRightActions}>
            {preview.cleanUri ? (
              <View style={[styles.modeToggleContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TouchableOpacity
                  style={[styles.modeToggleBtn, preview.mode === 'reader' && { backgroundColor: colors.accent }]}
                  onPress={() => {
                    setWebFallback(false);
                    setPreview((p) => (p ? { ...p, mode: 'reader' } : null));
                  }}
                >
                  <Text style={[styles.modeToggleText, { color: preview.mode === 'reader' ? '#fff' : colors.sub }]}>
                    Reader
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modeToggleBtn, preview.mode === 'web' && { backgroundColor: colors.accent }]}
                  onPress={() => {
                    setWebFallback(false);
                    setPreview((p) => (p ? { ...p, mode: 'web' } : null));
                  }}
                >
                  <Text style={[styles.modeToggleText, { color: preview.mode === 'web' ? '#fff' : colors.sub }]}>
                    Web
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.openExternalBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => openUrlInBrowser(preview.url)}
            >
              <Text style={[styles.openExternalText, { color: colors.text }]}>↗</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity onPress={onBack} style={[styles.back, { paddingTop: insets.top + 8 }]}>
          <Text style={[styles.backText, { color: colors.accent }]}>← Back</Text>
        </TouchableOpacity>
      )}

      {preview ? (
        <WebView
          ref={previewWebviewRef}
          key={`${preview.mode}_${webFallback ? 'index' : isOnlineWeb ? 'online' : 'frozen'}`}
          originWhitelist={['*']}
          source={activePreviewSource}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          allowingReadAccessToURL={preview.cleanUri || preview.frozenUri || preview.indexUri || undefined}
          javaScriptEnabled
          domStorageEnabled={true}
          injectedJavaScript={webviewInjectedJs}
          onMessage={handleMessage}
          onShouldStartLoadWithRequest={intercept}
          onError={() => {
            if (preview.mode === 'web' && !webFallback) {
              setWebFallback(true);
              showToast('Loaded offline snapshot');
            } else if (preview.mode === 'web' && preview.cleanUri) {
              setPreview((p) => (p ? { ...p, mode: 'reader' } : null));
            }
          }}
          renderError={(_, __, errorDesc) => (
            <View style={[styles.offlineErrorContainer, { backgroundColor: colors.bg }]}>
              <Feather name="file-text" size={42} color={colors.sub} style={{ marginBottom: 12 }} />
              <Text style={[styles.offlineErrorTitle, { color: colors.text }]}>Offline Page Not Cached</Text>
              <Text style={[styles.offlineErrorSub, { color: colors.sub }]}>
                This page link was not saved offline or its bundle is missing ({errorDesc}).
              </Text>
              <TouchableOpacity
                style={[styles.offlineErrorBtn, { backgroundColor: colors.accent }]}
                onPress={() => openUrlInBrowser(preview.url)}
              >
                <Text style={styles.offlineErrorBtnText}>Open Live Page in Browser</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      ) : (
        <WebView
          ref={mainWebviewRef}
          style={[styles.web, { backgroundColor: colors.bg }]}
          originWhitelist={['*']}
          source={{ html: bookmark.html_content }}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          javaScriptEnabled
          domStorageEnabled={false}
          injectedJavaScript={themeScript}
          onMessage={handleMessage}
          onShouldStartLoadWithRequest={intercept}
        />
      )}
      {isTweet && !preview ? (
        <View style={[styles.bar, { backgroundColor: colors.barBg, borderTopColor: colors.border, paddingBottom: insets.bottom + 16 }]}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.accent }]} onPress={copyCaption}>
            <Text style={styles.copyText}>Copy</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.outlineBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={openInX}
          >
            <View style={styles.openxRow}>
              <Text style={[styles.btnText, { color: colors.text }]}>Open in</Text>
              <Image source={require('../../assets/x-logo.png')} style={styles.xlogo} tintColor={colors.text} />
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.outlineBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={openInBrowser}
          >
            <Text style={[styles.btnText, { color: colors.text }]}>Browser</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 100 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  back: { paddingHorizontal: 16, paddingBottom: 8 },
  backText: { fontSize: 16, color: '#1d9bf0' },
  previewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  previewBackBtn: {
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  previewBackText: {
    fontSize: 14,
    fontWeight: '700',
  },
  previewDomainPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    maxWidth: 130,
  },
  previewDomainText: {
    fontSize: 11,
    fontWeight: '600',
  },
  previewRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  modeToggleContainer: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
  },
  modeToggleBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  modeToggleText: {
    fontSize: 11,
    fontWeight: '700',
  },
  openExternalBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  openExternalText: {
    fontSize: 13,
    fontWeight: '700',
  },
  offlineErrorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  offlineErrorIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  offlineErrorTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  offlineErrorSub: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  offlineErrorBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offlineErrorBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  web: { flex: 1 },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 12, borderTopWidth: 1 },
  btn: { flex: 1, borderRadius: 9999, paddingVertical: 11, alignItems: 'center', justifyContent: 'center' },
  outlineBtn: { borderWidth: 1 },
  copyText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  btnText: { fontSize: 14, fontWeight: '700' },
  openxRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  xlogo: { width: 14, height: 14 },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: '#333639',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  toastText: { color: '#fff', fontSize: 14 },
});
