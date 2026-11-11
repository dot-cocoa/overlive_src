// キャラの窓（2026-10-30 試作）：HUD と同じ状態（/obs/events）を受け取り、表情に合わせてデフォルメの絵を切り替える。
// TikTok LIVE Studio などのウィンドウキャプチャで取り込む用（縦配信の左上のキャラ）
'use strict';
const q = new URLSearchParams(location.search);
const CHARA = q.get('c') || 'elena';
if (q.get('bg')) document.documentElement.style.setProperty('--bg', '#' + q.get('bg').replace(/[^0-9a-f]/gi, ''));
const KEYS = ['normal', 'hit', 'shield_break', 'hp_low', 'healing', 'full_heal', 'kill', 'knockdown', 'champion'];
const box = document.getElementById('c');
const imgs = {};
for (const k of KEYS) { const im = new Image(); im.src = `../assets/chibi/${CHARA}/${k}.png`; im.alt = ''; box.appendChild(im); imgs[k] = im; }
const M = window.HudModel;
const state = M.initialState();
let cur = null, championUntil = 0, championAt = -1e9;
const MOVE = { hit: 'shake', shield_break: 'jump', kill: 'jump', full_heal: 'pop', champion: 'jump', knockdown: 'dizzy' };
function show(k) {
  if (k === cur) return;
  if (cur) imgs[cur].classList.remove('on');
  imgs[k].classList.add('on');
  cur = k;
  const mv = MOVE[k] || 'pop';
  box.className = ''; void box.offsetWidth; box.className = mv;
  if (mv !== 'dizzy') setTimeout(() => { if (cur === k) box.className = (k === 'knockdown') ? 'dizzy' : 'idle'; }, 650);
}
function update() {
  const now = performance.now();
  let k = M.derive(state, now).expression;
  if (now < championUntil) k = 'champion';
  show(imgs[k] ? k : 'normal');
}
function onMsg(msg) {
  const now = performance.now();
  if (msg.patch) M.applyPatch(state, msg.patch, now, { silent: !!msg.silent });
  // 優勝のポーズは次の試合で HUD がまた出るまで続ける（リザルト・ロビーの間もドヤ顔）。最長 20 分
  if (msg.patch && msg.patch.hudHidden === false && now - championAt > 10000) championUntil = 0;
  if (msg.event) {
    if (msg.event === 'champion') { championAt = now; championUntil = now + 20 * 60000; }
    else M.applyEvent(state, msg.event, now, msg.arg);
  }
  update();
}
function connect() {
  const es = new EventSource('/obs/events?chara=1');
  es.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch { /* 読めない行は捨てる */ } };
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}
show('normal');
setInterval(update, 150);   // 被弾などの表情は時間で戻るので見直す
connect();
