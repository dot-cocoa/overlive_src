// 配信用ページ（OBS・配信用の窓）にだけ、チャンピオンのお祝い（自分の画面の全画面演出と同じもの）を重ねる（2026-10-30）
// 中身は fx_obs.html。ゲームの HUD が消えている間（優勝の帯の上）にも出るよう、枠（#stage）の外に置く
(function () {
  if (new URLSearchParams(location.search).get('part') !== 'obs') return;
  const f = document.createElement('iframe');
  f.src = 'fx_obs.html'; f.title = 'fx'; f.setAttribute('allowtransparency', 'true');
  f.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;z-index:99999;color-scheme:normal';
  document.body.appendChild(f);
})();
