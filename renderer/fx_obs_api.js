// fx_obs.html 用：アプリの窓（hudApi）の代わりに、配信用サーバー（/obs/events?chara=1）からお祝いの合図を受け取る（2026-10-30）
(function () {
  'use strict';
  let cb = null;
  window.hudApi = { onInput: (f) => { cb = f; }, send: () => {} };
  function connect() {
    const es = new EventSource('/obs/events?chara=1');
    es.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.fxFull && cb) cb(m); } catch { /* 読めない行は捨てる */ } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  connect();
  // 配信用の窓の大きさを変えたとき、お祝いの絵を描く面も合わせる
  window.addEventListener('resize', () => { const c = document.getElementById('c'); if (c) { c.width = window.innerWidth; c.height = window.innerHeight; } });
})();
