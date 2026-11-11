/*
 * 画面読み取り（別スレッド）。描画スレッドを止めないよう、キャプチャ映像のフレームを
 * ここで受け取り、バーの小さな範囲だけをコピーして解析する。
 */
importScripts('reader.js', 'champion.js', 'killult.js');   // killult.js：キル・アシスト・味方のキル・ウルトの%（2026-11-02）   // champion.js：優勝の帯の読み取り（2026-10-30）
const R = self.HudReader;
let cfg = null, minInterval = 0, lastT = -1e9, diag = false;
const stats = { frames: 0, ms: new Float32Array(1024), i: 0, format: '' };

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'start') {
    cfg = m.config;
    // 2026-10-26：読み取りをやり直したとき（デモ再生・確認用ゲーム画面のあと）も、直前の並び（4段／5段）から始める
    if (m.layout === 4 || m.layout === 5) { layout = m.layout; layoutCand = m.layout; }
    minInterval = 1000 / (cfg.sampleFps || 60) * 0.9;
    const reader = m.readable.getReader();
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      const now = performance.now();
      if (now - lastT < minInterval) { frame.close(); continue; }
      lastT = now;
      try {
        const t0 = performance.now();
        const { reading, raw } = await analyzeFrame(frame);
        stats.ms[stats.i] = performance.now() - t0; stats.i = (stats.i + 1) % stats.ms.length; stats.frames++;
        if (raw) self.postMessage({ type: 'reading', reading, t: now, raw }, [raw.buffer]);
        else self.postMessage({ type: 'reading', reading, t: now });
      } catch (e) {
        self.postMessage({ type: 'error', message: String(e && e.stack || e) });
      } finally { frame.close(); }
    }
  } else if (m.type === 'chat') {
    chatOn = !!m.on; chatHash = 0;
  } else if (m.type === 'lids') {
    lidSegs = m.lids;
  } else if (m.type === 'onfoot') {
    onFoot = !!m.on;
  } else if (m.type === 'diag') {
    diag = !!m.on;
  } else if (m.type === 'stats') {
    const n = Math.min(stats.frames, stats.ms.length), a = Array.from(stats.ms.slice(0, n)).sort((x, y) => x - y);
    self.postMessage({ type: 'stats', id: m.id, stats: { frames: stats.frames, msP50: a[Math.floor(n * .5)] || 0, msP99: a[Math.floor(n * .99)] || 0, format: stats.format } });
  }
};

// ベース座標(2560x1080)の範囲 → フレーム上の範囲（偶数に揃える：YUV形式の制約）
function mapRect(r, fw, fh) {
  const k = fh / cfg.baseHeight;
  let x;
  if (r.anchor === 'right') x = fw - (cfg.baseWidth - r.x) * k;
  else if (r.anchor === 'center') x = fw / 2 + (r.x - cfg.baseWidth / 2) * k;
  else x = r.x * k;
  const y = fh - (cfg.baseHeight - r.y) * k;
  const ev = (v) => Math.max(0, Math.floor(v / 2) * 2);
  const X = ev(x), Y = ev(y);
  const W = Math.min(fw - X, Math.ceil(r.w * k / 2) * 2 + 2), H = Math.min(fh - Y, Math.ceil(r.h * k / 2) * 2 + 2);
  return { x: X, y: Y, width: W, height: H, fx: x - X, fy: y - Y, k };
}

