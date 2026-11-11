// コメントの読み上げ（2026-10-31）。見えない窓で、Windows に入っている声（speechSynthesis）を使って読む。
// ゲームには触らない。読む文はこのパソコンの中だけで扱い、どこにも送らない
'use strict';
(function () {
  const api = window.hudApi;
  const syn = window.speechSynthesis;
  let cfg = { on: false, voice: '', volume: 80, rate: 1.1, name: false, maxLen: 40, ng: '' };
  const queue = [];
  let speaking = false;
  function voiceList() { return syn.getVoices(); }
  function sendVoices() {
    const vs = voiceList();
    if (!vs.length) return;
    // 日本語の声を先に
    const names = vs.slice().sort((a, b) => (/^ja/i.test(b.lang) ? 1 : 0) - (/^ja/i.test(a.lang) ? 1 : 0)).map(v => v.name);
    api && api.send({ speakVoices: names });
  }
  syn.onvoiceschanged = sendVoices; setTimeout(sendVoices, 300); setTimeout(sendVoices, 2000);
  function pickVoice() {
    const vs = voiceList();
    return vs.find(v => v.name === cfg.voice) || vs.find(v => /^ja/i.test(v.lang)) || null;
  }
  // 読む文を整える：URL を省く・同じ文字の連続を短く・「www」を「わら」・長すぎるものは切る
  function clean(t) {
    t = String(t || '').replace(/https?:\/\/\S+/gi, 'URL省略');
    t = t.replace(/[wｗＷ]{3,}/g, 'わらわら').replace(/(.)\1{4,}/g, '$1$1$1');
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > cfg.maxLen) t = t.slice(0, cfg.maxLen) + '、以下略';
    return t;
  }
  function blocked(c) {
    const words = cfg.ng.split(/[,、\n]/).map(s => s.trim()).filter(Boolean);
    const all = `${c.name || ''} ${c.text || ''}`;
    return words.some(w => all.includes(w));
  }
  function line(c) {
    const body = clean(c.text);
    const nm = clean(c.name).slice(0, 16);
    if (c.gift) return `${nm || 'だれか'}さん、${c.giftText || 'ギフト'}ありがとう${body ? '。' + body : ''}`;
    if (!body) return '';
    return cfg.name && nm ? `${nm}さん、${body}` : body;
  }
  function next() {
    if (speaking || !queue.length) return;
    const text = queue.shift();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'ja-JP';
    u.volume = Math.max(0, Math.min(1, cfg.volume / 100)); u.rate = cfg.rate;
    speaking = true;
    const done = () => { speaking = false; setTimeout(next, 150); };
    u.onend = done; u.onerror = done;
    syn.speak(u);
    setTimeout(() => { if (speaking && !syn.speaking) done(); }, 30000);   // 念のため
  }
  // 2026-11-01（ユーザー決定）：届いた順に読み、追いつかない分だけ飛ばす。
  //   前は10件が一度に届くと、読み上げが空いていても最後の4件だけを読み、最初の6件を飛ばしていた
  //   → 空いていればすぐ1件目を読み始め、待ちが4件を超える分（あとから来たもの）だけ読まない
  const MAX_WAIT = 4;
  function add(list, force) {
    if (!cfg.on && !force) return;
    for (const c of list) {
      if (!force && blocked(c)) continue;
      const t = line(c); if (!t) continue;
      if (queue.length >= MAX_WAIT) continue;   // 追いつかない分は読まない
      queue.push(t);
      next();
    }
  }
  api && api.onInput((m) => {
    if (m.speakCfg) { cfg = { ...cfg, ...m.speakCfg }; if (!cfg.on) { queue.length = 0; syn.cancel(); speaking = false; } }
    if (m.speakStop) { queue.length = 0; syn.cancel(); speaking = false; }
    if (Array.isArray(m.speak)) add(m.speak, !!m.test);
  });
})();
