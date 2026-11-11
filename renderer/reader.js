/*
 * AQUA KAWAII HUD — 画面読み取り（ゲーム画面の「見えているピクセル」だけを使う）
 *
 * ゲームのメモリやプロセスには一切触れない。画面キャプチャ（OBS と同じ仕組み）から
 * HPバー・シールドバーの小さな領域だけを読み、塗られている長さと色から値を推定する。
 *
 * 純粋関数部分（analyzeBars）と、時間変化から出来事を判定する部分（Interpreter）に分かれている。
 * どちらも Node でテストできる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HudReader = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // シールドの色 → 段数（1段 = 25）
  // 白=2段(50) 青=3段(75) 紫=4段(100) 赤=5段(125) 金=4段(100)
  const SHIELD_TIERS = [
    { name: 'white',  segments: 2, test: (h, s, v) => s < 0.16 && v > 0.82 },
    { name: 'red',    segments: 5, test: (h, s, v) => (h < 15 || h > 345) && s > 0.35 && v > 0.55 },
    { name: 'gold',   segments: 4, test: (h, s, v) => h >= 35 && h < 62 && s > 0.35 && v > 0.6 },
    // 2026-10-25：アーマーなし（降下直後など）の空のバーは灰色がかった青（例 88,130,152）で、前の基準だと青と読んでいた → 彩度・明るさを上げる（本物の青は 60,206,255 前後）
    // 2026-10-26：ワイルドカード等のバナーの青は少し緑寄り（例 77,229,241 ＝色相184）で、185 からだと段の読み（4段／5段の見分け）が外れていた → 178 から
    { name: 'blue',   segments: 3, test: (h, s, v) => h >= 178 && h < 245 && s > 0.45 && v > 0.72 },
    { name: 'purple', segments: 4, test: (h, s, v) => h >= 262 && h < 330 && s > 0.2 && v > 0.75 },
  ];

  function hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx / 255];
  }

  function classifyShield(r, g, b) {
    const [h, s, v] = hsv(r, g, b);
    for (const t of SHIELD_TIERS) if (t.test(h, s, v)) return t;
    return null;
  }
  // HP の白。HP が少ないときはバーがうっすら赤く点滅する（例 254,216,215）ので、その色も白として読む
  const isHpFill = (r, g, b) => (Math.min(r, g, b) > 215 && (Math.max(r, g, b) - Math.min(r, g, b)) < 40) || (r > 240 && g > 190 && b > 190 && r - Math.min(g, b) < 60 && Math.abs(g - b) < 20);

  /**
   * 1行分のピクセル（RGBA配列）から、左端からの「塗り」の右端を探す。
   * 区切り線や小さなノイズを越えるため、maxGap px までの途切れは許す。
   */
  function fillExtent(px, width, match, maxGap) {
    let last = -1, gap = 0;
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      if (match(px[i], px[i + 1], px[i + 2])) { last = x; gap = 0; }
      else if (last >= 0 || x > maxGap) { if (++gap > maxGap) break; }
    }
    return last + 1;   // 塗られている幅(px)
  }

  /**
   * バー領域の解析。
   * regions: { hp: {rows:[RGBA行...], width}, shield: {rows:[...], width}, armorIcon: {data, w, h} }
   * cfg: config.json の bars セクション（px は読み取り領域内の座標）
   */
  function analyzeBars(sample, cfg) {
    // HP：複数行で読んで中央値（端の斜め部分の影響を避ける）
    const hpW = sample.hp.rows.map(r => fillExtent(r, sample.hp.width, isHpFill, cfg.hp.maxGap));
    hpW.sort((a, b) => a - b);
    const hpPx = hpW[Math.floor(hpW.length / 2)];
    const hpRatio = Math.max(0, Math.min(1, hpPx / cfg.hp.fullWidth));

    // シールド：塗られている色で段数を判定
    let tier = null;
    const counts = {};
    // 2026-10-25：+1段のアイテムで増えた段は、最初「赤いしましま」になる。紫のシールドが減っているときに、
    //   この赤を数で上回って「赤アーマー（5段）」と読まないよう、赤は左の2段の中に色があるときだけ赤アーマーとみなす
    //   （本物の赤アーマーは左から埋まるので、少しでも残っていれば1段目に赤がある）
    const redLeftW = cfg.shield.segmentPitch * 2;
    let redLeft = 0;
    for (const row of sample.shield.rows) {
      for (let x = 0; x < sample.shield.width; x++) {
        const i = x * 4, t = classifyShield(row[i], row[i + 1], row[i + 2]);
        if (t) { counts[t.name] = (counts[t.name] || 0) + 1; if (t.name === 'red' && x < redLeftW) redLeft++; }
      }
    }
    if (counts.red && redLeft < cfg.shield.minPixels) delete counts.red;
    let best = 0;
    for (const t of SHIELD_TIERS) if ((counts[t.name] || 0) > best) { best = counts[t.name]; tier = t; }
    if (best < cfg.shield.minPixels) tier = null;
    let shieldPx = 0;
    if (tier) {
      const m = (r, g, b) => classifyShield(r, g, b) === tier;
      const ws = sample.shield.rows.map(r => fillExtent(r, sample.shield.width, m, cfg.shield.maxGap)).sort((a, b) => a - b);
      shieldPx = ws[Math.floor(ws.length / 2)];
    }
    const segments = tier ? tier.segments : 0;
    // 1段 = pitch px。塗りの右端は区切り線ぶん手前で終わるので endPad を足して換算
    let raw = shieldPx / cfg.shield.segmentPitch * 25;
    // 段の右端（区切り線の手前）で止まっている場合は段の満タンに合わせる
    const snap = Math.round(raw / 25) * 25;
    if (snap > raw && (snap - raw) <= cfg.shield.endPad / cfg.shield.segmentPitch * 25 + 0.5) raw = snap;
    const shieldPoints = shieldPx === 0 ? 0 : Math.max(0, Math.min(segments * 25, Math.round(raw)));

    // HUDが表示されているか（マップ・メニュー表示中は読まない）
    let hudVisible = true;
    if (sample.anchor) {
      let bright = 0;
      const d = sample.anchor.data;
      for (let i = 0; i < d.length; i += 4) if (Math.min(d[i], d[i + 1], d[i + 2]) > cfg.anchor.minValue) bright++;
      hudVisible = bright >= cfg.anchor.minPixels;
    }

    // アーマーアイコンが見つからなくても、バーが読めていれば HUD は表示中とみなす（誤って枠を消さないため）
    if (!hudVisible && (hpPx > 4 || shieldPx > 4)) hudVisible = true;
    return { hudVisible, hpRatio, hpPx, shieldTier: tier ? tier.name : 'none', shieldSegments: segments, shieldPoints, shieldPx };
  }

  /**
   * 読み取り値の時間変化から HUD への入力（patch / event）を作る。
   *
   * 誤判定対策（実機テストのフィードバックより）
   * - HP とシールドは別々に「同じ値が数フレーム続いたら確定」
   * - 小さな減少（揺れ）は被弾にしない。回復・自動充填の最中の小さな上下も無視
   * - シールドの色（段数）が変わったら「アーマー進化」とみなし、色が落ち着くまで値を保留。
   *   その後しばらくはシールドの増減で被弾・回復の演出を出さない（進化時の自動充填・光る演出対策）
   */
  class Interpreter {
    constructor(opts = {}) {
      this.stableFrames = opts.stableFrames || 3;
      this.healWindowMs = opts.healWindowMs || 1500;
      this.tierHoldMs = opts.tierHoldMs || 450;
      this.evolveGraceMs = opts.evolveGraceMs || 3000;
      this.hpMinDrop = opts.hpMinDrop ?? 2;
      this.shieldMinDrop = opts.shieldMinDrop ?? 3;
      this.noiseDuringRise = opts.noiseDuringRise ?? 10;
      this.hp = null; this.sh = null;           // 確定値
      this.hpC = { v: null, n: 0 }; this.shC = { v: null, n: 0 };
      this.tierC = null;                        // 段数変化の候補 { segs, tier, since }
      this.graceUntil = -1e9;
      this.lastRise = -1e9;
      this.healing = false;
      this.hidden = false;
    }
    _stable(c, v) { if (c.v === v) c.n++; else { c.v = v; c.n = 1; } return c.n; }

    update(reading, now) {
      const out = [];
      if (!reading.hudVisible) {
        if (!this.hidden) { this.hidden = true; out.push({ patch: { hudHidden: true } }); }
        this.hpC.n = 0; this.shC.n = 0; this.tierC = null;
        return out;
      }
      if (this.hidden) { this.hidden = false; out.push({ patch: { hudHidden: false } }); }
      // バーそのものが読めていない（HUD の目印は残っているがバーが無い＝インベントリ等の切り替え中）なら値は動かさない。
      // ここで HP 0 と読むと「ダウン」と誤判定するため
      if (reading.barsOk === false) { this.hpC.n = 0; this.shC.n = 0; return out; }
      const first = this.hp === null;
      const rising = now - this.lastRise < 500;

      // ---- HP ----
      const hp = Math.round(reading.hpRatio * 100);
      // HP 0（＝ダウン）は、ダウン中の黄色／赤の出血バーが見えているときだけ認める（白いバーの読み落としでダウン扱いにしない）
      const noKnockProof = hp === 0 && reading.knockBar === false;
      const hn = noKnockProof ? (this.hpC.n = 0) : this._stable(this.hpC, hp);
      if (!noKnockProof && (first ? hn >= this.stableFrames : (hn >= this.stableFrames && hp !== this.hp))) {
        const d = first ? 0 : hp - this.hp;
        const drop = -d;
        const small = !first && ((d < 0 && (drop < this.hpMinDrop || (rising && drop < this.noiseDuringRise))) || (d > 0 && d < this.hpMinDrop));
        if (!small || hn >= this.stableFrames * 4) {   // 小さな揺れは無視。長く続く小さな差は演出なしで値だけ合わせる
          if (d > 0 && !small) this.lastRise = now;
          this.hp = hp;
          out.push(first || small ? { patch: { hp }, silent: true } : { patch: { hp } });
        }
      }

      // ---- シールド ----
      const segs = reading.shieldSegments, val = reading.shieldPoints;
      const curSegs = this.sh ? this.sh.segs : 0;
      if (segs > 0 && curSegs > 0 && segs !== curSegs) {
        // 段数が変わった：進化（または進化演出中のちらつき）。落ち着くまで保留
        if (!this.tierC || this.tierC.segs !== segs) this.tierC = { segs, tier: reading.shieldTier, since: now };
        if (now - this.tierC.since >= this.tierHoldMs) {
          this.sh = { v: val, segs, tier: reading.shieldTier };
          this.tierC = null; this.graceUntil = now + this.evolveGraceMs;
          out.push({ event: 'shield_evolve', arg: segs });
          out.push({ patch: { shield: val, shieldSegments: segs, shieldMax: segs * 25, shieldTier: reading.shieldTier }, silent: true });
        }
      } else {
        // 2026-11-01（機能の洗い出しで発見・テスト.mp4 の 19〜22秒）：空のシールドをセルで回復していると、段数が1コマだけ「4段」と読まれることがある。
        //   段数が 0（読めない）のコマでは保留（tierC）を消していなかったので、19.7秒の1コマの「4段」が残ったまま、21.1秒の次の1コマで
        //   「0.45秒続いた」とみなし、進化の演出と 4段→2段 の戻りが出ていた → 保留中と違う段数（0 も含む）のコマが来たら保留を消す（続けて同じ段数のときだけ進化）
        if (this.tierC && segs !== this.tierC.segs) this.tierC = null;
        const key = val + '|' + segs;
        const sn = this._stable(this.shC, key);
        const cur = this.sh ? this.sh.v : null;
        if (sn >= this.stableFrames && (cur === null || val !== cur || (segs && segs !== curSegs))) {
          const d = cur === null ? 0 : val - cur, drop = -d;
          // 2026-10-25：進化（+1段のアイテムを拾った時も含む）の直後 3 秒は被弾も出さなかったため、拾ってすぐ撃たれると赤くならなかった
          //   → 増える方（自動充填・光る演出）は 3 秒、減る方（被弾）は最初の 0.8 秒だけ演出なしにする
          const inGrace = d > 0 ? now < this.graceUntil : now < this.graceUntil - this.evolveGraceMs + 800;
          const toZero = val === 0 && cur > 0;
          const small = cur !== null && !toZero && ((d < 0 && (drop < this.shieldMinDrop || (rising && drop < this.noiseDuringRise))) || (d > 0 && d < this.shieldMinDrop));
          if (!small || sn >= this.stableFrames * 4) {
            const useSegs = segs || curSegs;
            const patch = { shield: val, shieldTier: segs ? reading.shieldTier : (this.sh ? this.sh.tier : 'none') };
            if (useSegs) { patch.shieldSegments = useSegs; patch.shieldMax = useSegs * 25; }
            if (d > 0 && !inGrace && !small) this.lastRise = now;
            this.sh = { v: val, segs: useSegs, tier: patch.shieldTier };
            out.push(cur === null || inGrace || small ? { patch, silent: true } : { patch });
          }
        }
      }

      // ---- 回復中：直近 healWindowMs 以内に値が増えていれば回復中 ----
      const healingNow = now - this.lastRise < this.healWindowMs;
      if (healingNow !== this.healing) {
        this.healing = healingNow;
        out.push({ event: healingNow ? 'heal_start' : 'heal_stop' });
      }
      return out;
    }
  }

  /** 味方バナー：名前の白い文字を「いる」目印にして analyzeBars と同じ読み方をする */
  function analyzeMate(sample, cfg) {
    return analyzeBars({ hp: sample.hp, shield: sample.shield, anchor: sample.name }, { hp: cfg.hp, shield: cfg.shield, anchor: cfg.name });
  }

  /** のぞき穴の色：ゲーム側の表示（白っぽい線・赤いノックダウンシールド）があるか */
  function peekHit(r, g, b, test, T) {
    if (test === 'red') return r >= T.red.minR && g <= T.red.maxG && b <= T.red.maxB;
    // 2026-10-29（ユーザー指摘・録画 01.47.09）：戦術の右の「回数」の窓（aqua2）は明るさだけで見ていたので、ミラージュ（回数1つ・ゲームの欄が短い）だと
    //   窓から明るい床（196,191,188）が見えて開いていた。ゲームの回数の印は色がはっきり（例 255,191,0）→ 彩度 0.5 以上の明るい色だけ
    if (test === 'vivid') { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx >= 150 && (mx - mn) / mx >= 0.5; }
    const mx = Math.max(r, g, b), luma = 0.299 * r + 0.587 * g + 0.114 * b;
    return mx >= T.bright.minMax && luma >= T.bright.minLuma;
  }
  function peekShown(pixels, peek, T) {
    // 2026-10-24：アイテムの四角。明るさだけだと明るい地面や壁でも開いてしまったので、
    // 「真ん中の点が白いアイコン」かつ「ふちの点がアイテムの色（紫・青・金など、色の濃いもの）」のときだけ開ける
    if (peek.test === 'item') {
      // 2026-10-25：シールドのアップグレードのアイテム（紫の四角に薄紫の ⇧）は、記号が真っ白ではなく（例 161,165,190）開かなかった。
      //   ①真ん中の記号が明るい（白〜薄い色）＋まわりがアイテムの色　または　②まわりの2点がどちらも同じ色味のアイテムの色（濃い背景を通した景色は暗いので通らない）
      const t = (T && T.item) || {}, gi = peek.glyph != null ? peek.glyph : 1, g = pixels[gi];
      if (!g) return false;
      const hsv = (p) => { const mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]), d = mx - mn; let h = 0;
        if (d) { if (mx === p[0]) h = ((p[1] - p[2]) / d) % 6; else if (mx === p[1]) h = (p[2] - p[0]) / d + 2; else h = (p[0] - p[1]) / d + 4; h *= 60; if (h < 0) h += 360; }
        return [h, mx ? d / mx : 0, mx / 255]; };
      // 2026-10-28（ユーザー指摘・録画 23.39.11）：グレネード・テルミットのダメージで、ふた越しの穴が白っぽいピンク〜赤（例 189,146,159：色相 340・彩度 0.23）になり、
      //   「白い記号＋色のついたふち」と見まちがえてアイテムのふたが何度か開いていた。
      //   → 赤〜ピンクの色味（色相 330〜20）は、はっきり濃い（彩度 0.45 以上）ときだけアイテムの色とみなす
      const reddish = (h) => h >= 330 || h <= 20;
      const colored = (p, sMin, vMin) => { const [h, sat, v] = hsv(p); return sat >= Math.max(sMin, reddish(h) ? 0.45 : 0) && v >= vMin; };
      const others = pixels.filter((_, i) => i !== gi);
      const gmn = Math.min(g[0], g[1], g[2]), gmx = Math.max(g[0], g[1], g[2]);
      const glyphOk = gmn >= (t.glyphMin || 140) && gmx - gmn <= (t.glyphSpread || 60);
      if (glyphOk && others.filter(p => colored(p, t.minSat || 0.22, t.minV || 0.45)).length >= (peek.min || 1)) return true;
      const bg = others.filter(p => colored(p, t.bgSat || 0.3, t.bgV || 0.55));
      if (bg.length >= 2) { const hs = bg.map(p => hsv(p)[0]); const dh = Math.abs(hs[0] - hs[1]); if (Math.min(dh, 360 - dh) <= 30) return true; }
      return false;
    }
    let n = 0;
    for (const p of pixels) if (peekHit(p[0], p[1], p[2], peek.test, T)) n++;
    return n >= (peek.min || 1);
  }

  /**
   * のぞき穴の判定を安定させる。見えたらすぐ開け（openFrames 回続けば）、
   * 見えなくなってもしばらく（closeMs）は開けたまま＝ゲームの表示をふたで隠す誤りを起こしにくくする
   */
  class PeekFilter {
    constructor(opts = {}) { this.openFrames = opts.openFrames || 5; this.closeMs = opts.closeMs || 1500; this.s = {}; }
    update(id, shown, now, opts) {
      const openFrames = (opts && opts.openFrames != null) ? opts.openFrames : this.openFrames, closeMs = (opts && opts.closeMs != null) ? opts.closeMs : this.closeMs;   // 0 も有効な値として扱う
      let s = this.s[id];
      if (!s) { s = this.s[id] = { v: true, n: 0, since: now }; }   // 最初は開けておく
      if (shown) { s.n++; s.since = now; if (!s.v && s.n >= openFrames) { s.v = true; return true; } }
      else { s.n = 0; if (s.v && now - s.since >= closeMs) { s.v = false; return false; } }
      return null;   // 変化なし
    }
  }

  return { analyzeBars, analyzeMate, peekShown, peekHit, PeekFilter, Interpreter, classifyShield, fillExtent, isHpFill, SHIELD_TIERS };
});
