/* 画面全体のお祝いエフェクト（チャンピオン等）。必要な数秒だけ表示される別ウィンドウ */
(function () {
  'use strict';
  const cv = document.getElementById('c');
  cv.width = window.innerWidth; cv.height = window.innerHeight;
  const sp = new window.HudFx.Sparkles(cv);
  const q = new URLSearchParams(location.search);
  const SLOW = +(q.get('fxslow') || 1);
  let running = false, prev = 0, until = 0, emitUntil = 0, kind = 'champion';
  const W = () => cv.width, H = () => cv.height, k = () => H() / 1080;

  const PASTEL = ['#ffb3d9', '#ffd6e8', '#b8f0ff', '#fff3b0', '#d9c6ff', '#ffffff'];
  let motif = 'cat';
  const cut = document.getElementById('cut'), band = document.getElementById('band'), cutImg = cut.querySelector('img');
  function cutIn(art, glow) {   // 全身絵のカットイン（絵があるキャラだけ）
    cut.classList.remove('on'); band.classList.remove('on');
    if (!art) return;
    if (glow) { cut.style.setProperty('--glow', glow); band.style.setProperty('--glow', glow.replace(/[\d.]+\)$/, '.45)')); }
    cutImg.onload = () => { void cut.offsetWidth; cut.classList.add('on'); band.classList.add('on'); };
    cutImg.src = art;
  }
  function show(name, mo, art, glow) {
    kind = name; motif = mo || 'cat';
    cutIn(art, glow);
    const now = performance.now();
    until = now + 5200 * SLOW; emitUntil = now + 2600 * SLOW;
    const cx = W() / k() / 2, cy = H() / k() / 2;
    // 1) 真ん中から広がる輪 ＋ 星の爆発
    for (let i = 0; i < 3; i++) sp.burst(cx, cy, 1, { kind: 'ring', colors: [['#ffffff', '#b8f0ff', '#ffb3d9'][i]], spread: 0, speed: 0, up: 0, size: 18 + i * 10, life: 1100 + i * 250 });
    sp.burst(cx, cy, 70, { kind: 'star', colors: ['#fff', '#fff3b0', '#ffd6e8', '#b8f0ff'], spread: 60, speed: 3.2, up: 1.4, size: 1.6, life: 2200 });
    // 2) 画面のあちこちで肉球がぽんぽん出る
    for (let i = 0; i < 16; i++) {
      setTimeout(() => sp.burst((0.08 + 0.84 * Math.random()) * W() / k(), (0.12 + 0.7 * Math.random()) * H() / k(), 1,
        motif === 'angel'   // 天使のキャラは、白い羽根と天使の輪
          ? { kind: i % 2 ? 'halo' : 'feather', colors: i % 2 ? ['#ffd970'] : ['#ffffff'], spread: 0, speed: 0, up: i % 2 ? 0.3 : -0.15, size: 3.4 + Math.random() * 1.5, life: 1800 }
          : motif === 'plain'   // マイキャラ・飾りなし：星とハート
          ? { kind: i % 2 ? 'heart' : 'star', colors: ['#ffffff', '#fff3b0', '#ffd6e8', '#b8f0ff'], spread: 0, speed: 0, up: 0.25, size: 3.0 + Math.random() * 1.5, life: 1600 }
          : motif === 'devil'   // 小悪魔のキャラは、紫のツノとピンクのハート
          ? { kind: i % 2 ? 'heart' : 'horns', colors: i % 2 ? ['#ff7ac8', '#ffb3e0'] : ['#5a2a6a', '#7a3a8c'], spread: 0, speed: 0, up: 0.3, size: 3.4 + Math.random() * 1.5, life: 1600 }
          : motif === 'bat'   // ドラキュラのキャラは、こうもりと赤い宝石
          ? { kind: i % 2 ? 'gem' : 'bat', colors: i % 2 ? ['#e0203c', '#ff5a6e'] : ['#2a0a14', '#4a0f1e'], spread: 0, speed: 0, up: 0.3, size: 3.4 + Math.random() * 1.5, life: 1600 }
          : motif === 'robot'   // ロボットのキャラは、歯車といなずま
          ? { kind: i % 2 ? 'bolt' : 'gear', colors: i % 2 ? ['#ffe066', '#ffc400'] : ['#ffffff', '#7ff3ff'], spread: 0, speed: 0, up: 0.25, size: 3.4 + Math.random() * 1.5, life: 1600 }
          : motif === 'bunny'   // うさぎのキャラは、うさぎの顔とハート
          ? { kind: i % 2 ? 'heart' : 'bunny', colors: i % 2 ? ['#ff9cc8', '#ffb3d9'] : ['#ffffff'], spread: 0, speed: 0, up: 0.25, size: 3.4 + Math.random() * 1.5, life: 1600 }
          : motif === 'ghost'   // おばけ・ハロウィンのキャラは、肉球の代わりにおばけとかぼちゃ
          ? { kind: i % 2 ? 'pumpkin' : 'ghost', colors: i % 2 ? ['#ff9f40'] : ['#ffffff'], spread: 0, speed: 0, up: 0.25, size: 3.4 + Math.random() * 1.5, life: 1600 }
          : { kind: 'paw', colors: ['#ffb3d9', '#ff9ccb', '#ffffff', '#b8f0ff'], spread: 0, speed: 0, up: 0.15, size: 3.2 + Math.random() * 1.5, life: 1500 }), i * 110 * SLOW);
    }
    document.body.classList.add('glow');
    setTimeout(() => document.body.classList.remove('glow'), 2600 * SLOW);
    if (!running) { running = true; prev = performance.now(); requestAnimationFrame(frame); }
  }
  function frame(t) {
    const dt = Math.min(50, t - prev) / 1000 / SLOW; prev = t;
    if (t < emitUntil) {   // 3) 上からパステルの紙吹雪、下からしゃぼん玉
      for (let i = 0; i < 4; i++) {
        sp.burst(Math.random() * W() / k(), -20, 1, { kind: 'confetti', colors: PASTEL, spread: 0, up: -1.0, speed: 0.9, size: 1.6, life: 3600 });
      }
      if (Math.random() < 0.5) sp.burst(Math.random() * W() / k(), H() / k() + 10, 1, { kind: 'bubble', colors: ['#ffffff', '#b8f0ff', '#ffd6e8'], spread: 0, up: 1.2, speed: 0.5, size: 2 + Math.random() * 2.5, life: 3800 });
      if (Math.random() < 0.6) sp.burst(Math.random() * W() / k(), Math.random() * H() / k(), 1, { kind: 'star', colors: ['#fff', '#fff3b0', '#ffd6e8'], spread: 0, up: 0.3, speed: 0.3, size: 1.1, life: 1200 });
    }
    const any = sp.step(dt, k());
    if (any || t < until) requestAnimationFrame(frame);
    else { running = false; window.hudApi && window.hudApi.send({ fxDone: true }); }
  }
  window.hudApi && window.hudApi.onInput((m) => { if (m.fxFull) show(m.fxFull, m.motif, m.art, m.glow); });
  if (q.get('demo')) show('champion', q.get('motif'), q.get('art'), q.get('glow'));
})();
