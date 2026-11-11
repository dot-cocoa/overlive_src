/*
 * AQUA KAWAII HUD — Windows 用オーバーレイ（ゲーム外で動作）
 * - 透明・枠なし・最前面・クリック透過のウィンドウを1枚出すだけ。
 * - ゲームプロセスへの注入、メモリ読み書き、入力フックは一切行わない。
 * - 値の入力: 画面読み取り（OBS と同じ画面キャプチャで、HP・シールドバーの見た目を読む）
 *            / テスト操作パネル / ローカルHTTP API (127.0.0.1 のみ)
 */
const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage, session, desktopCapturer, shell, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');

const argv = process.argv.slice(1);
// ---- テストモード（2026-10-31）：画面の代わりに録画した動画を読み取らせて、結果をファイルに書き出す ----
//   --test-video=動画のパス  --test-out=結果を書くフォルダ（省略時は動画の隣の _testlogs）  --test-speed=再生速度（既定 1）
//   --test-expect=期待する結果の .expect.json（省略時は動画と同じ名前の .expect.json）
//   ゲームの確認・起動確認・二重起動の確認・操作パネルは使わず、小さなウィンドウで HUD を表示し、動画が終わったら自動で終了する
const TEST_VIDEO = (() => { const a = argv.find(s => s.startsWith('--test-video=')); return a ? a.split('=').slice(1).join('=').replace(/^"|"$/g, '') : ''; })();
const TEST_DIR = (() => {
  if (!TEST_VIDEO) return '';
  const a = argv.find(s => s.startsWith('--test-out='));
  const base = a ? a.split('=').slice(1).join('=').replace(/^"|"$/g, '') : path.join(path.dirname(TEST_VIDEO), '_testlogs');
  const d = new Date(Date.now() + 9 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  return path.join(base, path.basename(TEST_VIDEO).replace(/\.[^.]+$/, '') + '_' + d);
})();
if (TEST_VIDEO) {
  try { fs.mkdirSync(TEST_DIR, { recursive: true }); } catch { /* 下で書けなければ記録されないだけ */ }
  // --test-shots：HUD の見た目を画像で残す（画面と同じ大きさの1枚のウィンドウで描き、状態が変わるたびに撮る）
  //   --test-real：本番と同じ「小さな透明ウィンドウを部品ごとに並べる」形で動かす（配信用ページへの中継も本番どおり）
  if (!argv.includes('--test-real')) argv.push(argv.includes('--test-shots') ? '--single-window' : '--windowed');
  argv.push('--no-game-check', '--no-safety', '--no-control', '--no-display-watch', '--no-update-check', '--diag', '--diag-dir=' + TEST_DIR, '--log-states=' + path.join(TEST_DIR, 'states.json'));
}
const flag = (name) => argv.includes('--' + name);
const opt = (name, def) => { const a = argv.find(s => s.startsWith('--' + name + '=')); return a ? a.split('=').slice(1).join('=') : def; };

// 2026-10-30：配信用の窓がゲームの後ろに隠れると、Windows の「隠れた窓は描かない」仕組みで 30fps 前後に落ちていた。
// 隠れていても描き続けるようにする（HUD の窓はいつも見えているので影響なし）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const ASSETS = path.join(__dirname, 'assets');
// グレード（体験版／通常版／カスタム版／管理用）。使える機能はここで決まる（edition.js）
const ED = require('./edition.js');
const EDITION = ED.load(__dirname, argv);
// 設定はグレードごとに別の場所に保存する（体験版と製品版を同じPCで使っても混ざらない）
app.setPath('userData', path.join(app.getPath('appData'), EDITION.appId));
const SHOP_URL = 'https://kawaiiframeworks.booth.pm/';

// BOOTH などのページを既定のブラウザで開く。shell.openExternal で開けなかったときは explorer.exe で開き直す
// （2026-10-24：体験版で「BOOTH を開く」「BOOTH で見る」を押しても何も起きなかったため）
function openUrl(url) {
  if (!/^https:\/\/[\w.\-\/?=&%#~:+]+$/.test(url)) return;
  if (process.platform !== 'win32') { shell.openExternal(url).catch((err) => console.error('[open]', err)); return; }
  // 2026-10-24：explorer.exe に渡すと「アプリケーションが見つかりません」になる PC があった（https の既定のアプリが未設定）。
  // 既定のブラウザが登録されていればそれで開き、無ければ Windows に必ず入っている Edge で開く。それも駄目なら URL をコピーして知らせる
  const viaEdge = () => {
    try {
      const p = spawn('cmd.exe', ['/d', '/s', '/c', `start "" msedge "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
      p.on('error', copyAndTell); p.on('exit', (code) => { if (code) copyAndTell(); }); p.unref();
    } catch { copyAndTell(); }
  };
  const copyAndTell = () => {
    try { require('electron').clipboard.writeText(url); } catch { /* なし */ }
    dialog.showMessageBox({ type: 'info', title: 'OverLIVE', message: 'ブラウザを開けませんでした', detail: 'ページのアドレスをコピーしました。ブラウザのアドレス欄に貼り付けて開いてください。\n' + url }).catch(() => {});
  };
  execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { windowsHide: true }, (err, out) => {
    const progId = !err && /ProgId\s+REG_SZ\s+(\S+)/.exec(String(out));
    if (!progId) return viaEdge();
    shell.openExternal(url).catch((e) => { console.error('[open]', e); viaEdge(); });
  });
}
const UPDATE_URL = '';   // 更新情報（JSON）の置き場所。決まったら入れる。空なら確認しない
const API_PORT = +opt('port', 47811);

// キャラクター：assets/characters/<フォルダ名>/ に表情9種と character.json。フォルダを増やせば2人目以降を追加できる
// 枠のデザイン：キャラ専用（auto）か、飾りなしの単色（assets/frames/<色>/）
const FRAME_STYLES = {
  aqua:   { label: '水色', glow: '60,200,255' },   blue:  { label: '青', glow: '70,120,255' },
  purple: { label: '紫', glow: '150,80,255' },    pink:  { label: 'ピンク', glow: '255,90,170' },
  red:    { label: '赤', glow: '240,40,60' },     orange:{ label: 'オレンジ', glow: '255,130,30' },
  yellow: { label: '黄色', glow: '255,205,20' },  green: { label: '緑', glow: '40,220,110' },
  white:  { label: '白', glow: '200,215,235' },   black: { label: '黒', glow: '110,115,130' },
  cyberpunk: { label: 'サイバーパンク', glow: '255,40,160' },   // 飾りつきの特別な枠（形と大きさも違う → 自分の parts.json の位置を使う）
  thunder:   { label: '雷ネオン', glow: '80,200,255' },     // 同上（雷・電気のネオン）
  vaporwave: { label: 'ヴェイパーウェイヴ', glow: '255,113,206' },   // 2026-10-28 試作：動く部分は SVG（parts.json の svg / _theme）
  steampunk: { label: 'スチームパンク', glow: '240,178,74' },         // 同上（歯車・蒸気）
  glitch: { label: 'グリッチ', glow: '0,240,255' },                    // 2026-10-28 かっこいい系パック（DIGITAL）
  syncsuit: { label: 'SYNC SUIT', glow: '255,122,26' },                // 同上（DIGITAL）
  bento: { label: 'Bento', glow: '10,132,255' },                        // 同上（CLASSIC）
  aquapocket: { label: 'AQUA♡POCKET', glow: '255,122,184' },          // 2026-10-28 かわいい系パック（KAWAII CHROME）
  chromebloom: { label: 'CHROME BLOOM', glow: '232,140,224' },        // 同上（KAWAII CHROME）
  y3k: { label: 'Y3K', glow: '217,204,255' },                         // 同上（DREAMY）
};
/** 枠フォルダが自分の位置・大きさを持つか（parts.json に "_ownGeometry": true）。持つならその parts.json を返す */
function ownGeometry(framesDir) {
  if (!framesDir || !framesDir.startsWith('frames/')) return null;
  try { const j = JSON.parse(fs.readFileSync(path.join(ASSETS, framesDir, 'parts.json'), 'utf8')); return j && j._ownGeometry ? j : null; } catch { return null; }
}
/** グレードで使える枠の選び方だけを通す（auto=キャラ専用の飾りつき／plain=飾りなし／色の名前=好きな色） */
function allowedFrameStyle(v) {
  if (!v || v === 'auto') return 'auto';
  if (v === 'plain') return EDITION.ornament ? 'plain' : 'auto';
  if (FRAME_STYLES[v]) return EDITION.colors ? v : (EDITION.ornament ? 'plain' : 'auto');
  return 'auto';
}
const plainTheme = (id) => { const g = FRAME_STYLES[id].glow; return { flow: `rgba(${g},.75)`, nameGlow: `rgba(${g},.95)`, sparkle: ['#fff', `rgb(${g})`] }; };
/** 実際に使う枠フォルダと色（キャラ＋設定から決める） */
function effectiveFrames(ch, st) {
  let fs_ = allowedFrameStyle(st.frameStyle);
  if (fs_ === 'plain') fs_ = (ch && ch.plain) || 'aqua';   // 飾りなし：そのキャラに近い色のシンプルな枠
  if (fs_ && fs_ !== 'auto' && FRAME_STYLES[fs_] && fs.existsSync(path.join(ASSETS, 'frames', fs_, 'parts.json')))
    return { frames: `frames/${fs_}/`, theme: Object.assign({}, (ch && ch.theme) || {}, plainTheme(fs_)) };
  if (ch && ch.custom) return { frames: fs.existsSync(path.join(ASSETS, 'frames', 'aqua', 'parts.json')) ? 'frames/aqua/' : null, theme: Object.assign({}, ch.theme, plainTheme('aqua')) };   // マイキャラの既定は水色
  return { frames: (ch && ch.frames) || null, theme: (ch && ch.theme) || null };
}
const MYCHARA = require('./mychara.js');
// 2026-11-02：ドキュメントの中のフォルダ名を新しい名前（OverLIVE）に。旧名のフォルダがあれば、起動時に1回だけ新しい名前へ移す
const DOC_DIR = () => path.join(app.getPath('documents'), 'OverLIVE');
const LOG_ROOT = () => path.join(app.getPath('documents'), 'OverLIVE-logs');
function migrateOldDocDirs() {
  const docs = app.getPath('documents');
  for (const [oldName, newName] of [['AquaKawaiiHUD', 'OverLIVE'], ['AquaKawaiiHUD-logs', 'OverLIVE-logs']]) {
    const from = path.join(docs, oldName), to = path.join(docs, newName);
    try {
      if (!fs.existsSync(from)) continue;
      if (!fs.existsSync(to)) { fs.renameSync(from, to); continue; }
      // 両方ある：新しい方に無いものだけ移す（同じ名前のファイルは上書きしない）
      const move = (a, b) => {
        for (const n of fs.readdirSync(a)) {
          const s = path.join(a, n), d = path.join(b, n);
          if (!fs.existsSync(d)) { try { fs.renameSync(s, d); } catch { /* 使用中などは残す */ } }
          else if (fs.statSync(s).isDirectory() && fs.statSync(d).isDirectory()) move(s, d);
        }
      };
      move(from, to);
    } catch (e) { console.error('[migrate]', oldName, e); }   // 移せなくても起動は続ける（新しいフォルダを使う）
  }
}
const MYCHARA_DIR = () => path.join(DOC_DIR(), 'マイキャラ');
const myCache = new Map();
// 飾りなしの枠にしたときの色（キャラに近い色）
const PLAIN_COLOR = { aqua: 'aqua', yoshua: 'blue', mea: 'purple', mel: 'pink', akira: 'yellow', racule: 'red', rei: 'orange', sora: 'yellow', elena: 'pink' };
const FACE_KEYS = ED.FACES8;   // 表情は8種（チャンピオン表情はなし：優勝画面ではゲームのUIが消えるため）
function editionFaces(faces) {
  // 体験版：表情を3種にしぼる（ほかの表情のときは近い表情を出す）
  if (!faces || !EDITION.faces) return faces;
  const out = {};
  for (const k of FACE_KEYS) out[k] = faces[EDITION.faces[k] || 'normal'] || faces.normal;
  return out;
}
function listCharacters() {
  const all = listBuiltin();
  const out = {};
  // キャラなし（枠だけ）：通常版から
  // 製品版のキャラはヨシュア＋仲間7人の8人。AQUA は体験版だけのキャラ（2026-10-28 ユーザー決定）
  const HIDDEN = new Set(EDITION.id === 'trial' ? [] : ['aqua']);
  const FIRST = EDITION.id === 'trial' ? 'aqua' : 'yoshua';
  const ents = Object.entries(all).sort((a, b) => (b[0] === FIRST) - (a[0] === FIRST));   // 最初のキャラを一覧の先頭に
  for (const [id, c] of ents) if (!HIDDEN.has(id) && (EDITION.characters === 'builtin' || EDITION.characters.includes(id))) out[id] = c;
  if (EDITION.noChara) out.__none = { id: '__none', displayName: '', faces: null, frames: null, theme: null, art: null, noChara: true, plain: 'aqua' };
  if (EDITION.myChara) { try { Object.assign(out, MYCHARA.scan(MYCHARA_DIR(), nativeImage, myCache)); } catch (err) { console.error('[mychara]', err); } }
  for (const c of Object.values(out)) c.faces = editionFaces(c.faces);
  return out;
}
const DEFAULT_CHAR = EDITION.id === 'trial' ? 'aqua' : 'yoshua';   // 体験版は AQUA、製品版はヨシュアが最初のキャラ
function listBuiltin() {
  const dir = path.join(ASSETS, 'characters');
  const out = {};
  // 看板キャラ AQUA（assets/v4 の表情と枠）。一覧の先頭に出す
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
    const faces = {};
    for (const k of FACE_KEYS) if (mf.faces[k]) faces[k] = mf.faces[k].file;
    if (faces.normal) out.aqua = { id: 'aqua', displayName: 'AQUA', faces, frames: null, theme: null, art: null, plain: 'aqua', star: true };
  } catch { /* なし */ }
  try {
    for (const id of fs.readdirSync(dir)) {
      const p = path.join(dir, id);
      if (!fs.statSync(p).isDirectory()) continue;
      let info = {};
      try { info = JSON.parse(fs.readFileSync(path.join(p, 'character.json'), 'utf8')); } catch { /* 無くても可 */ }
      const faces = {};
      for (const k of FACE_KEYS) {
        const f = path.join(p, 'faces', `face_${k}.png`);
        if (fs.existsSync(f)) faces[k] = `characters/${id}/faces/face_${k}.png`;
      }
      if (!faces.normal) continue;
      for (const k of FACE_KEYS) if (!faces[k]) faces[k] = faces.normal;   // 無い表情は通常で代用
      // frames/ があれば枠もそのキャラ専用の色（assets/v4 と同じファイル名で置く）
      const frames = fs.existsSync(path.join(p, 'frames', 'parts.json')) ? `characters/${id}/frames/` : null;
      // full.png があればチャンピオンのときに全身絵のカットインを出す
      const art = fs.existsSync(path.join(p, 'full.png')) ? `characters/${id}/full.png` : null;
      if (id === 'aqua') continue;
      out[id] = { id, displayName: info.displayName || id, faces, frames, theme: info.theme || null, art, plain: info.plain || PLAIN_COLOR[id] || 'aqua' };
    }
  } catch { /* フォルダが無い */ }
  return out;
}
function loadConfig() {
  const official = path.join(ASSETS, 'manifest.json');
  const manifestPath = fs.existsSync(official) ? official : path.join(ASSETS, 'manifest.provisional.json');
  const characters = listCharacters();
  const st = readSettingsSafe();
  const character = currentCharId(characters, st);
  const eff = effectiveFrames(characters[character], st);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // グレードで出さないパーツは、枠も窓（透明ウィンドウ）も作らない
  // 2026-10-28（ユーザー指摘）：あとから足した枠（オクタン用の tactical2・ult2、ワイルドカード等の味方 mate1_m・mate2_m）がここに無く、
  //   体験版でも消されずにオクタンだけ戦術・ウルトの枠が出ていた → それぞれのグループに入れる
  const PART_OF = { player: ['player', 'player_s', 'player_w', 'player_m', 'knock'], mates: ['mate1', 'mate2', 'mate1_m', 'mate2_m'], minimap: ['minimap'], compass: ['compass'], item: ['item'], tactical: ['tactical', 'tactical2'], ult: ['ult', 'ult2'], weapon: ['lalt', 'g', 'weapon'] };
  const keep = new Set(EDITION.parts.flatMap(k => PART_OF[k] || []));
  for (const n of Object.keys(manifest.parts)) {
    const grp = Object.keys(PART_OF).find(k => PART_OF[k].includes(n));
    if (grp && !keep.has(n)) delete manifest.parts[n];
  }
  if (!EDITION.parts.includes('mates')) delete manifest.chat;   // 体験版はチャット翻訳もなし
  const own = ownGeometry(eff.frames);   // サイバーパンクなど：部品の位置・大きさ・ふたも枠フォルダのものを使う
  if (own) for (const n of Object.keys(manifest.parts)) if (own[n] && own[n].layers) manifest.parts[n] = own[n];
  // 2026-10-28：世界観テーマの枠（ヴェイパーウェイヴ等）：動く部分の SVG・CSS・共通の定義は、ここで読んで HUD に渡す（HUD 側で file:// を読まなくて済むように）
  if (own) {
    const rd = (f) => { try { return fs.readFileSync(path.join(ASSETS, f), 'utf8'); } catch { return null; } };
    for (const n of Object.keys(manifest.parts)) { const q = manifest.parts[n]; if (q && typeof q.svg === 'string') q.svgText = rd(q.svg); }
    if (own._theme) { manifest.themeCss = own._theme.css ? rd(own._theme.css) : null; manifest.themeDefs = own._theme.defs ? rd(own._theme.defs) : null; }
  }
  const chObj = characters[character];
  const background = EDITION.background ? backgroundFor(manifest, eff.frames, true) : null;
  return {
    background,
    edition: { id: EDITION.id, label: EDITION.label, title: EDITION.title, parts: EDITION.parts, mark: EDITION.mark, timeLimitMin: EDITION.timeLimitMin,
      noChara: EDITION.noChara, ornament: EDITION.ornament, colors: EDITION.colors, myChara: EDITION.myChara, background: EDITION.background, test: EDITION.test, sparkles: EDITION.sparkles, chat: !!manifest.chat },
    manifest,
    characters, character, framesDir: eff.frames, themeEff: eff.theme,
    frameStyles: Object.fromEntries(Object.entries(FRAME_STYLES).map(([k, v]) => [k, { label: v.label, color: `rgb(${v.glow})`, ok: fs.existsSync(path.join(ASSETS, 'frames', k, 'parts.json')) }])),
    myCharaDir: MYCHARA_DIR(),
    reader: JSON.parse(fs.readFileSync(path.join(ASSETS, 'reader.json'), 'utf8')),
    options: {
      demoBg: flag('demo-bg'),
      screenRead: !flag('no-read'),          // 画面読み取り（既定で有効）
      showRegions: flag('show-regions'),     // 読み取り範囲を点線で表示
      minimap: !flag('no-minimap') && !(Array.isArray(st.hidden) && st.hidden.includes('minimap')),
      perf: flag('perf'),
      idleMotion: st.idleMotion !== false && !flag('still'),
      diag: flag('diag'),                    // 診断ログ（誤判定の調査用）
      // 枠に表示する名前。自分で入れた名前は空欄も OK（背景画像のロゴを見せたいとき）
      playerName: st.playerNameCustom ? String(st.playerName || '') : (chObj ? chObj.displayName : 'AQUA'),
      noChara: !!(chObj && chObj.noChara),
      lids: readSettingsSafe().lids !== false && !flag('no-lids'),
      hidden: Array.isArray(st.hidden) ? st.hidden : [],                // メニューで「表示しない」にした項目
      frameStyle: allowedFrameStyle(st.frameStyle),
      fx: readSettingsSafe().fx !== false && !flag('no-fx'),
      championFx: championFxMode(),          // チャンピオン演出：classic（いつもの）/ jackpot（大当たり）/ off
      sparkles: EDITION.sparkles,          // エフェクト（光の流れ・キラキラ）
      chatTranslate: !!manifest.chat && readSettingsSafe().chatTranslateOn === true && !flag('no-chat'),   // チャットの翻訳表示（試験的。既定は OFF、メニューで ON）
      testVideo: TEST_VIDEO ? require('url').pathToFileURL(TEST_VIDEO).href : '',   // テストモード：画面の代わりに読み取る動画
      testSpeed: +opt('test-speed', 1),
      pendingMs: opt('pending-ms', '') !== '' ? +opt('pending-ms', '') : undefined,
      visOpenFrames: opt('vis-open-frames', '') !== '' ? +opt('vis-open-frames', '') : undefined,   // テスト用：HUD が出たと判断するコマ数（既定 3）   // テスト用：演出の待ち時間（既定 250ms）
      fxSlow: +opt('fx-slow', 1),                                       // 確認用：エフェクトの再生速度（8 で 1/8 倍速）  // 水色の窓：ゲーム側に表示がないときはふたで閉じる
    },
  };
}

let overlay = null, control = null, tray = null, badge = null;
// 問い合わせ用：最近のエラーを5件だけ覚えておく（中身は動作のエラー文だけ。個人情報は入らない）
const recentErrors = [];
{ const orig = console.error.bind(console); console.error = (...a) => { try { recentErrors.push(new Date().toLocaleTimeString('ja-JP') + ' ' + a.map(x => (x && x.message) || String(x)).join(' ').slice(0, 160)); if (recentErrors.length > 5) recentErrors.shift(); } catch { /* 記録できなくても続行 */ } orig(...a); }; }
let overlayOthers = [];
let hudOn = true;
const TOGGLE_KEY = () => (readSettingsSafe().toggleKey || 'Alt+H');   // Fn なしで押せるキー（60%キーボード対応）
const MENU_KEY = () => (readSettingsSafe().menuKey || 'Alt+M');   // メニュー（テスト操作パネル）の開閉
let quitting = false;
function currentCharId(chars, st) {
  const saved = st.character === 'nekoboru' ? 'yoshua' : st.character;   // 旧ねこぼる → ヨシュアに引き継ぎ
  return chars[saved] ? saved : (chars[DEFAULT_CHAR] ? DEFAULT_CHAR : Object.keys(chars).find(k => k !== '__none') || Object.keys(chars)[0]);
}
function readSettingsSafe() { try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch { return {}; } }
const overlays = () => [overlay, ...overlayOthers].filter(w => w && !w.isDestroyed());

/*
 * 安全のため、画面全体を覆うウィンドウは作らない。
 * - 下段の帯（プレイヤー枠〜武器枠）と、左上（ミニマップ枠）の2枚の小さな透明ウィンドウに分ける
 *   （Windows では画面ぴったりの透明ウィンドウが真っ黒になり、画面をふさぐことがあるため）
 * - 万一透明にならなくても、ふさがるのは画面の端だけで、ほかのアプリは操作できる
 */
function hudBounds(cfg, d) {
  // パーツの「win」ごとに、必要な範囲だけの小さな透明ウィンドウを作る
  const m = cfg.manifest, k = d.bounds.height / m.baseHeight, W = d.bounds.width, H = d.bounds.height, pad = 6;
  const toScreen = (x, y, a) => ({
    x: a[1] === 'l' ? x * k : a[1] === 'r' ? W - (m.baseWidth - x) * k : W / 2 + (x - m.baseWidth / 2) * k,
    y: a[0] === 't' ? y * k : H - (m.baseHeight - y) * k,
  });
  const boxes = {};
  const add = (win, x0, y0, x1, y1, a) => {
    const p = toScreen(x0, y0, a), q = toScreen(x1, y1, a);
    const b = boxes[win] || (boxes[win] = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
    b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, q.x); b.y1 = Math.max(b.y1, q.y);
  };
  for (const p of Object.values(m.parts)) add(p.win, p.x, p.y, p.x + p.w, p.y + p.h, p.anchor);
  if (m.parts.mate1) { const p = m.parts.mate1; add(p.win, p.x, p.y - 21, p.x + p.w, p.y, p.anchor); }   // ワイルドカード等で味方1の枠が 21px 上にずれる分
  // 2026-10-28（ユーザー指摘）：オクタンの2本目のゲージが出ている間、tactical2 の枠を右へ 100px のばす（hud.js の extendable）が、
  //   透明ウィンドウがのばす前の幅までしかなく、のびた分が切れてゲージに枠が付いていなかった → のばした分も窓に入れる
  if (m.parts.tactical2) { const p = m.parts.tactical2; add(p.win, p.x, p.y, p.x + p.w + 100, p.y + p.h, p.anchor); }
  if (EDITION.mark) add('left', 440, 922, 652, 954, 'bl');   // 体験版マーク（プレイヤー枠の右。体験版はアイテム枠の窓が無いので、ここだけ広げる）
  if (m.girl) { const xs = m.girl.clip.map(q => q[0]), ys = m.girl.clip.map(q => q[1]); add(m.girl.win, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), m.girl.anchor); }
  if (m.chat) add(m.chat.win, m.chat.x, m.chat.y, m.chat.x + m.chat.w, m.chat.y + m.chat.h, m.chat.anchor);
  if (flag('no-minimap')) delete boxes.minimap;   // メニューで隠したときは窓は作っておく（あとで表示に戻せるように）
  // 画面読み取りをする「left」を最初に
  return Object.entries(boxes).sort((a, b) => (a[0] === 'left' ? -1 : b[0] === 'left' ? 1 : 0)).map(([win, b]) => {
    const x = Math.max(0, Math.floor(b.x0) - pad), y = Math.max(0, Math.floor(b.y0) - pad);
    return { part: win, x: d.bounds.x + x, y: d.bounds.y + y, width: Math.min(W, Math.ceil(b.x1) + pad) - x, height: Math.min(H, Math.ceil(b.y1) + pad) - y };
  });
}

function makeOverlay(cfg, b, windowed) {
  if (flag('debug-chat')) console.log('[win]', b.part, b.x, b.y, b.width, b.height);
  const w = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: !windowed,
    backgroundColor: windowed ? '#202a38' : '#00000000',
    frame: windowed, resizable: windowed, movable: windowed, focusable: windowed,
    skipTaskbar: !windowed, hasShadow: false, alwaysOnTop: !windowed, show: false,
    title: EDITION.title,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  if (!windowed) {
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);          // クリックはすべて下のウィンドウ（ゲーム）へ
    // 画面キャプチャ（自分の読み取り・OBS）に枠を写さない。録画に枠も入れたいときは --capturable
    if (flag('protect')) w.setContentProtection(true);   // 既定は録画・配信に写す（NVIDIA の録画が止まるため）
  }
  w.loadFile(path.join(__dirname, 'renderer', 'hud.html'), { query: { part: b.part } });
  w.once('ready-to-show', () => w.showInactive());
  if (flag('debug-chat')) w.webContents.on('console-message', (e) => console.log('[' + b.part + ']', e.message));
  w.webContents.on('did-finish-load', () => { try { w.webContents.send('hud:input', { options: { gameActive } }); } catch { /* 閉じた */ } });
  return w;
}

function createOverlay() {
  const cfg = loadConfig();
  loadConfigCache = cfg;
  const windowed = flag('windowed');            // 開発・検証用：通常ウィンドウで全体を表示
  const single = windowed || !!opt('capture', '') || flag('single-window');   // 検証用：1枚で全体
  const d = targetDisplay();
  cfg.screen = { width: d.bounds.width, height: d.bounds.height };
  const parts = single
    ? [{ part: 'all', ...(windowed ? { x: 40, y: 40, width: 1280, height: 540 } : d.bounds) }]
    : hudBounds(cfg, d);
  cfg.parts = {};
  for (const p of parts) cfg.parts[p.part] = { x: p.x - d.bounds.x, y: p.y - d.bounds.y, width: p.width, height: p.height };
  cfg.single = single; cfg.windowed = windowed;
  ipcMain.handle('hud:getConfig', () => cfg);
  overlay = makeOverlay(cfg, parts[0], windowed);
  overlayOthers = parts.slice(1).map(p => makeOverlay(cfg, p, windowed));
  if (!windowed && !opt('capture', '') && !opt('bench', '')) createBadge(d);
}

// 右側の「表示 ON/OFF」ヒント（半透明・クリック透過）。基準 2560x1080 で x2222〜2552, y560〜
// 2026-10-24：y752 だとガンゲームの「次のキル」や武器の表示に重なったので上げた
function createBadge(d) {
  const k = d.bounds.height / 1080, w = Math.round(330 * k), h = Math.round((EDITION.timeLimitMin ? 162 : 112) * k);   // HUD の ON/OFF とメニューの2段（体験版は残り時間の3段目）
  badge = new BrowserWindow({
    x: d.bounds.x + d.bounds.width - Math.round(8 * k) - w, y: d.bounds.y + Math.round(560 * k), width: w, height: h,
    transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, title: 'AQUA HUD toggle',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, zoomFactor: k },
  });
  badge.setAlwaysOnTop(true, 'screen-saver');
  badge.setIgnoreMouseEvents(true);
  if (flag('protect')) badge.setContentProtection(true);
  badge.loadFile(path.join(__dirname, 'renderer', 'badge.html'));
  badge.once('ready-to-show', () => badge.showInactive());
}
function menuOpen() { return !!(control && !control.isDestroyed() && control.isVisible()); }
function badgeState() { return { on: hudOn, key: TOGGLE_KEY(), menuOn: menuOpen(), menuKey: MENU_KEY(), trial: EDITION.timeLimitMin ? { leftMin: trialLeftMin() } : null }; }
function sendBadge() {
  if (badge && !badge.isDestroyed()) badge.webContents.send('hud:input', { badge: badgeState() });
  if (control && !control.isDestroyed()) control.webContents.send('hud:input', { badge: badgeState() });
}
function toggleMenu() {
  if (menuOpen()) { control.hide(); setTimeout(sendBadge, 60); }
  else createControl();
}

// 画面全体のお祝いエフェクト（チャンピオン等）用の透明ウィンドウ。
// 出来事の瞬間だけ表示し、終わったら隠す。画面ぴったりの大きさは避ける（真っ黒になる対策）
let fxWin = null, fxTimer = null;
function ensureFxWindow() {
  if (fxWin && !fxWin.isDestroyed()) return fxWin;
  const d = targetDisplay(), b = d.bounds, ins = 2;
  fxWin = new BrowserWindow({
    x: b.x + ins, y: b.y + ins, width: b.width - ins * 2, height: b.height - ins * 2,
    transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, title: 'AQUA HUD fx',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  fxWin.setAlwaysOnTop(true, 'screen-saver');
  fxWin.setIgnoreMouseEvents(true);
  if (flag('protect')) fxWin.setContentProtection(true);
  const slow = +opt('fx-slow', 1);
  fxWin.loadFile(path.join(__dirname, 'renderer', 'fx_full.html'), { query: slow !== 1 ? { fxslow: String(slow) } : {} });
  return fxWin;
}
// 2026-11-03：チャンピオン演出の「大当たり（パチンコ風）」版。いつもの演出・出さない と設定で選ぶ（championFx: classic / jackpot / off）
let jpWin = null, jpTimer = null;
function ensureJackpotWindow() {
  if (jpWin && !jpWin.isDestroyed()) return jpWin;
  const d = targetDisplay(), b = d.bounds, ins = 2;
  jpWin = new BrowserWindow({
    x: b.x + ins, y: b.y + ins, width: b.width - ins * 2, height: b.height - ins * 2,
    transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, title: 'AQUA HUD jackpot',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  jpWin.setAlwaysOnTop(true, 'screen-saver');
  jpWin.setIgnoreMouseEvents(true);
  if (flag('protect')) jpWin.setContentProtection(true);
  jpWin.loadFile(path.join(__dirname, 'renderer', 'fx_jackpot.html'));
  return jpWin;
}
function playJackpot(art) {
  if (!hudOn) return;
  const w = ensureJackpotWindow();
  const go = () => { w.showInactive(); w.webContents.send('hud:input', { jackpot: { art } }); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
  if (jpTimer) clearTimeout(jpTimer);
  jpTimer = setTimeout(() => { if (jpWin && !jpWin.isDestroyed()) jpWin.hide(); }, 16000);   // 安全装置：必ず消す
}
ipcMain.on('hud:send', (_e, msg) => { if (msg && msg.jackpotDone && jpWin && !jpWin.isDestroyed()) { jpWin.hide(); if (jpTimer) clearTimeout(jpTimer); } });
function championFxMode() { const v = readSettingsSafe().championFx; if (v === 'jackpot' && EDITION.id === 'trial') return 'classic';   // 2026-11-03：体験版には大当たりを入れない（ユーザー決定）
  return v === 'jackpot' || v === 'off' ? v : 'classic'; }
function playFullFx(kind) {
  if (readSettingsSafe().fx === false || flag('no-fx')) return;
  if (kind === 'champion' && championFxMode() === 'off') return;
  let motif = 'cat', art = null, glow = null;
  try {
    const st = readSettingsSafe(), chars = listCharacters(), id = currentCharId(chars, st), c = chars[id];
    motif = (c && c.theme && c.theme.motif) || 'cat';
    if (c && c.art && kind === 'champion') art = /^data:/.test(c.art) ? c.art : '../assets/' + c.art;   // 全身絵のカットイン（fx_full.html から見た相対パス）
    const th = effectiveFrames(c, st).theme;
    glow = (th && th.nameGlow) || null;
  } catch { /* 既定の猫 */ }
  // 2026-10-30：配信（OBS・配信用の窓）にも同じお祝いを出す（renderer/fx_obs.html が受け取る）。自分の画面の HUD を消していても配信には出す
  charaPush({ fxFull: kind, motif, art, glow });
  if (kind === 'champion' && championFxMode() === 'jackpot') { playJackpot(art); return; }
  if (!hudOn) return;
  const w = ensureFxWindow();
  const go = () => { w.showInactive(); w.webContents.send('hud:input', { fxFull: kind, motif, art, glow }); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
  if (fxTimer) clearTimeout(fxTimer);
  fxTimer = setTimeout(() => { if (fxWin && !fxWin.isDestroyed()) fxWin.hide(); }, 8000 * +opt('fx-slow', 1));   // 安全装置：必ず消す
}
ipcMain.on('hud:send', (_e, msg) => { if (msg && msg.fxDone && fxWin && !fxWin.isDestroyed()) fxWin.hide(); });
function setHud(on) {
  hudOn = on;
  for (const w of overlays()) on ? w.showInactive() : w.hide();
  try { on ? COMMENTS.showWin() : COMMENTS.hideWin(); } catch { /* 起動直後 */ }
  try { on ? NOWPLAY.showWin() : NOWPLAY.hideWin(); } catch { /* 起動直後 */ }
  if (!on && fxWin && !fxWin.isDestroyed()) fxWin.hide();
  if (!on && jpWin && !jpWin.isDestroyed()) jpWin.hide();
  if (badge && !badge.isDestroyed()) badge.webContents.send('hud:input', { badge: badgeState() });
  if (control && !control.isDestroyed()) control.webContents.send('hud:input', { badge: badgeState() });
}
ipcMain.on('hud:toggle', () => setHud(!hudOn));

function createControl() {
  if (control && !control.isDestroyed()) { control.show(); control.focus(); sendBadge(); return; }
  // 下段の HUD・ミニマップに重ならない右上に置く
  const wa = targetDisplay().workArea;
  const kk = targetDisplay().bounds.height / 1080;
  const ch = Math.max(420, Math.min(860, Math.round(740 * kk) - 40 - wa.y));   // 右下の ON/OFF 表示に重ならない高さ
  control = new BrowserWindow({
    x: wa.x + wa.width - 520, y: wa.y + 40, width: 500, height: ch, title: EDITION.title + ' メニュー', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  control.setAlwaysOnTop(true, 'screen-saver', 1);   // HUD より手前に出す
  control.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  // 操作パネルを閉じたら HUD も全部終了する（閉じても画面に枠が残る問題の修正）
  // ×で閉じてもアプリは終了せず、メニューを隠すだけ（キーでまた開ける）。終了は「HUD を終了する」かトレイから
  control.on('close', (e) => { if (!quitting) { e.preventDefault(); control.hide(); } });
  control.on('closed', () => { control = null; });
  const later = () => setTimeout(sendBadge, 60);
  control.on('show', later); control.on('hide', later);
}

function send(msg) {
  for (const w of overlays()) w.webContents.send('hud:input', msg);
  obsBroadcast(msg);
  if (msg && msg.event === 'champion') playFullFx('champion');
}

// 下段ウィンドウの画面読み取り結果を、ほかの HUD ウィンドウ（ミニマップ枠）にも伝える
ipcMain.on('hud:relay', (e, msg) => {
  for (const w of overlays()) if (w.webContents !== e.sender) w.webContents.send('hud:input', msg);
  obsBroadcast(msg);
  if (msg && msg.event === 'champion') playFullFx('champion');
});

// ---- 起動確認（見えていなければ自動終了）----
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')); } catch { return {}; } };
let safetyTimer = null, safetyDeadline = 0;
const SAFETY_SEC = 20;
function startSafetyTimer() {
  if (flag('no-safety') || opt('capture', '') || opt('bench', '') || opt('log-states', '')) return;
  if (readSettings().confirmedVersion === app.getVersion() && !flag('ask-confirm')) return;   // 一度確認済みなら省略
  safetyDeadline = Date.now() + SAFETY_SEC * 1000;
  safetyTimer = setTimeout(() => { console.log('[safety] not confirmed, quitting'); app.quit(); }, SAFETY_SEC * 1000);
}
ipcMain.handle('hud:safety', () => (safetyTimer ? { pending: true, secondsLeft: Math.max(0, Math.round((safetyDeadline - Date.now()) / 1000)) } : { pending: false }));
ipcMain.on('hud:confirm', () => {
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...readSettings(), confirmedVersion: app.getVersion() })); } catch { /* 保存できなくても続行 */ }
});
ipcMain.on('hud:quit', () => app.quit());
ipcMain.on('hud:open-shop', () => openUrl(SHOP_URL));

// ---- 説明書（アプリの中の窓で開く。ネットがなくても読める）----
let helpWin = null;
function openHelp(anchor) {
  const file = path.join(__dirname, 'manual', 'index.html');
  if (!fs.existsSync(file)) return;
  const hash = /^[a-z0-9-]{1,40}$/.test(anchor || '') ? anchor : '';
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.loadFile(file, { hash }); helpWin.show(); helpWin.focus(); return;
  }
  const wa = targetDisplay().workArea;
  helpWin = new BrowserWindow({ width: Math.min(980, wa.width - 80), height: Math.min(900, wa.height - 60), title: EDITION.title + ' 説明書', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true } });
  helpWin.setAlwaysOnTop(true, 'screen-saver', 2);
  helpWin.loadFile(file, { hash });
  // 説明書の中の外部リンク（BOOTH など）はふだんのブラウザで開く
  helpWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  helpWin.webContents.on('will-navigate', (e, url) => { if (/^https?:\/\//.test(url)) { e.preventDefault(); shell.openExternal(url); } });
  helpWin.on('closed', () => { helpWin = null; });
}
ipcMain.on('hud:help', (_e, anchor) => openHelp(anchor));

// ---- 枠の背景画像（カスタム版）----
// 枠の「パネル」（濃い色の地紋の部分）だけに好きな画像を入れる。ゲームの表示が見える窓・ネオンの線・光には入れない。
// パネルの形は、いま使っている枠の画像から作る（不透明で暗い画素 = パネル）。
const BG_DEFAULT = { file: null, w: 0, h: 0, scale: 100, x: 0, y: 0, opacity: 60, brightness: 100, blur: 0,
  targets: ['player', 'mates', 'item', 'tactical', 'ult', 'weapon', 'minimap', 'compass'] };
const BG_DIR = () => path.join(app.getPath('userData'), 'backgrounds');
// 2026-10-26：購入者が自分の画像を入れておく場所（マイキャラと同じ ドキュメント\OverLIVE の中）。画像を選ぶ窓はここから開く
const BG_SRC_DIR = () => path.join(DOC_DIR(), '背景');
const bgCache = { key: '', url: null };
const maskCache = new Map();
function bgSettings() { return Object.assign({}, BG_DEFAULT, readSettingsSafe().background || {}); }
function bgImageUrl(file) {
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const key = file + '|' + st.mtimeMs;
  if (bgCache.key === key) return bgCache.url;
  let im = nativeImage.createFromPath(file);
  if (im.isEmpty()) return null;
  const { width } = im.getSize();
  if (width > 1600) im = im.resize({ width: 1600, quality: 'best' });
  bgCache.key = key; bgCache.url = im.toDataURL();
  return bgCache.url;
}
/** 枠の画像 → パネルの形のマスク（data URL）。不透明で暗い画素だけを残し、ふちを少し内側に縮める */
// 2026-11-01（ユーザー指摘：背景を入れると蓋のところだけ画像が入らない）：窓のふた（lid）にも背景を入れる。
//   ふたには読み取り用の 1px の穴がある。穴と、そのまわり（読み取りが「ふただけの色」として見る穴の左 3px を含む）には画像を入れない（guard）
function panelMask(file, guard) {
  const ck = file + (guard ? '#g' : '');
  if (maskCache.has(ck)) return maskCache.get(ck);
  let url = null;
  try {
    const im = nativeImage.createFromPath(path.join(ASSETS, file));
    if (!im.isEmpty()) {
      const { width: W, height: H } = im.getSize();
      const src = im.toBitmap();   // BGRA
      const on = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const b = src[i * 4], g = src[i * 4 + 1], r = src[i * 4 + 2], a = src[i * 4 + 3];
        on[i] = (a >= 225 && Math.max(r, g, b) < 150) ? 1 : 0;
      }
      // 2px 内側に縮める（ネオンの線のきわに画像がかからないように）
      let cur = on;
      for (let n = 0; n < 2; n++) {
        const nx = new Uint8Array(W * H);
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          nx[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - W] && cur[i + W] ? 1 : 0;
        }
        cur = nx;
      }
      if (guard) {
        const opq = (x, y) => src[(y * W + x) * 4 + 3] >= 200;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          if (src[(y * W + x) * 4 + 3] >= 50 || !opq(x - 1, y) || !opq(x + 1, y) || !opq(x, y - 1) || !opq(x, y + 1)) continue;
          for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 4); xx <= Math.min(W - 1, x + 1); xx++) cur[yy * W + xx] = 0;
        }
      }
      const out = Buffer.alloc(W * H * 4);
      for (let i = 0; i < W * H; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255; out[i * 4 + 3] = cur[i] ? 255 : 0; }
      url = nativeImage.createFromBitmap(out, { width: W, height: H }).toDataURL();
    }
  } catch (err) { console.error('[bg mask]', err); }
  maskCache.set(ck, url);
  return url;
}
// 2026-11-02（ユーザー指摘：背景を入れると、閉じた蓋のふち（窓の線）だけが残って「枠」に見える）：
//   蓋は「ふちも含めて全部」を1色（その蓋の暗い地の色の中央値）で塗った絵（fill）を重ね、その上に背景の画像を入れる。状態（被弾など）ごとに作る。
//   読み取り用の穴とそのまわり（穴の左 4px〜右 1px・上下 1px）は元の蓋のまま（グレー）にして、画像も入れない
const lidCache = new Map();
// 2026-11-02 v2（ユーザー指摘：穴が大きく見える・蓋だけ色が違う）：
//   読み取り用の穴のまわりで「色を変えてはいけない」のは、画面の取り込みで穴と色が混ざる 2x2 のかたまりと、参照点（穴の3つ左）のかたまりだけ。
//   そこだけにしぼる（蓋の絵のグレーの部分と同じ範囲）。ox/oy は蓋の左上の画面座標の偶奇
function lidHoles(src, W, H, ox = 0, oy = 0) {
  const opq = (x, y) => src[(y * W + x) * 4 + 3] >= 200, g = new Uint8Array(W * H);
  const lo = (v, o) => ((v + o) & ~1) - o, hi = (v, o) => ((v + o) | 1) - o;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (src[(y * W + x) * 4 + 3] >= 50 || !opq(x - 1, y) || !opq(x + 1, y) || !opq(x, y - 1) || !opq(x, y + 1)) continue;
    for (let yy = Math.max(0, lo(y, oy)); yy <= Math.min(H - 1, hi(y, oy)); yy++) for (let xx = Math.max(0, lo(x - 3, ox)); xx <= Math.min(W - 1, hi(x, ox)); xx++) g[yy * W + xx] = 1;
  }
  return g;
}
function lidAsset(file, kind, ox = 0, oy = 0) {
  const ck = kind + '|' + ox + oy + '|' + file;
  if (lidCache.has(ck)) return lidCache.get(ck);
  let url = null;
  try {
    const im = nativeImage.createFromPath(path.join(ASSETS, file));
    if (!im.isEmpty()) {
      const { width: W, height: H } = im.getSize();
      const src = im.toBitmap();   // BGRA
      const guard = lidHoles(src, W, H, ox, oy);
      const out = Buffer.alloc(W * H * 4);
      {
        // fill：蓋の絵の模様はそのまま残し、ふちの線（透明に近いところから3px以内で、中の色と明るさがちがう画素）だけ中の色で塗る
        //   2026-11-02 v1 は全部を1色で塗っていたので、模様のある枠（アクア等）では蓋だけ色・模様が違って見えた
        const N = W * H, dist = new Uint8Array(N).fill(255), q = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (src[i * 4 + 3] < 128 && !guard[i] || x === 0 || y === 0 || x === W - 1 || y === H - 1) { dist[i] = 0; q.push(i); } }
        for (let h = 0; h < q.length; h++) { const i = q[h], d = dist[i]; if (d >= 4) continue; const x = i % W, y = (i / W) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (dist[j] > d + 1) { dist[j] = d + 1; q.push(j); } } }
        const lum = (i) => 0.299 * src[i * 4 + 2] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4];
        const rs = [], gs = [], bs = [], ls = [];
        for (let i = 0; i < N; i++) if (src[i * 4 + 3] >= 225 && !guard[i] && dist[i] > 3) { rs.push(src[i * 4 + 2]); gs.push(src[i * 4 + 1]); bs.push(src[i * 4]); ls.push(lum(i)); }
        const med = (v) => { if (!v.length) return 40; v.sort((p, q2) => p - q2); return v[v.length >> 1]; };
        const R = med(rs), G = med(gs), B = med(bs), Lm = med(ls);
        for (let i = 0; i < N; i++) {
          const a = src[i * 4 + 3];
          const edge = !guard[i] && a > 0 && dist[i] <= 3 && (a < 225 || Math.abs(lum(i) - Lm) > 22);
          const fb = edge ? B : src[i * 4], fg = edge ? G : src[i * 4 + 1], fr = edge ? R : src[i * 4 + 2];
          if (kind === 'fill') {
            out[i * 4] = fb; out[i * 4 + 1] = fg; out[i * 4 + 2] = fr;
            out[i * 4 + 3] = a ? 255 : 0;   // ふちの半透明を不透明に：下の枠の窓のふち（明るい線）が透けて「枠」に見えないように（背景ありのときだけ使う絵）
          } else {
            // mask：背景画像を入れるところ（穴のまわりを除く）／guard：穴のまわりだけ（そこには白黒にした背景画像を入れる）
            //   枠の本体（panelMask）と同じく、暗いところだけに入れる（明るい枠＝アクアポケット等では蓋だけ画像が濃く出て色が違って見えた）
            const dark = a > 0 && Math.max(fr, fg, fb) < 150;
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
            out[i * 4 + 3] = (dark && (kind === 'mask' ? !guard[i] : guard[i])) ? 255 : 0;
          }
        }
      }
      url = nativeImage.createFromBitmap(out, { width: W, height: H }).toDataURL();
    }
  } catch (err) { console.error('[bg lid]', err); }
  lidCache.set(ck, url);
  return url;
}
function backgroundFor(manifest, framesDir, withImage, noMasks) {
  const bg = bgSettings();
  // 2026-11-02（ユーザー指摘：背景の調整の反映にラグ）：調整（大きさ・位置・濃さ）のたびにマスクを全部送り直していた。
  //   マスクは枠が変わらなければ同じなので、調整のときは送らない（HUD 側は前のマスクを使い続ける）
  if (noMasks) return Object.assign({}, bg, withImage ? { url: bgImageUrl(bg.file) } : {});
  const masks = {}, lidFills = {};
  for (const [name, p] of Object.entries(manifest.parts)) {
    const f = p.layers && (p.layers.normal || Object.values(p.layers)[0]);
    if (!f) continue;
    const file = (framesDir && f.startsWith('v4/')) ? framesDir + f.slice(3) : f;
    masks[name] = panelMask(fs.existsSync(path.join(ASSETS, file)) ? file : f);
    // 窓の蓋（aqua〜）だけ。シールドの蓋（sh_〜）は今は使っていない（2026-11-02：送る量を減らす）
    for (const [ln, L] of Object.entries(p.lids || {})) {
      if (!ln.startsWith('aqua') || !L.files) continue;
      const real = (lf) => { const f2 = (framesDir && lf.startsWith('v4/')) ? framesDir + lf.slice(3) : lf; return fs.existsSync(path.join(ASSETS, f2)) ? f2 : lf; };
      const lf = L.files.normal || Object.values(L.files)[0];
      const ox = (L.x || 0) & 1, oy = (L.y || 0) & 1;
      masks[name + '#' + ln] = lidAsset(real(lf), 'mask', ox, oy);
      masks[name + '#' + ln + '#guard'] = lidAsset(real(lf), 'guard', ox, oy);
      const fills = {};
      for (const [st, f3] of Object.entries(L.files)) fills[st] = lidAsset(real(f3), 'fill', ox, oy);
      lidFills[name + '#' + ln] = fills;
    }
  }
  const r = Object.assign({}, bg, { masks, lidFills });
  if (withImage) r.url = bgImageUrl(bg.file);
  return r;
}
let bgAdjust = false;
function sendBackground(withImage, noMasks) {
  if (!EDITION.background) return;
  const cfg = loadConfigCache || loadConfig();
  const st = readSettingsSafe(), chars = listCharacters(), eff = effectiveFrames(chars[currentCharId(chars, st)], st);
  const b = backgroundFor(cfg.manifest, eff.frames, withImage, noMasks);
  b.adjust = bgAdjust;
  send({ options: { background: b } });
}
let loadConfigCache = null;
ipcMain.handle('hud:bg-get', () => {
  if (!EDITION.background) return null;
  const bg = bgSettings();
  const cfg = loadConfigCache || loadConfig();
  const st = readSettingsSafe(), chars = listCharacters(), eff = effectiveFrames(chars[currentCharId(chars, st)], st);
  const p = cfg.manifest.parts.player, f = p.layers.normal, file = (eff.frames && f.startsWith('v4/')) ? eff.frames + f.slice(3) : f;
  return { settings: bg, url: bgImageUrl(bg.file), adjust: bgAdjust,
    preview: { frame: '../assets/' + (fs.existsSync(path.join(ASSETS, file)) ? file : f), mask: panelMask(fs.existsSync(path.join(ASSETS, file)) ? file : f), w: p.w, h: p.h } };
});
ipcMain.handle('hud:bg-pick', async () => {
  if (!EDITION.background) return null;
  let defaultPath; try { fs.mkdirSync(BG_SRC_DIR(), { recursive: true }); defaultPath = BG_SRC_DIR(); } catch { /* 作れなくても選べる */ }
  const r = await dialog.showOpenDialog(control && !control.isDestroyed() ? control : undefined, { title: '枠の背景にする画像を選ぶ', properties: ['openFile'], defaultPath,
    filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const im = nativeImage.createFromPath(r.filePaths[0]);
  if (im.isEmpty()) return { error: 'この画像は読み込めませんでした（PNG・JPG がおすすめです）' };
  fs.mkdirSync(BG_DIR(), { recursive: true });
  for (const f of fs.readdirSync(BG_DIR())) { try { fs.unlinkSync(path.join(BG_DIR(), f)); } catch { /* 使用中 */ } }
  const dst = path.join(BG_DIR(), 'background' + path.extname(r.filePaths[0]).toLowerCase());
  fs.copyFileSync(r.filePaths[0], dst);   // 元の画像を動かしても消えないようにコピーして使う
  const { width, height } = im.getSize();
  saveBg({ file: dst, w: width, h: height, scale: 100, x: 0, y: 0 });
  sendBackground(true);
  return { ok: true };
});
function saveBg(patch) {
  const cur = readSettings();
  const bg = Object.assign({}, BG_DEFAULT, cur.background || {}, patch);
  bg.scale = Math.max(20, Math.min(800, +bg.scale || 100)); bg.x = Math.max(-300, Math.min(300, +bg.x || 0)); bg.y = Math.max(-300, Math.min(300, +bg.y || 0));
  bg.opacity = Math.max(0, Math.min(100, +bg.opacity)); bg.brightness = Math.max(30, Math.min(170, +bg.brightness || 100)); bg.blur = Math.max(0, Math.min(12, +bg.blur || 0));
  bg.targets = Array.isArray(bg.targets) ? bg.targets.map(String).slice(0, 20) : BG_DEFAULT.targets;
  try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...cur, background: bg })); } catch { /* 保存できなくても反映は行う */ }
  return bg;
}
ipcMain.on('hud:bg-set', (_e, patch) => {
  if (!EDITION.background || !patch) return;
  const { file, w, h, ...rest } = patch;   // 画像の差し替えは「画像を選ぶ」からだけ
  saveBg(rest);
  sendBackground(false, true);
});
ipcMain.on('hud:bg-clear', () => { if (!EDITION.background) return; saveBg({ file: null, w: 0, h: 0 }); sendBackground(true); });
ipcMain.on('hud:bg-reset', () => { if (!EDITION.background) return; saveBg({ scale: 100, x: 0, y: 0, opacity: BG_DEFAULT.opacity, brightness: 100, blur: 0 }); sendBackground(false); });
function toggleBgAdjust(on) {
  if (!EDITION.background) return;
  bgAdjust = on == null ? !bgAdjust : !!on;
  sendBackground(false);
  if (control && !control.isDestroyed()) control.webContents.send('hud:input', { bgAdjust });
}
ipcMain.on('hud:bg-adjust', (_e, on) => toggleBgAdjust(on));

// ---- 配信用（OBS のブラウザソース）----
// http://127.0.0.1:47812/obs を OBS の「ブラウザ」ソースに貼ると、同じ HUD が透明な1枚のページとして出る。
// ゲームキャプチャの上に重ねられる。画面の読み取りはアプリ側が行い、結果を届けるだけ（このPCの中だけで通信）。
const OBS_PORT = +opt('obs-port', 47812);
const OBS_URL = `http://127.0.0.1:${OBS_PORT}/obs`;
const obsClients = new Set();
const obsLast = {};   // 読み取りで変わる表示（ウルトのアイコン・方位・デスボックス）の最新値。あとから接続したページに渡す
const charaClients = new Set();
function charaSse(req, res, head) {
  res.writeHead(200, { ...head, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  res.write(': hello\n\n');
  charaClients.add(res);
  obsSnapshot().then((snap) => { if (snap) try { res.write('data: ' + JSON.stringify(snap) + '\n\n'); } catch { /* 切れた */ } });
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* 切れた */ } }, 15000);
  req.on('close', () => { clearInterval(ka); charaClients.delete(res); });
}
function charaPush(msg) { if (!charaClients.size) return; const d = 'data: ' + JSON.stringify(msg) + '\n\n'; for (const r of charaClients) { try { r.write(d); } catch { charaClients.delete(r); } } }
function obsBroadcast(msg) {
  if (!msg) return;
  if (charaClients.size && (msg.patch || msg.event)) { const d = 'data: ' + JSON.stringify(msg) + '\n\n'; for (const r of charaClients) { try { r.write(d); } catch { charaClients.delete(r); } } }
  // 2026-10-25：OBS をつなぐ前に変わった表示（射撃訓練場でミニマップを隠した等）も覚えておく。前は誰もつないでいないと覚えずに捨てていた
  if (msg.options) for (const k of ['ultIcon', 'mapUi', 'minimapUi', 'deathbox', 'layout', 'modeKind', 'mateDy', 'tacDual', 'evoCircle']) if (k in msg.options) obsLast[k] = msg.options[k];
  if (!obsClients.size) return;
  const data = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const res of obsClients) { try { res.write(data); } catch { obsClients.delete(res); } }
}
async function obsSnapshot() {
  // 今の体力などを、演出なしで合わせるための値
  try {
    const st = await overlay.webContents.executeJavaScript(`(() => { const s = window.hud.state; return JSON.parse(JSON.stringify({ hp: s.hp, shield: s.shield, shieldMax: s.shieldMax, shieldSegments: s.shieldSegments, healing: s.healing, knocked: s.knocked, hudHidden: s.hudHidden, shown: s.shown, mates: s.mates.map(m => ({ present: m.present, hp: m.hp, shield: m.shield, shieldSegments: m.shieldSegments, healing: m.healing, knocked: m.knocked })) })); })()`);
    return { patch: st, silent: true };
  } catch { return null; }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.gz': 'application/gzip' };
function obsConfig() {
  const cfg = loadConfig();
  { const d = targetDisplay(); cfg.screen = { width: d.bounds.width, height: d.bounds.height }; }   // ゲーム画面の縦横比（配信用ページはこれで並べて真ん中に置く）
  if (cfg.background) cfg.background = backgroundFor(cfg.manifest, cfg.framesDir, true);
  if (cfg.background) delete cfg.background.file;   // パソコンの中の場所は渡さない
  delete cfg.myCharaDir;
  cfg.options.screenRead = false; cfg.options.showRegions = false; cfg.options.demoBg = false; cfg.options.perf = false; cfg.options.diag = false;
  cfg.options.chatTranslate = false;
  cfg.obs = true;
  return cfg;
}
let obsServer = null;
function startObsServer() {
  if (!EDITION.obs || obsServer) return;
  obsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    const head = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'null' };
    // /obs は HUD だけ。コメント欄は人によって大きさ・置き場所を変えたいので、別の URL（/renderer/comments.html?full=1）で別のソースにする（2026-10-30 ユーザー）
    if (p === '/' || p === '/obs') { res.writeHead(302, { Location: '/renderer/hud.html?part=obs' }); return res.end(); }
    if (p === '/obs/config') { res.writeHead(200, { ...head, 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify(obsConfig())); }
    if (p === '/obs/events' && url.searchParams.has('chara')) { charaSse(req, res, head); return; }   // キャラの窓（OBS の接続数には数えない）
    if (p === '/obs/events' && url.searchParams.has('comments')) { COMMENTS.sse(req, res, head); return; }   // コメント欄（OBS の接続数には数えない）
    if (p === '/obs/events' && url.searchParams.has('np')) { NOWPLAY.sse(req, res, head); return; }   // 再生中の曲（2026-11-02。OBS の接続数には数えない）
    if (p === '/obs/events') {
      res.writeHead(200, { ...head, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      obsClients.add(res);
      const snap = await obsSnapshot();
      if (snap) res.write('data: ' + JSON.stringify(snap) + '\n\n');
      if (Object.keys(obsLast).length) res.write('data: ' + JSON.stringify({ options: { ...obsLast } }) + '\n\n');
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* 切れた */ } }, 15000);
      req.on('close', () => { clearInterval(ka); obsClients.delete(res); sendObsState(); });
      sendObsState();
      return;
    }
    // renderer/ と assets/ の中のファイルだけを出す（それ以外は出さない）
    const rel = path.normalize(p).replace(/^[\\/]+/, '');
    const top = rel.split(/[\\/]/)[0];
    const file = path.join(__dirname, rel);
    if (!['renderer', 'assets'].includes(top) || !file.startsWith(path.join(__dirname, top) + path.sep)) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { ...head, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  obsServer.on('error', (e) => console.error('[obs]', e.message));
  obsServer.listen(OBS_PORT, '127.0.0.1');
}
function sendObsState() { if (control && !control.isDestroyed()) control.webContents.send('hud:input', { obs: { url: OBS_URL, clients: obsClients.size, screenHud: readSettingsSafe().screenHud !== false } }); }
ipcMain.handle('hud:obs', () => EDITION.obs ? { url: OBS_URL, clients: obsClients.size, screenHud: readSettingsSafe().screenHud !== false } : null);
ipcMain.on('hud:obs-copy', () => { require('electron').clipboard.writeText(OBS_URL); });

// ---- 配信用の窓（2026-10-30）----
// TikTok LIVE Studio はリンクに http のアドレス（127.0.0.1 など）を入れられないので、OBS なしでも使えるように、
// 「ゲーム画面＋HUD」を重ねた1枚の普通の窓を出す。配信アプリの「ウィンドウキャプチャ」でこの窓を選ぶだけで映る。
// ゲーム画面は Apex のウィンドウだけを取り込む（画面全体だと自分の画面の HUD まで映って二重になるため）。音は配信アプリ側でゲームから拾う
let streamWin = null;
const STREAM_PAGE = () => `http://127.0.0.1:${OBS_PORT}/renderer/stream.html`;
function openStreamWin() {
  if (!EDITION.obs) return;
  // もう開いていたら閉じる（枠なしの窓なので、閉じるのはこのボタンで）
  if (streamWin && !streamWin.isDestroyed()) { streamWin.close(); return; }
  const d = targetDisplay().bounds;
  const w = 1280, h = Math.round(w * d.height / d.width);
  streamWin = new BrowserWindow({
    // 枠（タイトルバー）なし：ウィンドウキャプチャにタイトルバーまで映って HUD の位置がずれて見えるため（2026-10-30）
    width: w, height: h, frame: false, resizable: true, title: '【配信用の窓】' + EDITION.title, backgroundColor: '#000000',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },   // 後ろに隠れていても止めない
  });
  streamWin.setAspectRatio(d.width / d.height);   // ゲーム画面と同じ縦横比（HUD の位置がずれないように）
  streamWin.loadURL(STREAM_PAGE());
  streamWin.on('closed', () => { streamWin = null; if (control && !control.isDestroyed()) control.webContents.send('hud:input', { streamWin: false }); });
  if (control && !control.isDestroyed()) control.webContents.send('hud:input', { streamWin: true });
}
ipcMain.on('hud:stream-win', openStreamWin);

// ---- キャラの窓（2026-10-30 試作）：ゲームに合わせて表情が変わるデフォルメのキャラだけを出す窓。縦配信の左上に、ウィンドウキャプチャで取り込む ----
let charaWin = null;
function openCharaWin() {
  if (!EDITION.obs) return;
  if (charaWin && !charaWin.isDestroyed()) { charaWin.close(); return; }
  charaWin = new BrowserWindow({
    width: 460, height: 510, frame: false, resizable: true, title: '【キャラの窓】' + EDITION.title, backgroundColor: '#0a0e1a',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  charaWin.loadURL(`http://127.0.0.1:${OBS_PORT}/renderer/chara.html?c=elena`);
  charaWin.on('closed', () => { charaWin = null; if (control && !control.isDestroyed()) control.webContents.send('hud:input', { charaWin: false }); });
  if (control && !control.isDestroyed()) control.webContents.send('hud:input', { charaWin: true });
}
ipcMain.on('hud:chara-win', openCharaWin);

// ---- コメント表示（わんコメから受け取る。2026-10-30 試作）----
const COMMENTS = require('./comments_main.js').create({
  BrowserWindow, screen, path, OBS_PORT,
  readSettings: () => readSettingsSafe(),
  writeSettings: (patch) => { try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...readSettings(), ...patch })); } catch { /* 保存できなくても続ける */ } },
  getControl: () => control, isHudOn: () => hudOn, protect: flag('protect'),
});
ipcMain.on('hud:comments', (_e, on) => { if (EDITION.obs) COMMENTS.setOn(!!on); });
ipcMain.on('hud:comments-screen', (_e, on) => { if (EDITION.obs) COMMENTS.setScreen(!!on); });
ipcMain.handle('hud:comments-test', () => (EDITION.obs ? COMMENTS.test() : { ok: false, why: 'この版では使えません' }));
ipcMain.handle('hud:comments-state', () => (EDITION.obs ? COMMENTS.state() : null));
ipcMain.on('hud:comments-copy', () => { if (EDITION.obs) require('electron').clipboard.writeText(COMMENTS.state().url); });
// 2026-10-31：コメント欄の見た目の調整・読み上げ
ipcMain.on('hud:comments-look', (_e, patch) => { if (EDITION.obs && patch && typeof patch === 'object') COMMENTS.setLook(patch); });
ipcMain.on('hud:comments-speak', (_e, patch) => { if (EDITION.obs && patch && typeof patch === 'object') COMMENTS.setSpeak(patch); });
ipcMain.on('hud:comments-speak-test', () => { if (EDITION.obs) COMMENTS.speakTest(); });
// ---- 再生中の曲を画面に出す（ブラウザの YouTube など。2026-11-02）製品版だけ ----
const NOWPLAY = require('./nowplaying_main.js').create({
  BrowserWindow, screen, OBS_PORT,
  readSettings: () => readSettingsSafe(),
  writeSettings: (patch) => { try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...readSettings(), ...patch })); } catch { /* 保存できなくても続ける */ } },
  getControl: () => control, isHudOn: () => hudOn, protect: flag('protect'),
});
ipcMain.on('hud:np', (_e, on) => { if (EDITION.obs) NOWPLAY.setOn(!!on); });
ipcMain.on('hud:np-screen', (_e, on) => { if (EDITION.obs) NOWPLAY.setScreen(!!on); });
ipcMain.on('hud:np-look', (_e, patch) => { if (EDITION.obs && patch && typeof patch === 'object') NOWPLAY.setLook(patch); });
ipcMain.handle('hud:np-state', () => (EDITION.obs ? NOWPLAY.state() : null));
ipcMain.handle('hud:np-test', () => (EDITION.obs ? NOWPLAY.test() : { ok: false }));
ipcMain.on('hud:np-copy', () => { if (EDITION.obs) require('electron').clipboard.writeText(NOWPLAY.state().url); });
ipcMain.on('hud:send', (_e, msg) => { if (EDITION.obs && msg && Array.isArray(msg.speakVoices)) COMMENTS.setVoices(msg.speakVoices); });
// 「自分の画面にも出す」：OFF にすると、自分の画面には出さず配信（OBS）にだけ出す
ipcMain.on('hud:screen-hud', (_e, on) => {
  if (!EDITION.obs) return;
  try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...readSettings(), screenHud: !!on })); } catch { /* 保存できなくても反映は行う */ }
  setHud(!!on);
  sendObsState();
  COMMENTS.showWin();   // 「自分の画面にも出す」OFF ならコメント欄も自分の画面には出さない
  NOWPLAY.showWin();
});

