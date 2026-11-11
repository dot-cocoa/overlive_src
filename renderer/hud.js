/* OverLIVE — 描画（v2：ゲームHUDに合わせた枠のみ・画面読み取りで反応） */
(async function () {
  'use strict';
  const M = window.HudModel, R = window.HudReader;
  // 配信用（OBS のブラウザソース）：アプリから設定と出来事を受け取って同じ HUD を描く。読み取りはしない
  const OBS = new URLSearchParams(location.search).get('part') === 'obs';
  let api = window.hudApi || null;
  if (OBS && !api) {
    // 2026-10-25：つないだ直後に届く「今の状態」（ミニマップを隠す・味方がいない等）は、HUD の準備（設定の読み込み）より先に届く。
    //   前は受け取る人がまだいなくて捨てていたため、配信用ページだけミニマップ・方位・味方の枠が出たままになっていた → 準備ができるまでためておく
    const listeners = [], early = [];
    const es = new EventSource('/obs/events');
    es.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (!listeners.length) { early.push(m); return; } for (const cb of listeners) cb(m); };
    let wasDown = false;
    es.onerror = () => { wasDown = true; };
    es.onopen = () => { if (wasDown) location.reload(); };   // アプリを起動し直したら、設定ごと読み込み直す
    api = { getConfig: () => fetch('/obs/config').then(r => r.json()), onInput: (cb) => { listeners.push(cb); setTimeout(() => { while (early.length) { const m = early.shift(); for (const f of listeners) f(m); } }, 0); }, obs: true };
  }
  const cfg = api ? await api.getConfig() : await (async () => {
    const j = (u) => fetch(u).then(r => r.ok ? r.json() : Promise.reject(r.status));
    const manifest = await j('../assets/manifest.json').catch(() => j('../assets/manifest.provisional.json'));
    const q = new URLSearchParams(location.search);
    return { manifest, reader: await j('../assets/reader.json'),
      options: { demoBg: q.has('bg'), perf: q.has('perf'), idleMotion: !q.has('still'), screenRead: false, showRegions: q.has('regions'), minimap: !q.has('nominimap') } };
  })();
  const { manifest, reader: RC, options } = cfg;
  // このウィンドウが受け持つ部分（left=左下 / center=ウルト / right=右下 / minimap / compass / all=検証用に全体）
  const PART = OBS ? 'all' : (new URLSearchParams(location.search).get('part') || 'all');
  const READS = !OBS && (PART === 'all' || PART === 'left');   // 画面読み取りはプレイヤー枠のウィンドウだけが行う（配信用ページは読まない）
  if (OBS) document.body.classList.add('obs');
  const ORIGIN = (cfg.parts && cfg.parts[PART]) || { x: 0, y: 0 };
  const useScreen = !!(cfg.screen && PART !== 'all') || (cfg.single && !cfg.windowed && cfg.screen);
  // 2026-10-25：配信用ページ（OBS）は、ゲームの画面の縦横比で並べ、ページの真ん中に置く。
  //   OBS のキャンバス（例 2560×1080）よりゲーム（例 1920×1080）が細いと、OBS はゲームを真ん中に置くため、前は枠が左右にずれていた
  const obsFit = () => {
    if (!OBS || !cfg.screen) return null;
    const iw = window.innerWidth, ih = window.innerHeight, ar = cfg.screen.width / cfg.screen.height;
    const w = Math.min(iw, ih * ar), h = w / ar;
    return { w, h, x: (iw - w) / 2, y: (ih - h) / 2 };
  };
  const screenW = () => { const f = obsFit(); return f ? f.w : useScreen ? cfg.screen.width : window.innerWidth; };
  const screenH = () => { const f = obsFit(); return f ? f.h : useScreen ? cfg.screen.height : window.innerHeight; };
  if (OBS) { const upd = () => { const f = obsFit(); if (f) { ORIGIN.x = -f.x; ORIGIN.y = -f.y; } }; upd(); window.addEventListener('resize', upd); }
  const BW = manifest.baseWidth, BH = manifest.baseHeight;
  const $ = (s) => document.querySelector(s);
  const body = document.body;

  body.classList.toggle('idle-motion', options.idleMotion !== false);
  body.classList.toggle('no-minimap', options.minimap === false);
  if (manifest.version !== 4) console.warn('[hud] manifest v4 が必要です');
  function setDemoBg(on) {
    body.classList.toggle('demo-bg', !!on);
    const img = $('#demo-bg');
    if (on && !img.src) img.src = '../assets/demo_game.jpg';
    // 小さなウィンドウに分かれていても、画面全体の絵の「自分の位置の部分」だけを出す
    Object.assign(img.style, { inset: 'auto', left: -ORIGIN.x + 'px', top: -ORIGIN.y + 'px', width: screenW() + 'px', height: screenH() + 'px' });
  }
  setDemoBg(options.demoBg);

  // ---------- 配置：ゲームの HUD と同じく「画面の高さ」に比例し、各要素は自分の基準の角に寄せる ----------
  function place(el, x, y, anchor) {
    const W = screenW(), H = screenH(), k = H / BH;
    let left, top;
    if (anchor[0] === 't') top = y * k; else top = H - (BH - y) * k;
    if (anchor[1] === 'l') left = x * k;
    else if (anchor[1] === 'r') left = W - (BW - x) * k;
    else left = W / 2 + (x - BW / 2) * k;
    el.style.transform = `translate(${left - ORIGIN.x}px, ${top - ORIGIN.y}px) scale(${k})`;
  }
  const mine = (win) => PART === 'all' || win === PART;
  body.classList.add('part-' + PART);
  const stage = $('#stage');
  const loads = [];
  const placed = [];   // [el, x, y, anchor]
  const curChar = (cfg.characters && cfg.characters[cfg.character]) || null;
  const FR = ('framesDir' in cfg) ? cfg.framesDir : ((curChar && curChar.frames) || null);   // 枠フォルダ（キャラ専用・単色。無ければ既定の v4/）
  const fr = (file) => (FR && typeof file === 'string' && file.startsWith('v4/')) ? FR + file.slice(3) : file;
  function applyTheme(theme) {
    const t = theme || {};
    body.style.setProperty('--flow-color', t.flow || 'rgba(140,235,255,.75)');
    body.style.setProperty('--name-glow', t.nameGlow || 'rgba(80,200,255,.95)');
    body.dataset.sparkle = JSON.stringify(t.sparkle || null);
  }
  applyTheme(cfg.themeEff || (curChar && curChar.theme));
  const src = (file) => /^(data:|file:)/.test(file) ? file : '../assets/' + file;   // マイキャラの画像は data URL
  function img(file, cls, w, h) {
    file = fr(file);
    const im = document.createElement('img');
    im.className = cls; im.alt = ''; im.decoding = 'async'; if (w) { im.width = w; im.height = h; }
    loads.push(new Promise((res) => { im.onload = im.onerror = res; }));
    im.src = src(file);
    return im;
  }
  // 2026-10-28：枠を右へのばせるようにする（オクタンの2本目のゲージ用）。新しい画像は作らず、今の枠を3つに切って並べる：
  //   左（cut まで）／まん中（cut の 2px 列を横にのばす＝上下の線がまっすぐなところ）／右（cut から先を add だけ右へずらす）
  //   色テーマ・キャラの枠に切り替えても、同じ img.layer なのでそのまま差し替わる。.ext が付いている間だけのばす
  function extendable(g, p, cut, add) {
    const a = document.createElement('div'); a.className = 'seg seg-a';
    a.style.width = p.w + 'px'; a.style.height = p.h + 'px';
    while (g.firstChild) a.appendChild(g.firstChild);
    g.appendChild(a);
    const m = a.cloneNode(true), b = a.cloneNode(true);
    m.className = 'seg seg-m'; b.className = 'seg seg-b';
    m.style.clipPath = `inset(0 ${p.w - cut - 2}px 0 ${cut}px)`; m.style.transformOrigin = `${cut}px 0`; m.style.transform = `scaleX(${add / 2})`;
    b.style.clipPath = `inset(0 0 0 ${cut}px)`; b.style.transform = `translateX(${add}px)`;
    g.appendChild(m); g.appendChild(b);
    g.style.setProperty('--seg-cut', (p.w - cut - 1) + 'px'); g.style.setProperty('--ext-w', (p.w + add) + 'px');
  }
  // 2026-10-29（ユーザー決定）：1つ用の戦術の枠は右の細い窓（回数の窓）なしの絵にした（tactical_*.png を作り直し：左は今までの枠、右のふちは2つ用の枠の右はしを使う）。
  //   窓のふた（aqua2・確認用の穴つき）は出さない
  // 2026-10-31（ユーザー要望：武器の見出しを見えるように）：ゲームが武器の欄の上に黄色い帯（「ブリーチチャージモード」など）を出している間は、
  //   枠のその部分（画面の x2176〜2515・y954 より上）をくりぬいて、帯が見えるようにする。世界観の枠の見出しが帯にかぶっていた（グリッチ・サイバーパンク）
  function setBannerHole(g, p) {
    const x0 = Math.max(0, 2176 - p.x), x1 = Math.min(p.w, 2515 - p.x), y1 = Math.min(p.h, 954 - p.y);
    if (x1 <= x0 || y1 <= 0) return;
    g.style.setProperty('--wb-clip', `path(evenodd, "M0 0H${p.w}V${p.h}H0Z M${x0} 0H${x1}V${y1}H${x0}Z")`);
  }
  { const st = document.createElement('style'); st.textContent = '.group.wbanner > * { clip-path: var(--wb-clip, none); }'; document.head.appendChild(st); }
  function noStrip(g) { for (const l of g.querySelectorAll('.lid')) l.remove(); }


  // 枠のパーツ（状態ごとの色違いを重ね、ふたは窓の上に重ねる）
  // 2026-10-28：世界観テーマの枠：共通の CSS と SVG の定義（グラデーション・歯車の形など）を1回だけ入れる
  if (manifest.themeCss) { const st = document.createElement('style'); st.textContent = manifest.themeCss; document.head.appendChild(st); }
  if (manifest.themeDefs) { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden'; d.innerHTML = manifest.themeDefs; document.body.prepend(d); }
  const G = {};
  for (const [name, p] of Object.entries(manifest.parts)) {
    if (!mine(p.win)) continue;
    const g = document.createElement('div');
    g.className = 'group s-normal'; g.id = 'g-' + name;
    g.style.width = p.w + 'px'; g.style.height = p.h + 'px';
    for (const [st, file] of Object.entries(p.layers)) g.appendChild(img(file, 'layer v-' + st, p.w, p.h));
    // 動く部分（歯車・蒸気・夕日など）は SVG を重ねる。状態はこの枠の s-〇〇 のクラスで切り替わる
    if (p.svgText) { const host = document.createElement('div'); host.className = 'fxsvg'; host.innerHTML = p.svgText; g.appendChild(host); }
    const lids = {};
    for (const [ln, L] of Object.entries(p.lids || {})) {
      const d = document.createElement('div');
      d.className = 'lid'; d.dataset.lid = ln;
      d.style.left = (L.x - p.x) + 'px'; d.style.top = (L.y - p.y) + 'px'; d.style.width = L.w + 'px'; d.style.height = L.h + 'px';
      for (const [st, file] of Object.entries(L.files)) d.appendChild(img(file, 'v-' + st, L.w, L.h));
      g.appendChild(d); lids[ln] = { el: d, closes: L.closes };
    }
    // 水色の窓のまとまり（重なっている窓どうしは組み合わせのふたを使う）
    const clusters = [];
    for (const [ln, L] of Object.entries(lids)) {
      if (ln.startsWith('sh_')) continue;
      let c = clusters.find(c => L.closes.some(i => c.ids.has(i)));
      if (!c) { c = { ids: new Set(), lids: [] }; clusters.push(c); }
      L.closes.forEach(i => c.ids.add(i)); c.lids.push(ln);
    }
    if (window.HudFx) {
      const fl = window.HudFx.makeFlow(g, Object.assign({}, p, { tube: fr(p.tube) }));
      if (fl) {
        fl.style.animationDelay = (-(1 - p.x / BW) * 1.0) + 's';
        // 光はふたの下を通す（閉じている窓・まだ無いシールドの段の上を光が流れないように）
        const firstLid = g.querySelector('.lid'); if (firstLid) g.insertBefore(fl, firstLid);
      }
    }
    // 2026-10-30（ユーザー指摘：のびた枠が少し右にずれる）：ゲームの欄は 94px 右へ出る（録画 02.11.57 で計測）→ 100 から 94 に
    if (name === 'tactical2') extendable(g, p, 135, 94);
    if (name === 'weapon') setBannerHole(g, p);
    // 2026-10-29（ユーザー決定）：オクタン以外（1つ用の枠）は、右の「回数」の細い窓（aqua2 の確認用の穴つき）をなくす。
    //   枠の絵はそのままで、右の窓の分（12px）を切り取り、外側の右のふちを左へ寄せてつなぐ（ふちは斜めなので斜めに切る）
    if (name === 'tactical' && p.w === 128 && p.h === 86) noStrip(g);
    stage.appendChild(g);
    G[name] = { el: g, lids, clusters, state: 'normal', lidKey: '' };
    if (/^player_[swm]$/.test(name)) g.classList.add('off');   // シンプル枠は4段のモードのときだけ
    const pl = [g, p.x, p.y, p.anchor]; G[name].placed = pl; G[name].baseY = p.y;
    placed.push(pl);
  }
  // 少女（表情9種）
  const faceEls = {};
  const girl = manifest.girl;
  if (girl && mine(girl.win)) {
    const xs = girl.clip.map(q => q[0]), ys = girl.clip.map(q => q[1]);
    const gx0 = Math.min(...xs), gy0 = Math.min(...ys), gx1 = Math.max(...xs), gy1 = Math.max(...ys);
    const g = document.createElement('div');
    g.className = 'group'; g.id = 'g-girl';
    Object.assign(g.style, { width: (gx1 - gx0) + 'px', height: (gy1 - gy0) + 'px',
      clipPath: 'polygon(' + girl.clip.map(q => `${q[0] - gx0}px ${q[1] - gy0}px`).join(',') + ')' });
    const mv = document.createElement('div'); mv.id = 'girl-move'; g.appendChild(mv);
    const charFaces = (cfg.characters && cfg.characters[cfg.character]) ? cfg.characters[cfg.character].faces : null;
    // 表情画像は「幅 girl.w」に合わせ、縦横比は画像そのまま（キャラごとに高さが違っても潰れない）。下端を girl.y に揃える
    const fitFace = (im) => {
      if (!im.naturalWidth) return;
      const w = girl.w, hh = im.naturalHeight * w / im.naturalWidth;
      im.style.width = w + 'px'; im.style.height = hh + 'px';
      im.style.left = (girl.x - gx0) + 'px'; im.style.top = (girl.y - hh - gy0) + 'px';
      im.dataset.h = hh;
    };
    for (const key of M.EXPRESSION_KEYS) {
      const f = manifest.faces[key];
      const im = img(charFaces ? (charFaces[key] || charFaces.normal) : f.file, 'face');
      im.addEventListener('load', () => fitFace(im));
      mv.appendChild(im); faceEls[key] = im;
    }
    stage.insertBefore(g, G.item ? G.item.el : null);   // プレイヤー枠・ダウン中の枠の上、アイテム枠の下
    placed.push([g, gx0, gy0, girl.anchor]);
    g.classList.toggle('nochara', !!options.noChara);   // キャラなし（枠だけ）
  }
  // 体験版マーク（録画・配信にも映る）。プレイヤー枠の右、アイテム枠の上に小さく出す
  // 2026-10-24：枠の右上（300,884）だとゲームの味方のバナーに重なったので、右下へずらした（体力バー・味方・アイテムにはかからない）
  const ED = cfg.edition || {};
  if (ED.mark && (PART === 'left' || PART === 'all') && manifest.parts.player) {
    const g = document.createElement('div'); g.className = 'group'; g.id = 'g-trial';
    g.textContent = 'OverLIVE 体験版';
    stage.appendChild(g); placed.push([g, 442, 928, 'bl']);
  }
  // プレイヤー名（アプリが描く）
  let nameEl = null;
  const NM = manifest.name;
  if (NM && mine(NM.win)) {
    const g = document.createElement('div'); g.className = 'group'; g.id = 'g-name';
    g.style.fontSize = NM.size + 'px';
    nameEl = document.createElement('span'); g.appendChild(nameEl);
    stage.appendChild(g); placed.push([g, NM.x, NM.y, NM.anchor]);
  }
  function setName(text) {
    if (!nameEl) return;
    nameEl.textContent = text || '';
    nameEl.style.transform = '';
    const w = nameEl.getBoundingClientRect().width / (screenH() / BH);
    if (w > NM.maxW) nameEl.style.transform = `scaleX(${NM.maxW / w})`;
  }

  // メニューで「表示しない」にした項目を隠す（読み取り・表情の切り替えは続ける）
  const HIDE_GROUPS = { minimap: ['minimap'], compass: ['compass'], player: ['player', 'player_s', 'player_w', 'player_m', 'knock'], mates: ['mate1', 'mate2', 'mate1_m', 'mate2_m'], item: ['item'],
    tactical: ['tactical', 'tactical2'], ult: ['ult', 'ult2'], weapon: ['lalt', 'g', 'weapon'] };
  function applyHidden(list) {
    const h = new Set(Array.isArray(list) ? list : []);
    for (const [key, names] of Object.entries(HIDE_GROUPS)) for (const n of names) if (G[n]) G[n].el.classList.toggle('uoff', h.has(key));
    const gg = document.getElementById('g-girl'); if (gg) gg.classList.toggle('uoff', h.has('girl'));
    if (nameEl) nameEl.classList.toggle('uoff', h.has('name'));
    body.classList.toggle('no-minimap', h.has('minimap') || options.minimap === false);
  }
  applyHidden(options.hidden);

  // ---------- 枠の背景画像（カスタム版）：パネルの部分だけに画像を入れる。窓・ネオンの線には入れない ----------
  const BG_GROUPS = { player: ['player', 'player_s', 'player_w', 'player_m', 'knock'], mates: ['mate1', 'mate2', 'mate1_m', 'mate2_m'], item: ['item'], tactical: ['tactical', 'tactical2'], ult: ['ult', 'ult2'],
    weapon: ['lalt', 'g', 'weapon'], minimap: ['minimap'], compass: ['compass'] };
  let bgState = null;
  function applyBackground(b) {
    if (!b) return;
    bgState = Object.assign({}, bgState || {}, b);
    if (!('url' in b) && bgState.url === undefined) bgState.url = null;
    const s = bgState;
    const targets = new Set((s.targets || []).flatMap(k => BG_GROUPS[k] || []));
    body.classList.toggle('bg-adjust', !!s.adjust);
    for (const [name, g] of Object.entries(G)) {
      let d = g.el.querySelector(':scope > .bgimg, :scope > .seg-a > .bgimg');
      const p = manifest.parts[name], mask = s.masks && s.masks[name];
      if (!s.url || !mask || !targets.has(name) || !s.w) { if (d) d.remove(); for (const x of g.el.querySelectorAll('.lid > .bgimg, .lid > img.lidfill')) x.remove(); for (const x of g.el.querySelectorAll('.lid')) delete x.dataset.fill; continue; }
      if (!d) {
        d = document.createElement('div'); d.className = 'bgimg';
        const layers = g.el.querySelectorAll(':scope > img.layer, :scope > .seg-a > img.layer');   // のばせる枠（tactical2）は左の切れはしの中
        const last = layers[layers.length - 1];
        last ? last.after(d) : g.el.prepend(d);
      }
      // 画像は枠ごとに「すき間なく覆う」大きさを 100% として、大きさ・位置を調整
      // 2026-10-31（ユーザー指摘：見本とずれる）：ワイルドカード等のシンプル枠（player_m など）・オクタン用（tactical2・ult2）は
      //   形も大きさも違うので、それぞれの大きさで計算すると画像が別の位置に出ていた → 見本と同じ「もとの枠」（player など）を基準に計算し、位置の差だけずらす
      const RF = { player_s: 'player', player_w: 'player', player_m: 'player', knock: 'player', mate1_m: 'mate1', mate2_m: 'mate2', tactical2: 'tactical', ult2: 'ult' };
      const q = (RF[name] && manifest.parts[RF[name]]) || p;
      const c = Math.max(q.w / s.w, q.h / s.h) * (s.scale || 100) / 100;
      const W = s.w * c, H = s.h * c;
      const x = (q.w - W) / 2 + (s.x || 0) / 100 * q.w + (q.x - p.x), y = (q.h - H) / 2 + (s.y || 0) / 100 * q.h + (q.y - p.y);
      if (d.dataset.url !== String(s.url.length) + s.url.slice(-32)) { d.style.backgroundImage = `url("${s.url}")`; d.dataset.url = String(s.url.length) + s.url.slice(-32); }
      if (d.dataset.mask !== mask.slice(-32)) { d.style.webkitMaskImage = `url("${mask}")`; d.style.maskImage = `url("${mask}")`; d.dataset.mask = mask.slice(-32); }
      Object.assign(d.style, { width: p.w + 'px', height: p.h + 'px', backgroundSize: `${W}px ${H}px`, backgroundPosition: `${x}px ${y}px`,
        opacity: String((s.opacity == null ? 60 : s.opacity) / 100), filter: `brightness(${s.brightness || 100}%)` + (s.blur ? ` blur(${s.blur}px)` : '') });
      // 2026-11-01（ユーザー指摘：背景を入れると、閉じた蓋のところだけ画像が入らず元の色が見える）：ふたの中にも同じ画像を、枠と同じ位置で入れる
      //   ふたのマスクは main.js で読み取り用の穴のまわりを抜いてある（穴から見えるゲームの色を変えないように）
      for (const [ln, L] of Object.entries(p.lids || {})) {
        const lel = g.lids && g.lids[ln] && g.lids[ln].el; if (!lel) continue;
        const lm = s.masks[name + '#' + ln], lf = s.lidFills && s.lidFills[name + '#' + ln];
        let ld = lel.querySelector(':scope > .bgimg:not(.bgguard)');
        if (!lm) { for (const x of lel.querySelectorAll(':scope > .bgimg')) x.remove(); for (const x of lel.querySelectorAll(':scope > img.lidfill')) x.remove(); delete lel.dataset.fill; continue; }
        // 2026-11-02（ユーザー指摘：閉じた蓋のふちが「枠」に見える）：ふちごと1色で塗った絵（状態ごと、main.js の lidAsset）を蓋の絵の上に重ねる
        const fkey = lf ? Object.values(lf).map(u => (u || '').slice(-24)).join('|') : '';
        if (lel.dataset.fill !== fkey) {
          for (const x of lel.querySelectorAll(':scope > img.lidfill')) x.remove();
          for (const [st, url] of Object.entries(lf || {})) {
            if (!url) continue;
            const fi = document.createElement('img'); fi.className = 'lidfill v-' + st; fi.alt = ''; fi.width = L.w; fi.height = L.h; fi.src = url;
            lel.insertBefore(fi, ld || null);
          }
          lel.dataset.fill = fkey;
        }
        if (!ld) { ld = document.createElement('div'); ld.className = 'bgimg'; lel.appendChild(ld); }
        if (ld.dataset.url !== d.dataset.url) { ld.style.backgroundImage = d.style.backgroundImage; ld.dataset.url = d.dataset.url; }
        if (ld.dataset.mask !== lm.slice(-32)) { ld.style.webkitMaskImage = `url("${lm}")`; ld.style.maskImage = `url("${lm}")`; ld.dataset.mask = lm.slice(-32); }
        Object.assign(ld.style, { width: L.w + 'px', height: L.h + 'px', backgroundSize: d.style.backgroundSize,
          backgroundPosition: `${x - (L.x - p.x)}px ${y - (L.y - p.y)}px`, opacity: d.style.opacity, filter: d.style.filter });
        // 2026-11-02 v2（ユーザー指摘：背景ありだと穴が大きく目立つ）：穴のまわり（読み取りに使う小さな範囲）にも、白黒にした同じ画像を入れる
        //   白黒なら穴から見えるゲームの色の読み取りに影響しない
        const gm = s.masks[name + '#' + ln + '#guard'];
        let gd = lel.querySelector(':scope > .bgguard');
        if (!gm) { if (gd) gd.remove(); }
        else {
          if (!gd) { gd = document.createElement('div'); gd.className = 'bgimg bgguard'; lel.appendChild(gd); }
          if (gd.dataset.url !== d.dataset.url) { gd.style.backgroundImage = d.style.backgroundImage; gd.dataset.url = d.dataset.url; }
          if (gd.dataset.mask !== gm.slice(-32)) { gd.style.webkitMaskImage = `url("${gm}")`; gd.style.maskImage = `url("${gm}")`; gd.dataset.mask = gm.slice(-32); }
          Object.assign(gd.style, { width: ld.style.width, height: ld.style.height, backgroundSize: ld.style.backgroundSize, backgroundPosition: ld.style.backgroundPosition,
            opacity: ld.style.opacity, filter: 'grayscale(1) ' + (d.style.filter || '') });
        }
      }
    }
  }

  // キラキラ（Canvas）。このウィンドウ全体に重ねる
  const fxCanvas = document.createElement('canvas'); fxCanvas.id = 'fx-canvas'; body.appendChild(fxCanvas);
  const sparkles = window.HudFx ? new window.HudFx.Sparkles(fxCanvas) : null;
  body.classList.toggle('no-fx', options.fx === false);
  const FX_SLOW = +(new URLSearchParams(location.search).get('fxslow') || options.fxSlow || 1);   // 確認用：エフェクトをゆっくり再生
  if (FX_SLOW !== 1) body.style.setProperty('--fx-slow', FX_SLOW);
  // チャット翻訳の表示
  let chatBox = null;
  if (manifest.chat && mine(manifest.chat.win)) {
    chatBox = document.createElement('div'); chatBox.id = 'g-chat'; chatBox.className = 'group';
    chatBox.style.width = manifest.chat.w + 'px'; chatBox.style.height = manifest.chat.h + 'px';
    stage.appendChild(chatBox); placed.push([chatBox, manifest.chat.x, manifest.chat.y, manifest.chat.anchor]);
  }
  const chatLines = [];   // { en, ja, t }
  function showChat(items) {
    if (!chatBox) return;
    const now = performance.now();
    for (const it of items) chatLines.push({ ...it, t: now });
    while (chatLines.length > 4) chatLines.shift();
    renderChat();
  }
  function renderChat() {
    if (!chatBox) return;
    const now = performance.now(), keep = chatLines.filter(l => now - l.t < 12000);
    if (keep.length !== chatLines.length) chatLines.splice(0, chatLines.length, ...keep);
    chatBox.innerHTML = '';
    for (const l of chatLines) {
      const d = document.createElement('div'); d.className = 'chat-line';
      const en = document.createElement('span'); en.className = 'en'; en.textContent = l.en;
      const ja = document.createElement('span'); ja.className = 'ja'; ja.textContent = l.ja;
      d.appendChild(en); d.appendChild(ja); chatBox.appendChild(d);
    }
  }
  setInterval(renderChat, 1000);
  function layoutAll() {
    for (const [el, x, y, a] of placed) place(el, x, y, a);
    fxCanvas.width = window.innerWidth; fxCanvas.height = window.innerHeight;
    drawRegions();
  }
  // ゲーム座標 → このウィンドウの px
  function toWin(x, y, anchor) {
    const W = screenW(), H = screenH(), k = H / BH;
    const top = anchor[0] === 't' ? y * k : H - (BH - y) * k;
    const left = anchor[1] === 'l' ? x * k : anchor[1] === 'r' ? W - (BW - x) * k : W / 2 + (x - BW / 2) * k;
    return { x: left - ORIGIN.x, y: top - ORIGIN.y, k };
  }
  // 少女のまわり（ゲーム座標）でキラキラを出す
  const GIRL = girl ? { x: girl.x, y: girl.y, w: girl.w, get h() { return +(faceEls.normal && faceEls.normal.dataset.h) || manifest.faces.normal.h; } } : null;
  // シールドのハートの色（アーマーの色ごと）
  const SHIELD_HEART = { white: ['#ffffff', '#e6eef5', '#cfd8e0'], blue: ['#9fe3ff', '#4fc3ff', '#fff'], purple: ['#e3b3ff', '#c27bff', '#fff'], gold: ['#ffe9a8', '#ffd36e', '#fff'], red: ['#ffb3b3', '#ff6b6b', '#fff'] };
  // 2026-11-02（ユーザー指摘：ウルトの枠は線が細く、光り方の変化だけでは分からない）：ウルトの枠そのものにエフェクト
  //   100%：水色の輪＋星がはじけ、そのあと 100% の間は枠のまわりで小さな光がまたたき続ける／使った瞬間：輪2つ＋たくさんの星（キャラの色）
  function ultCenter() {
    const name = (G.ult2 && !G.ult2.el.classList.contains('off')) ? 'ult2' : 'ult';
    const p = manifest.parts[name]; if (!G[name] || !p || G[name].el.classList.contains('off')) return null;
    const c = toWin(p.x + p.w / 2, p.y + p.h / 2, p.anchor); return { x: c.x / c.k, y: c.y / c.k, w: p.w, h: p.h };
  }
  function ultBurst(kind) {
    if (!sparkles || options.fx === false || options.sparkles === false) return;
    const u = ultCenter(); if (!u) return;
    const sp = JSON.parse(body.dataset.sparkle || 'null');
    if (kind === 'ult_ready') {
      sparkles.burst(u.x, u.y, 1, { kind: 'ring', colors: ['#aef'], spread: 0, speed: 0, up: 0, size: 9, life: 800 });
      sparkles.burst(u.x, u.y, 18, { kind: 'star', colors: ['#fff', '#aef', '#ffe9a8'], spread: 70, speed: 1.1, up: 0.7, size: 1.4, life: 1500 });
    } else if (kind === 'use_ult') {
      sparkles.burst(u.x, u.y, 1, { kind: 'ring', colors: ['#fff'], spread: 0, speed: 0, up: 0, size: 12, life: 700 });
      setTimeout(() => sparkles.burst(u.x, u.y, 1, { kind: 'ring', colors: (sp && sp[1]) ? [sp[1]] : ['#ffd36e'], spread: 0, speed: 0, up: 0, size: 16, life: 900 }), 150);
      sparkles.burst(u.x, u.y, 40, { kind: 'star', colors: sp || ['#fff', '#ffe9a8', '#ffd36e', '#aef'], spread: 90, speed: 1.8, up: 0.9, size: 1.7, life: 1900 });
      sparkles.burst(u.x, u.y, 16, { kind: 'dot', colors: ['#fff', '#ffe9a8'], spread: 60, speed: 2.2, up: 0.6, size: 1.2, life: 1200 });
    }
  }
  function sparkleBurst(kind, tier) {
    if (!sparkles || !GIRL || options.fx === false || options.sparkles === false || options.noChara) return;
    const c = toWin(GIRL.x + GIRL.w * 0.5, GIRL.y - GIRL.h * 0.55, girl.anchor);
    const sp = JSON.parse(body.dataset.sparkle || 'null');
    const P = { kill: [36, { kind: 'star', colors: sp || ['#fff', '#ffe9a8', '#ffd36e', '#aef'], spread: 60, speed: 1.2, size: 1.3, life: 1700 }],
      champion: [90, { kind: 'star', colors: ['#fff', '#ffd36e', '#ffb3ec', '#aef'], spread: 110, speed: 1.3, size: 1.5, life: 2600 }],
      full_heal: [30, { kind: 'heart', colors: ['#ffb3d9', '#ff8fc8', '#fff'], spread: 50, speed: 0.9, up: 0.9, size: 1.2, life: 1800 }],
      full_shield: [30, { kind: 'heart', colors: SHIELD_HEART[tier] || SHIELD_HEART.blue, spread: 50, speed: 0.9, up: 0.9, size: 1.2, life: 1800 }],
      shield_evolve: [40, { kind: 'dot', colors: ['#aef', '#6ed2ff', '#fff'], spread: 80, speed: 1.1, size: 1.2 }],
      // 2026-11-02：アシスト・味方のキルは控えめ、ウルト 100% は中くらい、ウルトを使った瞬間は強め
      assist: [14, { kind: 'star', colors: sp || ['#fff', '#aef'], spread: 40, speed: 0.9, size: 1.0, life: 1200 }],
      team_kill: [12, { kind: 'dot', colors: ['#fff', '#ffe9a8', '#aef'], spread: 40, speed: 0.8, size: 1.0, life: 1200 }],
      ult_ready: [24, { kind: 'dot', colors: ['#fff', '#aef', '#ffe9a8'], spread: 55, speed: 1.0, size: 1.1, life: 1500 }],
      use_ult: [60, { kind: 'star', colors: sp || ['#fff', '#ffe9a8', '#ffd36e', '#aef'], spread: 100, speed: 1.4, size: 1.4, life: 2000 }] }[kind];
    if (P) sparkles.burst(c.x / c.k, c.y / c.k, P[0], P[1]);
  }
  window.addEventListener('resize', layoutAll);

  // ---------- 状態 ----------
  const state = M.initialState();
  let last = {};
  function setState(name, st) {
    const g = G[name]; if (!g || g.state === st) return;
    g.el.classList.remove('s-' + g.state); g.el.classList.add('s-' + st); g.state = st;
  }
  function show(name, on) { if (G[name]) G[name].el.classList.toggle('off', !on); }
  // シールドの段の並び（読み取り側が判断）：5＝ふつう（1段46px）、4＝ガンゲーム・ワイルドカード等（同じ幅を4段、1段58px）
  let shieldLayout = 5, modeKind = null, tacDual = false, evoCircle = false;
  let octExt = false, octOnAt = -1, octOffAt = -1, octOutAt = -1;
  let wBanner = false, wbOnAt = -1, wbOffAt = -1;   // 2026-10-31：武器の上の黄色い帯が出ているか   // 2026-10-28：オクタンの2本目のゲージが出ている間、2つ用の枠を右へのばす
  // 2026-10-27：地上にいるか（シップ・降下中は false）。false の間は戦術・ウルト・武器の枠を出さない。確認用ゲーム画面の間は常に出す
  let onFoot = true, footDemo = false;
  const mateWait = [false, false];   // 2026-10-28：味方がリスポーン待ち（黄緑のバナー）
  const waitLastAt = [0, 0];        // 2026-10-29：最後に「リスポーン待ち」と読めた時刻
  // 4段の並びのふたは自分の枠だけ（sh_l4_max2／sh_l4_max3）。味方の枠は4段用のふたが無いので開けたまま（ゲームの段がそのまま見える）
  // 4段の並びのふたは自分の枠だけ（sh_l4_max2／sh_l4_max3）。味方の枠は4段用のふたが無いので開けたまま（ゲームの段がそのまま見える）
  // 2026-10-26：一時「5本目だけふた」にしたが、ユーザー希望で元のふた（3〜5本目）に戻し、読み取り側でふたの穴の色の見方を広げた
  // 2026-10-26（ユーザー決定）：シールドのふたはなし（5段とも常に開けたまま）。ふた越しの見分けは今後のアップデートで見直す
  const shieldLid = () => null;
  const openSegs = () => (shieldLayout === 4 ? 4 : 5);
  // ワイルドカード等で上の味方のバナーが上にずれたら、味方1の枠も同じだけ動かす
  let mateDy = 0;
  function setMateDy(dy) {
    if (dy === mateDy) return; mateDy = dy;
    for (const n of ['mate1', 'mate1_m', 'db_mate1']) { const g = G[n]; if (!g || !g.placed) continue; g.placed[2] = g.baseY + dy; place(...g.placed); }
  }
  let lastLidKey = '';
  function setLids(name, segs, shown) {
    const g = G[name]; if (!g) return;
    const want = new Set();
    const sl = segs == null ? null : shieldLid(segs, name);
    if (sl && g.lids[sl]) want.add(sl);
    if (options.lids !== false) {
      for (const c of g.clusters) {
        const closed = [...c.ids].filter(i => shown[i] === false);
        if (!closed.length) continue;
        const ln = c.lids.find(l => g.lids[l].closes.length === closed.length && closed.every(i => g.lids[l].closes.includes(i)));
        if (ln) want.add(ln);
      }
    }
    const key = [...want].sort().join(',');
    if (key === g.lidKey) return;
    g.lidKey = key;
    for (const [ln, L] of Object.entries(g.lids)) L.el.classList.toggle('closed', want.has(ln));
  }
  function render(d) {
    if (d.expression !== last.expression && faceEls[d.expression]) {
      if (last.expression) faceEls[last.expression].classList.remove('on');
      faceEls[d.expression].classList.add('on');
      if (d.expression === 'full_heal') sparkleBurst('full_heal');
    }
    // 2026-10-28（ユーザー指摘）：シールド満タンのハートは5個目の途中で出て見えるうえ、全回復の表示もあるので出さない
    // if (d.fullShieldAt && d.fullShieldAt !== last.fullShieldAt) sparkleBurst('full_shield', d.shieldTier);
    const kn = d.knocked;
    // 2026-10-24（ユーザー決定）：ダウン専用の枠はやめて、ダウン中はいつもの枠を「被弾の赤」のまま出し続ける
    // ワイルドカード・ガンゲームなど（シールドが4段の並び）は、上の出っ張りとアーマー進化の丸をなくしたシンプルな枠（player_s）にする（2026-10-24 ユーザー決定）
    // 2026-10-25（ユーザー決定）：ワイルドカードもガンゲームも、ゲームのバナーの形（左右が「く」の字の横長）にそのまま合わせた枠（player_m）。
    //   player_s（左上までふさぐ）・player_w（前の段のある形）は使わない。モードの見分け（modeKind）は今後のために残す
    // 2026-10-25（ユーザー決定）：4段の並びでも、ゲームのバナーにシールド進化の丸（上の帯つきのバトロワのバナー）があればいつもの枠（4段用の蓋）
    // 2026-10-26（ユーザー確認）：イベントでも進化の丸が一時的に出ることがあり、バトロワ用の枠がたびたび出た → 4段の並びのときは常にシンプルな枠
    const PL = shieldLayout !== 4 ? 'player' : G.player_m ? 'player_m' : G.player_w ? 'player_w' : 'player';
    for (const n of ['player', 'player_s', 'player_w', 'player_m']) show(n, PL === n);
    // 2026-10-25：戦術アビリティが2つ並ぶキャラ（オクタン等）は2つ用の枠に
    const dual = tacDual && !!G.tactical2;
    // 2026-10-25：ダウン中はゲーム側の武器・グレネード等の表示が消えるので、その枠も消す（空の枠だけ残っていた）
    // 2026-10-27（ユーザー指摘）：シップ・降下中はゲームの戦術・ウルト・武器の欄が空なので、その枠も出さない
    const foot = onFoot || footDemo;
    for (const n of ['lalt', 'g', 'weapon']) show(n, !kn && foot);
    // 2026-10-27：アイテム欄も降下中は出さない（ワイルドカードの降下で枠だけ出ていた・録画 01.33.07）
    show('knock', false); show('item', !kn && foot); show('tactical', !kn && !dual && foot); show('tactical2', !kn && dual && foot);
    if (G.tactical2) G.tactical2.el.classList.toggle('ext', octExt && dual);
    if (G.weapon) G.weapon.el.classList.toggle('wbanner', wBanner);
    setState('tactical2', d.tacticalState);
    setState(PL, kn ? 'hit' : d.panel);
    setState('knock', d.panel === 'hit' ? 'hit' : 'normal');
    setState('tactical', d.tacticalState);
    setState('ult', d.ultState === 'ready' ? 'ready' : d.ultState);
    // オクタン（戦術が2つ並ぶキャラ）はウルトの右にもバーがあるので、専用のウルトの枠に（2026-10-25 ユーザー決定）
    const ult2 = tacDual && !!G.ult2;
    // 2026-10-26：ダウン中はゲームのウルトが消える（イベントではリスポーンの案内が重なり、アイコンがあると見まちがえた）→ 枠も消す
    show('ult', !ult2 && !kn && foot); show('ult2', ult2 && !kn && foot);
    setState('ult2', d.ultState === 'ready' ? 'ready' : d.ultState);
    setState('minimap', d.minimap === 'ring' ? 'ring' : 'normal');
    // 2026-10-26（ユーザー決定）：ゲームモード・イベントモード（4段の並びで、シールド進化の丸がないバナー）では味方もシンプルな枠（mate1_m／mate2_m）
    const mateM = PL === 'player_m' && !!G.mate1_m && !!G.mate2_m;
    d.mates.forEach((m, i) => {
      const n = 'mate' + (i + 1), nm = n + '_m', use = mateM ? nm : n, other = mateM ? n : nm;
      show(other, false); show(use, m.visible || mateWait[i]); setState(use, mateWait[i] ? 'normal' : m.panel); setLids(use, m.shieldSegments, {});
    });
    const segP = d.shieldSegments;
    // 2026-10-27（ユーザー決定）：4段の並び（イベント・ゲームモード）はアイテム欄のふたなし（常に開ける）。
    //   持っていないときも灰色のマークが出るので、ふたがなくても分かる。持っていないときにふたが開いたり閉じたりしていた
    // 2026-10-30（ユーザー指摘・録画 02.43.15）：ミックステープ（ガンゲームなど・オレンジの紋章なし＝modeKind 'gun'）はアイテムを使わないので、
    //   アイテム欄の窓は閉じる（空の欄が窓から見えていた）。ワイルドカード（'wild'）は今までどおり開ける
    const shownP = shieldLayout === 4 ? Object.assign({}, d.shown, { aqua1: modeKind !== 'gun' }) : d.shown;
    for (const n of ['player', 'player_s', 'player_w', 'player_m', 'knock']) setLids(n, segP, shownP);
    // デスボックス時の枠は、通常の自分・味方の枠と同じ状態（色・シールドの段数・装備の窓）を映す
    setState('db_player', d.panel === 'down' ? 'normal' : d.panel); setLids('db_player', d.shieldSegments, {});
    d.mates.forEach((m, i) => { setState('db_mate' + (i + 1), m.panel === 'down' ? 'normal' : m.panel); setLids('db_mate' + (i + 1), m.shieldSegments, d.shown); });
    for (const n of ['item', 'tactical']) setLids(n, null, shownP);
    if (d.hudHidden !== last.hudHidden) body.classList.toggle('game-hud-hidden', !!d.hudHidden);
    // 読み取り側に「ふたで閉じている段」を伝える（ふたの色をシールドと読まないため）
    const lk = JSON.stringify([segP, shieldLayout, d.mates.map(m => m.shieldSegments)]);
    if (lk !== lastLidKey && worker) { lastLidKey = lk; worker.postMessage({ type: 'lids', lids: { player: openSegs(segP), mates: d.mates.map(m => openSegs(m.shieldSegments)) } }); }
    last = d;
  }

  let demoView = !!options.demoBg;   // 確認用ゲーム画面を出している間
  let gameActive = true;   // Apex が手前にあるか（main から届く）。手前にないときは読み取り結果で枠を出さない
  // ---------- 入力 ----------
  function onInput(msg) {
    const now = performance.now();
    if (msg.patch) M.applyPatch(state, msg.patch, now, { silent: !!msg.silent });
    // 2026-10-25：配信用ページ（OBS）は読み取りをしないので、味方の有無・値も読み取り側から受け取る
    if (msg.mate) M.applyMate(state, msg.mate.i, msg.mate.msg, now);
    if (msg.patch && Array.isArray(msg.patch.mates) && !READS) msg.patch.mates.forEach((mm, i) => M.applyMate(state, i, { patch: { hudHidden: !mm.present, hp: mm.hp, shield: mm.shield, shieldSegments: mm.shieldSegments }, silent: true }, now));
    if (msg.event) { M.applyEvent(state, msg.event, now, msg.arg); if (['kill', 'champion', 'shield_evolve', 'assist', 'team_kill', 'ult_ready', 'use_ult'].includes(msg.event)) sparkleBurst(msg.event); if (msg.event === 'ult_ready' || msg.event === 'use_ult') ultBurst(msg.event); }
    if (msg.options) {
      const o = OBS ? Object.fromEntries(Object.entries(msg.options).filter(([k]) => !['demoBg', 'perf', 'showRegions', 'diag', 'screenRead'].includes(k))) : msg.options;   // 配信には確認用の表示を出さない
      if ('gameActive' in msg.options) gameActive = !!msg.options.gameActive;
      if ('demoBg' in o) {
        setDemoBg(o.demoBg);
        // 確認用ゲーム画面：見ている間は読み取り結果で枠を消さない。閉じたら、次の読み取りで今の画面に合わせて出す／消す
        demoView = !!o.demoBg; footDemo = demoView; if (last && last.mates) render(last);
        if (demoView) onInput({ patch: { hudHidden: false } }); else interp.hidden = false;
      }
      if ('perf' in o) $('#perf').hidden = !(o.perf && PERF_ON_HUD);
      if ('idleMotion' in o) body.classList.toggle('idle-motion', o.idleMotion);
      if ('showRegions' in o) { options.showRegions = o.showRegions; drawRegions(); }
      if ('minimap' in o) body.classList.toggle('no-minimap', !o.minimap);
      if ('deathbox' in o) { const d = o.deathbox || {}; body.classList.toggle('db-open', !!d.open); body.classList.toggle('db-m1', !!d.m1); body.classList.toggle('db-m2', !!d.m2); }
      if ('diag' in o && READS) setDiag(o.diag);
      if ('screenRead' in o && READS) o.screenRead ? startReader() : stopReader();
      if (o.faces) for (const key of Object.keys(faceEls)) faceEls[key].src = src(o.faces[key] || o.faces.normal);   // キャラクター切り替え（無い表情は通常で代用）
      if ('noChara' in o) { options.noChara = o.noChara; const gg = document.getElementById('g-girl'); if (gg) gg.classList.toggle('nochara', !!o.noChara); }
      if ('frames' in o) {   // 枠の画像をキャラ専用（または既定）に差し替える
        const to = o.frames || 'v4/';
        const RE = /assets\/(v4\/|characters\/[^/]+\/frames\/|frames\/[^/]+\/)/;
        for (const im of stage.querySelectorAll('img.layer, .lid img')) im.src = im.src.replace(RE, 'assets/' + to);
        for (const d of stage.querySelectorAll('.fx-flow')) { const v = d.style.webkitMaskImage.replace(RE, 'assets/' + to); d.style.webkitMaskImage = v; d.style.maskImage = v; }
        applyTheme(o.theme);
      }
      if (o.chat) showChat(o.chat);
      if ('chatTranslate' in o) { options.chatTranslate = o.chatTranslate; if (worker) worker.postMessage({ type: 'chat', on: !!o.chatTranslate }); }
      if ('mapUi' in o) body.classList.toggle('no-mapui', !o.mapUi);
      if ('minimapUi' in o) body.classList.toggle('no-minimapui', !o.minimapUi);
      if (!READS && ('layout' in o || 'modeKind' in o)) { if (o.layout) shieldLayout = o.layout; if ('modeKind' in o) modeKind = o.modeKind; for (const g of Object.values(G)) g.lidKey = '?'; if (last && last.mates) render(last); }
      if (!READS && 'mateDy' in o) setMateDy(o.mateDy || 0);
      if (!READS && Array.isArray(o.mateWait)) { o.mateWait.forEach((v, k) => { mateWait[k] = !!v; }); if (last && last.mates) render(last); }
      if ('onFoot' in o && !!o.onFoot !== onFoot) { onFoot = !!o.onFoot; if (last && last.mates) render(last); }
      if ('octExt' in o && !!o.octExt !== octExt) { octExt = !!o.octExt; if (last && last.mates) render(last); }
      if ('wBanner' in o && !!o.wBanner !== wBanner) { wBanner = !!o.wBanner; if (G.weapon) G.weapon.el.classList.toggle('wbanner', wBanner); }
      if ('tacDual' in o && !!o.tacDual !== tacDual) { tacDual = !!o.tacDual; if (last && last.mates) render(last); }
      if ('evoCircle' in o && !!o.evoCircle !== evoCircle) { evoCircle = !!o.evoCircle; for (const g of Object.values(G)) g.lidKey = '?'; if (last && last.mates) render(last); }
      if ('ultIcon' in o) body.classList.toggle('no-ult', !o.ultIcon);
      if ('fx' in o) { options.fx = o.fx; body.classList.toggle('no-fx', !o.fx); }
      if ('playerName' in o) { options.playerName = o.playerName; setName(o.playerName); }
      if ('lids' in o) { options.lids = o.lids; for (const g of Object.values(G)) g.lidKey = '?'; }
      if ('hidden' in o) applyHidden(o.hidden);
      if (o.background) applyBackground(o.background);
    }
  }
  window.hud = { input: onInput, state, derive: () => M.derive(state, performance.now()), reading: () => lastReading };
  if (api) api.onInput(onInput);

  // ---------- 画面読み取り ----------
  // OBS と同じ「画面キャプチャ」でゲーム画面を受け取り、バーの小さな領域だけを読む。
  // ゲームのプロセス・メモリには触れない。
  // 実際の読み取りは別スレッド（reader.worker.js）。ここでは結果から出来事を判定するだけ。
  let stream = null, worker = null, lastReading = null, readerOn = false;
  let testVid = null, testDone = false, testErr = '', testStarted = false, testFrame = null;
  const testRaw = []; window.hud.testRaw = testRaw;   // テストモード：1コマごとの読み取り値（動画の時刻, HUDあり, HP%, シールド, 段数）
  window.hud.testInfo = () => ({ done: testDone, error: testErr, readerStarted: testStarted, frameSize: testFrame,
    time: testVid ? testVid.currentTime : 0, duration: testVid && isFinite(testVid.duration) ? testVid.duration : 0 });
  let footHidSince = -1, footVisSince = -1, footRespawn = false;
  const interp = new R.Interpreter({ stableFrames: 2 });
  const mateInterp = [new R.Interpreter({ stableFrames: 2 }), new R.Interpreter({ stableFrames: 2 })];
  const peekFilter = new R.PeekFilter();
  const matePresence = new R.PeekFilter();
  const hudVisFilter = new R.PeekFilter();
  let pendingMsgs = [], quietUntil = 0;
  // 演出の出る更新を待つ時間（メニューの開け閉めで HUD が部品ごとに消える間の誤判定よけ）。テストでは --pending-ms で変えられる
  // 2026-10-31（ユーザー希望「まず一番速く」）：250ms → 0。録画46本で、被弾の赤が出るまで 0.29秒 → 0.03秒、
  //   誤作動（回復中・メニューの開け閉めでの赤）は増えなかった（読み取り側の barsOk・即時の非表示で防げている）
  const PENDING_MS = options.pendingMs != null ? options.pendingMs : 0;
  // メニューから戻ったとき、HUD が出たと判断するまでのコマ数。テストでは --vis-open-frames で変えられる
  const VIS_OPEN_FRAMES = options.visOpenFrames != null ? options.visOpenFrames : 3;
  // テストモード：出た出来事を動画の時刻つきで覚えておく（main が最後にまとめて書き出す）
  const testLog = [];
  window.hud.testLog = testLog;
  function dispatch(msg) {
    if (options.testVideo) {
      try {
        const t = testVid ? Math.round(testVid.currentTime * 100) / 100 : null;
        if (msg.event) testLog.push({ t, event: msg.event });
        else if (msg.patch) testLog.push({ t, patch: JSON.parse(JSON.stringify(msg.patch)) });
      } catch { /* 記録できなくても続行 */ }
    }
    onInput(msg);
    share(msg);
  }
  // ほかの HUD ウィンドウ（ウルト・右下・ミニマップ・方位）と配信用ページ（OBS）にも伝える
  function share(msg) { if (api && PART === 'left') api.relay(msg); }
  function mateApply(i, msg, now) { M.applyMate(state, i, msg, now); share({ mate: { i, msg } }); }
  function flushPending(now, all) {
    while (pendingMsgs.length && (all || now - pendingMsgs[0].t >= PENDING_MS)) dispatch(pendingMsgs.shift().msg);
  }
  const compassFilter = new R.PeekFilter();
  const minimapFilter = new R.PeekFilter();
  const ultFilter = new R.PeekFilter();
  const dualFilter = new R.PeekFilter(); dualFilter.s.d = { v: false, n: 0, since: 0 };
  let dualOffSince = -1, mapHidSince = -1, dualHidSince = -1, dualRecheckAt = -1, dualRecheckSeen = false, dualArmed = false, dualLastSeenAt = -1;
  const evoFilter = new R.PeekFilter(); evoFilter.s.e = { v: false, n: 0, since: 0 };   // 最初は1つ用の枠
  const deathboxFilter = new R.PeekFilter();
  for (const k of ['open', 'm1', 'm2']) deathboxFilter.s[k] = { v: false, n: 0, since: 0 };
  const rg = RC.regions;
  const regionKeys = Object.keys(rg);

  // ベース座標(2560x1080)の範囲 → 画面上の範囲（確認表示用）
  function mapRegion(r, sw, sh) {
    const k = sh / RC.baseHeight;
    let x;
    if (r.anchor === 'right') x = sw - (RC.baseWidth - r.x) * k;
    else if (r.anchor === 'center') x = sw / 2 + (r.x - RC.baseWidth / 2) * k;
    else x = r.x * k;
    return { x, y: sh - (RC.baseHeight - r.y) * k, w: r.w * k, h: r.h * k };
  }
  function drawRegions() {
    const box = $('#regions'); box.innerHTML = '';
    if (!options.showRegions) return;
    const extra = (RC.mates || []).flatMap(t => [t.hp, t.shield, t.name]).map(r => ({ anchor: 'left', ...r }));
    if (RC.chat) extra.push({ anchor: 'left', x: RC.chat.x, y: RC.chat.y, w: RC.chat.w, h: RC.chat.h });
    for (const r of [...regionKeys.map(k => rg[k]), ...extra]) {
      const m = mapRegion(r, screenW(), screenH());
      m.x -= ORIGIN.x; m.y -= ORIGIN.y;
      const d = document.createElement('div'); d.className = 'rg';
      Object.assign(d.style, { left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px' });
      box.appendChild(d);
    }
    for (const p of Object.values(RC.peeks || {})) for (const [x, y] of p.points) {
      const m = mapRegion({ anchor: 'left', x, y, w: 1, h: 1 }, screenW(), screenH());
      const d = document.createElement('div'); d.className = 'pk';
      Object.assign(d.style, { left: (m.x - ORIGIN.x) + 'px', top: (m.y - ORIGIN.y) + 'px' });
      box.appendChild(d);
    }
  }

  // エラーは同じものを何度も書かないよう、種類ごとに最初の数回だけ診断ログ（errors.txt）へ
  const errSeen = new Map();
  function reportError(where, e) {
    const msg = String(e && e.stack || e), key = where + msg.slice(0, 120), n = (errSeen.get(key) || 0) + 1;
    errSeen.set(key, n);
    if (n <= 3 || n % 1000 === 0) { console.error('[' + where + ']', msg); if (api && api.diag) api.diag({ error: `${new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 23)} [${where}] x${n} ${msg}` }); }
  }
  // ---------- 診断ログ（誤判定の調査用） ----------
  // 読み取り値を毎フレーム CSV に、演出が出た瞬間は前後約1.5秒の「読んだピクセル」を画像で保存する。
  let diagOn = false, diagLines = [], diagRing = [], diagPending = null, diagLastSnap = -1e9;
  const RAW_W = Math.max(rg.hp.w, rg.shield.w, rg.anchor.w), RAW_H = rg.shield.h + rg.hp.h + rg.anchor.h;
  function setDiag(on) {
    diagOn = !!on;
    if (worker) worker.postMessage({ type: 'diag', on: diagOn });
    if (diagOn && api) api.diag({ start: true });
  }
  function diagRecord(m, msgs, before, now) {
    const r = m.reading;
    const ev = msgs.map(x => x.event ? x.event : (x.silent ? 'sync' : Object.keys(x.patch).join('+'))).join(' ');
    const dv = M.derive(state, now);
    const mates = dv.mates.map(m => m.visible ? m.panel : '-').join('/');
    const closed = Object.entries(state.shown || {}).filter(([, v]) => v === false).map(([k]) => k.replace('aqua', '')).join('/');
    const clock = new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 23);   // 録画と時刻を合わせるための時計（日本時間）
    diagLines.push([clock, Math.round(now), r.hudVisible ? 1 : 0, (r.hpRatio * 100).toFixed(1), r.hpPx, r.shieldPoints, r.shieldPx, r.shieldSegments, r.shieldTier, state.hp, state.shield, dv.expression, dv.panel, mates, closed || '-', ev, r.itemPx || ''].join(','));   // 2026-10-27：最後の列はアイテム欄の穴の色（穴|ふた|戻した色）
    if (m.raw) { diagRing.push({ t: Math.round(now), raw: m.raw, r, ev }); if (diagRing.length > 90) diagRing.shift(); }
    const dropped = msgs.some(x => x.patch && !x.silent && ((x.patch.hp ?? 1e9) < before.hp || (x.patch.shield ?? 1e9) < before.shield));
    const notable = dropped || msgs.some(x => ['shield_evolve', 'heal_start'].includes(x.event));
    if (notable && !diagPending && now - diagLastSnap > 1000) {
      const reason = dropped ? (state.shield === 0 && before.shield > 0 ? 'shield_break' : 'hit') : msgs.find(x => x.event).event;
      diagPending = setTimeout(() => { diagPending = null; diagLastSnap = performance.now(); diagSnapshot(reason); }, 700);
    }
  }
  async function diagSnapshot(reason) {
    if (!api || !diagRing.length) return;
    const frames = diagRing.slice();
    const H = frames.length * (RAW_H + 1);
    const cv = new OffscreenCanvas(RAW_W, H), c2 = cv.getContext('2d');
    c2.fillStyle = '#ff00ff'; c2.fillRect(0, 0, RAW_W, H);
    frames.forEach((f, i) => c2.putImageData(new ImageData(new Uint8ClampedArray(f.raw), RAW_W, RAW_H), 0, i * (RAW_H + 1)));
    const png = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
    api.diag({ snapshot: { reason, png, frames: frames.map(f => ({ t: f.t, ev: f.ev, reading: f.r })) } });
  }
  // 5秒ごとの生存確認：読み取りが届いているか・ログが止まっていないかを後から確かめるため
  let hbReadings = 0, hbLast = 0;
  setInterval(() => {
    if (diagOn && api && ++hbLast % 5 === 0) diagLines.push(`#hb,${new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 23)},readings=${hbReadings},reader=${readerOn ? 1 : 0},visible=${document.visibilityState}`);
    if (diagLines.length && api) { api.diag({ lines: diagLines }); diagLines = []; }
  }, 1000);

  // ---------- チャット翻訳：読み取った文字画像を OCR（メインプロセス）→ 翻訳 → 全ウィンドウへ ----------
  let translator = null, ocrBusy = false, seenChat = new Map();
  async function handleChat(img) {
    if (ocrBusy || options.chatTranslate === false) return;
    ocrBusy = true;
    try {
      if (!translator) {
        const j = (u) => fetch(u).then(r => r.json());
        const [g, d] = await Promise.all([j('../assets/chat/glossary.json'), j('../assets/chat/dict.json')]);
        translator = new window.HudTranslate.Translator(g, d);
      }
      // 2倍に拡大して PNG に（OCR の精度のため）
      const cv = new OffscreenCanvas(img.w * 2, img.h * 2), c2 = cv.getContext('2d');
      const id = new ImageData(img.w, img.h);
      for (let i = 0; i < img.w * img.h; i++) { const v = img.data[i]; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
      const small = new OffscreenCanvas(img.w, img.h); small.getContext('2d').putImageData(id, 0, 0);
      c2.imageSmoothingEnabled = true; c2.drawImage(small, 0, 0, img.w * 2, img.h * 2);
      const png = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const text = await api.ocr(png);
      const now = performance.now();
      for (const [k, t] of seenChat) if (now - t > 60000) seenChat.delete(k);
      const items = [];
      for (const raw of String(text || '').split('\n')) {
        const body = window.HudTranslate.cleanLine(raw);                 // 本文だけが読まれている（名前は色で除いてある）
        if (!body || window.HudTranslate.hasJapanese(body)) continue;
        const name = '';
        const key = window.HudTranslate.norm(body);
        if (!key || seenChat.has(key)) continue;
        const tr = translator.translate(body);
        const known = tr.words - tr.unknown;
        const letters = (body.match(/[A-Za-z]/g) || []).length;
        const exact = translator.phr[translator.fixOcr(window.HudTranslate.norm(body).split(' ')).join(' ')] !== undefined;   // ty・gg など、まるごと辞書にある短い言葉は通す
        if (!exact && (tr.words < 1 || letters < 3 || letters / body.length < 0.6 || known < Math.max(1, Math.ceil(tr.words * 0.5)))) continue;
        seenChat.set(key, now);
        items.push({ en: (name ? name + ': ' : '') + translator.fixOcr(window.HudTranslate.norm(body).split(' ')).join(' '), ja: tr.ja });
      }
      if (items.length) { const msg = { options: { chat: items } }; onInput(msg); api.relay(msg); }
    } catch (e) { console.error('[chat]', e); }
    finally { ocrBusy = false; }
  }
  let statsReply = null;
  async function startReader() {
    if (readerOn) return;
    if (options.testVideo) {
      // テストモード：画面の代わりに録画した動画を読み取る（音は出さない・画面には出さない）
      try {
        testVid = document.createElement('video');
        testVid.muted = true; testVid.playsInline = true; testVid.preload = 'auto';
        testVid.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:27px;opacity:0.01;pointer-events:none';
        testVid.src = options.testVideo;
        document.body.appendChild(testVid);
        await new Promise((res, rej) => { testVid.onloadeddata = res; testVid.onerror = () => rej(new Error('動画を読み込めません: ' + options.testVideo)); });
        testVid.playbackRate = options.testSpeed || 1;
        testVid.onended = () => { testDone = true; };
        await testVid.play();
        stream = testVid.captureStream();
        testFrame = [testVid.videoWidth, testVid.videoHeight];
        testStarted = true;
      } catch (e) { testErr = String(e && e.message || e); console.error('[test] video failed', e); return; }
    } else try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: RC.sampleFps, max: RC.sampleFps } }, audio: false });
    } catch (e) { console.error('[reader] capture failed', e); return; }
    const track = stream.getVideoTracks()[0];
    const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
    // 2026-10-25：デモ再生・確認用ゲーム画面のあとに読み取りを再開すると、読み取り側は「もう隠れている」と覚えたままで
    //   「隠す」を送らず、枠が出っぱなしになっていた → 再開のたびに「今は見えている」から始め、最初の読み取りで正しく隠す
    interp.hidden = false;
    worker = new Worker('reader.worker.js');
    worker.onerror = (ev) => reportError('worker', (ev && ev.message) || 'worker error');
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'reading') {
        hbReadings++;
        lastReading = m.reading;
        if (testVid) { try { const r = m.reading; testRaw.push([Math.round(testVid.currentTime * 1000) / 1000, r.hudVisible ? 1 : 0, r.hpRatio == null ? null : Math.round(r.hpRatio * 1000) / 10, r.shieldPoints == null ? null : r.shieldPoints, r.shieldSegments || 0]); } catch { /* 記録できなくても続行 */ } }
        if (demoView) return;
        if (m.reading.championFire && gameActive) dispatch({ event: 'champion' });
        // 2026-11-02：キル・アシスト・味方のキル（ランクのチームポイント）・ウルト（判定は killult.js）
        //   ウルト：0〜99% はいつもの枠、100% は枠の光がゆっくり脈打つ（s-ready）、使った瞬間は強く光る（s-active）＋キラキラ
        if (m.reading.kuEv && gameActive) for (const e of m.reading.kuEv) {
          if (e.type === 'kill') dispatch({ event: 'kill', arg: e.n });
          else if (e.type === 'assist' || e.type === 'team_kill') dispatch({ event: e.type });
          else if (e.type === 'ult_charge') dispatch({ patch: { ult: { charge: e.pct } }, silent: true });
          else if (e.type === 'ult_ready') { dispatch({ patch: { ult: { charge: 100 } }, silent: true }); dispatch({ event: 'ult_ready' }); }
          else if (e.type === 'ult_used') { dispatch({ patch: { ult: { charge: 100 } }, silent: true }); dispatch({ event: 'use_ult' }); }
        }   // 2026-10-30：優勝の帯が見えた（1試合に1回。判定は champion.js）
        const now = performance.now();
        const before = { hp: state.hp, shield: state.shield };
        // HUD が出ているかは、続けて同じ結果のときだけ切り替える（消すのは早く、出すのは少し慎重に）
        const vis = hudVisFilter.update('hud', gameActive && !!m.reading.hudVisible, now, { openFrames: VIS_OPEN_FRAMES, closeMs: 0 });   // 2026-10-26（ユーザー希望「限界まで」）：消すのは即時   // 2026-10-25 夜：0.2 秒だとメニューを開いたとき枠が残って見えた → 0.05 秒（読み取り側で一瞬の読み落としは減らした）   // 2026-10-25：新しいモード（アーマーの丸が無い）で1コマだけ読み落として枠がちらついた → 消すのは 0.2 秒続いたときだけ   // 2026-10-24：メニューから戻ったときの表示が遅かったので 6→3（誤表示の対策は読み取り側で強化済み）
        const r0 = { ...m.reading, hudVisible: hudVisFilter.s.hud.v };
        const msgs = interp.update(r0, now);
        // メニュー・インベントリを開け閉めする瞬間は、ゲームの HUD が部品ごとにずれて消える／出るため、
        // バーだけ先に消えて「被弾」「シールド破壊」と誤判定しやすい。
        // 演出の出る更新は 250ms 待ってから出し、その間に HUD が消えたら演出なしにする。出てきた直後 1 秒も演出なし。
        for (const msg of msgs) {
          if (msg.patch && 'hudHidden' in msg.patch) {
            const hid = msg.patch.hudHidden;
            for (const p of pendingMsgs) { if (hid && p.msg.patch) p.msg.silent = true; }
            if (!hid) quietUntil = now + 1000;
            flushPending(now, true);
            dispatch(msg);
          } else if (msg.patch && !msg.silent) {
            // 2026-10-27：出てきた直後（演出なし）の更新は待たずにすぐ入れる。リスポーンで HP 満タンなのに、
            //   ダウンの顔・赤い枠が 0.3 秒ほど残っていた（記録 20261026_234322 の 23:50:21・23:58:16）
            if (now < quietUntil) { msg.silent = true; flushPending(now, true); dispatch(msg); }
            else pendingMsgs.push({ msg, t: now });
          } else if (msg.patch && pendingMsgs.length) {
            // 2026-10-31（テストで発見）：演出なしの更新を待ちの列より先に入れていたため、順番が入れ替わっていた。
            //   回復中に HP 80（待ち）→ 81（演出なし・すぐ）→ 待ちの 80 が後から入り「81→80 の被弾」で一瞬赤くなっていた
            //   → 待ちの列があるときは、演出なしの更新も列の後ろに並べて順番を守る
            pendingMsgs.push({ msg, t: now });
          } else if (msg.event && now < quietUntil && msg.event !== 'heal_stop') {
            /* 出てきた直後の回復開始などは出さない */
          } else if (msg.event === 'heal_start' && !onFoot) {
            /* 2026-10-27（ユーザー指摘）：降下中にゲームが最初のアーマーをくれる（シールド 0→50）のを回復と読み、緑が出ていた → 地上に着くまでは回復の緑を出さない */
          } else dispatch(msg);
        }
        flushPending(now, false);
        const r = m.reading;
        if ((r.layout && r.layout !== shieldLayout) || (r.modeKind !== undefined && r.modeKind !== modeKind)) { shieldLayout = r.layout || shieldLayout; modeKind = r.modeKind; for (const g of Object.values(G)) g.lidKey = '?'; lastLidKey = ''; if (last && last.mates) render(last); share({ options: { layout: shieldLayout, modeKind } }); }
        if (r.mates && r.mates[0] && typeof r.mates[0].dy === 'number' && r.mates[0].dy !== mateDy) { setMateDy(r.mates[0].dy); share({ options: { mateDy } }); }
        try {
        if (r.mates) r.mates.forEach((mr, i) => {
          // いる／いないは、続けて同じ結果が出たときだけ切り替える（ちらつき防止）
          // 2026-10-28：リスポーン待ち（黄緑のバナー）の間も枠を出す。値は動かさず、色はふつうにする
          // 2026-10-29（録画 23.30.02）：バナー待ちの読みが一瞬だけ外れても枠の色が行ったり来たりしないよう、外れが 0.5 秒続いたら戻す
          const rawWait = gameActive && !!mr.respawnWait;
          if (rawWait) waitLastAt[i] = now;
          const wait = rawWait || (gameActive && mateWait[i] && now - (waitLastAt[i] || 0) < 500);
          if (wait !== mateWait[i]) { mateWait[i] = wait; const wm = { options: { mateWait: mateWait.slice() } }; share(wm); if (last && last.mates) render(last); }
          const p = matePresence.update('m' + i, gameActive && !!mr.hudVisible, now, { openFrames: 10, closeMs: 1500 });
          // 現れ直したら、最初の値は演出なしで合わせる。新しい読み取り器は「隠れていた」状態を知らないので、ここで「いる」に戻す
          // （これが無いと、一度メニュー等で味方バナーが消えると二度と枠が出なかった）
          if (p === true) { mateInterp[i] = new R.Interpreter({ stableFrames: 2 }); mateApply(i, { patch: { hudHidden: false }, silent: true }, now); }
          const shown = matePresence.s['m' + i].v;
          const reading = shown ? (gameActive && mr.hudVisible ? mr : null) : { ...mr, hudVisible: false };
          if (!reading) return;   // いる扱いの間の一瞬の読み落としは無視
          if (wait) return;   // リスポーン待ちの間は値（HP 0 など）を入れない
          for (const msg of mateInterp[i].update(reading, now)) {
            // 2026-10-27（ユーザー指摘）：味方もシップから降りるとゲームが最初のアーマーをくれる（シールド 0→50）のを回復と読み、緑が出ていた → 自分が地上に着くまでは味方の回復の緑も出さない
            if (msg.event === 'heal_start' && !onFoot) continue;
            mateApply(i, msg, now);
          }
        });
        if (r.chat && api) handleChat(r.chat);
        if (hudVisFilter.s.hud && hudVisFilter.s.hud.v && r.evoCircle != null && r.barsOk) {
          // シールド進化の丸の有無（読み取り側で確かめ済みの値をそのまま使う）
          const c = evoFilter.update('e', !!r.evoCircle, now, { openFrames: 1, closeMs: 0 });   // 読み取り側で10回続けて確かめ済み
          if (c !== null) { const msg = { options: { evoCircle: c } }; onInput(msg); share(msg); }
        }
        const visD = !!(hudVisFilter.s.hud && hudVisFilter.s.hud.v);   // HUD が消えていた長さ（キャラ選び等）を数える
        // 2026-10-29（ユーザー指摘・録画 00.01.55／記録 20261029_000044 の 007）：キャラ選びから戻る途中で、前のオクタンの HUD が一瞬（3コマ）出てから
        //   もう一度消えることがあり、その3コマの「注射器2本」で見直しが取り消され、新しいキャラでも2つ用の枠のままだった。
        //   → 1.5秒以上消えたら「見直し待ち」にし、HUD が1秒続けて出るまでは、出直すたびに見直しをやり直す。
        //     見直しは、出直してから1秒の間に注射器2本の絵（dualTac）が一度も取れなければ1つ用の枠に戻す
        // 2026-10-29 2回目（録画 00.19.48）：射撃訓練場のキャラ選びは HUD が消えるのが 1.3〜1.5秒しかなく、1.5秒の基準に届かず見直しが始まらないことがあった（ミラージュ・ニューキャッスル）。
        //   → 0.5秒以上消えたら見直す。見直しの長さも 1秒→0.6秒（オクタンなら注射器2本の絵は出直した最初の0.1秒で取れている）
        if (!visD) { if (dualHidSince < 0) dualHidSince = now; }
        else if (dualHidSince >= 0) {
          if (now - dualHidSince > 500) dualArmed = true;
          if (dualArmed) {
            dualRecheckAt = now; dualRecheckSeen = false; dualLastSeenAt = -1;
            // 2026-10-29 5回目（ユーザー要望「もっと早く」・録画 01.35.21 の53.5秒：レヴナントに替えたあと約1秒、2つ用＋のばした枠が残った）：
            //   HUD が出直した瞬間に、いったん1つ用の枠（のばしもなし）にする。オクタンなら注射器2本の絵がすぐ取れて（約0.03秒）2つ用に戻る
            if (tacDual) { dualFilter.s.d = { v: false, n: 0, since: 0 }; const msg = { options: { tacDual: false } }; onInput(msg); share(msg); }
            if (octExt) { octOnAt = -1; octOffAt = now; const msg = { options: { octExt: false } }; onInput(msg); share(msg); }
          }
          dualHidSince = -1;
        }
        if (visD && dualRecheckAt >= 0) {
          if (r.dualTac) { dualRecheckSeen = true; dualLastSeenAt = now; }
          // 2026-10-29 4回目（ユーザー要望「もう少し早く」）：0.6秒待たずに、出直してから0.25秒たった時点で
          //   「直近0.2秒に注射器2本が一度も見えていない」なら、すぐ1つ用の枠に戻す（最長でも0.6秒で見直し終わり）
          const lastD = Math.max(dualLastSeenAt, dualRecheckAt);
          if (tacDual && now - dualRecheckAt >= 250 && now - lastD > 200) { dualFilter.s.d = { v: false, n: 0, since: 0 }; dualOffSince = -1; const msg = { options: { tacDual: false } }; onInput(msg); share(msg); dualRecheckAt = -1; dualArmed = false; }
          else if (now - dualRecheckAt >= 600) {
            // 2026-10-29 3回目（録画 00.53.35）：キャラ選びのあと、前のオクタンの HUD が一瞬（0.1〜0.2秒）映ってから、すぐ新しいキャラに切り替わることがある（間に HUD が消えない）。
            //   その一瞬の「注射器2本」で見直しが通っていた → 見直しの最後の0.3秒に注射器2本が見えていなければ1つ用の枠に戻す
            if ((!dualRecheckSeen || now - dualLastSeenAt > 300) && tacDual) { dualFilter.s.d = { v: false, n: 0, since: 0 }; dualOffSince = -1; const msg = { options: { tacDual: false } }; onInput(msg); share(msg); }
            dualRecheckAt = -1; dualArmed = false;
          }
        }
        if (r.dualTac != null) {
          // 2つ用の枠への切り替えは、続けて同じ結果のときだけ（2026-10-25 ユーザー要望で速く：出すのは約0.2秒、戻すのは約0.4秒）
          // 2026-10-28（実機）：オクタンの2本目の注射器がクールダウン中（暗い絵＋秒数）だと「2つ」の絵が取れず、
          //   0.15秒で1つ用の枠・ふつうのウルトの枠に戻って、枠がパタパタ切り替わっていた。
          // 2026-10-28 2回目（録画 22.10.26）：「1つ用の白い絵（tacGlyph）が見えたら戻す」にしたが、オクタンの1本目の注射器も
          //   同じ場所で白い絵として取れてしまい、やはり1つ用の枠に戻っていた。
          //   → 2つの絵（dualTac）か2本目のゲージ（octBar）が見えている間はオクタンのまま。
          //     戻すのは、上のキャラ選びのあとの見直しか、45秒ずっとどちらも見えないときだけ
          // 2026-10-28 3回目（録画 23.53.19）：オクタン→ほかのキャラにしても、のばした枠が砂地の上に重なってゲージの形に見え（octBar の誤反応）、
          //   それで「オクタンのまま」が続いた。→ 見直し中はゲージ（octExt）を数えない
          const octSeen = !!r.dualTac || (octExt && dualRecheckAt < 0);
          let c = null;
          if (octSeen) { dualOffSince = -1; if (!tacDual && r.dualTac) c = dualFilter.update('d', true, now, { openFrames: 2, closeMs: 150 }); }
          else if (tacDual && visD) {
            if (dualOffSince < 0) dualOffSince = now;
            if (now - dualOffSince >= 45000) { c = false; dualOffSince = -1; dualFilter.s.d = { v: false, n: 0, since: 0 }; }
          } else if (!tacDual) dualFilter.update('d', false, now, { openFrames: 2, closeMs: 150 });
          if (c !== null && c !== tacDual) { const msg = { options: { tacDual: c } }; onInput(msg); share(msg); }
        }
        {
          // 2026-10-28（ユーザー要望）：オクタンの注射器2本目のゲージ（金色のふちの板）が出ている間だけ枠をのばす。
          //   0.2秒続いたら出す（ほかの景色で最長0.1秒の誤反応あり）／0.25秒見えなかったら戻す
          // 2026-10-29（ユーザー要望：のびる・ちぢむをもっと早く）：0.12秒で出す（誤反応の最長0.1秒よりは長く）／0.15秒で戻す
          // 2026-10-30：ゲージより先に出る「黄色いふち」（octOut）も見る。ふちは細い線だけを数えるので誤反応が少なく、0.04秒続けば出す
          const ob = (!!r.octBar || !!r.octOut) && tacDual;
          if (ob) { octOffAt = -1; if (octOnAt < 0) octOnAt = now; } else { octOnAt = -1; if (octOffAt < 0) octOffAt = now; }
          if (r.octOut && tacDual) { if (octOutAt < 0) octOutAt = now; } else octOutAt = -1;
          const want = octExt ? !(octOffAt >= 0 && now - octOffAt >= 150) : ((octOutAt >= 0 && now - octOutAt >= 40) || (octOnAt >= 0 && now - octOnAt >= 120));
          if (want !== octExt) { const msg = { options: { octExt: want } }; onInput(msg); share(msg); }
        }
        {
          // 2026-10-31：武器の上の黄色い帯。0.06秒続いたらくりぬく／0.3秒見えなかったら戻す
          if (r.wBanner) { wbOffAt = -1; if (wbOnAt < 0) wbOnAt = now; } else { wbOnAt = -1; if (wbOffAt < 0) wbOffAt = now; }
          const want = wBanner ? !(wbOffAt >= 0 && now - wbOffAt >= 300) : (wbOnAt >= 0 && now - wbOnAt >= 60);
          if (want !== wBanner) { const msg = { options: { wBanner: want } }; onInput(msg); share(msg); }
        }
        {
          // 2026-10-27：地上にいるか。戦術のアイコン（または覚えたウルトのアイコン）が見えたら地上。
          //   ダウンしたまま HUD が5秒以上消えた（死亡→観戦→リスポーンのシップ）、または20秒以上消えた（ロビー・次の試合）ら地上ではない。
          //   見えないまま HUD が150秒以上出ていたら（戦術がずっとクールダウンのまま起動した等）、地上とみなす
          const visNow = !!(hudVisFilter.s.hud && hudVisFilter.s.hud.v);
          // 2026-10-27 2回目：ワイルドカード等はダウン・死亡から数秒でリスポーンして降下するので、上の「5秒以上消えた」に入らず、
          //   降下中に戦術・ウルト・武器の枠が出ていた（ユーザー指摘）。→ HP 0（ダウン・死亡）のまま HUD が消え、出直したら HP 満タン＝リスポーン → 地上ではない
          //   （蘇生は HUD が消えずに HP が少しだけ戻るので当てはまらない）
          if (visNow) { footHidSince = -1; if (footVisSince < 0) footVisSince = now; }
          else { footVisSince = -1; if (footHidSince < 0) { footHidSince = now; if (state.hp === 0 || state.knocked) footRespawn = true; } }
          let foot = onFoot;
          if (visNow && footRespawn) {
            if (state.hp >= 99) { foot = false; footRespawn = false; }
            else if (state.hp > 0 || now - footVisSince > 3000) footRespawn = false;
          }
          // 2026-10-28（実機・射撃訓練場）：オクタンは戦術が2つ並び、1つ用の位置の白い絵（tacGlyph）が取れない。さらに地上でないとウルトの形を覚えないので、
          //   ロビー（20秒以上 HUD なし）から戻ると「地上ではない」のまま抜けられず、アイテム・戦術・ウルト・武器の枠が出なかった。
          //   → 戦術2つの絵（dualTac：オクタンの注射器の形）が見えたら地上とみなす
          if (visNow && foot === onFoot && (r.tacGlyph || r.dualTac || r.ultIcon > 0.6)) foot = true;
          else if (!visNow && footHidSince >= 0 && ((state.knocked && now - footHidSince > 5000) || now - footHidSince > 20000)) foot = false;
          else if (visNow && !foot && now - footVisSince > 150000) foot = true;
          // 2026-10-28（ユーザー指摘・射撃訓練場）：オクタンからほかのキャラに替えると、名前以外の枠（アイテム・戦術・ウルト・武器）が出なくなった。
          //   キャラ選びで HUD が20秒以上消えると「地上ではない」になり、新しいキャラのアイコンが取れるまで戻れないため。
          //   → 方位計が無い（射撃訓練場：シップ・降下が無い）ところで HUD が3秒出ていたら地上とみなす
          else if (visNow && !foot && compassFilter.s.c && !compassFilter.s.c.v && now - footVisSince > 3000) foot = true;
          if (foot !== onFoot) { const msg = { options: { onFoot: foot } }; onInput(msg); if (api) api.relay(msg); if (worker) worker.postMessage({ type: 'onfoot', on: foot }); }
        }
        if (r.ultIcon != null) {
          // エイム中はゲームのウルトアイコンが消えるので、ウルトの枠も消す（消すのは速く、戻すのは少し確かめてから）
          const u = ultFilter.update('u', r.ultIcon > 0.3, now, { openFrames: 3, closeMs: 50 });
          if (u !== null) { const msg = { options: { ultIcon: u } }; onInput(msg); if (api) api.relay(msg); }
        }
        if (r.deathbox) {
          // デスボックスを開いた時の中央下のバナー（自分・味方）に枠を出す
          const db = r.deathbox, ch = {};
          const o = deathboxFilter.update('open', db.open, now, { openFrames: 3, closeMs: 150 });
          const a = deathboxFilter.update('m1', db.mates[0], now, { openFrames: 3, closeMs: 300 });
          const b = deathboxFilter.update('m2', db.mates[1], now, { openFrames: 3, closeMs: 300 });
          if (o !== null || a !== null || b !== null) {
            const S2 = deathboxFilter.s;
            const msg = { options: { deathbox: { open: S2.open.v, m1: S2.m1.v, m2: S2.m2.v } } };
            onInput(msg); if (api) api.relay(msg);
          }
        }
        // 2026-10-26：方位とミニマップは別々に（バトロワの降下中は方位だけ出てミニマップは出ない）。
        //   メニュー等でゲームの HUD が消えている間は見直さない（戻ったときにすぐ前の状態で出す）
        // 2026-10-28（実機・射撃訓練場）：ロビーから訓練場に入ると、前の試合の「方位・ミニマップあり」のまま一瞬枠が出ていた。
        //   → HUD が20秒以上消えていた（ロビー・読み込み）あとは、両方とも「なし」から始めて、見えてから出す
        if (!r0.hudVisible) { if (mapHidSince < 0) mapHidSince = now; }
        else if (mapHidSince >= 0) {
          if (now - mapHidSince > 20000) {
            compassFilter.s.c = { v: false, n: 0, since: 0 }; minimapFilter.s.m = { v: false, n: 0, since: 0 };
            const msg = { options: { mapUi: false, minimapUi: false } }; onInput(msg); if (api) api.relay(msg);
          }
          mapHidSince = -1;
        }
        if (r.compass != null && r0.hudVisible) {
          // 方位計が無い（射撃訓練場など）ときは方位の枠を隠す
          const c = compassFilter.update('c', r.compass >= 6, now, { openFrames: 3, closeMs: 1500 });
          if (c !== null) { const msg = { options: { mapUi: c } }; onInput(msg); if (api) api.relay(msg); }
        }
        if (r.mapArrow != null && r0.hudVisible) {
          // ミニマップの真ん中の自分の矢印（上向きの山形）があるときだけミニマップの枠を出す
          // 2026-10-28：訓練場は方位計が無いのに矢印の点数が 2.0〜2.6 出てミニマップの枠がチラついた（本物は 2.3〜5.4 で点数では分けられない）
          //   → 方位計が見えているときだけミニマップありとする（試合中は方位計が必ず出ている）
          // 2026-10-30：ガンゲームは方位計が無い代わりに武器のバー（gunBar）がある。そのときもミニマップの枠は出す
          // 2026-11-01：チームデスマッチ・コントロールは上の真ん中のスコアの枠（scoreBar）がある。そのときも出す
          const c = minimapFilter.update('m', r.mapArrow >= 1.8 && r.compass != null && (r.compass >= 6 || !!r.gunBar || !!r.scoreBar), now, { openFrames: 3, closeMs: 1500 });
          if (c !== null) { const msg = { options: { minimapUi: c } }; onInput(msg); if (api) api.relay(msg); }
        }
        if (r.peeks) {
          const ch = {};
          for (const [id, v] of Object.entries(r.peeks)) { const c = peekFilter.update(id, v, now, RC.peeks[id]); if (c !== null) ch[id] = c; }
          if (Object.keys(ch).length) { const msg = { patch: { shown: ch } }; onInput(msg); share(msg); }
        }
        } catch (e) { reportError('reading', e); }
        if (diagOn) { try { diagRecord(m, msgs, before, now); } catch (e) { reportError('diag', e); } }
      } else if (m.type === 'stats' && statsReply) { statsReply(m.stats); statsReply = null; }
      else if (m.type === 'error') reportError('worker', m.message);
    };
    worker.postMessage({ type: 'start', config: RC, readable: processor.readable, layout: shieldLayout }, [processor.readable]);
    worker.postMessage({ type: 'onfoot', on: onFoot });
    worker.postMessage({ type: 'chat', on: options.chatTranslate !== false });
    lastLidKey = '';
    if (diagOn) worker.postMessage({ type: 'diag', on: true });
    readerOn = true;
    console.log('[reader] started', track.getSettings().width, track.getSettings().height);
  }
  function stopReader() {
    readerOn = false;
    if (worker) worker.terminate();
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; worker = null; lastReading = null;
    onInput({ patch: { hudHidden: false } });
    if (!onFoot) { const msg = { options: { onFoot: true } }; onInput(msg); if (api) api.relay(msg); }   // 読み取りを止めたら枠は全部出す
    if (octExt) { const msg = { options: { octExt: false } }; onInput(msg); if (api) api.relay(msg); }
  }
  window.hud.readerStats = () => worker
    ? new Promise((res) => { statsReply = res; worker.postMessage({ type: 'stats' }); setTimeout(() => res(null), 500); })
    : Promise.resolve(null);

  // ---------- 性能計測（描画） ----------
  const perf = { deltas: new Float32Array(4096), renderMs: new Float32Array(4096), n: 0, i: 0 };
  // 性能表示は画面読み取りの邪魔にならないよう、全体表示（検証用）のときだけ HUD 上に出す。
  // 通常はテスト操作パネルに表示する。
  const PERF_ON_HUD = PART === 'all';
  $('#perf').hidden = !(options.perf && PERF_ON_HUD);
  function perfStats() {
    const n = Math.min(perf.n, perf.deltas.length);
    const a = Array.from(perf.deltas.slice(0, n)).sort((x, y) => x - y);
    const r = Array.from(perf.renderMs.slice(0, n)).sort((x, y) => x - y);
    const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
    const mean = a.reduce((s, v) => s + v, 0) / (a.length || 1);
    return { frames: perf.n, fps: mean ? 1000 / mean : 0, frameMsP50: q(a, .5), frameMsP99: q(a, .99), frameMsMax: a[a.length - 1] || 0,
      jsMsP50: q(r, .5), jsMsP99: q(r, .99), droppedFrames: a.filter(v => v > q(a, .5) * 1.5).length, sampled: a.length };
  }
  window.hud.perfStats = async () => Object.assign(perfStats(), { reader: await window.hud.readerStats() });
  let readerStatsCache = null;
  setInterval(async () => { if (!$('#perf').hidden) readerStatsCache = await window.hud.readerStats(); }, 500);
  window.hud.perfReset = () => { perf.n = 0; perf.i = 0; };
  window.hud.perfText = async () => {
    const st = perfStats(), rs = await window.hud.readerStats(), rd = lastReading;
    return `描画 ${st.fps.toFixed(1)}fps  p99 ${st.frameMsP99.toFixed(2)}ms  落ち ${st.droppedFrames}/${st.sampled}\n` +
      (rs ? `読取 ${rs.frames}回  p99 ${rs.msP99.toFixed(2)}ms（別スレッド）` : '読取 OFF');
  };

  layoutAll();
  await Promise.all(loads);
  if (cfg.background) applyBackground(cfg.background);
  setName(options.playerName);
  if (document.fonts) document.fonts.ready.then(() => setName(options.playerName));
  if (options.diag && READS) setDiag(true);
  if (options.screenRead && READS) startReader();
  body.dataset.ready = '1';

  let prevT = performance.now(), lastPerfDraw = 0;
  function frame(t) {
    const dt = t - prevT; prevT = t;
    const t0 = performance.now();
    M.tick(state, dt / 1000, t);
    const dv = M.derive(state, t);
    render(dv);
    if (sparkles && options.fx !== false) {
      if (dv.panel === 'healing' && GIRL && options.sparkles !== false && !options.noChara) { const c = toWin(GIRL.x, GIRL.y - GIRL.h * 0.8, girl.anchor); sparkles.drizzle(c.x / c.k, c.y / c.k, GIRL.w, GIRL.h * 0.6, dt / 1000 / FX_SLOW, 7, { kind: 'dot', colors: ['#bfffdc', '#fff', '#8ef0b8'] }); }
      if (dv.ultState === 'ready' && options.sparkles !== false) { const u = ultCenter(); if (u) sparkles.drizzle(u.x - u.w * 0.45, u.y - u.h * 0.45, u.w * 0.9, u.h * 0.9, dt / 1000 / FX_SLOW, 12, { kind: 'star', colors: ['#fff', '#aef', '#ffe9a8'], size: 1.3, life: 1200 }); }
      sparkles.step(Math.min(dt, 50) / 1000 / FX_SLOW, screenH() / BH);
    }
    perf.deltas[perf.i] = dt; perf.renderMs[perf.i] = performance.now() - t0; perf.i = (perf.i + 1) % perf.deltas.length; perf.n++;
    if (!$('#perf').hidden && t - lastPerfDraw > 250) {
      lastPerfDraw = t; const s = perfStats(), rd = lastReading;
      $('#perf').textContent = `描画 ${s.fps.toFixed(1)}fps  p99 ${s.frameMsP99.toFixed(2)}ms  落ち ${s.droppedFrames}/${s.sampled}\n` +
        (readerStatsCache ? `読取 ${readerStatsCache.frames}回  p99 ${readerStatsCache.msP99.toFixed(2)}ms（別スレッド）\n` : '') +
        (rd ? `HP ${(rd.hpRatio * 100).toFixed(0)}  盾 ${rd.shieldPoints}/${rd.shieldSegments * 25} ${rd.shieldTier}  HUD ${rd.hudVisible ? '表示' : '非表示'}` : '読取 OFF');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
