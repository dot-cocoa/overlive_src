/*
 * AQUA KAWAII HUD — 状態モデル（描画から独立。Node でもブラウザでも動く）
 * 値の入力はすべて applyPatch / applyEvent 経由。描画側は derive() の結果だけを見る。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HudModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 表情の優先度と表示時間（ms）。persistent は条件が続く間ずっと表示。
  const EXPRESSIONS = {
    knockdown:    { priority: 80, persistent: true },
    kill:         { priority: 70, duration: 2500 },
    shield_break: { priority: 60, duration: 2200 },
    hit:          { priority: 50, duration: 1600 },   // 2026-10-25：リングの中など続けて削られるとき、通常の顔と交互にちらつかないよう長めに（900→1600）
    full_heal:    { priority: 40, duration: 2000 },
    healing:      { priority: 30, persistent: true },
    hp_low:       { priority: 20, persistent: true },
    normal:       { priority: 0,  persistent: true },
  };
  const EXPRESSION_KEYS = Object.keys(EXPRESSIONS);

  // パネル装飾パターン（下段見本の4種）
  const PANEL_DURATION = { hit: 900, shield_break: 2200 };   // 2026-10-24：シールド破壊は長めに（1600→2200）

  const HP_LOW_RATIO = 0.35;

  function initialState() {
    // 基準画像の表示内容と同じ初期値
    return {
      hp: 78, hpMax: 100,
      shield: 125, shieldMax: 125, shieldSegments: 5,
      healing: false,
      knocked: false,
      champion: false,
      squadNumber: 3,
      items: { count: 4 },
      tactical: { cooldown: 0, cooldownMax: 20, override: null },
      ult: { charge: 95, override: null },
      weapon: {
        active: 1,
        slots: [
          { name: 'R-301', mag: 25, reserve: Infinity },
          { name: 'R-99', mag: 20, reserve: Infinity },
        ],
      },
      minimap: { ring: false, combat: false },
      hudHidden: false,      // ゲーム側のHUDが見えない（マップ・メニュー表示中など）
      // 味方（上段・下段のバナー）。present=false のバナーは枠ごと隠す（デュオで上段が空く場合など）
      mates: [newMate(), newMate()],
      // 水色の窓：ゲーム側に表示があるか（のぞき穴の読み取り結果）。false の窓はふたで閉じる
      shown: {},
      // 一時演出（開始時刻 ms）
      transient: {},
    };
  }

  function newMate() {
    return { present: true, hp: 100, shield: 0, shieldSegments: 3, healing: false, knocked: false, transient: {} };
  }

  /** 味方バナーの値の更新（Interpreter の出力をそのまま渡す）。被弾・シールド破壊・回復を判定 */
  function applyMate(state, i, msg, now) {
    const m = state.mates[i]; if (!m) return state;
    if (msg.event === 'heal_start') m.healing = true;
    else if (msg.event === 'heal_stop') m.healing = false;
    const p = msg.patch; if (!p) return state;
    if ('hudHidden' in p) { m.present = !p.hudHidden; if (!m.present) m.transient = {}; }
    const prev = { hp: m.hp, shield: m.shield };
    if ('hp' in p) m.hp = clamp(+p.hp || 0, 0, 100);
    if ('shield' in p) m.shield = Math.max(0, +p.shield || 0);
    if (p.shieldSegments) m.shieldSegments = p.shieldSegments;
    if ('hp' in p) m.knocked = m.hp === 0;
    if (msg.silent) return state;
    if (m.hp + m.shield < prev.hp + prev.shield && !(m.hp === 0 && prev.hp === 0)) m.transient.hit = now;
    if (prev.shield > 0 && m.shield === 0) m.transient.shield_break = now;
    return state;
  }

  function deriveMate(m, now) {
    if (!m.present) return { visible: false, panel: 'normal', shieldSegments: m.shieldSegments };
    let panel = 'normal';
    if (m.knocked) panel = 'down';
    else if (m.healing) panel = 'healing';
    // 2026-10-25（ユーザー決定）：シールドが割れたときは、被弾の赤より紫を優先（割れた瞬間から紫を光らせる）
    if (active(m.transient, 'hit', now, PANEL_DURATION.hit)) panel = 'hit';
    if (active(m.transient, 'shield_break', now, PANEL_DURATION.shield_break)) panel = 'shield_break';
    return { visible: true, panel, shieldSegments: m.shieldSegments };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function deepMerge(dst, src) {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (Array.isArray(v)) {
        if (!Array.isArray(dst[k])) dst[k] = [];
        v.forEach((item, i) => {
          if (item && typeof item === 'object') dst[k][i] = deepMerge(dst[k][i] || {}, item);
          else dst[k][i] = item;
        });
      } else if (v && typeof v === 'object') {
        dst[k] = deepMerge(dst[k] && typeof dst[k] === 'object' ? dst[k] : {}, v);
      } else {
        dst[k] = v;
      }
    }
    return dst;
  }

  function normalize(s) {
    s.hp = clamp(+s.hp || 0, 0, s.hpMax);
    s.shield = clamp(+s.shield || 0, 0, s.shieldMax);
    s.ult.charge = clamp(+s.ult.charge || 0, 0, 100);
    s.tactical.cooldown = Math.max(0, +s.tactical.cooldown || 0);
    s.items.count = Math.max(0, Math.floor(+s.items.count || 0));
    s.weapon.active = s.weapon.active === 2 ? 2 : 1;
    for (const w of s.weapon.slots) {
      if (w.reserve === null || w.reserve === 'inf' || w.reserve === '∞') w.reserve = Infinity;
      w.mag = Math.max(0, Math.floor(+w.mag || 0));
    }
    return s;
  }

  /**
   * 値の更新。前後の差分から演出イベントを自動発火する
   * （被弾・シールド破壊・全回復・ダウン など）。
   */
  function applyPatch(state, patch, now, opts) {
    const prev = JSON.parse(JSON.stringify(state, (k, v) => (v === Infinity ? '∞' : v)));
    deepMerge(state, patch);
    normalize(state);
    // ダウン／復帰の「状態」は、演出なし（silent）の更新でも必ず合わせる。
    // 2026-10-25：リスポーンで HUD が出直した直後の 1 秒は更新が silent になるため、HP 0→100 でもダウン扱いが解けず、
    //   生き返ってから被弾するまで赤い枠のままだった。逆に、ダウンの瞬間に HUD が一瞬消えると HP 0 が silent になり、ダウンの枠にならなかった
    if ('hp' in patch) {
      if (prev.hp > 0 && state.hp === 0) { state.knocked = true; state.healing = false; }
      else if ((prev.knocked || state.knocked) && state.hp >= 5) state.knocked = false;   // ダウン中の黄色いバーの揺れ（0〜1）では復帰しない
    }
    if (opts && opts.silent) return state;   // 最初の読み取りなど：値だけ合わせ、演出は出さない
    const t = state.transient;
    const prevTotal = (+prev.hp) + (+prev.shield);
    const total = state.hp + state.shield;
    if (total < prevTotal) t.hit = now;
    if (prev.shield > 0 && state.shield === 0) t.shield_break = now;
    if (prev.hp < prev.hpMax && state.hp === state.hpMax) t.full_heal = now;
    // 2026-10-25（ユーザー決定）：シールドが満タンになったときも、シールドの色のハートを出す
    if (state.shieldMax > 0 && prev.shield < state.shieldMax && state.shield === state.shieldMax && prev.shield > 0) t.full_shield = now;
    // 画面読み取りで HP が 0 になったらダウン、0 から戻ったら蘇生（上で silent より前に処理済み）
    if (prev.tactical && prev.tactical.cooldown > 0 && state.tactical.cooldown === 0) t.tactical_ready = now;
    return state;
  }

  /** 明示イベント（キル、アビリティ使用 等）。 */
  function applyEvent(state, type, now, arg) {
    const t = state.transient;
    switch (type) {
      case 'damage': {
        const amt = Math.max(0, +arg || 25);
        const fromShield = Math.min(state.shield, amt);
        applyPatch(state, { shield: state.shield - fromShield, hp: state.hp - (amt - fromShield) }, now);
        if (state.hp === 0) state.knocked = true;
        break;
      }
      case 'kill': t.kill = now; break;
      case 'shield_evolve': t.shield_evolve = now; break;   // アーマー進化（演出は今のところなし）
      case 'knock': state.knocked = true; state.healing = false; break;
      case 'revive': state.knocked = false; applyPatch(state, { hp: Math.max(state.hp, 20) }, now); break;
      case 'champion': state.champion = true; break;
      case 'heal_start': state.healing = true; break;
      case 'heal_stop': state.healing = false; break;
      case 'use_tactical':
        if (state.tactical.cooldown === 0) { t.tactical_active = now; state.tactical.cooldown = state.tactical.cooldownMax; }
        break;
      case 'use_ult':
        if (state.ult.charge >= 100) { t.ult_active = now; state.ult.charge = 0; }
        break;
      case 'fire': {
        const w = state.weapon.slots[state.weapon.active - 1];
        if (w.mag > 0) w.mag -= 1;
        break;
      }
      case 'reload': {
        const w = state.weapon.slots[state.weapon.active - 1];
        w.mag = +arg || w.magSize || 25;
        break;
      }
      case 'swap': state.weapon.active = state.weapon.active === 1 ? 2 : 1; break;
      case 'reset': {
        const fresh = initialState();
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, fresh);
        break;
      }
      default: break;
    }
    return state;
  }

  /** 時間経過（クールダウン減少など）。dt 秒。 */
  function tick(state, dt, now) {
    if (state.tactical.cooldown > 0) {
      const before = state.tactical.cooldown;
      state.tactical.cooldown = Math.max(0, before - dt);
      if (state.tactical.cooldown === 0) state.transient.tactical_ready = now;
    }
    return state;
  }

  function active(t, key, now, dur) { return t[key] != null && now - t[key] < dur; }

  /** 描画に必要な派生値。純関数。 */
  function derive(state, now) {
    const t = state.transient;
    const hpRatio = state.hp / state.hpMax;

    // 表情：条件を満たすもののうち優先度最大
    const cands = [];
    // チャンピオン表情は使わない（優勝画面ではゲームのUIが消え、HUD も隠れるため）
    if (state.knocked) cands.push('knockdown');
    for (const k of ['kill', 'shield_break', 'hit', 'full_heal']) {
      if (active(t, k, now, EXPRESSIONS[k].duration)) cands.push(k);
    }
    if (state.healing) cands.push('healing');
    if (hpRatio <= HP_LOW_RATIO) cands.push('hp_low');
    cands.push('normal');
    cands.sort((a, b) => EXPRESSIONS[b].priority - EXPRESSIONS[a].priority);
    const expression = cands[0];

    // パネル：シールド破壊(紫) > 被弾(赤点滅) > 回復中(緑) > 通常
    let panel = 'normal';
    if (state.healing) panel = 'healing';
    // 2026-10-25（ユーザー決定）：シールドが割れたときは、被弾の赤より紫を優先（割れた瞬間から紫を光らせる）
    if (active(t, 'hit', now, PANEL_DURATION.hit)) panel = 'hit';
    if (active(t, 'shield_break', now, PANEL_DURATION.shield_break)) panel = 'shield_break';

    // シールド：セグメントごとの充填率
    const segSize = state.shieldMax / state.shieldSegments;
    const shieldSegs = [];
    for (let i = 0; i < state.shieldSegments; i++) {
      shieldSegs.push(clamp((state.shield - i * segSize) / segSize, 0, 1));
    }

    const tac = state.tactical;
    let tacticalState = tac.cooldown > 0 ? 'cooldown' : 'normal';
    if (active(t, 'tactical_ready', now, 1200)) tacticalState = 'ready';
    if (active(t, 'tactical_active', now, 700)) tacticalState = 'active';
    if (tac.override) tacticalState = tac.override;

    let ultState = state.ult.charge >= 100 ? 'ready' : 'normal';
    if (active(t, 'ult_active', now, 900)) ultState = 'active';
    if (state.ult.override) ultState = state.ult.override;

    const w = state.weapon;
    const cur = w.slots[w.active - 1];

    return {
      expression,
      panel,
      hpRatio,
      shieldSegs,
      tacticalState,
      ultState,
      ultText: Math.floor(state.ult.charge) + '%',
      itemCount: String(state.items.count),
      ammoMag: String(cur.mag),
      ammoReserve: cur.reserve === Infinity ? '∞' : String(cur.reserve),
      weaponNames: [w.slots[0].name, w.slots[1].name],
      weaponActive: w.active,
      minimap: state.minimap.ring ? 'ring' : (state.minimap.combat ? 'combat' : 'normal'),
      squadNumber: state.squadNumber,
      hudHidden: !!state.hudHidden,
      knocked: !!state.knocked,
      shieldSegments: state.shieldSegments,
      fullShieldAt: t.full_shield || 0,
      shieldTier: state.shieldTier || 'none',
      mates: state.mates.map(m => deriveMate(m, now)),
      shown: state.shown,
    };
  }

  return { initialState, applyPatch, applyEvent, applyMate, tick, derive, EXPRESSIONS, EXPRESSION_KEYS, HP_LOW_RATIO };
});