// ---- 体験版：1回の起動で1時間。時間が来たら案内を出して終了（もう一度起動すればまた1時間使える）----
let trialEnd = 0;
function trialLeftMin() { return trialEnd ? Math.max(0, Math.ceil((trialEnd - Date.now()) / 60000)) : 0; }
function startTrialTimer() {
  if (!EDITION.timeLimitMin) return;
  const min = +opt('trial-min', EDITION.timeLimitMin);   // 確認用に短くできる（管理用の --as=trial のときだけ）
  trialEnd = Date.now() + (EDITION.previewOf ? min : EDITION.timeLimitMin) * 60000;
  const iv = setInterval(() => {
    sendBadge();
    if (Date.now() < trialEnd) return;
    clearInterval(iv);
    setHud(false);
    const quit = setTimeout(() => app.quit(), 120000);   // 返事がなくても2分で終了
    dialog.showMessageBox({ type: 'info', title: EDITION.title, buttons: ['BOOTH を開く', '閉じる'], defaultId: 1, noLink: true,
      message: '体験版の時間（1時間）が終わりました',
      detail: 'お試しいただきありがとうございます！\nもう一度起動すると、また1時間使えます。\n\n時間制限なし・全部の枠・8人のキャラ・8種の表情で使える「通常版」は BOOTH で販売中です。' })
      .then(r => { if (r.response === 0) openUrl(SHOP_URL); clearTimeout(quit); setTimeout(() => app.quit(), r.response === 0 ? 3000 : 400); })
      .catch(() => app.quit());
  }, 15000);
}

