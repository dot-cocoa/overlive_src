/*
 * チャットの簡易翻訳（オフライン）。ゲーム用語・略語の辞書 → 単語辞書 の順で当てる。
 * 自然な日本語ではなく「何を言っているかわかる」程度。Node でもブラウザでも動く。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HudTranslate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class Translator {
    constructor(glossary, dict) {
      this.phr = {};
      for (const [k, v] of Object.entries(glossary.phrases || {})) this.phr[norm(k)] = v;
      this.maxWords = Math.max(...Object.keys(this.phr).map(k => k.split(' ').length), 1);
      this.dict = dict || {};
    }
    /** 単語1つの訳。辞書に無ければ語尾を削って試し、それでも無ければそのまま */
    word(w) {
      if (w in this.phr) return this.phr[w];
      const d = this.dict;
      if (w in d) return d[w];
      const tries = [];
      if (w.endsWith('ing')) tries.push(w.slice(0, -3), w.slice(0, -3) + 'e', w.slice(0, -4));
      if (w.endsWith('ied')) tries.push(w.slice(0, -3) + 'y');
      if (w.endsWith('ed')) tries.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -3));
      if (w.endsWith('ies')) tries.push(w.slice(0, -3) + 'y');
      if (w.endsWith('es')) tries.push(w.slice(0, -2));
      if (w.endsWith('s')) tries.push(w.slice(0, -1));
      if (w.endsWith('er')) tries.push(w.slice(0, -2), w.slice(0, -1));
      if (w.endsWith('est')) tries.push(w.slice(0, -3));
      if (w.endsWith('ly')) tries.push(w.slice(0, -2));
      for (const t of tries) { if (t.length >= 2 && t in this.phr) return this.phr[t]; if (t.length >= 2 && t in d) return d[t]; }
      // OCR の読み違い（1文字違い）をゲーム用語・よく使う語で補う
      if (w.length >= 4) {
        for (const k of Object.keys(this.phr)) if (!k.includes(' ') && Math.abs(k.length - w.length) <= 1 && near1(k, w)) return this.phr[k];
        if (w.length >= 5) for (const k in d) if (Math.abs(k.length - w.length) <= 1 && k[1] === w[1] && near1(k, w)) return d[k];
      }
      return null;
    }
    /** OCR のよくある読み違いを直す（ty→ly、"ilove" のように I がくっつく など） */
    fixOcr(toks) {
      const out = [];
      for (const w of toks) {
        const fx = OCR_FIX[w];
        if (fx) { out.push(fx); continue; }
        if (w.length >= 4 && w[0] === 'i' && !(w in this.phr) && !(w in this.dict)) {
          const rest = w.slice(1);
          if (rest in this.phr || rest in this.dict) { out.push('i', rest); continue; }
        }
        out.push(w);
      }
      return out;
    }
    translate(text) {
      const toks = this.fixOcr(norm(text).split(' ').filter(Boolean));
      const out = [];
      let unknown = 0;
      for (let i = 0; i < toks.length;) {
        let hit = null;
        for (let n = Math.min(this.maxWords, toks.length - i); n >= 2; n--) {   // 長いフレーズから
          const key = toks.slice(i, i + n).join(' ');
          if (key in this.phr) { hit = [this.phr[key], n]; break; }
        }
        if (!hit) {
          const w = toks[i];
          if (/^\d+$/.test(w)) hit = [w, 1];
          else { const t = this.word(w); if (t === null) { unknown++; hit = [w, 1]; } else hit = [t, 1]; }
        }
        if (hit[0] && !(hit[0] === toks[i] && toks[i].length <= 2 && !/^\d+$/.test(toks[i]))) out.push(hit[0]);   // 訳せない1〜2文字は OCR のゴミとして捨てる
        i += hit[1];
      }
      return { ja: out.join(' '), unknown, words: toks.length };
    }
  }

  const OCR_FIX = { ly: 'ty', tv: 'ty', iy: 'ty', '9g': 'gg', 'qg': 'gg', 'gq': 'gg', 'ggs': 'ggs', 'thx': 'thx', 'tx': 'thx', 'nl': 'nt' };
  function near1(a, b) {   // 編集距離が1以下か
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, diff = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return diff + (a.length - i) + (b.length - j) <= 1;
  }
  function norm(s) {
    return String(s).toLowerCase()
      .replace(/[’‘`´]/g, "'")
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  /** 日本語が含まれていれば翻訳しない */
  const hasJapanese = (s) => /[぀-ヿ一-鿿]/.test(s);
  /** 英語っぽいか（OCR のゴミを除く）：英字の単語が2つ以上、または辞書語が1つ */
  function looksEnglish(s) {
    const t = norm(s).split(' ').filter(w => /^[a-z']{2,}$/.test(w));
    return t.length >= 1;
  }

  /** OCR の1行から、チャット本文の後ろに付いたゲーム画面の誤読（大きな空白の後ろ）を切る */
  function cleanLine(s) { return String(s).split(/\s{3,}|\s[|\[\]=_~—>]+\s*/)[0].trim(); }
  return { Translator, norm, hasJapanese, looksEnglish, cleanLine, near1 };
});
