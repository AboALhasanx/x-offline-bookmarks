/** Shared HTML helpers: escaping, reader template, image lightbox. */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
export const THEME_CSS = [
  ':root {',
  '  --bg: #000000;',
  '  --text: #e7e9ea;',
  '  --sub: #71767b;',
  '  --border: #2f3336;',
  '  --card: #16181c;',
  '  --link: #1d9bf0;',
  '  --avatar-bg: #333639;',
  '  --quote-bg: #121212;',
  '}',
  'body.light-theme {',
  '  --bg: #ffffff;',
  '  --text: #0f1419;',
  '  --sub: #536471;',
  '  --border: #eff3f4;',
  '  --card: #f7f9f9;',
  '  --link: #1d9bf0;',
  '  --avatar-bg: #e1e8ed;',
  '  --quote-bg: #f7f9f9;',
  '}',
].join('\n');

export const ZOOM_CSS = [
  '.zoomov{position:fixed;inset:0;background:rgba(0,0,0,.96);display:none;align-items:center;justify-content:center;z-index:99}',
  '.zoomov.open{display:flex}',
  '.zoomov img{max-width:100vw;max-height:100vh;touch-action:none}',
  '.zoomclose{position:fixed;top:12px;right:16px;color:#fff;font-size:30px;z-index:100;padding:12px}',
].join('\n');

export const CAROUSEL_CSS = [
  '.carousel{position:relative;margin:12px -16px;background:var(--bg,#000);border-top:1px solid var(--border,#2f3336);border-bottom:1px solid var(--border,#2f3336);overflow:hidden}',
  '.tpart .carousel{margin:12px 0;border:1px solid var(--border,#2f3336);border-radius:12px}',
  '.carousel-track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
  '.carousel-track::-webkit-scrollbar{display:none}',
  '.carousel-slide{flex:0 0 100%;width:100%;scroll-snap-align:start;scroll-snap-stop:always;display:flex;align-items:center;justify-content:center;background:#000;position:relative}',
  '.carousel-slide img{width:100%;height:auto;max-height:480px;object-fit:contain;display:block}',
  '.carousel-slide video{width:100%;max-height:480px;display:block;background:#000}',
  '.carousel-badge{position:absolute;top:12px;right:12px;background:rgba(0,0,0,.72);color:#fff;font-size:12px;font-weight:700;padding:4px 8px;border-radius:9999px;pointer-events:none;backdrop-filter:blur(4px);z-index:5}',
  '.carousel-dots{position:absolute;bottom:8px;left:0;right:0;display:flex;justify-content:center;gap:6px;pointer-events:none;z-index:5}',
  '.carousel-dots .dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.45);transition:all .2s ease}',
  '.carousel-dots .dot.active{width:16px;border-radius:4px;background:#1d9bf0}',
].join('\n');

export const CAROUSEL_SCRIPT = [
  '<script>',
  '(function(){',
  'function initCarousels(){',
  "var carousels=document.querySelectorAll('.carousel');",
  'carousels.forEach(function(c){',
  "var track=c.querySelector('.carousel-track');",
  "var badge=c.querySelector('.carousel-badge .cur');",
  "var dots=c.querySelectorAll('.carousel-dots .dot');",
  'if(!track)return;',
  "track.addEventListener('scroll',function(){",
  'var w=track.offsetWidth||1;',
  'var idx=Math.round(track.scrollLeft/w);',
  'if(badge)badge.innerText=idx+1;',
  'dots.forEach(function(d,i){',
  "if(i===idx)d.classList.add('active');",
  "else d.classList.remove('active');",
  '});',
  '},{passive:true});',
  '});',
  '}',
  "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',initCarousels);}",
  'else{initCarousels();}',
  '})();',
  '</scr' + 'ipt>',
].join('\n');

const ZOOM_DIV =
  '<div class="zoomov" id="zoomov"><span class="zoomclose" onclick="closeZoom()">&#215;</span><img id="zoomimg" /></div>';