// ---- 更新のお知らせ：新しいバージョンがあればメニューに案内を出す（自動でダウンロード・インストールはしない）----
let updateInfo = null;
function newer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
async function checkUpdate() {
  if (!EDITION.updateCheck || !UPDATE_URL || flag('no-update-check')) return;
  try {
    const r = await net.fetch(UPDATE_URL, { cache: 'no-store' });
    const j = await r.json();
    if (j && j.version && newer(j.version, app.getVersion())) {
      updateInfo = { version: String(j.version).slice(0, 16), message: String(j.message || '').slice(0, 300), url: /^https:\/\//.test(j.url) ? j.url : SHOP_URL };
      if (control && !control.isDestroyed()) control.webContents.send('hud:input', { update: updateInfo });
    }
  } catch { /* オフライン等は何もしない */ }
}
ipcMain.handle('hud:update', () => updateInfo);
ipcMain.on('hud:open-update', () => openUrl((updateInfo && updateInfo.url) || SHOP_URL));

// ---- チャット翻訳用 OCR（tesseract.js、オフライン。言語データは assets/chat/eng.traineddata.gz）----
const OCR = require('./ocr_server.js');
const OCR_CACHE = () => path.join(app.getPath('userData'), 'ocr-cache');
ipcMain.handle('hud:ocr', async (_e, png) => {
  if (flag('debug-chat')) console.log('[ocr] request', png && png.length);
  try { const t = await OCR.recognize(OCR_CACHE(), png); if (flag('debug-chat')) console.log('[ocr]', JSON.stringify(t)); return t; }
  catch (err) { console.error('[ocr]', err); return ''; }
});
// 設定の保存（名前・ふたの自動開閉）。HUD にもすぐ反映する
ipcMain.on('hud:setting', (_e, kv) => {
  const allowed = ['playerName', 'lids', 'fx', 'character', 'chatTranslate', 'frameStyle', 'hidden', 'minimap', 'idleMotion', 'resetName', 'championFx'];
  const patch = {};
  let relaunchFor;   // 形の違う枠（サイバーパンクなど）に切り替えたときは起動し直す
  for (const k of allowed) if (k in kv) {
    if (k === 'playerName') patch[k] = String(kv[k]).slice(0, 32);
    else if (k === 'character' || k === 'frameStyle') patch[k] = String(kv[k]);
    else if (k === 'championFx') patch[k] = ['classic', 'jackpot', 'off'].includes(kv[k]) ? kv[k] : 'classic';
    else if (k === 'hidden') patch[k] = Array.isArray(kv[k]) ? kv[k].map(String).slice(0, 40) : [];
    else patch[k] = !!kv[k];
  }
  if (patch.frameStyle) patch.frameStyle = allowedFrameStyle(patch.frameStyle);
  const resetName = !!patch.resetName; delete patch.resetName;
  if (patch.character || patch.frameStyle) {
    const chars = listCharacters(), cur = readSettings();
    if (patch.character && !chars[patch.character]) delete patch.character;
    const id = patch.character || (chars[cur.character] ? cur.character : null);
    const ch = id ? chars[id] : null;
    if (patch.character && ch) { patch.faces = ch.faces; patch.noChara = !!ch.noChara; if (!('playerName' in kv) && !cur.playerNameCustom) patch.playerName = ch.displayName; }
    const eff = effectiveFrames(ch, { ...cur, ...patch });
    patch.frames = eff.frames; patch.theme = eff.theme;
    const before = effectiveFrames(chars[currentCharId(chars, cur)], cur).frames;
    if (before !== eff.frames && (ownGeometry(before) || ownGeometry(eff.frames))) relaunchFor = eff.frames;   // 形が変わる枠：保存してから起動し直す
  }
  if ('playerName' in kv) patch.playerNameCustom = true;
  if (resetName) {   // 「キャラの名前に戻す」
    const chars = listCharacters(), c = chars[currentCharId(chars, readSettings())];
    patch.playerName = c ? c.displayName : ''; patch.playerNameCustom = false;
  }
  if ('chatTranslate' in patch) patch.chatTranslateOn = patch.chatTranslate;   // 0.4.20 から既定 OFF にしたので保存名を変えた
  if (relaunchFor !== undefined) {
    const { faces, frames, theme, chatTranslate, noChara, ...save } = patch;
    try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...readSettings(), ...save })); } catch { /* 保存できなくても続ける */ }
    console.log('[frames] shape changed → relaunch', relaunchFor);
    quitting = true;
    app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--relaunched').concat(['--relaunched']) });
    setTimeout(() => app.exit(0), 300);
    return;
  }
  const { faces, frames, theme, chatTranslate, noChara, ...save } = patch;
  if ('hidden' in patch) patch.minimap = !patch.hidden.includes('minimap');
  try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...readSettings(), ...save })); } catch { /* 保存できなくても反映は行う */ }
  send({ options: patch });
  if (control && !control.isDestroyed()) control.webContents.send('hud:input', { options: patch });
  if ('frames' in patch) { sendBackground(false); if (control && !control.isDestroyed()) control.webContents.send('hud:input', { bgFrames: true }); }
});

