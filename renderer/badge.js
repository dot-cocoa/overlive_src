(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const b = $('b'), m = $('m');
  let last = {};
  function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  // 体験版の残り時間。急に終わってびっくりしないよう、5分前と1分前に知らせる
  let noticed5 = false, noticeTimer = 0;
  function notice(text, ms) {
    const t = $('t'), name = t.querySelector('.name');
    clearTimeout(noticeTimer);
    name.textContent = text; t.classList.remove('notice'); void t.offsetWidth; t.classList.add('notice');
    noticeTimer = setTimeout(() => { name.textContent = '体験版'; t.classList.remove('notice'); }, ms);
  }
  function showTrial(left) {
    const t = $('t');
    t.hidden = false;
    $('tst').textContent = 'のこり ' + left + '分';
    t.classList.toggle('low', left <= 5);
    t.classList.toggle('last', left <= 1);
    if (left <= 5 && left > 1 && !noticed5) { noticed5 = true; notice('あと5分だよ！', 10000); }
    if (left <= 1 && !t.dataset.lastShown) { t.dataset.lastShown = '1'; notice('まもなく終了', 60000); }
  }
  function show(s) {
    if (s.key) $('key').textContent = s.key;
    if (s.menuKey) $('mkey').textContent = s.menuKey;
    b.classList.toggle('on', !!s.on); b.classList.toggle('off', !s.on);
    $('st').textContent = s.on ? 'ON' : 'OFF';
    m.classList.toggle('on', !!s.menuOn); m.classList.toggle('off', !s.menuOn);
    $('mst').textContent = s.menuOn ? 'OPEN' : 'CLOSE';
    if (s.trial) showTrial(s.trial.leftMin);
    if (last.on !== undefined && last.on !== s.on) flash(b);
    if (last.menuOn !== undefined && last.menuOn !== s.menuOn) flash(m);
    last = s;
  }
  if (window.hudApi) {
    window.hudApi.onInput((msg) => { if (msg.badge) show(msg.badge); });
    window.hudApi.query('badge').then((s) => s && show(s));
  }
})();