// フレームの一部を RGBA にして取り出す（新しい Chromium は copyTo で RGBA 変換できる）
let canConvert = true;
async function copyRGBA(frame, rect) {
  const n = rect.width * rect.height * 4;
  if (canConvert) {
    try {
      const buf = new Uint8ClampedArray(n);
      await frame.copyTo(buf, { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, format: 'RGBA' });
      stats.format = frame.format + '→RGBA';
      return buf;
    } catch { canConvert = false; }
  }
  const fmt = frame.format;
  stats.format = fmt;
  const size = frame.allocationSize({ rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  const raw = new Uint8Array(size);
  const layout = await frame.copyTo(raw, { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  const out = new Uint8ClampedArray(n), W = rect.width, H = rect.height;
  if (fmt === 'RGBA' || fmt === 'RGBX' || fmt === 'BGRA' || fmt === 'BGRX') {
    const { offset, stride } = layout[0], bgr = fmt[0] === 'B';
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const s = offset + y * stride + x * 4, d = (y * W + x) * 4;
      out[d] = raw[s + (bgr ? 2 : 0)]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s + (bgr ? 0 : 2)]; out[d + 3] = 255;
    }
  } else if (fmt === 'NV12' || fmt === 'I420') {
    const Yp = layout[0], U = layout[1], V = fmt === 'I420' ? layout[2] : null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const yy = raw[Yp.offset + y * Yp.stride + x];
      let u, v;
      if (V) { u = raw[U.offset + (y >> 1) * U.stride + (x >> 1)]; v = raw[V.offset + (y >> 1) * V.stride + (x >> 1)]; }
      else { const o = U.offset + (y >> 1) * U.stride + (x >> 1) * 2; u = raw[o]; v = raw[o + 1]; }
      const c = yy - 16, dd = u - 128, e = v - 128, d = (y * W + x) * 4;   // BT.709 limited range
      out[d] = 1.164 * c + 1.793 * e; out[d + 1] = 1.164 * c - 0.213 * dd - 0.533 * e; out[d + 2] = 1.164 * c + 2.112 * dd; out[d + 3] = 255;
    }
  } else throw new Error('unsupported frame format ' + fmt);
  return out;
}

// 範囲をベース解像度（設定の w×h）に合わせて取り出し、行の配列で返す
async function regionRows(frame, r) {
  const fw = frame.displayWidth, fh = frame.displayHeight;
  const rect = mapRect(r, fw, fh);
  const px = await copyRGBA(frame, rect);
  const rows = [];
  for (let y = 0; y < r.h; y++) {
    const row = new Uint8ClampedArray(r.w * 4);
    const sy = Math.min(rect.height - 1, Math.round(rect.fy + y * rect.k));
    for (let x = 0; x < r.w; x++) {
      const sx = Math.min(rect.width - 1, Math.round(rect.fx + x * rect.k));
      const s = (sy * rect.width + sx) * 4, d = x * 4;
      row[d] = px[s]; row[d + 1] = px[s + 1]; row[d + 2] = px[s + 2]; row[d + 3] = 255;
    }
    rows.push(row);
  }
  return rows;
}

let frameN = 0;
// ウルトのアイコン：エイム中は消える。アイコンの輪郭（エッジ）を覚えておき、今の画面と似ているかで判断する
// 2026-10-25：前はアイコンの形を1つだけ覚えていて、レジェンドを替えると「似ていない」が8秒続くまで覚え直さず、その間ウルトの枠が消えていた
//   （射撃訓練場でレジェンドを替えるたび・試合ごとにレジェンドが変わるたびに数秒枠が消える）。
//   → レジェンドごとに形を覚えておき（最大24個）、どれかに似ていれば「出ている」。
//     どれにも似ていなくても、画面のその場所が1秒動かない（＝新しいレジェンドのアイコン。エイム中は景色が動く）なら新しく覚える
let ultLikeN = 0;
let onFoot = true;   // 2026-10-27：地上にいるか（hud.js から届く）。シップ・降下中はウルトの形を覚えない（降下の案内の板を覚えてしまうため）
let ultTs = [], ultBoot = [], ultPrev = null, ultStill = 0;
async function readUltIcon(frame) {
  const c = cfg.ultIcon, rows = await regionRows(frame, { anchor: 'center', x: c.x, y: c.y, w: c.w, h: c.h });
  const W = c.w >> 1, H = c.h >> 1, g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const r = rows[y * 2], i = x * 8; g[y * W + x] = 0.299 * r[i] + 0.587 * r[i + 1] + 0.114 * r[i + 2]; }
  const e = new Float32Array((W - 1) * (H - 1));
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const v = g[y * W + x]; e[y * (W - 1) + x] = Math.hypot(g[y * W + x + 1] - v, g[(y + 1) * W + x] - v); }
  const ncc = (a, b) => { let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= b.length;
    let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; } return s / Math.sqrt(sa * sb + 1e-9); };
  const learn = (list) => { const t = new Float32Array(e.length); for (let i = 0; i < e.length; i++) { const v = list.map(b => b[i]).sort((p, q) => p - q); t[i] = v[v.length >> 1]; } ultTs.push(t); if (ultTs.length > 24) ultTs.shift(); };
  // 2026-10-25：キャラを替えた直後は形を覚えていないので枠がしばらく出ず（反応が遅い）、
  //   エイム中に止まっていると背景を「アイコン」として覚えてしまい、空の枠が出ることがあった。
  //   → どのキャラでも同じ「アイコンらしさ」（輪郭がくっきり。エイム中のぼやけた景色は輪郭が弱い）で判定し、
  //     形を覚えるのはアイコンらしいときだけ。覚えた形と合えばそれも「あり」
  let wh = 0, es = 0; for (let i = 0; i < g.length; i++) if (g[i] > 200) wh++; for (let i = 0; i < e.length; i++) es += e[i];
  const whR = wh / g.length, eMean = es / e.length;
  const iconLike = eMean >= 15 && whR <= 0.45;   // たまっていないウルトは絵柄が灰色なので白の量は見ない（真っ白な画面だけ除く）
  ultLikeN = iconLike ? ultLikeN + 1 : 0;
  let best = -1, bi = -1;
  for (let k = 0; k < ultTs.length; k++) { const v = ncc(e, ultTs[k]); if (v > best) { best = v; bi = k; } }
  if (best > 0.6) { const t = ultTs[bi]; for (let i = 0; i < e.length; i++) t[i] = t[i] * 0.98 + e[i] * 0.02; ultBoot = []; ultPrev = e; return best; }
  if (iconLike) {
    // 新しい形：アイコンらしい状態が続いたら覚える（次からは形でもすぐ分かる）
    ultBoot.push(e); if (ultBoot.length > 20) ultBoot.shift();
    if (ultLikeN >= 20 && ultBoot.length >= 20 && onFoot) { learn(ultBoot); ultBoot = []; }
    ultPrev = e; return 0.5;
  }
  ultBoot = []; ultPrev = e;
  return Math.min(best, 0.1);
}
const every = (fps) => Math.max(1, Math.round((cfg.sampleFps || 60) / (fps || 30)));
const sub = (rows, dx, dy, w, h) => rows.slice(dy, dy + h).map(r => r.subarray(dx * 4, (dx + w) * 4));
function unionRect(list, pad) {
  const x0 = Math.min(...list.map(r => r.x)) - pad, y0 = Math.min(...list.map(r => r.y)) - pad;
  const x1 = Math.max(...list.map(r => r.x + r.w)) + pad, y1 = Math.max(...list.map(r => r.y + r.h)) + pad;
  return { anchor: 'left', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
let mateRect = null, chatOn = false, chatHash = 0;
// チャット欄：明るい文字だけを黒、他を白にした 1ch 画像。前回と同じなら送らない
async function readChat(frame) {
  // チャット欄：名前は色付き（水色など）、本文は白。名前のすぐ右に続く白い文字だけを本文として取り出す
  // （ゲーム画面の白い文字や、日本語の名前を読み間違えないため）
  const c = cfg.chat, rows = await regionRows(frame, { anchor: 'left', x: c.x, y: c.y, w: c.w, h: c.h });
  const W = c.w, H = c.h, thr = c.minBright || 175;
  const white = new Uint8Array(W * H), col = new Uint8Array(W * H), dark = new Uint8Array(W * H), rowCol = new Uint16Array(H);
  for (let y = 0; y < H; y++) { const r = rows[y]; for (let x = 0; x < W; x++) {
    const i = x * 4, R = r[i], G = r[i + 1], B = r[i + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    if (mn >= thr) white[y * W + x] = 1; else if (mx > 170 && mx - mn > 70) { col[y * W + x] = 1; rowCol[y]++; }
    if (mx < 110) dark[y * W + x] = 1; } }
  // チャットの文字は黒いふちどり付き。近く（2px 以内）に暗い点が無い白は、明るい床や壁なので文字として扱わない
  const dh = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let k = -2; k <= 2 && !a; k++) { const xx = x + k; if (xx >= 0 && xx < W && dark[y * W + xx]) a = 1; } dh[y * W + x] = a; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!white[y * W + x]) continue; let a = 0; for (let k = -2; k <= 2 && !a; k++) { const yy = y + k; if (yy >= 0 && yy < H && dh[yy * W + x]) a = 1; } if (!a) white[y * W + x] = 0; }
  const out = new Uint8ClampedArray(W * H).fill(255);
  let h = 0, bright = 0;
  for (let y = 0; y < H;) {
    if (rowCol[y] < 2) { y++; continue; }
    const y0 = y; while (y < H && rowCol[y] >= 2) y++;
    if (y - y0 < 6 || y - y0 > 30) continue;   // 文字1行の高さ（名前の色）でない帯は景色なので読まない
    const a0 = Math.max(0, y0 - 4), a1 = Math.min(H, y + 4);
    let xe = -1; for (let yy = y0; yy < y; yy++) for (let x = W - 1; x > xe; x--) if (col[yy * W + x]) { xe = x; break; }
    let last = xe;
    for (let x = xe + 1; x < W; x++) {
      let any = false; for (let yy = a0; yy < a1; yy++) if (white[yy * W + x]) { out[yy * W + x] = 0; any = true; bright++; h = (h * 31 + yy * W + x) | 0; }
      if (any) last = x; else if (x - last > 18) break;   // 文の終わり（大きなすき間）で止める
    }
  }
  if (bright < 25 || h === chatHash) return null;
  chatHash = h;
  return { w: W, h: H, data: out };
}
// 枠の「ふた」で閉じているシールドの段（自分の枠が画面キャプチャに写る環境でも、ふたの色を読まないよう黒く塗る）
let lidSegs = { player: 5, mates: [5, 5] };
// シールドの段の並び（2026-10-24）：ふつうは5段ぶんの幅に 46px ずつ。
// ガンゲーム・ワイルドカードなどのモードでは同じ幅を4段で分けていて、1段が約 58px（白は2段・青は3段のまま、段が広い）。
// 段の区切りの位置で見分ける：5段なら x=221〜223 が区切り（すき間）、4段ならそこは段の中で、x=233〜234 が区切り。
// 3回続けて同じ結果になったら切り替える（シールドが空・1段だけのときは判断しない）
let layout = 5, layoutCand = 5, layoutN = 0;
// 2026-10-25：区切りは動画の圧縮・画面の揺れで1px分ぼやけることがあり、1行・1点だけで見ると5段を4段とまちがえて
//   蓋が付いたり外れたり・シールド量が 75↔60 と揺れて被弾の赤が出続けた。4行すべてで見て、はっきりしたときだけ数える。
//   切り替えは、最初の判断は3回、いったん決まった後は 12 回続けて同じ結果のときだけ（試合中にモードは変わらない）
function layoutVote(rows) {
  const seg = (row, x) => { const i = x * 4, r = row[i], g = row[i + 1], b = row[i + 2]; return !!R.classifyShield(r, g, b) || Math.min(r, g, b) > 195; };
  let v4 = 0, v5 = 0;
  for (const row of rows) {
    const solid = (a, b) => { for (let x = a; x <= b; x++) if (!seg(row, x)) return false; return true; };
    const gapIn = (a, b) => { for (let x = a; x <= b; x++) if (!seg(row, x)) return true; return false; };
    if (!solid(20, 30)) continue;   // 1段目が塗られていない行は判断しない
    if (solid(38, 52) && gapIn(54, 59) && solid(61, 66)) v4++;
    else if (gapIn(42, 48) && solid(51, 62)) v5++;
  }
  let v = 0;
  if (v4 >= 3 && v5 === 0) v = 4; else if (v5 >= 3 && v4 === 0) v = 5;
  return v;
}
function detectLayout(v) {
  if (!v) return;
  if (v === layoutCand) layoutN++; else { layoutCand = v; layoutN = 1; }
  const need = layoutDecided ? 12 : 3;
  if (layoutN >= need) { layout = v; layoutDecided = true; }
}
let layoutDecided = false;
// 2026-10-26：ミニマップがあるか。ミニマップの真ん中にはいつも自分の矢印（上向きの山形）がある（地図が回るので向きは固定）。
//   色はプレイヤーごとに違う（水色・薄紫など）ので、形で見る：山形の中の明るさがそろっていて、まわりと違うか
//   録画：ミニマップあり 2.4〜5.4（バトロワ・イベント・TDM）／なし 0〜1.6（射撃訓練場・メニュー）
const MAP_ARROW_RECT = { anchor: 'left', x: 157, y: 155, w: 26, h: 26 };
const ARROW_T = [], ARROW_O = [];
(() => {
  const pat = ['............##....', '...........####...', '...........####...', '...........####...', '...........#####..', '..........+####+..', '.........#######..', '.........########.', '.........###..###.', '.........##....##.'];
  const T = new Uint8Array(26 * 26);
  pat.forEach((r, i) => { for (let j = 0; j < r.length; j++) if (r[j] !== '.') T[(7 + i) * 26 + j] = 1; });
  let y0 = 99, y1 = 0, x0 = 99, x1 = 0;
  for (let y = 0; y < 26; y++) for (let x = 0; x < 26; x++) if (T[y * 26 + x]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  const near = (y, x) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < 26 && xx >= 0 && xx < 26 && T[yy * 26 + xx]) return true; } return false; };
  for (let y = 0; y < 26; y++) for (let x = 0; x < 26; x++) {
    if (T[y * 26 + x]) ARROW_T.push([y, x]);
    else if (y >= y0 - 3 && y <= y1 + 3 && x >= x0 - 3 && x <= x1 + 3 && !near(y, x)) ARROW_O.push([y, x]);
  }
})();
const SCORE_RECT = { anchor: 'center', x: 1170, y: 80, w: 260, h: 46 };   // TDM・コントロールの上の真ん中のスコアの枠（青・オレンジ）
async function readMapArrow(frame) {
  const rows = await regionRows(frame, MAP_ARROW_RECT);
  const L = (y, x) => { if (y < 0 || y >= 26 || x < 0 || x >= 26) return null; const i = x * 4, r = rows[y]; return (r[i] + r[i + 1] + r[i + 2]) / 3; };
  let best = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    let st = 0, st2 = 0, nt = 0, so = 0, no = 0;
    for (const [y, x] of ARROW_T) { const v = L(y + dy, x + dx); if (v == null) continue; st += v; st2 += v * v; nt++; }
    for (const [y, x] of ARROW_O) { const v = L(y + dy, x + dx); if (v == null) continue; so += v; no++; }
    if (!nt || !no) continue;
    const mt = st / nt, sd = Math.sqrt(Math.max(0, st2 / nt - mt * mt)), d = Math.abs(mt - so / no);
    best = Math.max(best, d / (sd + 8));
  }
  return Math.round(best * 100) / 100;
}
let wasVisible = false, lastStrongT = -1e9;   // lastStrongT：バナーの地まで確かめて「出ている」と言えた最後の時刻
// 2026-10-26：HUD を起動した直後など、シールドが2段たまるまでは4段／5段を見分けられず、イベントでもバトロワ用の枠が出ていた。
//   イベントのバナーは左上に緑の紋章（色相 135〜170 の濃い緑が 220〜370 点）。バトロワのレベルの六角形・TDM には出ない（0〜5 点）。
//   まだ並びが決まっていない間だけ見て、3回続けて紋章があれば仮に4段にする（シールドの区切りで決まればそちらが優先）
const EVENT_EMBLEM_RECT = { anchor: 'left', x: 32, y: 924, w: 29, h: 29 };
let emblemN = 0;
async function readEventEmblem(frame) {
  const rows = await regionRows(frame, EVENT_EMBLEM_RECT);
  let n = 0;
  for (const row of rows) for (let x = 0; x < EVENT_EMBLEM_RECT.w; x++) {
    const i = x * 4, r = row[i], g = row[i + 1], b = row[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // 2026-11-01：バトロワでも、進化の丸（レベルの数字の丸）が暗い青緑（色相150・明るさ82・あざやかさ0.41）で最大301点になる録画があった（10/31 00.54.48 の34〜42秒）。
    //   紋章は色相163〜166・明るさ109〜123・あざやかさ0.56〜0.59 → 明るさ95・あざやかさ0.47・色相155〜175 に絞る（紋章250〜310点のまま、バトロワ最大20点）
    if (mx < 95 || (mx - mn) < mx * 0.47 || mx !== g) continue;   // 濃い緑系（いちばん強いのが緑）だけ
    const h = 60 * ((b - r) / (mx - mn) + 2);
    if (h >= 155 && h < 175) n++;
  }
  if (n >= 150) { if (++emblemN >= 3 && layout !== 4) { layout = 4; layoutCand = 4; layoutN = 0; layoutDecided = true; } } else emblemN = 0;
}
let evoCircle = false, evoN = 0;   // バナー左上のシールド進化の丸（あり＝バトロワのバナー）
// 4段のモードの見分け（2026-10-25 ユーザー決定：ワイルドカードとガンゲームは別の枠）
// ワイルドカードはバナー左上にオレンジの紋章がある。4段になってから最初の数回だけ見て決め、その後は固定
// （ガンゲーム用の枠はそこをふさぐので、決めた後に見直すと自分の枠の色を拾ってしまう）。
// 5段に戻る・HUD が 10 秒以上見えない（ロビーなど）とやり直す
const EMBLEM_RECT = { anchor: 'left', x: 14, y: 916, w: 64, h: 50 };
let modeKind = null, modeVotes = [], hiddenSince = -1;
async function readModeKind(frame, reading, now) {
  if (layout !== 4) { modeKind = null; modeVotes = []; return; }
  if (!reading.hudVisible) { if (hiddenSince < 0) hiddenSince = now; else if (now - hiddenSince > 10000) { modeKind = null; modeVotes = []; } return; }
  hiddenSince = -1;
  if (modeKind) return;
  const rows = await regionRows(frame, EMBLEM_RECT);
  let n = 0;
  // 2026-11-01（テストで発見）：ワイルドカードの紋章は陣営でオレンジ（デーモン）と緑（ビースト）がある。オレンジだけ見ていたので、
  //   ビースト側の試合をガンゲームと判断し、アイテム欄の窓を閉じていた（録画 10/27 01.33〜01.58・10/28 01.25〜02.02・10/30 22.46）
  //   → 緑の紋章（readEventEmblem と同じ色の範囲）もワイルドカードとして数える
  let gN = 0;
  for (const row of rows) for (let x = 0; x < EMBLEM_RECT.w; x++) {
    const i = x * 4, r = row[i], g = row[i + 1], b = row[i + 2];
    if (r > 190 && g > 70 && g < 170 && b < 100 && r - b > 120) n++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx >= 77 && (mx - mn) >= mx * 0.35 && mx === g) { const h = 60 * ((b - r) / (mx - mn) + 2); if (h >= 135 && h < 170) gN++; }
  }
  modeVotes.push(n >= 60 || gN >= 60);
  if (modeVotes.length >= 6) modeKind = modeVotes.filter(Boolean).length >= 3 ? 'wild' : 'gun';
}
const pitchK = () => layout === 4 ? 5 / 4 : 1;
const barsFor = (bars) => layout === 4 ? Object.assign({}, bars, { shield: Object.assign({}, bars.shield, { segmentPitch: bars.shield.segmentPitch * 5 / 4 }) }) : bars;
const maskX0 = (bars, segsOpen) => segsOpen >= (layout === 4 ? 4 : 5) ? null : Math.max(0, Math.floor(segsOpen * bars.segmentPitch * pitchK() - bars.endPad - 1));
function maskShield(rows, bars, segsOpen) {
  const x0 = maskX0(bars, segsOpen);
  if (x0 === null) return rows;
  for (const r of rows) r.fill(0, x0 * 4);
  return rows;
}
// 2026-10-25：ふたで隠した境目までシールドが塗られている＝開いている段は満タン。
//   隠す位置は段の右端より数px手前なので、満タンでも 50→47・75→72・100→98 と少なく読み、
//   ふたが閉じた瞬間に「被弾」と誤判定していた（実機録画で確認）。境目まで届いていたら満タンに合わせる
function snapMaskEdge(r, bars, segsOpen) {
  const x0 = maskX0(bars, segsOpen);
  if (x0 === null || !r.shieldPx || r.shieldPx < x0 - 1) return;
  const T = R.SHIELD_TIERS.find(t => t.name === r.shieldTier);
  if (T) r.shieldPoints = Math.max(r.shieldPoints, Math.min(T.segments, segsOpen) * 25);
}