// ---- マイキャラ：フォルダを開く／読み込み直す ----
ipcMain.on('hud:open-mychara', () => { if (!EDITION.myChara) return; const d = MYCHARA_DIR(); try { MYCHARA.scan(d, nativeImage, myCache); } catch { /* 作れなくても開くだけ試す */ } shell.openPath(d); });
ipcMain.handle('hud:characters', () => {
  const chars = listCharacters(), st = readSettings();
  // メニューには名前と通常顔だけ送る（重い表情データは送らない）
  return { current: currentCharId(chars, st), dir: EDITION.myChara ? MYCHARA_DIR() : null,
    list: Object.values(chars).map(c => ({ id: c.id, name: c.noChara ? 'キャラなし' : c.displayName, custom: !!c.custom, star: !!c.star, noChara: !!c.noChara,
      face: c.noChara ? null : (/^data:/.test(c.faces.normal) ? c.faces.normal : '../assets/' + c.faces.normal) })) };
});

// ---- 診断ログ：ドキュメント\OverLIVE-logs\<起動日時>\ に保存 ----
let diagDir = null, snapN = 0;
function ensureDiagDir() {
  if (diagDir) return diagDir;
  const ts = new Date(Date.now() + 9 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  diagDir = path.join(opt('diag-dir', '') || LOG_ROOT(), ts);
  fs.mkdirSync(diagDir, { recursive: true });
  const rc = JSON.parse(fs.readFileSync(path.join(ASSETS, 'reader.json'), 'utf8'));
  fs.writeFileSync(path.join(diagDir, 'readings.csv'), '\ufefftime,ms,hud,hp%,hpPx,shield,shieldPx,segments,tier,stateHP,stateShield,expression,panel,mates,closedWindows,events\n');
  fs.writeFileSync(path.join(diagDir, 'info.json'), JSON.stringify({ version: app.getVersion(), display: targetDisplay().size, scaleFactor: targetDisplay().scaleFactor, reader: rc }, null, 1));
  return diagDir;
}
ipcMain.on('hud:diag', (_e, m) => {
  try {
    const dir = ensureDiagDir();
    if (m.lines) fs.appendFileSync(path.join(dir, 'readings.csv'), m.lines.join('\n') + '\n');
    if (m.error) fs.appendFileSync(path.join(dir, 'errors.txt'), m.error + '\n');
    if (m.snapshot) {
      const base = path.join(dir, `${String(++snapN).padStart(3, '0')}_${m.snapshot.reason}`);
      fs.writeFileSync(base + '.png', Buffer.from(m.snapshot.png));
      fs.writeFileSync(base + '.json', JSON.stringify(m.snapshot.frames));
    }
  } catch (err) { console.error('[diag]', err); }
});
ipcMain.on('hud:open-logs', () => { const d = opt('diag-dir', '') || LOG_ROOT(); fs.mkdirSync(d, { recursive: true }); shell.openPath(diagDir || d); });

ipcMain.on('hud:send', (_e, msg) => { if (!(msg && (msg.fxDone || msg.jackpotDone))) send(msg); });
ipcMain.handle('hud:query', async (_e, expr) => {
  // 検証用：オーバーレイ側の状態・計測値を取得（固定の式のみ許可）
  const allowed = { perf: 'window.hud.perfStats()', derive: 'window.hud.derive()', perfReset: 'window.hud.perfReset()', reading: 'window.hud.reading()', perfText: 'window.hud.perfText()' };
  if (expr === 'badge') return badgeState();
  if (!allowed[expr]) return null;
  return overlay.webContents.executeJavaScript(allowed[expr]);
});

// ---- ローカル API（外部ツール・将来のデータ連携用。127.0.0.1 のみ待受）----
function startApi() {
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/state') {
      overlay.webContents.executeJavaScript('window.hud.derive()').then(d => reply(200, d)).catch(e => reply(500, { error: String(e) }));
      return;
    }
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { return reply(400, { error: 'invalid JSON' }); }
      if (req.url === '/state') send({ patch: data });
      else if (req.url === '/toggle') setHud(data.on == null ? !hudOn : !!data.on);
      else if (req.url.startsWith('/event/')) send({ event: decodeURIComponent(req.url.slice(7)), arg: data.arg });
      else return reply(404, { error: 'unknown path' });
      reply(200, { ok: true });
    });
  });
  server.on('error', (e) => console.error('[api]', e.message));
  server.listen(API_PORT, '127.0.0.1');
}

