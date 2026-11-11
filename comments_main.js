// OverLIVE：コメント表示（2026-10-30 試作）
// わんコメ（OneComme）の WebSocket（ws://127.0.0.1:11180/sub）からコメントを受け取り、
// 自分の画面のコメント欄（透明・クリック透過の小さな窓）と、配信用の窓・OBS 用ページ（/renderer/comments.html）に流す。
// ゲームには一切触らない。わんコメが起動していなければ 5 秒ごとにつなぎ直すだけ
'use strict';
const ONECOMME = { host: '127.0.0.1', port: 11180 };
// 基準 2560x1080 でのコメント欄の場所（右の真ん中・「AQUA HUD／MENU」の表示 y560〜 より上）
const PANEL = { x: 2160, y: 290, w: 372, h: 262 };
// 2026-10-31：見た目の調整（メニュー）。comments.js と同じ計算で場所・大きさを決める
//   場所：tr＝右上（初期）／lm＝左（ミニマップの下）。dx・dy は基準 2560x1080 での微調整
const LOOK_DEF = { pos: 'tr', dx: 0, dy: 0, size: 100, opacity: 24, life: 25, max: 3 };
const ROW = 74;   // コメント1件ぶんの高さ（デザイン上の px）
function lookGeom(L) {
  const s = 0.76 * L.size / 100, hd = 342 + (L.max - 3) * ROW, w = 478 * s, h = hd * s;
  const right = L.pos === 'lm' ? null : 2532 + L.dx, left = L.pos === 'lm' ? 40 + L.dx : null, top = (L.pos === 'lm' ? 300 : 290) + L.dy;
  return { s, hd, w, h, right, left, top };
}
// 読み上げ（2026-10-31）：Windows の声（speechSynthesis）で読む。読むのは見えない小さな窓の中
const SPEAK_DEF = { on: false, voice: '', volume: 80, rate: 1.1, name: false, maxLen: 40, ng: '' };

