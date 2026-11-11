(function () {
  'use strict';
  const api = window.hudApi;
  const send = (m) => api.send(m);
  const $ = (s) => document.getElementById(s);
  const toast = (t) => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 1600); };

  // ---------- タブ ----------
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('cur', x === b));
    document.querySelectorAll('main section').forEach(s => s.classList.toggle('cur', s.id === 'tab-' + b.dataset.tab));
    try { localStorage.setItem('tab', b.dataset.tab); } catch { /* 保存できなくてもよい */ }
  }));
  try { const t = localStorage.getItem('tab'); if (t) { const b = document.querySelector(`nav button[data-tab="${t}"]`); if (b) b.click(); } } catch { /* なし */ }

  // ---------- キャラ ----------
  let curChar = '';
  async function loadChars() {
    const r = await api.characters();
    curChar = r.current;
    if (r.dir) $('mydir').textContent = '場所：' + r.dir;
    const box = $('chars'); box.innerHTML = '';
    for (const c of r.list) {
      const d = document.createElement('button');
      d.className = 'chara' + (c.id === curChar ? ' cur' : ''); d.dataset.id = c.id; d.title = c.name;
      let im;
      if (c.noChara) { im = document.createElement('div'); im.className = 'none'; im.textContent = '枠だけ'; }
      else { im = document.createElement('img'); im.src = c.face; im.alt = ''; }
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = c.name;
      d.append(im, nm);
      if (c.custom) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'マイキャラ'; d.appendChild(t); }
      if (c.star) { const t = document.createElement('span'); t.className = 'tag star'; t.textContent = '看板'; d.appendChild(t); }
      d.addEventListener('click', () => {
        api.setting({ character: c.id });
        curChar = c.id; box.querySelectorAll('.chara').forEach(x => x.classList.toggle('cur', x.dataset.id === c.id));
        toast(c.noChara ? 'キャラなし（枠だけ）にしました' : `${c.name} にしました`);
      });
      box.appendChild(d);
    }
    return r;
  }
  $('openMy').addEventListener('click', () => api.openMyChara());
  $('rescan').addEventListener('click', async () => {
    const r = await loadChars();
    if (curChar.startsWith('my:')) api.setting({ character: curChar });   // 選択中のマイキャラは画像を差し替え
    toast(`読み込みました（マイキャラ ${r.list.filter(c => c.custom).length} 人）`);
  });
  const saveName = () => { const v = $('pname').value.trim(); api.setting({ playerName: v }); toast(v ? '名前を反映しました' : '名前を表示しないようにしました'); };
  $('pnameClear').addEventListener('click', () => { $('pname').value = ''; saveName(); });
  $('pnameReset').addEventListener('click', () => { api.setting({ resetName: true }); toast('キャラの名前に戻しました'); });
  $('pnameSave').addEventListener('click', saveName);
  $('pname').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

  // ---------- 枠の色 ----------
  function markFrame(id) {
    $('frameAuto').classList.toggle('cur', id === 'auto');
    $('framePlain').classList.toggle('cur', id === 'plain');
    document.querySelectorAll('.sw').forEach(b => b.classList.toggle('cur', b.dataset.id === id));
  }
  function buildSwatches(styles, cur) {
    const box = $('swatches'); box.innerHTML = '';
    for (const [id, s] of Object.entries(styles || {})) {
      const b = document.createElement('button'); b.className = 'sw'; b.dataset.id = id; b.style.color = s.color;
      const i = document.createElement('i'); const t = document.createElement('span'); t.textContent = s.label; t.style.color = 'var(--text)';
      b.append(i, t);
      if (!s.ok) { b.disabled = true; b.title = 'この色の枠ファイルが見つかりません'; }
      b.addEventListener('click', () => { api.setting({ frameStyle: id }); markFrame(id); toast(`枠を「${s.label}」にしました`); });
      box.appendChild(b);
    }
    markFrame(cur || 'auto');
  }
  $('frameAuto').addEventListener('click', () => { api.setting({ frameStyle: 'auto' }); markFrame('auto'); toast('飾りありの枠にしました'); });
  $('framePlain').addEventListener('click', () => { api.setting({ frameStyle: 'plain' }); markFrame('plain'); toast('飾りなしの枠にしました'); });

  // ---------- 表示する項目 ----------
  const PARTS = [
    ['girl', 'キャラ画像', '左下の顔アイコン'], ['name', '名前', '枠に出す名前'],
    ['player', '自分の体力枠', 'HP・シールドの枠'], ['mates', '味方の枠', '左の味方2人'],
    ['minimap', 'ミニマップ枠', '左上'], ['compass', '方位', '上の方角'],
    ['item', 'アイテム', '回復アイテムの枠'], ['tactical', '戦術スキル', 'Q の枠'],
    ['ult', 'ウルト', '中央下'], ['weapon', '武器・グレネード', '右下'],
  ];
  let hidden = new Set();
  function check(box, key, label, sub, on, fn) {
    const l = document.createElement('label'); l.className = 'check';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = on; c.dataset.key = key;
    const t = document.createElement('span'); t.textContent = label;
    if (sub) { const s = document.createElement('small'); s.textContent = sub; t.appendChild(s); }
    l.append(c, t); box.appendChild(l);
    c.addEventListener('change', () => fn(c.checked));
    return c;
  }
  function buildChecks(o, ed) {
    hidden = new Set(o.hidden || []);
    const box = $('checks'); box.innerHTML = '';
    for (const [k, label, sub] of PARTS.filter(p => !ed || ed.parts.includes(p[0]))) check(box, k, label, sub, !hidden.has(k), (on) => {
      on ? hidden.delete(k) : hidden.add(k);
      api.setting({ hidden: [...hidden] });
    });
    const box2 = $('checks2'); box2.innerHTML = '';
    check(box2, 'fx', 'エフェクト', '光の流れ・キラキラ・優勝演出', o.fx !== false, (on) => api.setting({ fx: on }));
    { // チャンピオン演出の種類（2026-11-03）
      // 2026-11-03：2列のチェックの1マスに入って「チャンピオ／ン演出」と折り返していた → 横いっぱいの1枚のカードにする（ユーザー指摘）
      const row = document.createElement('div'); row.className = 'check'; row.style.cssText = 'grid-column:1 / -1;cursor:default;justify-content:space-between';
      const l = document.createElement('label'); l.htmlFor = 'champFx'; l.style.cssText = 'white-space:nowrap;cursor:default'; l.innerHTML = 'チャンピオン演出<small>優勝したときの画面の演出</small>';
      const s = document.createElement('select'); s.id = 'champFx';
      s.style.cssText = 'width:170px;flex:none;background:var(--bg,#0d1626);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit';
      for (const [v, t] of [['classic', 'いつもの'], ['jackpot', '大当たり（パチンコ風・音あり）'], ['off', '出さない']].filter(([v]) => !(v === 'jackpot' && (window.__ed || {}).id === 'trial'))) { const op = document.createElement('option'); op.value = v; op.textContent = t; s.appendChild(op); }
      s.value = ['jackpot', 'off'].includes(o.championFx) && s.querySelector(`option[value="${o.championFx}"]`) ? o.championFx : 'classic';
      s.addEventListener('change', () => { api.setting({ championFx: s.value }); toast('チャンピオン演出：' + s.selectedOptions[0].textContent); });
      row.append(l, s); box2.appendChild(row);
    }
    check(box2, 'idle', '待機モーション', 'キャラがふわっと動く', o.idleMotion !== false, (on) => { api.setting({ idleMotion: on }); send({ options: { idleMotion: on } }); });
    check(box2, 'lids', '使っていない窓を閉じる', 'アイテム等が無いとき枠でふさぐ', o.lids !== false, (on) => api.setting({ lids: on }));
    if (!ed || ed.chat) check(box2, 'chat', 'チャット翻訳（試験中）', '英語チャットに日本語を添える', o.chatTranslate === true, (on) => api.setting({ chatTranslate: on }));
  }

  // ---------- 設定 ----------
  function toggle(id, fn) {
    const b = $(id);
    b.addEventListener('click', () => { b.classList.toggle('on'); fn(b.classList.contains('on'), b); });
  }
  toggle('read', (on, b) => { b.textContent = on ? '読み取り ON' : '読み取り OFF'; send({ options: { screenRead: on } }); });
  toggle('regions', on => send({ options: { showRegions: on } }));
  toggle('perf', on => { send({ options: { perf: on } }); $('perfbox').hidden = !on; });
  toggle('diag', on => send({ options: { diag: on } }));
  $('logs').addEventListener('click', () => api.openLogs());
  setInterval(async () => { if (!$('perfbox').hidden) $('perfbox').textContent = await api.query('perfText'); }, 500);
  // かんたん診断・問い合わせ用の情報（2026-10-28）
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  if ($('check')) $('check').addEventListener('click', async () => {
    const out = $('checkOut'); out.hidden = false; out.textContent = '確かめています…';
    try {
      const r = await api.check();
      const bad = r.items.filter((x) => x.level === 'ng' || x.level === 'warn');
      out.innerHTML = (bad.length ? `<p><b>${bad.length} 件、見直すところがあります。</b></p>` : '<p><b>よくある原因は見つかりませんでした。</b><br><small>直らないときは「問い合わせ用の情報をコピー」を押して、BOOTH のメッセージに貼り付けてください。</small></p>')
        + [...bad, ...r.items.filter((x) => !(x.level === 'ng' || x.level === 'warn'))].map((x) => `<div class="it ${x.level}"><b>${esc(x.title)}</b>${x.fix ? `<small>${esc(x.fix)}</small>` : ''}</div>`).join('');
    } catch { out.textContent = '確かめられませんでした。アプリを起動し直してからもう一度押してください。'; }
  });
  if ($('copyInfo')) $('copyInfo').addEventListener('click', async () => {
    try { await api.copyInfo(); toast('コピーしました。BOOTH のメッセージに貼ってください'); }
    catch { toast('コピーできませんでした'); }
  });

  // ---------- テスト ----------
  function slider(id, toPatch) {
    const el = $(id), out = document.querySelector(`output[for=${id}]`);
    el.addEventListener('input', () => { out.textContent = el.value; send({ patch: toPatch(+el.value) }); });
  }
  slider('hp', v => ({ hp: v }));
  slider('shield', v => ({ shield: v }));
  document.querySelectorAll('button[data-ev]').forEach(b => b.addEventListener('click', () =>
    send({ event: b.dataset.ev, arg: b.dataset.arg != null ? +b.dataset.arg : undefined })));
  document.querySelectorAll('button[data-patch]').forEach(b => b.addEventListener('click', () =>
    send({ patch: JSON.parse(b.dataset.patch) })));
  toggle('heal', on => send({ event: on ? 'heal_start' : 'heal_stop' }));
  toggle('demoBg', on => send({ options: { demoBg: on } }));
  $('chatTest').addEventListener('click', () => send({ options: { chat: [{ en: 'Jo_xx: lets push them they are low', ja: '突っ込もう 彼ら 低い' }, { en: 'arma: need bats pls', ja: 'バッテリー欲しい お願い' }] } }));
  // デモ再生：表情9種とパネル4種、アビリティ状態を順に見せる（読み取りは一時停止）
  // 2026-11-01（ユーザー指摘）：再生中に止められず、終わるまで枠が出たままだった → 再生中にもう一度押すと止める
  let demoRun = null;
  $('demo').addEventListener('click', async () => {
    if (demoRun) { demoRun.stop = true; return; }
    const run = demoRun = { stop: false };
    const label = $('demo').textContent; $('demo').textContent = 'デモを止める';
    const wasOn = $('read').classList.contains('on');
    if (wasOn) send({ options: { screenRead: false } });
    const steps = [
      [{ event: 'reset' }, 1200], [{ event: 'damage', arg: 20 }, 1300], [{ event: 'damage', arg: 120 }, 2000],
      [{ patch: { hp: 30 } }, 1800], [{ event: 'heal_start' }, 2200], [{ patch: { hp: 100 } }, 400], [{ event: 'heal_stop' }, 2200],
      [{ event: 'use_tactical' }, 1500], [{ patch: { ult: { charge: 100 } } }, 2000], [{ event: 'use_ult' }, 1500],
      [{ event: 'kill' }, 2800], [{ event: 'knock' }, 2200], [{ event: 'revive' }, 1200], [{ event: 'reset' }, 0],
    ];
    for (const [m, wait] of steps) {
      if (run.stop) break;
      send(m);
      // 待っている間に止められたらすぐ抜ける（0.1秒ごとに確認）
      for (let t = 0; t < wait && !run.stop; t += 100) await new Promise(r => setTimeout(r, Math.min(100, wait - t)));
    }
    if (run.stop) send({ event: 'reset' });
    if (wasOn) send({ options: { screenRead: true } });
    demoRun = null; $('demo').textContent = label;
  });

  // ---------- 起動時：今の設定をボタンに反映 ----------
  api.getConfig().then(c => {
    const o = c.options;
    const set = (id, on, label) => { $(id).classList.toggle('on', !!on); if (label) $(id).textContent = label; };
    set('read', o.screenRead, o.screenRead ? '読み取り ON' : '読み取り OFF');
    set('regions', o.showRegions); set('diag', o.diag); set('demoBg', o.demoBg);
    if (o.perf) $('perf').click();
    $('pname').value = o.playerName || '';
    const ed = c.edition || {};
    applyEdition(ed);
    buildSwatches(c.frameStyles, o.frameStyle);
    buildChecks(o, ed);
    loadChars();
  });

  // ---------- グレードごとの見せ方 ----------
  function applyEdition(ed) {
    document.title = (ed.title || 'OverLIVE') + ' メニュー';
    $('edtitle').textContent = 'OverLIVE';
    window.__ed = ed;
    if (ed.id === 'trial') { const cf = $('champFx'); if (cf) { const op = cf.querySelector('option[value="jackpot"]'); if (op) op.remove(); if (cf.value === 'jackpot') cf.value = 'classic'; } }   // 2026-11-03：体験版は大当たりなし
    const chip = document.createElement('span'); chip.className = 'edchip' + (ed.id === 'trial' ? ' trial' : ''); chip.textContent = ed.label || '';
    if (ed.label) $('edtitle').appendChild(chip);
    $('myH').hidden = $('myBox').hidden = !ed.myChara;
    $('upsell').hidden = ed.id !== 'trial';
    $('colorBox').hidden = !ed.colors;
    const tabFrame = document.querySelector('nav button[data-tab="frame"]');
    if (!ed.ornament && !ed.colors) tabFrame.hidden = true;
    $('tabTest').hidden = !ed.test;
    // 2026-10-30（ユーザー決定）：確認用ゲーム画面は配る版から外した（絵も入れていない）。管理用だけボタンを出す
    $('demoBg').hidden = !ed.test && !ed.previewOf;
    $('tabBg').hidden = !ed.background;
    initObs(ed);
    if (ed.background) initBg();
    // 隠したタブが選ばれていたら最初のタブに戻す
    const cur = document.querySelector('nav button.cur');
    if (cur && cur.hidden) document.querySelector('nav button[data-tab="chara"]').click();
  }
  $('shop').addEventListener('click', () => api.openShop());
  $('helpBtn').addEventListener('click', () => api.help(''));
  document.querySelectorAll('a.q[data-help]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); api.help(a.dataset.help); }));

  // ---------- 配信（OBS のブラウザソース） ----------
  function showObs(o) {
    if (!o) return;
    $('obsUrl').value = o.url;
    $('obsState').textContent = o.clients ? `OBS：つながっています（${o.clients}）` : 'OBS：まだつながっていません';
    $('obsState').style.color = o.clients ? 'var(--ok)' : '';
    $('screenHud').checked = o.screenHud !== false;
  }
  // 2026-11-02：再生中の曲
  function showNp(s) {
    if (!s) return;
    $('npOn').checked = !!s.on; $('npScreen').checked = s.screen !== false; $('npUrl').value = s.url || '';
    const setv = (id, v) => { const el = $(id); if (!el || document.activeElement === el || v === undefined) return; el.value = v; const o = document.querySelector(`output[for=${id}]`); if (o) o.textContent = v; };
    if (s.look) { setv('npPos', s.look.pos); setv('npDx', s.look.dx); setv('npDy', s.look.dy); setv('npSize', s.look.size); setv('npOpacity', s.look.opacity); }
    const st = { off: '使っていません', unsupported: 'この PC では使えません（Windows 10・11 が必要です）', starting: '準備中…', error: '読み取れません（もう一度オンにしてみてください）' }[s.status];
    $('npState').textContent = st || (s.track ? `${s.track.playing ? '再生中' : '一時停止中'}：${s.track.title}${s.track.artist ? ' ／ ' + s.track.artist : ''}${s.hasThumb ? '' : '（' + (s.thumbNote || 'サムネイル待ち') + '）'}` : 'ブラウザで曲が流れていません');
  }
  function showCm(s) {
    if (!s) return;
    $('cmOn').checked = !!s.on; $('cmScreen').checked = s.screen !== false; $('cmUrl').value = s.url || '';
    // 2026-10-31：見た目・読み上げ（触っている最中の値は上書きしない）
    const setv = (id, v) => { const el = $(id); if (!el || document.activeElement === el || v === undefined) return; el.value = v; const o = document.querySelector(`output[for=${id}]`); if (o) o.textContent = v; };
    if (s.look) { setv('cmPos', s.look.pos); setv('cmDx', s.look.dx); setv('cmDy', s.look.dy); setv('cmSize', s.look.size); setv('cmOpacity', s.look.opacity); setv('cmLife', s.look.life); setv('cmMax', s.look.max); }
    if (s.voices && s.voices.length) { const sel = $('spVoice'), cur = (s.speak && s.speak.voice) || sel.value; if (sel.options.length !== s.voices.length + 1) { sel.innerHTML = '<option value="">（日本語の声を自動で選ぶ）</option>' + s.voices.map(v => `<option>${v.replace(/[&<>"]/g, '')}</option>`).join(''); } sel.value = cur; }
    if (s.speak) { $('spOn').checked = !!s.speak.on; $('spName').checked = !!s.speak.name; setv('spVol', s.speak.volume); setv('spRate', Math.round(s.speak.rate * 100)); setv('spLen', s.speak.maxLen); if (document.activeElement !== $('spNg')) $('spNg').value = s.speak.ng || ''; setv('spVoice', s.speak.voice || ''); }
    $('cmState').textContent = !s.on ? 'わんコメ：使っていません' : (s.connected ? 'わんコメ：つながっています' : 'わんコメ：つながっていません（わんコメを起動してください）');
    $('cmState').style.color = s.on && s.connected ? 'var(--ok)' : '';
  }
  async function initObs(ed) {
    const o = await api.obs();
    $('obsBox').hidden = !o; $('obsTrial').hidden = !!o || ed.id !== 'trial';
    if (!o) return;
    showObs(o);
    $('obsCopy').addEventListener('click', () => { api.obsCopy(); toast('URL をコピーしました'); });
    if (api.streamWin) $('streamWin').addEventListener('click', () => { api.streamWin(); });
    if (api.charaWin) $('charaWin').addEventListener('click', () => { api.charaWin(); });
    // 再生中の曲（2026-11-02）
    if (api.npState) {
      const ns = await api.npState();
      if (ns) {
        $('npBox').hidden = false; showNp(ns);
        $('npOn').addEventListener('change', () => { api.np($('npOn').checked); toast($('npOn').checked ? '再生中の曲を出します' : '再生中の曲を出すのをやめました'); });
        $('npScreen').addEventListener('change', () => { api.npScreen($('npScreen').checked); toast($('npScreen').checked ? '曲名を自分の画面にも出します' : '曲名は配信にだけ出します'); });
        $('npTest').addEventListener('click', async () => { await api.npTest(); toast('見本を8秒出しました（「再生中の曲を出す」がオンのとき見えます）'); });
        $('npCopy').addEventListener('click', () => { api.npCopy(); toast('曲名の URL をコピーしました'); });
        const NL = { npDx: 'dx', npDy: 'dy', npSize: 'size', npOpacity: 'opacity' };
        for (const [id, k] of Object.entries(NL)) $(id).addEventListener('input', () => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; api.npLook({ [k]: +$(id).value }); });
        $('npPos').addEventListener('change', () => { api.npLook({ pos: $('npPos').value, dx: 0, dy: 0 }); for (const id of ['npDx', 'npDy']) { $(id).value = 0; document.querySelector(`output[for=${id}]`).textContent = 0; } });
        $('npLookReset').addEventListener('click', () => { api.npLook({ pos: 'rm', dx: 0, dy: 0, size: 100, opacity: 70 }); toast('曲名の見た目を元に戻しました'); });
      }
    }
    // コメント表示（わんコメ）
    if (api.commentsState) {
      const cs = await api.commentsState();
      if (cs) {
        $('cmBox').hidden = false; showCm(cs);
        $('cmOn').addEventListener('change', () => { api.comments($('cmOn').checked); toast($('cmOn').checked ? 'コメントを出します' : 'コメントを出すのをやめました'); });
        $('cmScreen').addEventListener('change', () => { api.commentsScreen($('cmScreen').checked); toast($('cmScreen').checked ? 'コメントを自分の画面にも出します' : 'コメントは配信にだけ出します'); });
        $('cmTest').addEventListener('click', async () => { const r = await api.commentsTest(); toast(r && r.ok ? 'テストコメントを送りました' : ((r && r.why) || '送れませんでした')); });
        $('cmCopy').addEventListener('click', () => { api.commentsCopy(); toast('コメント欄の URL をコピーしました'); });
        // 2026-10-31：コメント欄の見た目
        const LOOK = { cmDx: 'dx', cmDy: 'dy', cmSize: 'size', cmOpacity: 'opacity', cmLife: 'life', cmMax: 'max' };
        for (const [id, k] of Object.entries(LOOK)) $(id).addEventListener('input', () => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; if (api.commentsLook) api.commentsLook({ [k]: +$(id).value }); });
        $('cmPos').addEventListener('change', () => { api.commentsLook({ pos: $('cmPos').value, dx: 0, dy: 0 }); $('cmDx').value = 0; $('cmDy').value = 0; document.querySelector('output[for=cmDx]').textContent = 0; document.querySelector('output[for=cmDy]').textContent = 0; });
        $('cmLookReset').addEventListener('click', () => { api.commentsLook({ pos: 'tr', dx: 0, dy: 0, size: 100, opacity: 24, life: 25, max: 3 }); toast('コメント欄の見た目を元に戻しました'); });
        $('cmLookTest').addEventListener('click', async () => { const r = await api.commentsTest(); toast(r && r.ok ? 'テストコメントを送りました' : ((r && r.why) || '送れませんでした')); });
        // 読み上げ
        const SP = { spVol: ['volume', 1], spRate: ['rate', 0.01], spLen: ['maxLen', 1] };
        for (const [id, [k, m]] of Object.entries(SP)) $(id).addEventListener('change', () => api.commentsSpeak({ [k]: +$(id).value * m }));
        for (const id of Object.keys(SP)) $(id).addEventListener('input', () => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; });
        $('spOn').addEventListener('change', () => { api.commentsSpeak({ on: $('spOn').checked }); toast($('spOn').checked ? 'コメントを読み上げます' : '読み上げをやめました'); });
        $('spName').addEventListener('change', () => api.commentsSpeak({ name: $('spName').checked }));
        $('spVoice').addEventListener('change', () => api.commentsSpeak({ voice: $('spVoice').value }));
        $('spNg').addEventListener('change', () => api.commentsSpeak({ ng: $('spNg').value }));
        $('spTest').addEventListener('click', () => { api.commentsSpeakTest(); toast('読み上げのテストをします'); });
      }
    }
    $('screenHud').addEventListener('change', () => { api.screenHud($('screenHud').checked); toast($('screenHud').checked ? '自分の画面にも出します' : '自分の画面には出さず、配信にだけ出します'); });
  }

  // ---------- 枠の背景画像（カスタム版） ----------
  const BG_T = [['player', '自分の体力枠'], ['mates', '味方の枠'], ['item', 'アイテム'], ['tactical', '戦術スキル'], ['ult', 'ウルト'], ['weapon', '武器・グレネード'], ['minimap', 'ミニマップ'], ['compass', '方位']];
  const SL = { bgScale: 'scale', bgX: 'x', bgY: 'y', bgOpacity: 'opacity', bgBright: 'brightness', bgBlur: 'blur' };
  let bg = null, bgInited = false;
  function drawPreview() {
    if (!bg || !bg.url) return;
    const s = bg.settings, P = bg.preview, el = $('bgPrevBg');
    // 2026-10-31（ユーザー指摘：見本と実際の枠で画像の位置がずれる）：見本の箱は 452×163 の決め打ちで、世界観の枠（大きさが違う）だと
    //   枠の絵が引きのばされ、画像の位置の計算（枠の大きさ基準）とも合っていなかった → 見本は枠と同じ大きさで作り、箱に収まるよう縮めて見せる
    const k = Math.min(452 / P.w, 200 / P.h), pv = $('bgPrev');
    pv.style.width = Math.round(P.w * k) + 'px'; pv.style.height = Math.round(P.h * k) + 'px';
    for (const ch of [el, $('bgPrevFrame')]) Object.assign(ch.style, { width: P.w + 'px', height: P.h + 'px', transform: `scale(${k})`, transformOrigin: '0 0' });
    bg.k = k;
    const c = Math.max(P.w / s.w, P.h / s.h) * s.scale / 100, W = s.w * c, H = s.h * c;
    Object.assign(el.style, { backgroundImage: `url("${bg.url}")`, backgroundSize: `${W}px ${H}px`,
      backgroundPosition: `${(P.w - W) / 2 + s.x / 100 * P.w}px ${(P.h - H) / 2 + s.y / 100 * P.h}px`,
      webkitMaskImage: `url("${P.mask}")`, opacity: s.opacity / 100, filter: `brightness(${s.brightness}%)` + (s.blur ? ` blur(${s.blur}px)` : '') });
    $('bgPrevFrame').src = P.frame;
  }
  function fillBg() {
    const has = !!(bg && bg.url);
    $('bgBody').hidden = !has; $('bgNone').hidden = has;
    if (!bg) return;
    const s = bg.settings;
    for (const [id, k] of Object.entries(SL)) { $(id).value = s[k]; document.querySelector(`output[for=${id}]`).textContent = s[k]; }
    $('bgAdj').classList.toggle('on', !!bg.adjust);
    const box = $('bgTargets'); box.innerHTML = '';
    const tg = new Set(s.targets || []);
    for (const [k, label] of BG_T) check(box, 'bg-' + k, label, '', tg.has(k), (on) => { on ? tg.add(k) : tg.delete(k); s.targets = [...tg]; api.bgSet({ targets: s.targets }); });
    drawPreview();
  }
  async function reloadBg() { bg = await api.bgGet(); fillBg(); }
  let sendT = 0, pending = null;
  function push(patch) {   // スライダーを動かしている間は間引いて送る
    Object.assign(bg.settings, patch); drawPreview();
    pending = Object.assign(pending || {}, patch);
    if (!sendT) sendT = setTimeout(() => { api.bgSet(pending); pending = null; sendT = 0; }, 50);
  }
  function initBg() {
    if (bgInited) return; bgInited = true;
    $('bgPick').addEventListener('click', async () => { const r = await api.bgPick(); if (r && r.error) toast(r.error); else if (r) { await reloadBg(); toast('画像を入れました'); } });
    $('bgClear').addEventListener('click', async () => { api.bgClear(); await new Promise(r => setTimeout(r, 100)); await reloadBg(); toast('画像を外しました'); });
    $('bgReset').addEventListener('click', async () => { api.bgReset(); await new Promise(r => setTimeout(r, 100)); await reloadBg(); toast('元に戻しました'); });
    $('bgAdj').addEventListener('click', () => { const on = !$('bgAdj').classList.contains('on'); api.bgAdjust(on); $('bgAdj').classList.toggle('on', on); });
    for (const [id, k] of Object.entries(SL)) $(id).addEventListener('input', () => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; push({ [k]: +$(id).value }); });
    // プレビューをドラッグで移動・ホイールで拡大縮小
    const pv = $('bgPrev'); let drag = null;
    pv.addEventListener('pointerdown', (e) => { if (!bg || !bg.url) return; pv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, sx: bg.settings.x, sy: bg.settings.y }; });
    pv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const P = bg.preview, k = bg.k || 1, x = Math.round(drag.sx + (e.clientX - drag.x) / (P.w * k) * 100), y = Math.round(drag.sy + (e.clientY - drag.y) / (P.h * k) * 100);
      const cx = Math.max(-300, Math.min(300, x)), cy = Math.max(-300, Math.min(300, y));
      $('bgX').value = cx; $('bgY').value = cy; document.querySelector('output[for=bgX]').textContent = cx; document.querySelector('output[for=bgY]').textContent = cy;
      push({ x: cx, y: cy });
    });
    pv.addEventListener('pointerup', () => { drag = null; });
    pv.addEventListener('wheel', (e) => {
      if (!bg || !bg.url) return; e.preventDefault();
      const v = Math.max(20, Math.min(800, Math.round(bg.settings.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06))));
      $('bgScale').value = v; document.querySelector('output[for=bgScale]').textContent = v; push({ scale: v });
    }, { passive: false });
    reloadBg();
  }
  function showUpdate(u) { if (!u) return; $('update').hidden = false; $('updVer').textContent = 'v' + u.version; $('updMsg').textContent = u.message || ''; }
  $('updOpen').addEventListener('click', () => api.openUpdate());
  api.update().then(showUpdate);

  // HUD の表示 ON/OFF（キーでも切り替え可。状態はキー操作とも同期）
  function showBadge(st) {
    const b = $('hudtoggle'); b.classList.toggle('on', st.on); b.textContent = st.on ? 'HUD 表示 ON' : 'HUD 表示 OFF';
    $('keyhint').textContent = `「${st.key}」で HUD の表示 ON/OFF、「${st.menuKey}」でこのメニューを開く／閉じる。×で閉じても HUD は動いたまま。` + (st.trial ? `\n体験版：のこり ${st.trial.leftMin} 分（時間が来ると終了します。もう一度起動すればまた1時間使えます）` : '');
  }
  $('hudtoggle').addEventListener('click', () => api.toggle());
  api.onInput((m) => {
    if (m.bgAdjust != null) $('bgAdj').classList.toggle('on', !!m.bgAdjust);
    if (m.bgFrames && bgInited) reloadBg();
    if (m.openTab) { const b = document.querySelector(`nav button[data-tab="${m.openTab}"]`); if (b && !b.hidden) b.click(); }
    if (m.update) showUpdate(m.update);
    if (m.obs) showObs(m.obs); if ('charaWin' in m) { $('charaWin').textContent = m.charaWin ? 'キャラの窓を閉じる' : 'キャラの窓を開く（エレナ・試作）'; toast(m.charaWin ? 'キャラの窓を開きました' : 'キャラの窓を閉じました'); } if (m.commentsState) showCm(m.commentsState); if (m.nowPlayingState) showNp(m.nowPlayingState); if ('streamWin' in m) { $('streamWin').textContent = m.streamWin ? '配信用の窓を閉じる' : '配信用の窓を開く'; toast(m.streamWin ? '配信用の窓を開きました' : '配信用の窓を閉じました'); } if (m.badge) showBadge(m.badge); if (m.options && 'playerName' in m.options) $('pname').value = m.options.playerName; });
  api.query('badge').then((st) => st && showBadge(st));
  // メニューを開き直したとき、マイキャラを読み込み直す（画像を追加してすぐ反映）
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadChars(); });
  window.addEventListener('focus', () => loadChars());

  // 起動確認（安全装置）と終了
  $('quit').addEventListener('click', () => api.quit());
  $('ng').addEventListener('click', () => api.quit());
  $('ok').addEventListener('click', () => { api.confirm(); $('safety').hidden = true; });
  (async function poll() {
    const st = await api.safety();
    $('safety').hidden = !st.pending;
    if (st.pending) { $('sec').textContent = st.secondsLeft; setTimeout(poll, 500); }
  })();

  const NAMES = { normal: '通常', hit: '被弾', shield_break: 'シールド破壊', hp_low: 'ピンチ', healing: '回復', full_heal: '全回復', kill: 'キル', knockdown: 'ダウン' };
  setInterval(async () => {
    if (document.hidden) return;
    const [d, r] = await Promise.all([api.query('derive'), api.query('reading')]);
    if (r) $('reading').textContent = `ゲームの HUD: ${r.hudVisible ? '検出中' : '見つからない → 枠を隠しています\n（ゲーム外・マップ表示中なら正常）'}\nHP ${(r.hpRatio * 100).toFixed(0)}%   シールド ${r.shieldPoints}/${r.shieldSegments * 25}`;
    else $('reading').textContent = '読み取り OFF';
    if (d) $('now').textContent = `表情: ${NAMES[d.expression]}   パネル: ${d.panel}\n戦術: ${d.tacticalState}   ウルト: ${d.ultState}`;
  }, 400);
})();