// 味方バナー2人分（まとめて1回だけコピーしてから切り分ける）
// ワイルドカードなど、バナーの上に鍵マークの列があるモードでは、上の味方（1人目）のバナーが 21px 上にずれる（2026-10-24 スクショで確認）。
// 1人目は今の位置で見つからなければ、もう一方の位置も試す（見つかった位置を覚える）
const MATE_DY = [0, -21];
let dySwitchN = 0;   // 2026-10-30：味方の枠の高さの切り替えを続けて確かめる回数
let mateDy = 0;
const shiftRect = (r, dy) => Object.assign({}, r, { y: r.y + dy });
async function readMates(frame) {
  if (!mateRect) mateRect = unionRect(cfg.mates.flatMap(m => MATE_DY.flatMap(dy => [m.hp, m.shield, m.name].map(r => shiftRect(r, dy)))), 4);
  const rows = await regionRows(frame, mateRect);
  const mb = barsFor(cfg.mateBars);
  const readOne = (m0, i, dy) => {
    const m = dy ? { hp: shiftRect(m0.hp, dy), shield: shiftRect(m0.shield, dy), name: shiftRect(m0.name, dy) } : m0;
    const cut = (r) => sub(rows, r.x - mateRect.x, r.y - mateRect.y, r.w, r.h);
    const nm = cut(m.name), nd = new Uint8ClampedArray(m.name.w * m.name.h * 4);
    nm.forEach((row, i) => nd.set(row, i * m.name.w * 4));
    const sh = cut(m.shield).map(r => r.slice());
    maskShield(sh, cfg.mateBars.shield, lidSegs.mates[i] ?? 5);
    const r = R.analyzeMate({ hp: { rows: cut(m.hp), width: m.hp.w }, shield: { rows: sh, width: m.shield.w }, name: { data: nd } }, mb);
    snapMaskEdge(r, cfg.mateBars.shield, lidSegs.mates[i] ?? 5);
    if (layout === 4 && r.shieldSegments > 4) { r.shieldSegments = 4; r.shieldPoints = Math.min(r.shieldPoints, 100); }
    // バナーがあるかの確かめ：HPバーのすぐ左・すぐ下・シールドとの間は、バナーの暗い地のはず。
    // 明るい背景（射撃訓練場の砂や壁）でバーがあると誤認しないため、ここが白っぽければ「いない」
    const white = (row, x0, x1) => { let n = 0, t = 0; for (let x = Math.max(0, x0); x < x1; x++) { const i = x * 4; t++; if (R.isHpFill(row[i], row[i + 1], row[i + 2])) n++; } return t ? n / t : 0; };
    const ox = m.hp.x - mateRect.x, oy = m.hp.y - mateRect.y, span = Math.max(20, Math.min(m.hp.w, r.hpPx || m.hp.w));
    const below = white(rows[oy + m.hp.h + 2] || rows[rows.length - 1], ox + 4, ox + span - 6);
    const gap = white(rows[oy - 2] || rows[0], ox + 4, ox + span - 6);
    let left = 0; for (let y = oy; y < oy + m.hp.h; y++) left += white(rows[y], ox - 4, ox - 1);
    // ダウン中の味方はHPバーが赤／黄色になるので、その色も「いる」の目印にする
    let colored = 0; for (const row of cut(m.hp)) for (let x = 0; x < m.hp.w; x++) { const i = x * 4, rr = row[i], gg = row[i + 1], bb = row[i + 2]; if (rr > 170 && bb < 90 && (gg < 90 || gg > 150)) colored++; }
    r.bannerOk = below < 0.3 && gap < 0.3 && left / m.hp.h < 0.5 && (r.hpPx >= 8 || colored >= m.hp.w * 2);
    // 2026-10-28（ユーザー要望）：味方がリスポーン待ちのとき（バナーが黄緑で「リスポーンまで○○」）も枠を出す。
    //   このときHPバーは無く、HPの位置に黄緑の文字が並ぶ（録画 02.18.59：黄緑の点が 0.19〜0.29）。名前の白い文字もあるときだけ
    // 2026-10-29（録画 23.30.02）：味方が死んでバナー回収待ち（黄緑の「バナーをクラフト」）だと、黄緑の点は 0.08〜0.16 しかなく 0.15 に届かないことがあった。
    //   さらに黄緑の文字の一部を「ダウンの黄色いHPバー」と取り違え、枠が ダウン／被弾／回復／消える を行ったり来たりしていた
    //   → 黄緑の文字が 0.08 以上あり名前もあれば、ほかの判定より先に「リスポーン待ち」にする（生きている味方のHPバーに黄緑は無い）
    {
      let lime = 0, tot = 0; for (const row of cut(m.hp)) for (let x = 0; x < m.hp.w; x++) { const i = x * 4, rr = row[i], gg = row[i + 1], bb = row[i + 2]; tot++; if (gg > 150 && rr > 90 && rr < 230 && bb < 110 && gg > rr + 15 && gg > bb + 70) lime++; }
      let nameW = 0; for (let i = 0; i < nd.length; i += 4) if (Math.min(nd[i], nd[i + 1], nd[i + 2]) > 200) nameW++;
      const lf = tot ? lime / tot : 0;
      if (lf >= 0.08 && lf <= 0.55 && nameW >= 12)   // 2026-10-30：明るい草が透けると 0.44 まで上がった（録画 03.06.30）
 { r.respawnWait = true; r.bannerOk = true; r.hudVisible = true; r.hpPx = 0; r.hpRatio = 0; r.shieldPx = 0; r.shieldPoints = 0; r.shieldSegments = 0; r.shieldTier = 'none'; return r; }
    }
    if (!r.bannerOk) { r.hudVisible = false; r.hpPx = 0; r.hpRatio = 0; r.shieldPx = 0; r.shieldPoints = 0; r.shieldSegments = 0; r.shieldTier = 'none'; }
    return r;
  };
  return cfg.mates.map((m, i) => {
    if (i !== 0) return readOne(m, i, 0);
    let r = readOne(m, i, mateDy);
    if (!r.bannerOk) {
      const other = MATE_DY.find(d => d !== mateDy), r2 = readOne(m, i, other);
      // 2026-10-30（ユーザー指摘：3人目の枠が上に動く・録画 03.06.30）：リスポーン待ちの味方の後ろに明るい草が透けると、黄緑の点が 0.4 を超えて
      //   数コマだけ「いない」になり、そのすきに 21px 上の位置（名前の白い文字）をHPバーと見て、枠の高さが切り替わっていた
      //   → 切り替えは「リスポーン待ち」の判定では行わず、8回続けて見えたときだけ
      if (r2.bannerOk && !r2.respawnWait) { if (++dySwitchN >= 8) { dySwitchN = 0; mateDy = other; r = r2; } } else dySwitchN = 0;
    } else dySwitchN = 0;
    r.dy = mateDy;
    return r;
  });
}