function create({ BrowserWindow, screen, path, readSettings, writeSettings, OBS_PORT, getControl, isHudOn, protect }) {
  const clients = new Set();   // comments.html の SSE
  let ws = null, connected = false, retry = null, win = null, recent = [];
  // 2026-10-30：同時視聴者数（わんコメがつないでいる配信ごとの数を足す）。わんコメが数を送ってこないときは null のまま＝「LIVE」だけ出す
  const viewerBy = new Map(); let viewers = null;
  function findViewers(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    for (const k of ['viewer', 'viewers', 'viewerCount', 'concurrentViewers', 'liveViewers', 'concurrent']) {
      const v = o[k]; if (typeof v === 'number' && isFinite(v)) return v; if (typeof v === 'string' && /^\d+$/.test(v)) return +v;
    }
    for (const v of Object.values(o)) { const r = findViewers(v, depth + 1); if (r != null) return r; }
    return null;
  }
  function onMeta(d) {
    const list = Array.isArray(d) ? d : [d];
    let changed = false;
    for (const x of list) {
      const n = findViewers(x && (x.data || x)); if (n == null) continue;
      const id = String((x && (x.id || x.connectionId || x.service)) || 'main');
      if (viewerBy.get(id) !== n) { viewerBy.set(id, n); changed = true; }
    }
    if (!changed) return;
    let sum = 0; for (const n of viewerBy.values()) sum += n;
    viewers = sum; broadcast({ viewers });
  }
  const on = () => readSettings().comments === true;
  const clamp = (v, a, b, d) => { v = +v; return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  function look() {
    const L = { ...LOOK_DEF, ...(readSettings().commentsLook || {}) };
    return { pos: L.pos === 'lm' ? 'lm' : 'tr', dx: clamp(L.dx, -800, 800, 0), dy: clamp(L.dy, -300, 600, 0), size: clamp(L.size, 50, 180, 100),
      opacity: clamp(L.opacity, 0, 85, 24), life: clamp(L.life, 5, 90, 25), max: Math.round(clamp(L.max, 1, 6, 3)) };
  }
  function speakCfg() {
    const P = { ...SPEAK_DEF, ...(readSettings().commentsSpeak || {}) };
    return { on: P.on === true, voice: String(P.voice || ''), volume: clamp(P.volume, 0, 100, 80), rate: clamp(P.rate, 0.5, 2, 1.1), name: P.name === true, maxLen: Math.round(clamp(P.maxLen, 10, 120, 40)), ng: String(P.ng || '').slice(0, 500) };
  }
  let voices = [];

  function stripHtml(s) {
    return String(s || '').replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
  }
  function pick(c) {
    const d = c.data || {};
    const gift = !!(d.hasGift || (d.price && d.price > 0));
    let giftText = '';
    if (gift) {
      const g = d.gift || {};
      const name = stripHtml(g.name || d.giftName || '');
      const count = g.count || d.giftCount || '';
      const unit = d.unit || (/youtube/i.test(String(c.service || '')) ? '¥' : '');   // わんコメのテストでは単位が来ないことがある
      giftText = name ? `${name}${count ? ' ×' + count : ''}` : (d.price ? (unit === '¥' ? `¥${d.price}` : `${d.price}${unit}`) : 'ギフト');
    }
    return { id: d.id || c.id || String(Date.now() + Math.random()), service: String(c.service || '').toLowerCase(), name: stripHtml(d.displayName || d.name || ''), text: stripHtml(d.comment || ''), gift, giftText, at: Date.now() };
  }
  function broadcast(msg) {
    const data = 'data: ' + JSON.stringify(msg) + '\n\n';
    for (const res of clients) { try { res.write(data); } catch { clients.delete(res); } }
  }
  function push(list) {
    for (const c of list) { recent.push(c); }
    recent = recent.slice(-10);
    broadcast({ comments: list });
    if (speakCfg().on && list.length) { ensureSpeaker(); speakSend({ speak: list }); }
  }
  // ---- 読み上げの窓（見えない。音だけ出す）----
  let spk = null, spkReady = false, spkQueue = [];
  function ensureSpeaker() {
    if (spk && !spk.isDestroyed()) return;
    spkReady = false;
    spk = new BrowserWindow({ show: false, width: 200, height: 100, skipTaskbar: true, title: 'OverLIVE speak',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    spk.loadFile(path.join(__dirname, 'renderer', 'speak.html'));
    spk.webContents.once('did-finish-load', () => { spkReady = true; spk.webContents.send('hud:input', { speakCfg: speakCfg() }); for (const m of spkQueue) spk.webContents.send('hud:input', m); spkQueue = []; });
    spk.on('closed', () => { spk = null; spkReady = false; });
  }
  function speakSend(m) { if (spk && !spk.isDestroyed() && spkReady) spk.webContents.send('hud:input', m); else spkQueue.push(m); }
  function setVoices(v) { if (Array.isArray(v)) { voices = v.slice(0, 40).map(String); sendState(); } }
  function setSpeak(patch) {
    writeSettings({ commentsSpeak: { ...speakCfg(), ...(patch || {}) } });
    const c = speakCfg();
    if (c.on) { ensureSpeaker(); speakSend({ speakCfg: c }); } else if (spk && !spk.isDestroyed()) { speakSend({ speakStop: true }); }
    sendState();
  }
  function speakTest() { ensureSpeaker(); speakSend({ speakCfg: speakCfg() }); speakSend({ speak: [{ name: 'テストさん', text: 'コメントの読み上げのテストです。聞こえていますか？', service: 'youtube' }], test: true }); }
  // ---- 見た目の調整 ----
  function setLook(patch) {
    writeSettings({ commentsLook: { ...look(), ...(patch || {}) } });
    broadcast({ look: look() });
    placeWin();
    sendState();
  }
  function winBounds() {
    const d = (global.__overliveDisplay ? global.__overliveDisplay() : screen.getPrimaryDisplay()), b = d.bounds, k = b.height / 1080, g = lookGeom(look());
    const x = g.right != null ? b.x + Math.round(b.width - (2560 - (g.right - g.w)) * k) : b.x + Math.round(g.left * k);
    return { x, y: b.y + Math.round(g.top * k), width: Math.max(40, Math.round(g.w * k)), height: Math.max(40, Math.round(g.h * k)) };
  }
  function placeWin() { if (win && !win.isDestroyed()) win.setBounds(winBounds()); }
  function sendState() {
    const ctl = getControl();
    if (ctl && !ctl.isDestroyed()) ctl.webContents.send('hud:input', { commentsState: state() });
  }
  function state() { return { on: on(), screen: readSettings().commentsScreen !== false, connected, url: `http://127.0.0.1:${OBS_PORT}/renderer/comments.html?full=1`, look: look(), speak: speakCfg(), voices }; }

  function connect() {
    clearTimeout(retry); retry = null;
    if (!on() || ws) return;
    if (typeof WebSocket !== 'function') return;   // 古い Electron
    try { ws = new WebSocket(`ws://${ONECOMME.host}:${ONECOMME.port}/sub`); } catch { ws = null; return later(); }
    ws.onopen = () => { connected = true; sendState(); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.type === 'comments' && m.data && Array.isArray(m.data.comments)) push(m.data.comments.map(pick).filter(c => c.text || c.gift));
      else if (m.type === 'meta' || m.type === 'metas') onMeta(m.data);
      // 'connected'（つないだときの過去のコメント）は出さない
    };
    ws.onclose = () => { ws = null; if (connected) { connected = false; sendState(); } later(); };
    ws.onerror = () => { try { ws && ws.close(); } catch { /* 閉じている */ } };
  }
  function later() { if (on() && !retry) retry = setTimeout(connect, 5000); }
  function disconnect() { clearTimeout(retry); retry = null; if (ws) { try { ws.onclose = null; ws.close(); } catch { /* なし */ } ws = null; } connected = false; }

  // 自分の画面のコメント欄（クリック透過）
  function showWin() {
    // 自分の画面に出すのは「コメントを出す」ON かつ「コメントを自分の画面にも出す」ON のとき。
    // HUD の Alt+H で消しているときは一緒に消す（HUD を「配信にだけ出す」にしているときは HUD に関係なく出す）
    const st = readSettings();
    const hudVisibleOrStreamOnly = isHudOn() || st.screenHud === false;
    if (!on() || st.commentsScreen === false || !hudVisibleOrStreamOnly) { if (win && !win.isDestroyed()) win.hide(); return; }
    if (win && !win.isDestroyed()) { win.showInactive(); return; }
    const wb = winBounds();
    win = new BrowserWindow({
      ...wb,
      transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, title: 'AQUA HUD comments',
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    if (protect) win.setContentProtection(true);
    win.loadURL(`http://127.0.0.1:${OBS_PORT}/renderer/comments.html?fit=1`);
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => { win = null; });
  }
  function hideWin() { if (win && !win.isDestroyed()) win.hide(); }

  function setOn(v) {
    writeSettings({ comments: !!v });
    if (v) { connect(); showWin(); broadcast({ commentsOn: true }); } else { disconnect(); hideWin(); viewerBy.clear(); viewers = null; broadcast({ commentsOff: true }); if (spk && !spk.isDestroyed()) speakSend({ speakStop: true }); }
    sendState();
  }
  // わんコメのテストコメント機能で1件送る（わんコメ → この仕組み → 画面、の通し確認）
  async function test() {
    const samples = [
      { platform: 'youtube', username: 'テストさん', comment: 'コメントのテストです！' },
      { platform: 'twitch', username: 'apex_love', comment: '被弾で赤くなるのいいね' },
      { platform: 'youtube', username: 'ぴよ', comment: 'スパチャのテスト♡', hasGift: true, price: 500, unit: '¥' },
    ];
    const s = samples[Math.floor(Math.random() * samples.length)];
    const body = JSON.stringify({ platform: s.platform, hasGift: !!s.hasGift, unit: s.unit || '', price: s.price || 0, giftType: s.hasGift ? 'superchat' : 'none', newComment: false, repeater: false, subscribe: false, speech: false, username: s.username, comment: s.comment });
    try {
      const r = await fetch(`http://${ONECOMME.host}:${ONECOMME.port}/api/comments/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      return r.ok ? { ok: true } : { ok: false, why: 'わんコメが受け付けませんでした' };
    } catch { return { ok: false, why: 'わんコメにつながりません（わんコメを起動してください）' }; }
  }
  // /obs/events?comments=1 と同じ形の SSE（OBS の接続数には数えない）
  function sse(req, res, head) {
    res.writeHead(200, { ...head, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    res.write('data: ' + JSON.stringify({ hello: true, on: on(), viewers, look: look(), recent: recent.filter(c => Date.now() - c.at < look().life * 1000 - 3000) }) + '\n\n');
    clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* 切れた */ } }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
  }
  function start() { if (on()) { connect(); setTimeout(showWin, 1500); } if (speakCfg().on) setTimeout(ensureSpeaker, 2000); else setTimeout(() => { ensureSpeaker(); }, 4000); }   // 声の一覧をメニューに出すため、読み上げオフでも一度だけ見えない窓を作る
  function setScreen(v) { writeSettings({ commentsScreen: !!v }); showWin(); sendState(); }
  return { start, setOn, setScreen, test, state, sse, showWin, hideWin, sendState, setLook, setSpeak, speakTest, setVoices };
}
module.exports = { create };