// ---- 自動ベンチ（--bench=秒 --bench-out=path）----
async function runBench() {
  const secs = +opt('bench', 0);
  if (!secs) return;
  const out = opt('bench-out', path.join(process.cwd(), 'bench.json'));
  await new Promise(r => setTimeout(r, 1500));
  await overlay.webContents.executeJavaScript('window.hud.perfReset()');
  const events = ['damage', 'damage', 'fire', 'kill', 'heal_start', 'heal_stop', 'use_tactical', 'swap', 'fire', 'reload', 'damage', 'damage', 'damage', 'damage', 'damage', 'revive', 'champion', 'reset'];
  let i = 0;
  app.getAppMetrics();   // CPU使用率の計測起点
  const cpu0 = process.cpuUsage(); const t0 = Date.now();
  const timer = setInterval(() => { send({ event: events[i % events.length], arg: 30 }); if (i % 7 === 3) send({ patch: { ult: { charge: (i * 13) % 101 } } }); i++; }, 400);
  await new Promise(r => setTimeout(r, secs * 1000));
  clearInterval(timer);
  const stats = await overlay.webContents.executeJavaScript('window.hud.perfStats()');
  const metrics = app.getAppMetrics().map(m => ({ type: m.type, cpuPercent: m.cpu.percentCPUUsage, memKB: m.memory.workingSetSize }));
  const gpu = app.getGPUFeatureStatus();
  const result = { durationSec: secs, eventsSent: i, renderer: stats, processes: metrics, gpuFeatureStatus: gpu,
    mainCpuMs: (process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000, wallMs: Date.now() - t0,
    display: targetDisplay().size, refreshRate: targetDisplay().displayFrequency };
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log('[bench] written', out);
  if (flag('quit-after-bench')) app.quit();
}

// ---- スクリーンショット（--capture=path、検証用）----
async function runCapture() {
  const out = opt('capture', '');
  if (!out) return;
  await overlay.webContents.executeJavaScript(`new Promise(r => { const c = () => document.body.dataset.ready ? setTimeout(r, 600) : setTimeout(c, 50); c(); })`);
  const script = opt('capture-script', '');
  if (script) {
    for (const step of JSON.parse(fs.readFileSync(script, 'utf8'))) {
      if (step.wait) { await new Promise(r => setTimeout(r, step.wait)); continue; }
      send(step);
      if (step.shot) {
        await new Promise(r => setTimeout(r, step.delay || 400));
        const img = await overlay.webContents.capturePage();
        fs.writeFileSync(step.shot, img.toPNG());
      }
    }
  }
  const img = await overlay.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('[capture] written', out);
  app.quit();
}

// 二重起動しない（前の HUD が残ったまま重なるのを防ぐ）。2回目の起動は操作パネルを前に出すだけ
// 画面の大きさが変わって起動し直したとき（--relaunched）は、前の HUD が終わりきるまで少し待ってから確かめる
const gotLock = () => { if (app.requestSingleInstanceLock()) return true; if (!flag('relaunched')) return false; for (let i = 0; i < 6; i++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); if (app.requestSingleInstanceLock()) return true; } return false; };
if (!opt('capture', '') && !opt('bench', '') && !opt('log-states', '') && !gotLock()) { app.quit(); }
app.on('second-instance', () => { if (control && !control.isDestroyed()) { control.show(); control.focus(); } });


