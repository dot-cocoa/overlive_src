/*
 * AQUA KAWAII HUD — エフェクト
 * - flow: ネオン管の中を光が流れる（チューブのマスク画像の下でグラデーションを動かす）
 * - sparkle: 出来事（キル・チャンピオン・HP全回復・アーマー進化）で少女のまわりにキラキラ
 * 画像の差し替えとは独立していて、options.fx で丸ごと ON/OFF できる。
 */
(function (root) {
  'use strict';

  // ---- 光の流れ ----
  // 各枠に <div class="fx-flow"> を重ねる。mask にチューブ画像、background に細い光の帯。
  function makeFlow(group, part, k) {
    if (!part.tube) return null;
    const d = document.createElement('div');
    d.className = 'fx-flow';
    d.style.width = part.w + 'px'; d.style.height = part.h + 'px';
    d.style.webkitMaskImage = `url(../assets/${part.tube})`;
    d.style.maskImage = `url(../assets/${part.tube})`;
    d.style.webkitMaskSize = '100% 100%'; d.style.maskSize = '100% 100%';
    group.appendChild(d);
    return d;
  }

  // ---- キラキラ ----
  class Sparkles {
    constructor(canvas) {
      this.cv = canvas; this.c2 = canvas.getContext('2d');
      this.ps = [];
    }
    /** 中心 (x,y) から n 個。kind: star / heart / dot。colors: 配列 */
    burst(x, y, n, opts) {
      const o = Object.assign({ kind: 'star', colors: ['#fff', '#aef', '#ffd6f0'], speed: 1, up: 0.6, size: 1, spread: 40, life: 1400 }, opts);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * o.spread;
        this.ps.push({
          x: x + Math.cos(a) * r, y: y + Math.sin(a) * r * 0.6,
          vx: (Math.random() - 0.5) * 60 * o.speed, vy: (-40 - Math.random() * 90) * o.up * o.speed,
          t: 0, life: o.life * (0.7 + Math.random() * 0.6), s: (4 + Math.random() * 7) * o.size,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 4, kind: o.kind,
          col: o.colors[(Math.random() * o.colors.length) | 0], tw: Math.random() * 6.28,
        });
      }
    }
    /** 継続的にふわっと出す（回復中など） */
    drizzle(x, y, w, h, dt, rate, opts) {
      const n = rate * dt + Math.random();
      for (let i = 0; i < Math.floor(n); i++) this.burst(x + Math.random() * w, y + Math.random() * h, 1, Object.assign({ spread: 0, up: 0.35, speed: 0.6, size: 0.7, life: 1600 }, opts));
    }
    step(dt, k) {
      const c = this.c2, W = this.cv.width, H = this.cv.height;
      c.clearRect(0, 0, W, H);
      if (!this.ps.length) return false;
      const alive = [];
      for (const p of this.ps) {
        p.t += dt * 1000; if (p.t >= p.life) continue;
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 25 * dt; p.rot += p.vr * dt;
        const u = p.t / p.life, al = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
        const tw = 0.6 + 0.4 * Math.sin(p.tw + p.t * 0.02);
        c.save(); c.globalAlpha = Math.max(0, al * tw); c.translate(p.x * k, p.y * k); c.rotate(p.rot); c.scale(k, k);
        c.fillStyle = p.col; c.shadowColor = p.col; c.shadowBlur = 6;
        const s = p.s;
        if (p.kind === 'confetti') {           // 紙吹雪：ひらひら回る細長い紙
          c.shadowBlur = 0; c.rotate(Math.sin(p.t * 0.006 + p.tw) * 0.8);
          c.scale(1, 0.25 + 0.75 * Math.abs(Math.sin(p.t * 0.004 + p.tw)));
          c.fillRect(-s * 0.9, -s * 0.35, s * 1.8, s * 0.7);
        } else if (p.kind === 'paw') {            // 肉球
          c.shadowBlur = 4;
          c.beginPath(); c.ellipse(0, s * 0.25, s * 0.55, s * 0.45, 0, 0, 6.283); c.fill();
          for (const [dx, dy] of [[-0.62, -0.25], [-0.22, -0.6], [0.22, -0.6], [0.62, -0.25]]) { c.beginPath(); c.arc(dx * s, dy * s, s * 0.2, 0, 6.283); c.fill(); }
        } else if (p.kind === 'feather') {        // 白い羽根（ゆらゆら）
          c.rotate(Math.sin(p.t * 0.004 + p.tw) * 0.6); c.shadowBlur = 8; c.shadowColor = '#fff3c4';
          c.beginPath(); c.ellipse(0, 0, s * 0.22, s * 0.7, 0.2, 0, 6.283); c.fill(); c.shadowBlur = 0;
          c.strokeStyle = 'rgba(200,190,170,.8)'; c.lineWidth = s * 0.05; c.beginPath(); c.moveTo(-s * 0.05, s * 0.8); c.lineTo(s * 0.08, -s * 0.6); c.stroke();
        } else if (p.kind === 'halo') {           // 金の天使の輪
          c.shadowBlur = 12; c.shadowColor = '#ffd970'; c.strokeStyle = p.col; c.lineWidth = s * 0.14;
          c.beginPath(); c.ellipse(0, 0, s * 0.6, s * 0.2, 0, 0, 6.283); c.stroke();
        } else if (p.kind === 'horns') {          // 小悪魔のツノ（紫の三日月形が2本・つやのハイライト）
          c.shadowBlur = 10; c.shadowColor = '#ff7ac8';
          for (const sd of [-1, 1]) {
            c.beginPath(); c.moveTo(sd * s * 0.12, s * 0.35);
            c.quadraticCurveTo(sd * s * 0.75, s * 0.2, sd * s * 0.62, -s * 0.7);
            c.quadraticCurveTo(sd * s * 0.5, -s * 0.05, sd * s * 0.52, s * 0.35);
            c.closePath(); c.fill();
          }
          c.shadowBlur = 0; c.fillStyle = 'rgba(220,180,255,.75)';
          for (const sd of [-1, 1]) { c.beginPath(); c.ellipse(sd * s * 0.42, s * 0.05, s * 0.05, s * 0.2, sd * -0.3, 0, 6.283); c.fill(); }
        } else if (p.kind === 'bat') {            // こうもり（黒い羽・赤いふち・赤い目）
          c.shadowBlur = 10; c.shadowColor = '#ff3a55'; c.beginPath(); c.moveTo(0, -s * 0.15);
          for (const [x, y] of [[0.2, -0.4], [0.55, -0.7], [1, -0.75], [0.95, -0.35], [0.8, -0.2], [0.7, 0], [0.52, -0.05], [0.42, 0.15], [0.24, 0.08], [0.1, 0.25], [0, 0.3], [-0.1, 0.25], [-0.24, 0.08], [-0.42, 0.15], [-0.52, -0.05], [-0.7, 0], [-0.8, -0.2], [-0.95, -0.35], [-1, -0.75], [-0.55, -0.7], [-0.2, -0.4]]) c.lineTo(x * s, y * s);
          c.closePath(); c.fill(); c.shadowBlur = 0;
          c.fillStyle = '#ff3a55'; for (const dx of [-0.06, 0.06]) { c.beginPath(); c.arc(dx * s, -s * 0.05, s * 0.035, 0, 6.283); c.fill(); }
        } else if (p.kind === 'gem') {            // ひし形の宝石（金のふち）
          c.shadowBlur = 10; c.beginPath(); c.moveTo(0, -s * 0.6); c.lineTo(s * 0.4, 0); c.lineTo(0, s * 0.6); c.lineTo(-s * 0.4, 0); c.closePath(); c.fill();
          c.shadowBlur = 0; c.lineWidth = s * 0.08; c.strokeStyle = '#e8c46a'; c.stroke();
          c.fillStyle = 'rgba(255,255,255,.7)'; c.beginPath(); c.moveTo(0, -s * 0.45); c.lineTo(s * 0.15, -s * 0.1); c.lineTo(0, -s * 0.05); c.closePath(); c.fill();
        } else if (p.kind === 'gear') {           // 歯車
          c.shadowBlur = 8; c.beginPath();
          for (let i = 0; i < 16; i++) { const r = i % 2 ? s * 0.48 : s * 0.62, a0 = i * Math.PI / 8 - 0.12, a1 = i * Math.PI / 8 + 0.12; c.lineTo(Math.cos(a0) * r, Math.sin(a0) * r); c.lineTo(Math.cos(a1) * r, Math.sin(a1) * r); }
          c.closePath(); c.fill(); c.shadowBlur = 0;
          c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(0, 0, s * 0.2, 0, 6.283); c.fill(); c.globalCompositeOperation = 'source-over';
        } else if (p.kind === 'bolt') {           // いなずま
          c.shadowBlur = 10; c.beginPath();
          c.moveTo(s * 0.15, -s * 0.8); c.lineTo(-s * 0.35, s * 0.08); c.lineTo(-s * 0.02, s * 0.08); c.lineTo(-s * 0.18, s * 0.8); c.lineTo(s * 0.38, -s * 0.12); c.lineTo(s * 0.04, -s * 0.12);
          c.closePath(); c.fill();
        } else if (p.kind === 'bunny') {          // うさぎの顔（白・ピンクの耳の内側・黒い目）
          c.shadowBlur = 8; c.shadowColor = '#ffb3d9';
          for (const dx of [-0.28, 0.28]) { c.beginPath(); c.ellipse(dx * s, -s * 0.75, s * 0.2, s * 0.5, dx * 0.4, 0, 6.283); c.fill(); }
          c.beginPath(); c.ellipse(0, 0, s * 0.62, s * 0.5, 0, 0, 6.283); c.fill(); c.shadowBlur = 0;
          c.fillStyle = '#ffb3d9'; for (const dx of [-0.28, 0.28]) { c.beginPath(); c.ellipse(dx * s, -s * 0.75, s * 0.08, s * 0.3, dx * 0.4, 0, 6.283); c.fill(); }
          c.fillStyle = '#3a2a35'; for (const dx of [-0.22, 0.22]) { c.beginPath(); c.arc(dx * s, -s * 0.05, s * 0.07, 0, 6.283); c.fill(); }
          c.fillStyle = '#ff9cc8'; for (const dx of [-0.38, 0.38]) { c.beginPath(); c.arc(dx * s, s * 0.15, s * 0.08, 0, 6.283); c.fill(); }
        } else if (p.kind === 'ghost') {          // おばけ（白・波打つすそ・黒い目）
          c.shadowBlur = 8; c.shadowColor = '#d9c4ff';
          c.beginPath(); c.arc(0, -s * 0.15, s * 0.7, Math.PI, 0); c.lineTo(s * 0.7, s * 0.6);
          for (let k = 0; k <= 4; k++) c.lineTo(s * 0.7 - k * s * 0.35, s * 0.6 + (k % 2 ? s * 0.18 : 0));
          c.closePath(); c.fill(); c.shadowBlur = 0;
          c.fillStyle = '#3a2a55'; for (const dx of [-0.22, 0.22]) { c.beginPath(); c.ellipse(dx * s, -s * 0.1, s * 0.08, s * 0.12, 0, 0, 6.283); c.fill(); }
        } else if (p.kind === 'pumpkin') {        // かぼちゃ
          c.shadowBlur = 6;
          for (const [dx, rx] of [[-0.3, 0.45], [0.3, 0.45], [0, 0.48]]) { c.beginPath(); c.ellipse(dx * s, 0, rx * s, s * 0.55, 0, 0, 6.283); c.fill(); }
          c.shadowBlur = 0; c.fillStyle = '#5a9a3a'; c.fillRect(-s * 0.08, -s * 0.78, s * 0.16, s * 0.28);
          c.fillStyle = '#5a2a08'; for (const dx of [-0.2, 0.2]) { c.beginPath(); c.moveTo(dx * s - s * 0.09, -s * 0.02); c.lineTo(dx * s + s * 0.09, -s * 0.02); c.lineTo(dx * s, -s * 0.2); c.fill(); }
          c.beginPath(); c.ellipse(0, s * 0.15, s * 0.22, s * 0.09, 0, 0, Math.PI); c.fill();
        } else if (p.kind === 'bubble') {         // しゃぼん玉
          c.shadowBlur = 0; c.globalAlpha *= 0.8;
          c.lineWidth = 1.2; c.strokeStyle = p.col; c.beginPath(); c.arc(0, 0, s * 0.6, 0, 6.283); c.stroke();
          c.globalAlpha *= 0.5; c.beginPath(); c.arc(-s * 0.22, -s * 0.22, s * 0.14, 0, 6.283); c.fill();
        } else if (p.kind === 'ring') {           // 広がる輪
          const r = s * (0.2 + 3 * u); c.shadowBlur = 10; c.globalAlpha = Math.max(0, (1 - u)) * 0.9;
          c.lineWidth = s * 0.18 * (1 - u) + 1; c.strokeStyle = p.col; c.beginPath(); c.arc(0, 0, r, 0, 6.283); c.stroke();
        } else if (p.kind === 'heart') {
          c.beginPath(); c.moveTo(0, s * 0.35);
          c.bezierCurveTo(-s, -s * 0.4, -s * 0.5, -s, 0, -s * 0.45); c.bezierCurveTo(s * 0.5, -s, s, -s * 0.4, 0, s * 0.35); c.fill();
        } else if (p.kind === 'dot') {
          c.beginPath(); c.arc(0, 0, s * 0.35, 0, 6.283); c.fill();
        } else {   // 4つ角の星
          c.beginPath();
          for (let i = 0; i < 8; i++) { const r = i % 2 ? s * 0.22 : s, a = i * Math.PI / 4; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
          c.closePath(); c.fill();
        }
        c.restore();
        alive.push(p);
      }
      this.ps = alive;
      return true;
    }
  }

  root.HudFx = { makeFlow, Sparkles };
})(typeof self !== 'undefined' ? self : this);
