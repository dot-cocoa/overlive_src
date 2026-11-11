// 再生中の曲のカード（2026-11-02）。/obs/events?np=1 から曲名・チャンネル・サムネイルを受け取る。
// FIT：自分の画面の小さな窓（窓いっぱい）／それ以外：配信用（画面全体 2560x1080 基準で場所と大きさを計算。nowplaying_main.js の lookGeom と同じ）
'use strict';
const q = new URLSearchParams(location.search);
const FIT = q.has('fit');
const card = document.getElementById('card');
let look = { pos: 'rm', dx: 0, dy: 0, size: 100, opacity: 70 }, on = true, track = null, hideTimer = null;
function layout() {
  const W = innerWidth, H = innerHeight;
  if (FIT) { const k = Math.min(W / 440, H / 112); card.style.transform = ''; card.style.scale = k; card.style.left = (W - 440 * k) + 'px'; card.style.top = '0px'; return; }
  const k = H / 1080, s = look.size / 100, sc = k * s;
  card.style.scale = sc;
  const right = look.pos === 'lm' ? null : 2532 + look.dx, left = look.pos === 'lm' ? 40 + look.dx : null, top = (look.pos === 'lm' ? 700 : 690) + look.dy;
  card.style.left = (right != null ? W - (2560 - right) * k - 440 * sc : left * k) + 'px';
  card.style.top = (top * k) + 'px';
}
function applyLook(L) { if (L) look = { ...look, ...L }; card.style.setProperty('--a', Math.max(0, Math.min(.95, look.opacity / 100))); layout(); }
addEventListener('resize', layout); applyLook();
const titleEl = document.getElementById('title'), artistEl = document.getElementById('artist'), jk = document.getElementById('jk');
function render() {
  clearTimeout(hideTimer);
  if (!on || !track || !track.title) { card.classList.remove('show'); return; }
  if (titleEl.textContent !== track.title) {
    titleEl.textContent = track.title; titleEl.classList.remove('scroll');
    requestAnimationFrame(() => {   // 長い曲名はゆっくり流す
      const over = titleEl.scrollWidth - 60 - document.getElementById('tw').clientWidth;
      if (over > 0) { titleEl.style.setProperty('--w', (over + 20) + 'px'); titleEl.style.setProperty('--d', Math.max(8, over / 25 + 6) + 's'); titleEl.classList.add('scroll'); }
    });
  }
  artistEl.textContent = track.artist || track.album || '';
  if (track.thumb) { let img = jk.querySelector('img'); if (!img) { img = document.createElement('img'); jk.appendChild(img); } if (img.src !== track.thumb) img.src = track.thumb; jk.querySelector('.note').style.display = 'none'; }
  else if (track.thumb === null) { const img = jk.querySelector('img'); if (img) img.remove(); jk.querySelector('.note').style.display = ''; }
  card.classList.add('show');
  card.classList.toggle('paused', !track.playing);
  if (!track.playing) hideTimer = setTimeout(() => card.classList.remove('show'), 15000);   // 一時停止したまま 15 秒で隠す
}
function connect() {
  const es = new EventSource('/obs/events?np=1');
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.look) applyLook(m.look);
    if ('on' in m) on = m.on !== false;
    if ('track' in m) {
      const t = m.track;
      if (t && track && t.title === track.title && t.thumb == null && track.thumb && !m.test) t.thumb = track.thumb;   // 同じ曲ならサムネイルは前のまま
      track = t;
    }
    render();
  };
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}
connect();
