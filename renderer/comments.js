// コメント欄（2026-10-30 試作）。コメントがないときは右上の「LIVE ◯人」だけ出して、来たらそこから開く。/obs/events?comments=1 からコメントを受け取って最新3件を出す
'use strict';
const q = new URLSearchParams(location.search);
const FIT = q.has('fit');           // 自分の画面の小さな窓（窓いっぱいに描く）
const wrap = document.getElementById('wrap');
const rowsEl = document.getElementById('rows');
// 2026-10-31：見た目はメニューで変えられる（場所・大きさ・背景の濃さ・表示時間・件数）。値は SSE の look で届く。計算は comments_main.js の lookGeom と同じ
let look = { pos: 'tr', dx: 0, dy: 0, size: 100, opacity: 24, life: 25, max: 3 };
if (q.get('life')) look.life = +q.get('life');
const ROW = 74;
let MAX = 3, LIFE = 25000;
function geom() {
  const s = 0.76 * look.size / 100, e = (look.max - 3) * ROW, hd = 342 + e;
  const right = look.pos === 'lm' ? null : 2532 + look.dx, left = look.pos === 'lm' ? 40 + look.dx : null, top = (look.pos === 'lm' ? 300 : 290) + look.dy;
  return { s, e, hd, right, left, top };
}
function shape(e) {
  // 件数に合わせて枠の下のふちを伸び縮みさせる（デザイン上の座標で e だけ下へ）
  const o = `M2046,330 L2484,330 L2512,358 L2512,${642 + e} L2496,${660 + e} L2070,${660 + e} L2046,${636 + e} Z`;
  document.querySelectorAll('path.outer').forEach(p => p.setAttribute('d', o));
  document.getElementById('p-inner').setAttribute('d', `M2052,336 L2481,336 L2506,361 L2506,${639 + e} L2493,${654 + e} L2073,${654 + e} L2052,${633 + e} Z`);
  const fr = document.getElementById('frame'), hd = 342 + e;
  fr.setAttribute('height', hd); fr.setAttribute('viewBox', `2040 324 478 ${hd}`);
  for (const el of [wrap, document.getElementById('panel')]) el.style.height = hd + 'px';
  rowsEl.style.height = (246 + e) + 'px';
  let t = ''; for (let x = 2090; x < 2470; x += 8) t += `<line x1="${x}" y1="${654 + e}" x2="${x}" y2="${(x % 40 === 10 ? 646 : 650) + e}"/>`;
  document.getElementById('ticks').innerHTML = t;
}
function layout() {
  const W = innerWidth, H = innerHeight, g = geom();
  if (FIT) {   // 自分の画面の窓は、main 側で枠ぴったりの大きさに作ってある
    const k = Math.min(W / 478, H / g.hd);
    wrap.style.transform = `scale(${k})`; wrap.style.left = (W - 478 * k) + 'px'; wrap.style.top = '0px';
  } else {
    const k = H / 1080, sc = k * g.s;
    wrap.style.transform = `scale(${sc})`;
    wrap.style.left = (g.right != null ? W - (2560 - g.right) * k - 478 * sc : g.left * k) + 'px';
    wrap.style.top = (g.top * k) + 'px';
  }
}
function applyLook(L) {
  if (L) look = { ...look, ...L };
  MAX = look.max; LIFE = look.life * 1000;
  const a = Math.max(0, Math.min(.85, look.opacity / 100));
  document.getElementById('b0').setAttribute('stop-opacity', a); document.getElementById('b1').setAttribute('stop-opacity', a);
  shape(geom().e); layout();
  while (rowsEl.children.length > MAX) rowsEl.firstElementChild.remove();
}
addEventListener('resize', layout); applyLook();

const ICON = {
  youtube: '<svg class="ic" viewBox="-13 -10 26 20"><rect x="-13" y="-9" width="26" height="18" rx="5" fill="#ff3b3b"/><path d="M-4,-5 L6,0 L-4,5 Z" fill="#fff"/></svg>',
  tiktok: '<svg class="ic" viewBox="-13 -12 26 24"><circle r="12" fill="#111"/><g fill="none" stroke-width="2.4"><path d="M-2,-7 v10 a3.4,3.4 0 1 1 -3,-3.4" stroke="#25f4ee"/><path d="M0,-7 v10 a3.4,3.4 0 1 1 -3,-3.4" stroke="#fe2c55"/><path d="M-1,-7 v10 a3.4,3.4 0 1 1 -3,-3.4 M-1,-7 q2,5 6,5" stroke="#fff"/></g></svg>',
  twitch: '<svg class="ic" viewBox="-11 -11 22 23"><path d="M-10,-10 h20 v13 l-6,6 h-5 l-3,3 v-3 h-6 Z" fill="#9146ff"/><rect x="-2" y="-6" width="2.4" height="6" fill="#fff"/><rect x="3" y="-6" width="2.4" height="6" fill="#fff"/></svg>',
};
const other = '<svg class="ic" viewBox="-10 -10 20 20"><circle r="7" fill="#9fe6ff"/></svg>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function add(c) {
  const el = document.createElement('div');
  el.className = 'row' + (c.gift ? ' gift' : '');
  el.innerHTML = (ICON[c.service] || other) + `<div class="nm">${esc(c.name || '')}</div><div class="tx">${esc(c.text || '')}</div>` + (c.gift ? `<div class="gf">🎁 ${esc(c.giftText || 'ギフト')} ありがとう！</div>` : '');
  rowsEl.appendChild(el);
  while (rowsEl.children.length > MAX) rowsEl.firstElementChild.remove();
  // はみ出したら古いものから消す
  while (rowsEl.children.length > 1 && rowsEl.scrollHeight > rowsEl.clientHeight + 1) rowsEl.firstElementChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); check(); }, 700); }, LIFE);
  open();
}
// コメントがなくなったら右上の「LIVE ◯人」にしまう（消さない）。コメント表示が OFF のときだけ全部消す
let closeTimer = null;
function check() { if (!rowsEl.children.length) { clearTimeout(closeTimer); closeTimer = setTimeout(() => { if (!rowsEl.children.length) wrap.classList.remove('open'); }, 400); } }
function open() { clearTimeout(closeTimer); wrap.classList.add('show', 'open'); }
function viewers(n) {
  const s = (typeof n === 'number' && n >= 0) ? ` ${n.toLocaleString('ja-JP')}人` : '';
  document.getElementById('pillcnt').textContent = s;
  document.getElementById('livecnt').textContent = 'LIVE' + s;
}
function connect() {
  const es = new EventSource('/obs/events?comments=1');
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.look) applyLook(m.look);
    if (m.hello) { if (m.on === false) wrap.classList.remove('show'); else wrap.classList.add('show'); viewers(m.viewers); }
    if (m.hello && Array.isArray(m.recent)) m.recent.forEach(add);
    if ('viewers' in m && !m.hello) viewers(m.viewers);
    if (m.commentsOn) wrap.classList.add('show');
    if (Array.isArray(m.comments)) m.comments.forEach(add);
    if (m.commentsOff) { rowsEl.innerHTML = ''; wrap.classList.remove('open', 'show'); }
  };
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}
connect();