// 2026-10-26：ふたが閉じている間は 1px の穴の色だけで見るため、色の薄いアイテム・一時的なアーマー（薄い斜線）は「ある」と分からなかった。
//   メニューから戻る（＝ふたが全部開いて、窓全体で見直す）と分かっていた → 穴の色が「いつもの色」から変わったら、ふたを少しだけ開けて見直してもらう（probe）
const probeBase = {}, probeN = {}, probeAt = {};
function probeCheck(id, px, now) {
  const b = probeBase[id];
  if (!b || b.length !== px.length) { probeBase[id] = px.map(p => p.slice(0, 3)); probeN[id] = 0; return false; }
  let dev = 0;
  px.forEach((p, i) => { if (Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1]) + Math.abs(p[2] - b[i][2]) > 60) dev++; });
  if (dev >= Math.min(2, px.length)) {
    if (++probeN[id] >= 3) { probeN[id] = 0; probeBase[id] = px.map(p => p.slice(0, 3)); if (now - (probeAt[id] || -1e9) > 2000) { probeAt[id] = now; return true; } }
    return false;
  }
  probeN[id] = 0;
  px.forEach((p, i) => { for (let c = 0; c < 3; c++) b[i][c] = b[i][c] * 0.9 + p[c] * 0.1; });
  return false;
}
// 穴（1px）の色から、同じ 2×2 の中のふた 3px の色の混ざりを取り除く。明るさ（Y）は 1px ごとに正しいので、色み（U・V）だけ戻す
function unmixChroma(hole, lid) {
  const yuv = ([r, g, b]) => { const y = 0.299 * r + 0.587 * g + 0.114 * b; return [y, (b - y) * 0.564, (r - y) * 0.713]; };
  const [Y, U, V] = yuv(hole), [, Ul, Vl] = yuv(lid);
  const u = 4 * U - 3 * Ul, v = 4 * V - 3 * Vl;
  const r = Y + 1.403 * v, b = Y + 1.773 * u, g = (Y - 0.299 * r - 0.114 * b) / 0.587;
  return [r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c))));
}
// 2026-10-27：無限バッテリー増幅器（紫の四角にリサイクルの矢印のバッテリー）は紫が薄め（窓を開けた状態で 131,99,141 など）で、
//   判定の境目（彩度 0.3・明るさ 0.55）ぎりぎり。開いた／閉じたを約1秒ごとにくり返していた（記録 20261027_004510 の 00:51〜00:52、スクショ 00.51.41）
//   → 一度「ある」と分かったら、同じ色味（色相 ±35°）でゆるい基準（彩度 0.15・明るさ 0.40）を2点が満たす間は「ある」のまま。
//   アイテムが無いときの欄はバナーの暗い地（約 70,65,62）なので、ゆるい基準でも通らない
const itemHold = {};
function hsv3(p) { const mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]), d = mx - mn; let h = 0;
  if (d) { if (mx === p[0]) h = ((p[1] - p[2]) / d) % 6; else if (mx === p[1]) h = (p[2] - p[0]) / d + 2; else h = (p[0] - p[1]) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx / 255]; }
