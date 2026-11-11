/*
 * グレード（体験版／通常版／カスタム版／管理用）ごとの機能の違い。
 * どのグレードかは同じフォルダの edition.json（{"edition":"standard"}）で決める。組み立て時に書き込む。
 * 中身のプログラムは全グレード共通。ここで「使える機能」だけを切り替える。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ALL_PARTS = ['girl', 'name', 'player', 'mates', 'minimap', 'compass', 'item', 'tactical', 'ult', 'weapon'];
const FACES8 = ['normal', 'hit', 'shield_break', 'hp_low', 'healing', 'full_heal', 'kill', 'knockdown'];

const EDITIONS = {
  trial: {
    id: 'trial', label: '体験版', title: 'OverLIVE 体験版', appId: 'aqua-kawaii-hud-trial',
    characters: ['aqua'],            // AQUA だけ
    parts: ['girl', 'name', 'player'],   // プレイヤー枠だけ（味方・ミニマップ・アイテム等は出さない）
    // 表情は3種（通常・被弾・回復）。ほかの表情のときは近いものを出す
    // 2026-10-24：被弾の絵は通常との差が小さく気づきにくかったので、被弾には口の開いた「シールド破壊」の絵を使う
    faces: { normal: 'normal', hit: 'shield_break', healing: 'healing', shield_break: 'shield_break', knockdown: 'shield_break', hp_low: 'normal', full_heal: 'healing', kill: 'normal' },
    timeLimitMin: 1440, mark: true,
    noChara: false, ornament: false, colors: false, myChara: false, background: false,
    // 2026-11-01（ユーザー決定）：キャラのキラキラ（キル・全回復のハート・回復中の粒など）を体験版にも入れる。
    //   画面全体の優勝の演出（輪・紙吹雪・肉球）も「おまけ」として体験版に残す（playFullFx はグレードで制限しない）
    sparkles: true, test: false, api: false, updateCheck: false, obs: false,
  },
  standard: {
    id: 'standard', label: '通常版', title: 'OverLIVE', appId: 'aqua-kawaii-hud',
    characters: 'builtin', parts: ALL_PARTS, faces: null,
    timeLimitMin: 0, mark: false,
    noChara: true, ornament: true, colors: false, myChara: false, background: false,
    sparkles: true, test: false, api: false, updateCheck: true, obs: true,
  },
  custom: {
    id: 'custom', label: 'カスタム版', title: 'OverLIVE カスタム版', appId: 'aqua-kawaii-hud-custom',
    characters: 'builtin', parts: ALL_PARTS, faces: null,
    timeLimitMin: 0, mark: false,
    noChara: true, ornament: true, colors: true, myChara: true, background: true,
    sparkles: true, test: false, api: false, updateCheck: true, obs: true,
  },
  admin: {
    id: 'admin', label: '管理用', title: 'OverLIVE 管理用', appId: 'aqua-kawaii-hud-admin',
    characters: 'builtin', parts: ALL_PARTS, faces: null,
    timeLimitMin: 0, mark: false,
    noChara: true, ornament: true, colors: true, myChara: true, background: true,
    sparkles: true, test: true, api: true, updateCheck: true, obs: true,
    // 確認用：起動オプション --as=trial / --as=standard / --as=custom で、ほかのグレードの見え方を試せる
  },
};

const crypto = require('crypto');
const K = ['kfw', 'aqua', 'hud', '2026', 'frame'].join(':');
function sign(id) { return crypto.createHmac('sha256', K).update('edition:' + id).digest('hex').slice(0, 24); }

function load(dir, argv = []) {
  // edition.json が無い・書き換えられている（しるしが合わない）ときは、一番制限の強い体験版として動かす
  let id = 'trial';
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'edition.json'), 'utf8'));
    if (EDITIONS[j.edition] && j.sig === sign(j.edition)) id = j.edition;
  } catch { /* 無ければ体験版 */ }
  // 管理用だけ、ほかのグレードの見え方を試せる
  const as = (argv.find(s => s.startsWith('--as=')) || '').slice(5);
  if (id === 'admin' && EDITIONS[as]) return Object.assign({}, EDITIONS[as], { previewOf: as });
  return EDITIONS[id];
}

module.exports = { load, sign, EDITIONS, ALL_PARTS, FACES8 };