// ---- かんたん診断・問い合わせ用の情報（2026-10-28）----
// よくある原因を確かめて、直し方を返す。読むのはアプリ自身の状態・画面の大きさ・Apex が起動しているかだけ。
const OK_RES = ['1920x1080', '2560x1440', '3840x2160', '2560x1080', '3440x1440', '1280x720', '1600x900', '5120x1440'];
async function collectCheck() {
  const st = readSettingsSafe(), d = targetDisplay(), all = screen.getAllDisplays();
  const px = { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) };
  let r = null; try { r = overlay && !overlay.isDestroyed() ? await overlay.webContents.executeJavaScript('window.hud.reading && window.hud.reading()') : null; } catch { r = null; }
  const items = [];
  const add = (level, title, fix) => items.push({ level, title, fix: fix || '' });
  if (gameInfo.checked && gameInfo.apexRunning === false) add('warn', 'Apex Legends が起動していません', 'ゲームを起動すると自動で反応します。ゲームの外では枠は隠れます（故障ではありません）。');
  else if (gameInfo.checked) add('ok', 'Apex Legends が起動しています');
  if (!hudOn) add('ng', 'HUD が OFF になっています', `${TOGGLE_KEY()} を押すと ON になります。`); else add('ok', 'HUD は ON です');
  if (EDITION.obs && st.screenHud === false) add('warn', '「自分の画面にも出す」が OFF です', '配信（OBS）にだけ出ている状態です。自分の画面にも出すときは、メニュー「設定」でチェックを入れてください。');
  if (r == null) add('ng', '画面の読み取りが OFF です', 'メニュー「設定」の「読み取り ON」を押してください。');
  else if (r.hudVisible) add('ok', 'ゲームの HUD を読み取れています');
  else if (gameInfo.apexRunning) add('warn', 'ゲームの HUD が見つかりません',
    '試合中にもう一度「かんたん診断」を押してください（ロビー・マップ表示中は見えないのが正常です）。試合中でも出るときは、Apex の表示モードを「ボーダーレスウィンドウ」に、ゲームの「HUD のサイズ」を既定に戻してください。');
  const res = `${px.w}x${px.h}`;
  if (OK_RES.includes(res)) add('ok', `画面の大きさ ${px.w}×${px.h} に対応しています`);
  else add('warn', `画面の大きさ ${px.w}×${px.h} はまだ確認していない大きさです`, 'Apex の解像度を画面と同じにしてください。ずれるときは、ずれ方のスクリーンショットをお問い合わせで送ってください。');
  if (all.length > 1) add('ok', `モニターが ${all.length} 台あります（HUD は Apex が映っているモニターに出ます）`, 'Apex を別のモニターに移したときは、3 秒ほどで自動で起動し直してそちらに出ます。');
  if (EDITION.obs) {
    if (obsClients.size > 0) add('ok', 'OBS とつながっています');
    else add('info', 'OBS とはまだつながっていません', '配信に出さないなら問題ありません。配信に出すときは「配信に出す（OBS）」の URL を OBS のブラウザソースに貼ってください。');
  }
  const info = [
    '【OverLIVE 問い合わせ用の情報】',
    `グレード：${EDITION.label || EDITION.id}／バージョン：${app.getVersion()}`,
    `Windows：${require('os').release()}`,
    `画面：${px.w}×${px.h}（拡大率 ${Math.round(d.scaleFactor * 100)}%・${d.displayFrequency || '?'}Hz）／モニター ${all.length} 台`,
    `Apex：${gameInfo.checked ? (gameInfo.apexRunning ? '起動中' : '起動していない') : '確認できず'}／HUD：${hudOn ? 'ON' : 'OFF'}／読み取り：${r == null ? 'OFF' : (r.hudVisible ? 'ゲームのHUDを検出中' : 'ゲームのHUDが見つからない')}`,
    EDITION.obs ? `OBS：${obsClients.size > 0 ? 'つながっている' : 'つながっていない'}／自分の画面にも出す：${st.screenHud === false ? 'OFF' : 'ON'}` : '',
    `キャラ：${st.character || '既定'}／枠：${st.frameStyle || 'auto'}`,
    `診断の結果：${items.filter(x => x.level === 'ng' || x.level === 'warn').map(x => x.title).join('／') || '問題なし'}`,
    recentErrors.length ? '最近のエラー：\n' + recentErrors.map(e => '・' + e).join('\n') : '最近のエラー：なし',
    '',
    '（この下に、どんなときに、どうなったかを書いてください）',
  ].filter(x => x !== '').join('\n');
  return { items, info };
}
ipcMain.handle('hud:check', () => collectCheck());
ipcMain.handle('hud:copy-info', async () => { const c = await collectCheck(); require('electron').clipboard.writeText(c.info); return c.info; });