const ZOOM_SCRIPT = [
  '<script>',
  '(function(){',
  'var scale=1,tx=0,ty=0,lastD=0;',
  'var pts=new Map();',
  "var img=document.getElementById('zoomimg');",
  "function apply(){img.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')';}",
  "window.zoomImg=function(src){img.src=src;scale=1;tx=0;ty=0;apply();document.getElementById('zoomov').classList.add('open');};",
  "window.closeZoom=function(){document.getElementById('zoomov').classList.remove('open');};",
  "document.getElementById('zoomov').addEventListener('click',function(e){if(e.target.id==='zoomov')closeZoom();});",
  "img.addEventListener('pointerdown',function(e){try{img.setPointerCapture(e.pointerId);}catch(_){}pts.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pts.size===2){var p=Array.from(pts.values());lastD=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);}});",
  "img.addEventListener('pointermove',function(e){if(!pts.has(e.pointerId))return;var pr=pts.get(e.pointerId);var dx=e.clientX-pr.x,dy=e.clientY-pr.y;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pts.size===1){if(scale>1){tx+=dx;ty+=dy;apply();}}else if(pts.size===2){var p=Array.from(pts.values());var d=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);if(lastD>0){scale=Math.min(4,Math.max(1,scale*d/lastD));if(scale===1){tx=0;ty=0;}apply();}lastD=d;}});",
  'function up(e){pts.delete(e.pointerId);lastD=0;}',
  "img.addEventListener('pointerup',up);img.addEventListener('pointercancel',up);",
  '})();',
  '</scr' + 'ipt>',
].join('\n');

export const ZOOM_HTML = ZOOM_DIV + '\n' + ZOOM_SCRIPT;

/** Reader styling for saved articles and cleaned link bundles. */
export function styleArticle(title: string, html: string, sourceUrl?: string): string {
  const zoomable = html.replace(/<img(?=\s|>)/g, '<img onclick="zoomImg(this.src)"');
  const sourceBadge = sourceUrl
    ? `<div class="doc-source"><span class="doc-badge">Offline Reader</span><span class="doc-url">${escapeHtml(sourceUrl)}</span></div>`
    : '';
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${THEME_CSS}
body{background:var(--bg,#000);color:var(--text,#e7e9ea);font-family:-apple-system,Roboto,Helvetica,Arial,sans-serif;margin:0 auto;max-width:800px;padding:16px 20px 56px;line-height:1.7;font-size:16px}
h1{font-size:24px;line-height:1.3;color:var(--text,#e7e9ea);margin:16px 0 12px}
h2{font-size:20px;color:var(--text,#e7e9ea);margin:20px 0 10px;border-bottom:1px solid var(--border,#2f3336);padding-bottom:6px}
h3{font-size:17px;color:var(--text,#e7e9ea);margin:16px 0 8px}
.doc-source{display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border,#2f3336);font-size:12px;color:var(--sub,#71767b);overflow:hidden}
.doc-badge{background:var(--link,#1d9bf0);color:#fff;font-weight:700;padding:2px 8px;border-radius:9999px;font-size:11px;flex-shrink:0}
.doc-url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
img{max-width:100%;height:auto;border-radius:12px;margin:12px 0}
a{color:var(--link,#1d9bf0);text-decoration:none}
pre{background:var(--card,#16181c);color:var(--text,#e7e9ea);border:1px solid var(--border,#2f3336);border-radius:10px;padding:14px 16px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13.5px;line-height:1.55;margin:16px 0;-webkit-overflow-scrolling:touch}
pre code{background:transparent!important;border:none!important;padding:0!important;font-size:inherit;color:inherit;white-space:pre}
code{background:var(--card,#16181c);color:var(--link,#1d9bf0);border:1px solid var(--border,#2f3336);border-radius:6px;padding:2px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.88em}
blockquote{border-left:3px solid var(--link,#1d9bf0);margin:16px 0;padding:6px 16px;color:var(--sub,#71767b);background:var(--card,#16181c);border-radius:0 8px 8px 0}
table{width:100%;border-collapse:collapse;margin:18px 0;font-size:14.5px;display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
th,td{border:1px solid var(--border,#2f3336);padding:8px 12px;text-align:left}
th{background:var(--card,#16181c);font-weight:700;color:var(--text,#e7e9ea)}
tr:nth-child(even) td{background:rgba(128,128,128,.04)}
ul,ol{padding-left:22px;margin:12px 0}
li{margin-bottom:6px}
hr{border:none;border-top:1px solid var(--border,#2f3336);margin:24px 0}
figure{margin:16px 0}
${ZOOM_CSS}
</style></head><body>${sourceBadge}<h1>${escapeHtml(title)}</h1>${zoomable}${ZOOM_HTML}</body></html>`;
}