function itemHoldCheck(id, px, fix, shown, now) {
  const H = itemHold[id] || (itemHold[id] = { hue: null, at: -1e9 });
  if (shown) {
    const hs = px.map(hsv3).filter(([, s, v]) => s >= 0.22 && v >= 0.4);
    if (hs.length) { const x = hs.reduce((a, [h]) => a + Math.cos(h * Math.PI / 180), 0), y = hs.reduce((a, [h]) => a + Math.sin(h * Math.PI / 180), 0); H.hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
    H.at = now; return true;
  }
  if (H.hue == null || now - H.at > 500) return false;   // 途切れたら 0.5 秒で終わり（取ったあとふたが閉じて、穴から見える景色の色で開き直さないように）
  const near = (p) => { const [h, s, v] = hsv3(p), dh = Math.abs(h - H.hue); return s >= 0.15 && v >= 0.40 && Math.min(dh, 360 - dh) <= 35; };
  if (px.filter(near).length >= 2 || (fix && fix.filter(near).length >= 2)) { H.at = now; return true; }
  return false;
}
// のぞき穴（水色の窓のふたにあけた小さな穴）の色
let peekGroups = null;
let diagItem = '';
async function readPeeks(frame) {
  // デスボックス用の穴は画面中央基準、それ以外は左基準。まとまりごとに小さな範囲だけ読む
  if (!peekGroups) {
    const groups = {};
    for (const id of Object.keys(cfg.peeks)) { const a = String(cfg.peeks[id].part).startsWith('db_') ? 'center' : 'left'; (groups[a] = groups[a] || []).push(id); }
    // dx4：4段のモード（ワイルドカード等）でずれる穴（アイテム欄は右に 30px）。両方の位置が入る範囲を読む
    peekGroups = Object.entries(groups).map(([a, ids]) => ({ ids, rect: Object.assign(unionRect(ids.flatMap(id => cfg.peeks[id].points.flatMap(([x, y]) => [{ x, y, w: 1, h: 1 }, { x: x + (cfg.peeks[id].dx4 || 0), y, w: 1, h: 1 }])), 4), { anchor: a }) }));   // 2026-10-26：穴の左 3px（ふただけの色）も読むので余白 1→4
  }
  const out = {};
  for (const g of peekGroups) {
    const rows = await regionRows(frame, g.rect);
    for (const id of g.ids) {
      const p = cfg.peeks[id];
      const dx = layout === 4 ? (p.dx4 || 0) : 0;   // 4段の並び（イベント等）はアイテム欄が右に 30px（2026-10-26：進化の丸での切り替えはやめた）
      const px = p.points.map(([x0, y]) => { const x = x0 + dx, row = rows[y - g.rect.y], i = (x - g.rect.x) * 4; return [row[i], row[i + 1], row[i + 2]]; });
      out[id] = R.peekShown(px, p, cfg.peekTests);
      // 2026-10-26：画面の取り込みは色の情報が 2×2 ピクセルで1つ（YUV 4:2:0）。1px の穴の色は、まわりのふたの色と混ざって薄まる
      //   （紫のアイテム 175,111,193 → 139,130,181 に）。ふたの色（穴の左 3px）を差し引いて、穴の本当の色を戻してから見直す
      if (p.test === 'item') {
        // 2026-10-29（ユーザー指摘・録画 00.01.22 の42秒／記録 20261029_000044 の 001）：グレネードで紫のシールドが割れると、自分の枠のふたが紫（131,51,166 など）に変わり、
        //   ふた越しの穴の色も紫になって「紫のアイテム」と見まちがえ、ふたが開いていた。
        //   → ふただけの色（穴の左 3px）がふだんのピンク（彩度 0.36 前後）より濃い色（彩度 0.5 以上：被弾の赤・シールドの色など）のときは、判定しない（今の表示のまま）
        const lidRef = p.points.map(([x0, y]) => { const x = x0 + dx, row = rows[y - g.rect.y], i = (x - 3 - g.rect.x) * 4; return [row[i], row[i + 1], row[i + 2]]; });
        if (lidRef.some(q => hsv3(q)[1] >= 0.5)) { delete out[id]; continue; }
        let fix = null;
        if (!out[id]) {
          fix = p.points.map(([x0, y], k) => { const x = x0 + dx, row = rows[y - g.rect.y], i = (x - 3 - g.rect.x) * 4; return unmixChroma(px[k], [row[i], row[i + 1], row[i + 2]]); });
          // 2026-10-28：明るい砂地（射撃訓練場）では、色を戻すと茶色（色相 30 前後・彩度 0.3）になり、「ある」と見まちがえて
          //   ふたが 0.3 秒ずつ開いていた（記録 20261028_000252、録画 00.12.50）。色を戻して見るのは紫のアイテムのためなので、紫に見える点が2つ以上のときだけ
          const purple2 = fix.filter(q => { const h2 = hsv3(q)[0]; return h2 >= 255 && h2 <= 325; }).length >= 2;
          const purpleOk = (q) => { const [h2, sa, va] = hsv3(q); return h2 >= 255 && h2 <= 325 && sa >= 0.15 && va >= 0.45; };
          if (purple2 && R.peekShown(fix, p, cfg.peekTests)) out[id] = true;
          // 2026-10-27：無限バッテリー増幅器は、ふた越しに色を戻しても彩度が 0.25〜0.35 で、上の基準（2点とも 0.3 以上）に届かず、
          //   拾ってから開くまで約1.5秒かかっていた（記録 20261027_235211：拾った直後から 186,127,195／153,118,162／160,116,161 など）。
          //   → 3点とも紫（色相 255〜325）・彩度 0.24 以上・明るさ 0.5 以上で、色味がそろっていれば「ある」
          //   （何もないときの穴は景色の色。茶色い地面などは戻すと彩度 0.34 まで上がることがあるので、紫の範囲だけにした）
          // 2026-11-02（ユーザー指摘：アップグレードアイテム5種のうち2種がまた開かない、録画 11/02 01.56.35）：記号の点（白）が穴にかかる絵・薄い紫の絵は、
          //   3点そろわないことがあった（例 181,139,201／145,124,150／142,116,152）。蓋の穴のまわりはグレーにした（色の混ざりは薄まるだけで、戻せば元の色）ので、
          //   「紫の点が2つ以上（彩度 0.15・明るさ 0.45 以上）、その色味がそろう」で「ある」とする。録画の試験で5種とも開き、アイテムなしの約3,300コマで誤って開いたのは 5 コマ
          else if (fix.filter(purpleOk).length >= 2) {
            const hs = fix.filter(purpleOk).map(q => hsv3(q)[0]); let span = 0;
            for (let a2 = 0; a2 < hs.length; a2++) for (let b2 = a2 + 1; b2 < hs.length; b2++) { const d2 = Math.abs(hs[a2] - hs[b2]); span = Math.max(span, Math.min(d2, 360 - d2)); }
            if (span <= 30) out[id] = true;
          }
        }
        out[id] = itemHoldCheck(id, px, fix, out[id], performance.now());
        if (diag && id === 'aqua1') {   // 2026-10-27：記録用。穴の色・ふたの色・戻した色（反応の遅さを調べるため）
          const lid = p.points.map(([x0, y]) => { const x = x0 + dx, row = rows[y - g.rect.y], i = (x - 3 - g.rect.x) * 4; return [row[i], row[i + 1], row[i + 2]]; });
          const f2 = fix || px.map((q, k) => unmixChroma(q, lid[k]));
          diagItem = [px, lid, f2].map(L => L.map(q => q.slice(0, 3).join(' ')).join('/')).join('|');
        }
      }
    }
  }
  return out;
}

// デスボックスを開いた時：画面中央下のバナーのHPバー。白（またはダウンの黄・赤）がぎっしり並ぶ行が数行あり、
// その上下に暗い行がある（＝空や壁の明るい面ではない）ときだけ「ある」とみなす
async function readDeathbox(frame) {
  const d = cfg.deathbox, minRows = d.minRows || 3;
  const barRows = async (r) => {
    const rect = { anchor: 'center', x: r.x, y: r.y - 4, w: r.w, h: r.h + 8 };
    const rows = await regionRows(frame, rect);
    let good = 0;
    for (const row of rows) {
      let n = 0, ext = 0;
      for (let x = 0; x < r.w; x++) { const i = x * 4, rr = row[i], gg = row[i + 1], bb = row[i + 2]; if (R.isHpFill(rr, gg, bb) || (rr > 170 && bb < 90 && (gg < 90 || gg > 150))) { n++; ext = x + 1; } }
      if (ext >= 20 && n / ext >= 0.8) good++;
    }
    return good >= minRows && good <= rows.length - 3;
  };
  const open = await barRows(d.player);
  const mates = [];
  for (const m of d.mates) mates.push(open && await barRows(m));
  return { open, mates };
}

// バーのまわり（シールドの上・シールドとHPの間・HPの下）。ゲームのバナーの地なので暗い／半透明の灰色のはず。
// イベントモードなどアーマーの丸や進化ゲージが無い画面でも、ここが暗くてバーが読めれば HUD は出ているとみなす
// 2026-10-25：見る行を y995 → y988 に。y994〜995 はシールドのバーのすぐ上の明るい線（枠が赤く光ると明るさ 150 を超える）で、
//   ワイルドカード等のバナーでは「暗い地ではない」と判定されて HUD が一瞬ずつ消え、枠が暗くなったりキャラが消えたりしていた
const BAND = { anchor: 'left', x: 180, y: 986, w: 230, h: 38 };
function bannerDark(rows) {
  const at = (y, lim = 150) => { const r = rows[y]; let s = 0, fill = 0; for (let x = 0; x < BAND.w; x++) { const i = x * 4, mn = Math.min(r[i], r[i + 1], r[i + 2]); s += mn; if (R.isHpFill(r[i], r[i + 1], r[i + 2])) fill++; } return s / BAND.w < lim && fill < BAND.w * 0.1; };
  // y1006（シールドと HP のあいだ）は、チームデスマッチ等のバナーではバーのふちで少し明るい（約155）ので基準をゆるめる
  return at(2) && at(20, 180) && at(36);   // y988・y1006・y1022
}
// シールドの段が1つ増えるアイテム（2026-10-24 作り直し）
// ゲームの仕組み（ユーザー説明）：名前の右の四角に入るアイテムの一つが、アーマーのレベルに関係なく段を1つ増やす（白2→3、青3→4、紫4→5）。
// 増えた段は、最初は赤いしましま → 空 → 回復で色が入る。アイテムを捨てると段は元に戻る。
// 判断：①アイテムの四角にアイテムが見えている　かつ　②「本来の段数＋1」の位置に色（または赤いしましま）を一度でも見た → 段を1つ増やす。
//       アイテムが見えなくなったら（捨てた）すぐ元に戻す。アーマーの色が変わったら見直す。
// 増えた段は、ふたが閉じていても小さな穴（各段3点）から見える。
const EXTRA_PTS = { 3: [[279, 1001], [293, 1001], [307, 1001]], 4: [[326, 1001], [340, 1001], [354, 1001]], 5: [[372, 1001], [386, 1001], [400, 1001]] };
// 4段の並び（1段 約58px）：3段目 x=293〜348、4段目 x=351〜406
const EXTRA_PTS4 = { 3: [[307, 1001], [321, 1001], [335, 1001]], 4: [[365, 1001], [379, 1001], [393, 1001]] };
const EXTRA_RECT = { anchor: 'left', x: 279, y: 1001, w: 128, h: 1 };
let extra = { seen: false, tier: null }, itemSeenAt = -1e9, hudHiddenAt = -1e9, itemGoneAt = -1e9;
function readShieldExtra(rows, reading, now) {
  const tier = reading.shieldTier, T = R.SHIELD_TIERS.find(t => t.name === tier);
  // アイテムの四角（のぞき穴 aqua1）を最後に見てから 1 秒以内。
  // 2026-10-25：マップ・メニューで HUD が隠れている間はのぞき穴を読まないので、戻った直後に増えた段を忘れていた → 戻ってから少し待つ
  const itemOn = now - itemSeenAt < 1000 || (extra.seen && now - hudHiddenAt < 1500 && itemGoneAt < hudHiddenAt);   // 戻ってからのぞき穴で「無い」と見えたら（インベントリで捨てた）すぐ元に戻す
  if (!T || !itemOn) { if (!itemOn) extra = { seen: false, tier: null }; reading.shieldExtra = 0; return; }
  if (extra.tier && extra.tier !== tier) extra = { seen: false, tier: null };
  const k = T.segments + 1, pts = (layout === 4 ? EXTRA_PTS4 : EXTRA_PTS)[k];
  if (!pts) { reading.shieldExtra = 0; return; }
  let nFill = 0, nRed = 0, nLit = 0;
  for (const [x, y] of pts) {
    const row = rows[y - EXTRA_RECT.y], i = (x - EXTRA_RECT.x) * 4, r = row[i], g = row[i + 1], b = row[i + 2];
    const t = R.classifyShield(r, g, b);
    if ((t && t.name === tier) || Math.min(r, g, b) > 200) nLit++;   // 増えた段は満タンのとき白く光るしましまが流れる
    if (t && t.name === tier) nFill++;
    else if (r > 150 && g < 120 && b < 120 && r - Math.max(g, b) > 60) nRed++;   // 赤いしましま（増えたばかりの段）
  }
  if (nFill + nRed >= 2) extra = { seen: true, tier };
  reading.shieldExtra = nFill * 10 + nRed;
  if (extra.seen && reading.shieldSegments === T.segments) {
    const sc = barsFor(cfg.bars).shield, full = nFill >= 2;
    reading.shieldSegments = k;
    let raw = reading.shieldPx / sc.segmentPitch * 25;
    const snap = Math.round(raw / 25) * 25;
    if (snap > raw && snap - raw <= sc.endPad / sc.segmentPitch * 25 + 0.5) raw = snap;
    if (full && raw < T.segments * 25) raw = T.segments * 25;   // ふた越しに増えた段に色が見えている＝その手前までは満タン
    // 2026-10-25：増えた段が満タンのときの光るしましまで、右端の読みが数px揺れて 125→122 の「被弾」になっていた → 3点とも光っていれば満タン
    if (full && nLit === pts.length) raw = k * 25;
    reading.shieldPoints = Math.max(0, Math.min(k * 25, Math.round(raw) + (full && lidSegs.player < k ? 25 : 0)));
  }
}
// 2026-10-26（ユーザー案）：ふたで閉じている最初の段の穴（3点）に、アーマーの色が見えたら段を1つ開ける。
//   3・4本目は白・青・紫・赤（金）、5本目は紫・赤（金）のどれでもよい（今のアーマーの色でなくてもよい）。
//   色の違うアーマーを拾ったときの薄い斜線は、しましまが流れるので3点がいつも色になるとは限らない → 直近 15 回のうち 4 回以上、どれかの点に色が見えたら
const HOLE_OK = { 3: ['white', 'blue', 'purple', 'red', 'gold'], 4: ['white', 'blue', 'purple', 'red', 'gold'], 5: ['purple', 'red', 'gold'] };
let holeHist = [], holeKey = '';
// 穴の1点の色 → アーマーの色。一時的なアーマー（薄い斜線）は色が薄いので、ふつうの判定より少しゆるめる
// （例：薄い赤 161,88,76。空の段の灰色 104,103,92 や、アーマーなしの灰色がかった青 88,130,152 は通さない）
function holeTier(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, v = mx / 255, sat = mx ? d / mx : 0;
  let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  if (sat < 0.16 && v > 0.78) return 'white';
  if ((h < 20 || h > 340) && sat > 0.3 && v > 0.45) return 'red';
  if (h >= 35 && h < 62 && sat > 0.35 && v > 0.55) return 'gold';
  if (h >= 185 && h < 245 && sat > 0.5 && v > 0.62) return 'blue';
  if (h >= 262 && h < 330 && sat > 0.15 && v > 0.55) return 'purple';
  return null;
}
// 2026-10-26 改：前の版は「段を1つ開ける → 開いた段は今の色（白など）の段数で読まれて閉じる」をくり返し、2→3→2→4→2→5 と行ったり来たりした。
//   一時的な表示は「今のアーマーの段のあとに、拾ったアーマーの段が薄い色で続く」もの（例：白2段＋薄い赤3段）。
//   → 今のアーマーのすぐ次の段（ふたが閉じていれば穴、開いていればそのまま）に薄い色が見え続ける間は、その色の段数まで開けたままにする
const TIER_SEGS = { white: 2, blue: 3, purple: 4, gold: 4, red: 5 };
function readLidHoles(rows, reading) {
  if (!reading.barsOk) return;
  const T = R.SHIELD_TIERS.find(t => t.name === reading.shieldTier), base = T ? T.segments : 0;
  const maxSeg = layout === 4 ? 4 : 5, k = base + 1;
  const pts = base ? (layout === 4 ? EXTRA_PTS4 : EXTRA_PTS)[k] : null;
  const key = layout + ':' + base;
  if (key !== holeKey) { holeKey = key; holeHist = []; }
  if (!pts || k > maxSeg) return;
  const ok = HOLE_OK[k] || [];
  const cnt = {};
  for (const [x, y] of pts) {
    const row = rows[y - EXTRA_RECT.y], i = (x - EXTRA_RECT.x) * 4, t = holeTier(row[i], row[i + 1], row[i + 2]);
    if (t && ok.includes(t) && t !== reading.shieldTier) cnt[t] = (cnt[t] || 0) + 1;
  }
  const top = Object.keys(cnt).sort((p, q) => cnt[q] - cnt[p])[0] || null;
  holeHist.push(top); if (holeHist.length > 15) holeHist.shift();
  const tally = {}; for (const t of holeHist) if (t) tally[t] = (tally[t] || 0) + 1;
  const best = Object.keys(tally).sort((p, q) => tally[q] - tally[p])[0];
  reading.lidHoles = best ? best + tally[best] : 0;
  if (best && tally[best] >= 4) {
    const want = Math.min(maxSeg, TIER_SEGS[best] || k);
    if (want > base && reading.shieldSegments < want) reading.shieldSegments = want;
  }
}
// 2026-10-25：戦術アビリティのアイコンが2つ並ぶキャラ（オクタン等）か。2つ目のアイコンの右のふち（ななめ）の内と外の明るさを比べる。
// ゲームのアイコン欄は半透明の暗い板なので、ふちの内側は外側より暗い。4行のうち3行以上でそうなら「2つある」。
// 2つ用の枠を出している間は、外側の点は枠の 1px の穴から見える（build_parts.py の tactical2 の holes と同じ位置）
const TAC2_RECT = { anchor: 'left', x: 680, y: 985, w: 40, h: 31 };
const TAC2_ROWS = [[985, 692], [995, 698], [1005, 704], [1015, 710]];   // [y, ふちの x]
// 2026-10-26 作り直し：前の「ふちの内と外の明るさ」は、銃や腕が後ろに重なると（カタリスト等）オクタンと見まちがえた。
//   → 2つ目の欄にオクタンの戦術（注射器と星）の白い絵があるかを、形（白い点の重なり具合）で見る。
//   形はオクタンの録画（21.51・21.52）8コマから作った 48×40 の白黒（TAC2_T）。重なり 0.36 以上で「2つ」、0.25 以下で「1つ」
const TAC2_GLYPH = { anchor: 'left', x: 636, y: 980, w: 48, h: 40 };
const TAC2_T = (() => { const hx = '0000000000000002000000000002000000000007000000000007000000000605830000000389ce00000003f9fe00080001808e001c0001800c00320001810c007d0001820e00ff8003040703e7c01c1803e3c1803f1319e380c00f81b80394400380fc0234400180fe0076000181ff007f000131ff80fd8001f8ffc372c003fc7fe3e1e0030e3ff0418004071fc800e000070f0400600003040600200002020b000000020105800000000080400000000040200000000020600000000010c00000000009e00000000007e00000000000f000000000001000000000000800000000000400000000000200000000000100', out = new Uint8Array(48 * 40); for (let i = 0; i < out.length; i++) out[i] = (parseInt(hx[i >> 2], 16) >> (3 - (i & 3))) & 1; return out; })();
async function readDualTac(frame) {
  const rows = await regionRows(frame, TAC2_GLYPH);
  let inter = 0, uni = 0, inter2 = 0, uni2 = 0;
  for (let y = 0; y < TAC2_GLYPH.h; y++) { const r = rows[y]; for (let x = 0; x < TAC2_GLYPH.w; x++) { const i = x * 4, mn = Math.min(r[i], r[i + 1], r[i + 2]), m = mn > 190 ? 1 : 0, m2 = mn > 110 ? 1 : 0, t = TAC2_T[y * TAC2_GLYPH.w + x]; if (m & t) inter++; if (m | t) uni++; if (m2 & t) inter2++; if (m2 | t) uni2++; } }
  const iou = uni ? inter / uni : 0, iou2 = uni2 ? inter2 / uni2 : 0;
  // 1つ用の枠を出している間は、枠で絵の左半分が隠れて重なりが 0.45 前後になる（2つ用の枠では 0.75〜0.9）。ほかのキャラは 0.25 以下
  // 2026-10-28（ユーザー指摘・録画 02.02.55）：ジャンプパッドを使うと2つ目の絵が灰色（クールダウン）になり、白の基準では 0.08 まで下がって
  //   1つ用の枠に戻っていた。灰色まで含めた形（明るさ 110 以上）でも見る：クールダウン中 0.34〜0.43／ほかのキャラ 0.20 以下
  if (iou >= 0.36 || iou2 >= 0.30) return true;
  return iou <= 0.25 && iou2 <= 0.22 ? false : null;   // null＝どちらとも言えない（今の表示のまま）
}
// 2026-10-28：オクタンの注射器2本目を刺すと、戦術の右に金色のふちの板（黄緑のゲージ）が約3.5秒出る（ユーザー要望：その間だけ枠をのばす・録画 02.02.55／02.02.47）
//   ゲージの細い横線（上下2本、間は暗い）か、ゲージがいっぱいのときの黄緑のかたまりを見る。どちらも「上が暗→明るい」と「下が明るい→暗」の段差が 12〜17px 離れて並ぶ。
//   30 列のうち 7 割以上でそうなら「出ている」。金色のふちは自分の枠の線と重なるので使わない（ゲージは枠の内側＝透明なところ）
//   録画29本：板が出ている間は毎コマ○、ほかは最長3コマ（0.1秒）の誤反応 → hud.js で 0.2秒続いたら出す
const OCT_BAR_RECT = { anchor: 'left', x: 735, y: 980, w: 30, h: 36 };
async function readOctBar(frame) {
  const R0 = OCT_BAR_RECT, W = R0.w, H = R0.h, rows = await regionRows(frame, R0);
  const Y = new Float32Array(W * H), yel = new Uint8Array(W * H);
  rows.forEach((r, y) => { for (let x = 0; x < W; x++) { const i = x * 4, rr = r[i], gg = r[i + 1], bb = r[i + 2]; Y[y * W + x] = (rr + 2 * gg + bb) / 4; yel[y * W + x] = (gg - bb > 20 && rr - bb > 12 && gg > 110) ? 1 : 0; } });
  let n = 0;
  for (let x = 0; x < W; x++) {
    const ups = [], los = [];
    for (let y = 0; y < H; y++) {
      const k = y * W + x; if (!yel[k]) continue;
      if (y >= 3 && Y[k] - Y[k - 3 * W] > 40) ups.push(y);
      if (y < H - 3 && Y[k] - Y[k + 3 * W] > 40) los.push(y);
    }
    if (ups.some(u => los.some(l => l - u >= 12 && l - u <= 17))) n++;
  }
  return n / W >= 0.7;
}
// 2026-10-30（ユーザー指摘：注射器の反応から枠がのびるのが遅い・録画 02.11.57）：
//   ゲームは注射器2本目を使うと、まず黄色いふちだけの欄が右へすべり出て（約0.25秒）、そのあと中の黄色いゲージがたまる。
//   今まではゲージ（readOctBar）だけを見ていたので、すべり出し始めから約0.5秒遅れていた。
//   → 黄色いふちを見る：①すべり出し中＝上のふち（y972-973、x696〜）と下のふち（y1028-1029、x718〜）の細い黄色い横線
//                       ②出きったあと＝右の斜めのふち（自分の枠がのびて上下のふちを隠しても、斜めのふちは枠の内側に見える）
//   どちらも「細い線」のときだけ（上下 3px が黄色くない）数える。黄色い景色のかたまりでは反応しない
// 2026-10-31（ユーザー要望：武器の見出しを見えるように）：ゲームが武器の欄の上に出す黄色い帯（「ブリーチチャージモード」など）があるか。
//   帯の黄色い部分のうち、どの枠（ふつうの枠・世界観の枠）にも隠れない段（y918〜924）だけを見る（自分の枠を読み取っても変わらない）。
//   黄色い景色で誤反応しないよう、帯のすぐ上（y912〜915）は黄色くないことも確かめる
const WB_RECT = { anchor: 'right', x: 2190, y: 912, w: 230, h: 13 };
async function readWeaponBanner(frame) {
  const R0 = WB_RECT, W = R0.w, rows = await regionRows(frame, R0);
  const yel = (row, x) => { const i = x * 4; return row[i] > 150 && row[i + 1] > 150 && row[i + 2] < 90; };
  let band = 0, above = 0;
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < W; x++) { if (!yel(rows[y], x)) continue; if (y >= 6) band++; else if (y <= 3) above++; }
  // 帯は点滅して黄色の割合が 0.83 ⇔ 0.41 を行き来する（録画 00.35.39・01.41.55）。帯が無いときは 0〜0.0x → 0.3 以上で「あり」
  return band / (W * (rows.length - 6)) >= 0.3 && above / (W * 4) <= 0.3;
}
const OCT_OUT_RECT = { anchor: 'left', x: 690, y: 966, w: 128, h: 68 };
async function readOctOut(frame) {
  const R0 = OCT_OUT_RECT, W = R0.w, H = R0.h, rows = await regionRows(frame, R0);
  const Y = (x, y) => { if (y < 0 || y >= H || x < 0 || x >= W) return false; const r = rows[y], i = x * 4, rr = r[i], gg = r[i + 1], bb = r[i + 2]; return gg > 150 && rr > 130 && bb < 110 && gg - bb > 60; };
  const X0 = R0.x, Y0 = R0.y;
  // ① 横線：左はしから続けて 6px 以上、線の上下 3px は黄色くない
  const hline = (yy, xs) => { const y = yy - Y0; let run = 0, miss = 0; for (let x = xs - X0; x < W; x++) { const on = Y(x, y) || Y(x, y + 1); if (on && !Y(x, y - 3) && !Y(x, y + 4)) { run++; miss = 0; } else if (++miss >= 2) break; } return run; };   // 1px の切れ目は許す
  const top = hline(972, 696), bot = hline(1028, 718);
  if (top >= 6 && bot >= 6) return true;
  // ② 斜めのふち（出きった位置）：y974→x782、y1022→x809 あたり。行ごとに予想の位置 ±4px に黄色があり、6px 左右は黄色くない
  let hit = 0, tot = 0;
  for (let yy = 976; yy <= 1022; yy++) {
    if (yy >= 990 && yy <= 1010) continue;   // 中のゲージの高さは除く
    tot++;
    const xe = Math.round(782 + (yy - 974) * 0.57) - X0, y = yy - Y0;
    let f = -1; for (let x = xe - 4; x <= xe + 4; x++) if (Y(x, y)) { f = x; break; }
    if (f >= 0 && !Y(f - 6, y) && !Y(f + 7, y)) hit++;
  }
  return hit >= tot * 0.6;
}
// 2026-10-27：シップ・降下中は、ゲームの戦術・ウルト・武器の欄が空なのに枠だけ出ていた（ユーザー指摘・録画 23.45.28）。
//   地上にいる目印として、戦術アビリティのアイコン（白い絵）を見る。録画：地上 19〜31%（ほとんど動かない）／シップ・降下 2〜9%（景色が動く）
//   白の割合が 14〜40% で、前のコマとほぼ同じ形（重なり 0.85 以上・割合の差 0.03 以下）が 0.4 秒続いたら「地上」
//   2026-10-27 2回目：降下の終わりに白い建物の上をゆっくり通ると、0.75・5回では「地上」になり、着地の約10秒前から枠が出た（録画 00.47.40）
//   → 基準を厳しく。今夜の録画6本で、シップ・降下中は一度も「地上」にならず、着地は 0.2〜0.4 秒で「地上」
const TAC_GLYPH_RECT = { anchor: 'left', x: 580, y: 972, w: 52, h: 56 };
let tacPrev = null, tacPrevFrac = -1, tacPrevT = 0, tacOkSince = -1;
async function readTacGlyph(frame) {
  const now = performance.now();
  if (tacPrev && now - tacPrevT < 28) return tacOkSince >= 0 && now - tacOkSince >= 400;   // 約30コマ/秒で比べる（60コマ/秒だと動く景色でも重なりが大きい）
  const rows = await regionRows(frame, TAC_GLYPH_RECT), W = TAC_GLYPH_RECT.w, m = new Uint8Array(W * rows.length);
  let n = 0;
  rows.forEach((r, y) => { for (let x = 0; x < W; x++) { const i = x * 4, mn = Math.min(r[i], r[i + 1], r[i + 2]), mx = Math.max(r[i], r[i + 1], r[i + 2]); if (mn > 185 && mx - mn < 40) { m[y * W + x] = 1; n++; } } });
  let inter = 0, uni = 0;
  if (tacPrev) for (let i = 0; i < m.length; i++) { if (m[i] & tacPrev[i]) inter++; if (m[i] | tacPrev[i]) uni++; }
  const frac = n / m.length, iou = uni ? inter / uni : 0;
  const ok = !!tacPrev && frac >= 0.14 && frac <= 0.40 && iou >= 0.85 && Math.abs(frac - tacPrevFrac) <= 0.03;
  tacPrev = m; tacPrevFrac = frac; tacPrevT = now;
  if (!ok) tacOkSince = -1; else if (tacOkSince < 0) tacOkSince = now;
  return tacOkSince >= 0 && now - tacOkSince >= 400;
}
async function analyzeFrame(frame) {
  const g = cfg.regions;
  frameN++;
  const [hp, shield, anchor, badge, band] = await Promise.all([regionRows(frame, g.hp), regionRows(frame, g.shield), regionRows(frame, g.anchor), g.badge ? regionRows(frame, g.badge) : null, regionRows(frame, BAND)]);
  const shieldRaw = shield.map(r => r.slice());   // 段の並びを見る用（ふたの分を黒くする前）
  maskShield(shield, cfg.bars.shield, lidSegs.player);
  const ad = new Uint8ClampedArray(anchor.length * g.anchor.w * 4);
  anchor.forEach((row, i) => ad.set(row, i * g.anchor.w * 4));
  const reading = R.analyzeBars({ hp: { rows: hp, width: g.hp.w }, shield: { rows: shield, width: g.shield.w }, anchor: { data: ad } }, barsFor(cfg.bars));
  snapMaskEdge(reading, cfg.bars.shield, lidSegs.player);
  if (layout === 4 && reading.shieldSegments > 4) { reading.shieldSegments = 4; reading.shieldPoints = Math.min(reading.shieldPoints, 100); }
  reading.layout = layout;
  // HUD が本当に出ているか：アーマーレベルの丸（白い数字＋暗い輪）と、HP・シールドバー（ダウン中は黄・赤）が両方そろっているときだけ
  let lv = 0;
  if (badge) {
    const b = g.badge, cx = b.w / 2, cy = b.h / 2, hc = cfg.hudCheck || {};
    let digit = 0, ringW = 0;
    badge.forEach((row, y) => { for (let x = 0; x < b.w; x++) { const i = x * 4, mn = Math.min(row[i], row[i + 1], row[i + 2]), d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d < 11 && mn > 200) digit++; else if (d >= 13.5 && d <= 17 && mn > 200) ringW++; } });
    let colored = 0; for (const row of hp) for (let x = 0; x < g.hp.w; x++) { const i = x * 4, rr = row[i], gg = row[i + 1], bb = row[i + 2]; if (rr > 170 && bb < 90 && (gg < 90 || gg > 150)) colored++; }
    const badgeOk = digit >= (hc.digitMin ?? 110) && digit <= (hc.digitMax ?? 300) && ringW <= (hc.ringWhiteMax ?? 6);
    let evo = 0; for (let i = 0; i < ad.length; i += 4) if (Math.min(ad[i], ad[i + 1], ad[i + 2]) > cfg.bars.anchor.minValue) evo++;
    // 塗りがぎっしり詰まっているときだけバーとみなす（デス画面などで同じ場所に出る白い文字・ID をバーと読まない）
    const dense = (rows, ext, test) => { if (ext <= 4) return false; let n = 0, t = 0; for (const row of rows) for (let x = 0; x < ext; x++) { const i = x * 4; t++; if (test(row[i], row[i + 1], row[i + 2])) n++; } return n / t >= 0.75; };
    const shTier = R.SHIELD_TIERS.find(t => t.name === reading.shieldTier);
    const hpSolid = dense(hp, reading.hpPx, R.isHpFill);
    const shSolid = !!shTier && dense(shield, reading.shieldPx, (r, gg, b) => R.classifyShield(r, gg, b) === shTier);
    // 2026-10-24：タイトル画面の青い背景をシールドの青と、デスクトップの黄色い壁紙をダウン中の出血バーと見まちがえて枠がちらついた。
    //   本物の HUD では、シールドだけ読めて HP が 0 ということはない → シールドだけのときは HP も少しは読めていること
    //   ダウン中の出血バーは HP の範囲の上下に少しすき間が残る → 範囲がまるごと同じ色なら壁紙などとみなす
    const knockLike = colored >= g.hp.w * 2 && colored <= g.hp.w * g.hp.h * 0.92;   // 本物の出血バーは満タンでも範囲の約8割。壁紙は10割
    const bars = hpSolid || (shSolid && reading.hpPx > 0) || knockLike;
    // 3つの目印（アーマーの丸・進化ゲージの文字・HP/シールドバー）のうち2つ以上で「出ている」。
    // 画面の揺れ（被弾・アークスター）で1つずれても消えないように
    const evoOk = evo >= cfg.bars.anchor.minPixels, bandOk = bannerDark(band);
    const votes = (badgeOk ? 1 : 0) + (evoOk ? 1 : 0) + (bars ? 1 : 0);
    // 通常：3つのうち2つ（画面の揺れで1つずれても消えない）。イベントモード：バーが読めてまわりがバナーの暗い地なら出ている
    // バーは「まわりがバナーの暗い地」のときだけ本物とみなす（降下地点選択などの明るい画面の白をバーと読まない）。
    // 画面の揺れでバーがずれた一瞬は、アーマーの丸と進化ゲージの文字の両方が見えていれば出ているまま（値は動かさない）
    // 2026-10-25：チームデスマッチ等のバナーは半透明の灰色で、明るい景色（雪・白い壁）の前では「暗い地」にならず、枠が消えたり出たりした
    //   → まわりが暗くなくても、HP とシールドがぎっしり塗られていて、シールドの段の区切り（暗いすき間）が本物の並びどおりに見えればバー
    lv = layoutVote(shieldRaw);
    // 2026-11-03：世界観枠＋背景画像のように、こちらの枠がバナーの暗い地を明るい絵で覆うと bandOk が出にくい。
    //   シールドが割れて（shSolid なし）被弾の赤が出たとき、バーは見えているのに「消えた」になり、枠が出たり消えたりした（録画 11/03 02.09・02.15・02.36）
    //   → 直前（4 秒以内）に確かに出ていたなら、HP バーがぎっしり塗られている（または出血バー）あいだは出ているまま
    const tNow = performance.now();
    const strong = bars && (bandOk || (hpSolid && shSolid && lv > 0));
    if (strong) lastStrongT = tNow;
    const barsReal = strong || (bars && (hpSolid || knockLike) && tNow - lastStrongT < 4000);
    reading.hudVisible = barsReal || (badgeOk && evoOk);
    reading.barsOk = barsReal;
    reading.knockBar = knockLike;   // ダウン中の出血バー（黄・赤）
    reading.badge = { digit, ringW, evo, colored, bandOk };
    // 2026-10-25（ユーザー案）：バナー左上のシールド進化の丸があるか。イベントでもバトロワと同じバナー（上の帯つき）が出ることがあり、
    //   丸があればバトロワ用の枠、無ければイベント用の枠にする。丸の中の白い数字・紋章が digit（録画：丸あり 128〜153／丸なし 13〜31）
    // 自分の枠で丸の下半分が隠れても足りるよう基準は低め。バーが本当に見えているときだけ、10回続けて同じなら切り替え
    if (barsReal) { const raw = digit >= 50 && digit <= 260;   // 丸の中は白が4割ほど。明るい景色（雪など）で全部白なら丸ではない
      if (raw !== evoCircle) { if (++evoN >= 10) { evoCircle = raw; evoN = 0; } } else evoN = 0; }
    reading.evoCircle = evoCircle;
  }
  // 2026-10-26：メニューを開いた瞬間に枠の残像が見えた（ゲームの HUD が消えてから 3〜5 コマ）。
  //   出ている→消えたと分かったら、残りの読み取り（ウルト・味方・アイテム欄など）を待たずにすぐ知らせる
  if (wasVisible && !reading.hudVisible) self.postMessage({ type: 'reading', reading: Object.assign({}, reading, { early: true }), t: performance.now() });
  wasVisible = !!reading.hudVisible;
  if (reading.hudVisible && reading.barsOk !== false) detectLayout(badge ? lv : layoutVote(shieldRaw));   // HUD のバーが本当に見えているときだけ（白い壁などで切り替えない）
  // 2026-11-01（ユーザー指摘・録画 06.59.41）：バトロワのあとにイベントへ行くと、シップ内ではバトロワ用の枠のままだった（降りた後は正しい）。
  //   並びは一度決まると紋章を見なくなり、シップ内はシールドが空で段の区切りでも決められないため。
  //   → 5段のあいだはずっと紋章を見る（イベントの紋章は 250〜310 点、バトロワは最大 20 点）。紋章が3回続けば4段に
  if (reading.hudVisible && reading.barsOk !== false && (!layoutDecided || layout !== 4)) await readEventEmblem(frame);
  await readModeKind(frame, reading, performance.now());
  reading.modeKind = modeKind;
  reading.championFire = await CHAMP.check(frame, reading, frameN, performance.now());   // 2026-10-30：優勝の帯（HUD が消えているときだけ見る。中身は champion.js）
  if (cfg.deathbox && frameN % 2 === 0) reading.deathbox = await readDeathbox(frame);
  if (reading.hudVisible) {
    const exRows = await regionRows(frame, EXTRA_RECT), nowX = performance.now();
    readShieldExtra(exRows, reading, nowX);
    // readLidHoles(exRows, reading);   // 2026-10-26：シールドのふたをなくしたので使わない（今後のアップデートで見直す）
  }
  else hudHiddenAt = performance.now();
  if (cfg.ultIcon) reading.ultIcon = await readUltIcon(frame);
  reading.kuEv = await KU.check(frame, reading, performance.now());   // 2026-11-02：キル・アシスト・味方のキル（ランク）・ウルト（0.25秒に1回。中身は killult.js）
  if (reading.hudVisible) reading.dualTac = await readDualTac(frame);   // 2026-10-26：毎コマ（切り替えを速く）
  if (reading.hudVisible) reading.octBar = await readOctBar(frame);   // 2026-10-28：オクタンの2本目のゲージ
  if (reading.hudVisible) reading.octOut = await readOctOut(frame);   // 2026-10-30：ゲージの欄の黄色いふち（すべり出し・出きり）
  if (reading.hudVisible) reading.wBanner = await readWeaponBanner(frame);   // 2026-10-31：武器の上の黄色い帯
  if (reading.hudVisible) reading.tacGlyph = await readTacGlyph(frame); else { tacPrev = null; tacOkSince = -1; }
  if (cfg.compass && frameN % (cfg.compass.every || 4) === 0) {
    // 方位計の目盛り：白い短い縦線（上下は暗い）がいくつあるか
    const c = cfg.compass, rows = await regionRows(frame, { anchor: 'center', x: c.x, y: c.y, w: c.w, h: c.h });
    const wht = (row, x) => Math.min(row[x * 4], row[x * 4 + 1], row[x * 4 + 2]) > 190;
    let ticks = 0, last = -10;
    for (let x = 1; x < c.w - 1; x++) {
      if (wht(rows[5], x) && wht(rows[7], x) && !wht(rows[0], x) && !wht(rows[c.h - 1], x) && !wht(rows[6], x - 1 > 0 ? x - 3 : x) ) { if (x - last > 6) ticks++; last = x; }
    }
    // 2026-10-30（ユーザー指摘：ミックステープのガンゲームで方位の枠が出る・録画 02.43.15）：ガンゲームは方位計の代わりに
    //   武器の進み具合のバー（白い短い横線「- - -」と武器の絵）があり、横線の左はしを目盛りと数えて 6 本以上になっていた。
    //   白い横線のかたまり（長さ 6〜14px）が、方位計では 10〜58 個、ガンゲームのバーでは 160〜240 個 → 120 個以上なら方位計なし
    let dashes = 0;
    for (const row of rows) { let x = 0; while (x < c.w) { if (wht(row, x)) { const s = x; while (x < c.w && wht(row, x)) x++; if (x - s >= 6 && x - s <= 14) dashes++; } else x++; } }
    reading.gunBar = dashes >= 120;   // ガンゲームのバーがある＝試合中（ミニマップの判定に使う）
    if (dashes >= 120) ticks = 0;
    reading.compass = ticks;
    // 2026-11-01（機能の洗い出しで発見・録画 11/01 06.01〜06.05）：チームデスマッチは方位計もガンゲームのバーも無いので、ミニマップの枠が出なかった。
    //   TDM は画面の上の真ん中に、青（味方）とオレンジ（敵）のスコアの枠がある（録画：青・オレンジとも約3100点。バトロワ・イベントは青0〜540・オレンジ0）
    //   → 両方 1200 点以上なら試合中とみなしてミニマップの枠を出す（コントロールの点数の枠も同じ色で、そちらでも出る）
    if (ticks < 6 && !reading.gunBar) {
      const sr = await regionRows(frame, SCORE_RECT);
      let bl = 0, or = 0;
      for (const row of sr) for (let x = 0; x < SCORE_RECT.w; x++) {
        const i = x * 4, r = row[i], g = row[i + 1], b = row[i + 2];
        if (x < 125 && b > g && g > r && b - r > 60 && b > 120) bl++;
        else if (x >= 130 && r > g && g > b && r - b > 70 && r > 140) or++;
      }
      reading.scoreBar = bl >= 1200 && or >= 1200;
    } else reading.scoreBar = false;
    reading.mapArrow = await readMapArrow(frame);
  }
  if (cfg.mates && frameN % every(cfg.mateFps) === 0) reading.mates = await readMates(frame);
  if (cfg.peeks && frameN % every(cfg.peekFps) === 0) { diagItem = ''; reading.peeks = await readPeeks(frame); if (diagItem) reading.itemPx = diagItem; if (reading.peeks) { if (reading.peeks.aqua1) itemSeenAt = performance.now(); else itemGoneAt = performance.now(); } }
  if (cfg.chat && chatOn && frameN % every(cfg.chat.fps || 1.5) === 0) reading.chat = await readChat(frame);
  let raw = null;
  if (diag) {
    // 診断用：読んだピクセルそのもの（シールド行→HP行→アイコン行）を幅 W に揃えて渡す
    const W = Math.max(g.hp.w, g.shield.w, g.anchor.w), rows = [...shield, ...hp, ...anchor];
    raw = new Uint8ClampedArray(W * rows.length * 4);
    rows.forEach((row, i) => raw.set(row, i * W * 4));
  }
  return { reading, raw };
}