// ---- 表示するモニター（2026-11-03：複数モニター対応）----
// 枠・画面の読み取り・演出・コメント・NOW PLAYING は、すべてこのモニターに出す。
// 決め方：--display=番号 ＞ 前回 Apex が映っていたモニター（settings の gameDisplayId）＞ メインのモニター。
// Apex がほかのモニターで手前に来たら、そのモニターを覚えて起動し直す（下の startGameWatch）。
function targetDisplay() {
  const prim = screen.getPrimaryDisplay();
  let all = [prim]; try { all = screen.getAllDisplays(); } catch { /* 起動直後 */ }
  const want = opt('display', '') || String(readSettingsSafe().gameDisplayId || '');
  return (want && all.find(d => String(d.id) === want)) || prim;
}
global.__overliveDisplay = targetDisplay;   // comments_main.js・nowplaying_main.js からも使う
// Apex のウィンドウの真ん中（PowerShell が返す画面のピクセル座標）が、どのモニターにあるか
function displayAtScreenPoint(x, y) {
  const all = screen.getAllDisplays();
  for (const d of all) {   // 拡大率つきのモニターでも合うよう、実際のピクセルの範囲で見る
    let r = d.bounds; try { if (screen.dipToScreenRect) r = screen.dipToScreenRect(null, d.bounds); } catch { /* 非対応 */ }
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return d;
  }
  for (const d of all) { const r = d.bounds; if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return d; }
  return null;
}
let displaySwitchTimer = null, displaySeen = null;
function noteApexDisplay(rect) {
  if (opt('display', '') || flag('windowed') || TEST_VIDEO || opt('capture', '') || opt('bench', '')) return;
  const [l, t, r, b] = rect; if (!(r > l && b > t)) return;
  const d = displayAtScreenPoint((l + r) / 2, (t + b) / 2); if (!d) return;
  displaySeen = String(d.id);
  if (displaySeen === String(targetDisplay().id)) { clearTimeout(displaySwitchTimer); displaySwitchTimer = null; return; }
  if (displaySwitchTimer) return;
  // 3 秒たってもそのモニターで手前にあれば切り替える（ウィンドウを動かしている途中で切り替えないように）
  displaySwitchTimer = setTimeout(() => {
    displaySwitchTimer = null;
    if (!displaySeen || displaySeen === String(targetDisplay().id) || !gameInfo.apexFront) return;
    try { fs.writeFileSync(SETTINGS(), JSON.stringify({ ...readSettings(), gameDisplayId: displaySeen })); } catch (e) { console.warn('[display] save', e); return; }
    console.log('[display] Apex is on display', displaySeen, '→ relaunch');
    quitting = true;
    app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--relaunched').concat(['--relaunched']) });
    app.exit(0);
  }, 3000);
}

// ---- ゲームが前面にあるかの確認（2026-10-24）----
// デスクトップの白いウィンドウや黄色い壁紙を、ゲームの体力バーと見まちがえて枠がちらつくことがあったため、
// Apex（r5apex*）が起動していて、いちばん手前にあるときだけ画面の読み取り結果で枠を出す。
// メニューなど HUD 自身が手前のときは、直前の状態のまま。確かめられないとき（PowerShell が動かない等）は今までどおり。
// 見るのは「いちばん手前のウィンドウのアプリ名」と「Apex が起動しているか」だけ。ゲームの中身には触れない。
let gameActive = true;
const gameInfo = { checked: false, apexRunning: null, apexFront: null };   // かんたん診断用
function setGameActive(v) {
  if (v === gameActive) return;
  gameActive = v;
  for (const w of overlays()) w.webContents.send('hud:input', { options: { gameActive: v } });
}
function startGameWatch() {
  if (process.platform !== 'win32' || flag('no-game-check') || opt('capture', '') || opt('bench', '')) return;
  const ps = "Add-Type -Namespace KFW -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);';"
    // 2026-11-03：Apex のウィンドウの位置（どのモニターか）。作れなくても今までの確認はそのまま動くよう、別に作って try で囲む
    + " $okR=$false; try { Add-Type -ErrorAction Stop -Namespace KFW2 -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); public struct RECT { public int L; public int T; public int R; public int B; }'; $okR=$true } catch {};"
    + " $last=''; while ($true) { $p=0; $h=[KFW.U]::GetForegroundWindow(); [void][KFW.U]::GetWindowThreadProcessId($h, [ref]$p); $n='';"
    + " try { $n=(Get-Process -Id $p -ErrorAction Stop).ProcessName } catch {}; $a=@(Get-Process -Name 'r5apex*' -ErrorAction SilentlyContinue).Count;"
    + " $w=''; if ($okR -and $n -like 'r5apex*') { $rc=New-Object KFW2.Win+RECT; if ([KFW2.Win]::GetWindowRect($h, [ref]$rc)) { $w=\"$($rc.L),$($rc.T),$($rc.R),$($rc.B)\" } }; $s=\"$n|$a|$w\"; if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last=$s }; Start-Sleep -Milliseconds 500 }";
  let child;
  try { child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }); }
  catch { return; }
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const [fg = '', cnt = '0', wr = ''] = line.split('|');
      const f = fg.toLowerCase(), running = +cnt > 0;
      const self = f.startsWith('aquakawaiihud') || f === 'electron';
      gameInfo.checked = true; gameInfo.apexRunning = running; if (!self) gameInfo.apexFront = f.startsWith('r5apex');
      if (flag('debug-game')) console.log('[game]', line);
      if (!running) setGameActive(false);
      else if (f.startsWith('r5apex')) { setGameActive(true); if (wr) noteApexDisplay(wr.split(',').map(Number)); }
      else if (!self) setGameActive(false);
    }
  });
  child.on('error', () => setGameActive(true));
  child.on('exit', () => setGameActive(true));
  app.on('will-quit', () => { try { child.kill(); } catch { /* 終わっている */ } });
}

app.whenReady().then(() => {
  if (!TEST_VIDEO) migrateOldDocDirs();
  // 画面キャプチャの許可：主画面（または --display=番号）を、確認ダイアログなしで HUD 自身にだけ渡す
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    // 配信用の窓からの頼みには、Apex のウィンドウだけを渡す（見つからなければ渡さない → 窓のほうで少し待ってやり直す）
    let fromStream = false;
    try { fromStream = !!(_req && _req.frame && String(_req.frame.url || '').startsWith(STREAM_PAGE())); } catch { /* 古い Electron */ }
    if (fromStream) {
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
        const src = sources.find(s => /^apex legends$/i.test(String(s.name).trim())) || sources.find(s => /apex legends/i.test(String(s.name)) && !/AQUA KAWAII HUD|OverLIVE/i.test(String(s.name)));
        cb(src ? { video: src } : {});
      }).catch(() => cb({}));
      return;
    }
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const want = opt('display', '');
      const primary = String(targetDisplay().id);
      const src = sources.find(s => want ? s.display_id === want : s.display_id === primary) || sources[0];
      cb(src ? { video: src } : {});
    }).catch(() => cb({}));
  });
  createOverlay();
  watchDisplay();
  if (EDITION.api) startApi();   // ローカル API は管理用だけ
  startObsServer();
  if (EDITION.obs) COMMENTS.start();
  if (EDITION.obs && !TEST_VIDEO) NOWPLAY.start();   // 2026-11-02：再生中の曲
  if (EDITION.obs && readSettingsSafe().screenHud === false) setTimeout(() => setHud(false), 300);   // 前回「配信にだけ出す」にしていたら
  startTrialTimer();
  startGameWatch();
  checkUpdate();
  // テスト操作パネルは必ず開く（起動確認と終了ボタンのため）。検証用の自動実行時のみ開かない
  if (!flag('no-control') && !opt('capture', '') && !opt('bench', '')) { createControl(); startSafetyTimer(); }
  globalShortcut.register('Control+Shift+F9', createControl);
  const toggleHud = () => setHud(!hudOn);
  globalShortcut.register('Control+Shift+F10', toggleHud);
  if (!globalShortcut.register(TOGGLE_KEY(), toggleHud)) console.warn('[toggle] could not register', TOGGLE_KEY());
  if (TOGGLE_KEY() !== 'Insert') globalShortcut.register('Insert', toggleHud);   // Insert キーがあるキーボードでは従来どおり Insert でも
  if (!globalShortcut.register(MENU_KEY(), toggleMenu)) console.warn('[menu] could not register', MENU_KEY());
  let perfOn = flag('perf');
  globalShortcut.register('Control+Shift+F11', () => { perfOn = !perfOn; send({ options: { perf: perfOn } }); });
  globalShortcut.register('Control+Shift+F12', () => app.quit());
  if (EDITION.background) globalShortcut.register('Alt+B', () => { toggleBgAdjust(); if (bgAdjust) { createControl(); control.webContents.send('hud:input', { openTab: 'bg' }); } });   // 背景の調整モード（ゲーム画面で見ながら直す）
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'icon.png')));
    tray.setToolTip(EDITION.title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'メニュー', click: createControl },
      { label: '説明書（使い方）', click: () => openHelp('') },
      { label: 'HUD 表示/非表示', click: () => toggleHud() },
      { type: 'separator' }, { label: '終了', click: () => app.quit() },
    ]));
  } catch { /* トレイ非対応環境 */ }
  overlay.webContents.once('did-finish-load', () => { runBench(); runCapture(); startStateLog(); startTestRun(); });
  // 検証用：指定秒後に操作パネルを閉じる（閉じたら全体が終了することの確認）
  // 検証用：メニュー画面を画像に保存（--capture-control=path）
  const cc = opt('capture-control', '');
  if (cc) setTimeout(async () => { try { const tab = opt('tab', ''); if (tab) await control.webContents.executeJavaScript(`document.querySelector('nav button[data-tab="${tab}"]').click()`); await new Promise(r => setTimeout(r, 400)); fs.writeFileSync(cc, (await control.webContents.capturePage()).toPNG()); } catch (e) { console.error(e); } app.quit(); }, 3500);
  const tcc = +opt('test-close-control', 0);
  if (tcc) setTimeout(() => control && control.close(), tcc * 1000);
  const quitAfter = +opt('quit-after', 0);
  if (quitAfter) setTimeout(() => app.quit(), quitAfter * 1000);
});

// ---- 画面の大きさが変わったら起動し直す（2026-10-25）----
// HUD の窓の位置・大きさは起動したときの画面の大きさで決めている。HUD を出したまま解像度や拡大率を変えると、
// 枠がゲームの表示からずれたままになっていた → 変わったら 1.5 秒待ってから自動で起動し直す。
// どんな画面で動いているかを userData の display.json に残す（ずれの調査用）
function displayInfo() {
  const d = targetDisplay();
  return { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, size: d.size, displays: screen.getAllDisplays().length };
}
function watchDisplay() {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'display.json'), JSON.stringify({ at: new Date().toISOString(), ...displayInfo() }, null, 1)); } catch { /* 書けなくても続ける */ }
  if (flag('windowed') || opt('capture', '') || opt('bench', '') || flag('no-display-watch')) return;
  const keyOf = () => { const i = displayInfo(); return JSON.stringify([i.bounds, i.scaleFactor]); };
  let key = keyOf(), timer = null;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const k = keyOf(); if (k === key) return;
      key = k;
      console.log('[display] changed → relaunch', k);
      quitting = true;
      app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--relaunched').concat(['--relaunched']) });
      app.exit(0);
    }, 1500);
  };
  screen.on('display-metrics-changed', changed);
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
}

// ---- テストモードの記録と終了（--test-video）----
// 出来事（events.json）・エラー（errors.json）・まとめ（summary.json）を TEST_DIR に書く。
// 動画と同じ名前の .expect.json があれば、期待どおりかを判定して summary.json の pass に入れる。
//   例：{ "events": { "champion": 1, "knock": { "min": 1 } }, "noErrors": true }
const testErrors = [];
function testNote(where, msg) { if (TEST_VIDEO) testErrors.push({ t: Date.now(), where, msg: String(msg).slice(0, 2000) }); }
if (TEST_VIDEO) {
  process.on('uncaughtException', (e) => testNote('main', e && e.stack || e));
  process.on('unhandledRejection', (e) => testNote('main', e && e.stack || e));
}
function startTestRun() {
  if (!TEST_VIDEO) return;
  const t0 = Date.now();
  const write = (f, v) => { try { fs.writeFileSync(path.join(TEST_DIR, f), JSON.stringify(v, null, 1)); } catch (e) { console.error('[test]', e); } };
  for (const w of overlays()) {
    w.webContents.on('console-message', (e, level, message) => {
      const lv = e && e.level !== undefined ? e.level : level, text = e && e.message !== undefined ? e.message : message;
      if (lv === 'error' || lv === 3) testNote('renderer', text);
    });
    w.webContents.on('render-process-gone', (_e, d) => testNote('renderer', 'process gone: ' + (d && d.reason)));
  }
  if (!fs.existsSync(TEST_VIDEO)) { testNote('test', '動画が見つかりません: ' + TEST_VIDEO); }
  let finished = false;
  const finish = async (why) => {
    if (finished) return; finished = true;
    let info = {}, log = [];
    try { info = await overlay.webContents.executeJavaScript('window.hud && window.hud.testInfo ? window.hud.testInfo() : {}'); } catch (e) { testNote('test', e); }
    try { log = await overlay.webContents.executeJavaScript('window.hud && window.hud.testLog ? window.hud.testLog : []'); } catch (e) { testNote('test', e); }
    const counts = {};
    for (const x of log) if (x.event) counts[x.event] = (counts[x.event] || 0) + 1;
    let expect = null, checks = [], pass = null;
    const ef = (opt('test-expect', '') || '').replace(/^"|"$/g, '') || TEST_VIDEO.replace(/\.[^.]+$/, '') + '.expect.json';
    if (fs.existsSync(ef)) {
      try {
        expect = JSON.parse(fs.readFileSync(ef, 'utf8'));
        for (const [k, v] of Object.entries(expect.events || {})) {
          const n = counts[k] || 0;
          const ok = typeof v === 'number' ? n === v : ((v.min === undefined || n >= v.min) && (v.max === undefined || n <= v.max));
          checks.push({ event: k, expected: v, actual: n, ok });
        }
        if (expect.noErrors) checks.push({ event: 'errors', expected: 0, actual: testErrors.length, ok: testErrors.length === 0 });
        pass = checks.every(c => c.ok);
      } catch (e) { testNote('test', 'expect.json を読めません: ' + e.message); }
    }
    const summary = { video: TEST_VIDEO, finishedBy: why, wallSec: Math.round((Date.now() - t0) / 1000), videoSec: info.duration || null, reachedSec: info.time || null,
      readerStarted: !!info.readerStarted, frameSize: info.frameSize || null, events: counts, errorCount: testErrors.length, pass, checks, version: app.getVersion(), edition: EDITION.id };
    let raw = [];
    try { raw = await overlay.webContents.executeJavaScript('window.hud && window.hud.testRaw ? window.hud.testRaw : []'); } catch (e) { testNote('test', e); }
    write('events.json', log); write('errors.json', testErrors); write('summary.json', summary);
    try { fs.writeFileSync(path.join(TEST_DIR, 'raw.json'), JSON.stringify(raw)); } catch { /* 書けなくても続行 */ }
    // まとめて見られるよう、結果フォルダの親にも1行ずつ足していく
    try { fs.appendFileSync(path.join(path.dirname(TEST_DIR), 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), dir: path.basename(TEST_DIR), ...summary, checks: undefined }) + '\n'); } catch { /* 書けなくても続行 */ }
    console.log('[test] done', why, JSON.stringify(counts));
    quitting = true; app.quit();
  };
  let maxSec = 0;
  const iv = setInterval(async () => {
    let info = null;
    try { info = await overlay.webContents.executeJavaScript('window.hud && window.hud.testInfo ? window.hud.testInfo() : null'); } catch { /* 準備中 */ }
    if (info && info.duration) maxSec = info.duration / (+opt('test-speed', 1) || 1) * 3 + 60;   // 遅い PC でも最後まで再生できるよう余裕をとる
    if (info && info.error) { clearInterval(iv); testNote('test', info.error); finish('error'); return; }
    if (info && info.done) { clearInterval(iv); setTimeout(() => finish('ended'), 1500); return; }   // 最後の演出の分だけ少し待つ
    const el = (Date.now() - t0) / 1000;
    if ((maxSec && el > maxSec) || (!maxSec && el > 120)) { clearInterval(iv); testNote('test', 'タイムアウト（動画が終わらない／読み込めない）'); finish('timeout'); }
  }, 500);
}

// ---- 状態ログ（--log-states=path、通しテスト用）----
function startStateLog() {
  const out = opt('log-states', '');
  if (!out) return;
  const t0 = Date.now(); let lastKey = '', lastVKey = '', shotN = 0;
  const lines = [];
  setInterval(async () => {
    try {
      const [d, r, ti] = await overlay.webContents.executeJavaScript('[window.hud.derive(), window.hud.reading(), window.hud.testInfo ? window.hud.testInfo() : null]');
      const key = [d.expression, d.panel, d.hudHidden, r ? Math.round(r.hpRatio * 100) : '-', r ? r.shieldPoints : '-', JSON.stringify(d.mates), JSON.stringify(d.shown)].join('|');
      const vkey = [d.expression, d.panel, d.hudHidden, JSON.stringify(d.mates), JSON.stringify(d.shown)].join('|');
      if (TEST_VIDEO && flag('test-shots') && vkey !== lastVKey && shotN < 400 && ti && ti.readerStarted) {
        lastVKey = vkey; shotN++;
        const vt = ti.time;
        setTimeout(async () => {
          try {
            const img = await overlay.webContents.capturePage();
            const dir = path.join(TEST_DIR, 'shots'); fs.mkdirSync(dir, { recursive: true });
            const t2 = await overlay.webContents.executeJavaScript('window.hud.testInfo().time');
            fs.writeFileSync(path.join(dir, String(Math.round(vt * 1000)).padStart(6, '0') + '_' + String(Math.round(t2 * 1000)).padStart(6, '0') + '.png'), img.toPNG());
          } catch (e) { console.error('[shot]', e); }
        }, 150);
      }
      if (key !== lastKey) { lastKey = key; lines.push({ t: Date.now() - t0, vt: ti && ti.readerStarted ? Math.round(ti.time * 100) / 100 : undefined, expression: d.expression, panel: d.panel, hudHidden: d.hudHidden, mates: d.mates, shown: d.shown, reading: r }); fs.writeFileSync(out, JSON.stringify(lines, null, 1)); }
    } catch { /* 起動中 */ }
  }, 20);
}

app.on('will-quit', () => { try { NOWPLAY.stop(); } catch { /* なし */ } globalShortcut.unregisterAll(); OCR.terminate().catch(() => {}); });
// 終了時は全ウィンドウを確実に破棄する
app.on('before-quit', () => { quitting = true; for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch { /* 既に閉じている */ } } });
app.on('window-all-closed', () => app.quit());
