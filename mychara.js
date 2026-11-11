/*
 * マイキャラ（購入者が自分の画像で使うキャラ）
 * ドキュメント\OverLIVE\マイキャラ\ に画像を置くと、起動時・メニューを開いたときに自動で読み込む。
 *   - フォルダごとに1キャラ（フォルダ名がキャラ名）。マイキャラ直下に置いた画像は「マイキャラ」1人分。
 *   - ファイル名で表情を判別（通常.png / normal.png / face_normal.png など）。判別できない画像は「通常」に使う。
 *   - 画像が1枚だけなら全部の表情にその1枚を使う。足りない表情は「通常」で代用（main.js 側）。
 *   - full.png / 全身.png があれば、チャンピオンのときに全身絵のカットインを出す。
 * 画像は 200:185 の比率に自動で切り抜き（上寄せ・左右中央）、data URL にして HUD へ渡す。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const EXTS = ['.png', '.jpg', '.jpeg'];
// 表情の名前（ファイル名の別名）。小文字・空白なしで比較する
const ALIASES = {
  normal: ['normal', '通常', 'ふつう', '普通', 'default', 'icon', 'アイコン'],
  hit: ['hit', '被弾', 'ダメージ', 'damage'],
  shield_break: ['shield_break', 'shieldbreak', 'シールド破壊', 'シールドブレイク', 'びっくり', 'surprise'],
  hp_low: ['hp_low', 'hplow', 'low', 'HP低下', 'ピンチ', '困り'],
  healing: ['healing', 'heal', '回復中', '回復'],
  full_heal: ['full_heal', 'fullheal', '全回復', 'えがお', '笑顔', 'smile'],
  kill: ['kill', 'キル', 'ウインク', 'wink'],
  knockdown: ['knockdown', 'knock', 'down', 'ダウン', '泣き', 'cry'],
  champion: ['champion', 'win', 'チャンピオン', '優勝', '大笑い'],
  full: ['full', 'fullbody', '全身', 'cutin', 'カットイン', 'tachie', '立ち絵'],
};
const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/^face_/, '');
const ALIAS_MAP = {};
for (const [k, list] of Object.entries(ALIASES)) for (const a of list) ALIAS_MAP[norm(a)] = k;

/** ファイル名 → 表情キー（判別できなければ null） */
function keyOf(file) {
  const base = norm(path.basename(file, path.extname(file)));
  if (ALIAS_MAP[base]) return ALIAS_MAP[base];
  // 「01_通常」「mikan-hit」なども拾う。英字は区切られた単語ごと（yellow → low のような誤判定を防ぐ）、日本語は部分一致
  for (const t of base.split(/[^a-z0-9]+/)) if (t && ALIAS_MAP[t]) return ALIAS_MAP[t];
  for (const [a, k] of Object.entries(ALIAS_MAP)) if (/[^\x00-\x7f]/.test(a) && a.length >= 2 && base.includes(a)) return k;
  return null;
}

/** 表情用の切り抜き範囲（比率 200:185、左右中央・上寄せ） */
function cropRect(W, H, aspect = 200 / 185) {
  if (W / H > aspect) { const w = Math.round(H * aspect); return { x: Math.round((W - w) / 2), y: 0, width: w, height: H }; }
  const h = Math.round(W / aspect);
  return { x: 0, y: Math.round((H - h) * 0.1), width: W, height: h };
}

/** フォルダの画像を表情キーごとに振り分ける（純粋関数：ファイル名の配列 → {key: file}） */
function assign(files) {
  const out = {}, rest = [];
  for (const f of files.slice().sort()) { const k = keyOf(f); if (k && !out[k]) out[k] = f; else rest.push(f); }
  if (!out.normal && rest.length) out.normal = rest.shift();   // 判別できない画像は「通常」に
  return out;
}

const GUIDE = `OverLIVE ─ マイキャラの置き方
================================

このフォルダに画像を置くと、HUD のキャラ画像として自動で使えます。
（メニューを開くか、「再読み込み」を押すと反映されます）

■ いちばん簡単な使い方
  好きな画像を1枚、このフォルダに置くだけ。全部の表情にその画像が使われます。

■ 表情を出し分けたいとき
  フォルダを作って（フォルダ名がキャラ名になります）、中に次の名前で画像を置きます。
  足りない表情は「通常」で代わりに表示します。

    通常.png        … いつもの顔（必須）
    被弾.png        … ダメージを受けたとき
    シールド破壊.png … シールドが割れたとき
    HP低下.png      … 体力が少ないとき
    回復.png        … 回復したとき（回復中.png でも OK）
    全回復.png      … 全回復したとき
    キル.png        … キルしたとき
    ダウン.png      … ダウンしたとき

  英語の名前（normal / hit / shield_break / hp_low / healing / full_heal / kill / knockdown）でも OK です。

■ 画像について
  ・PNG / JPG が使えます。背景が透明な PNG がおすすめです。
  ・正方形に近い「顔〜胸元」の画像がきれいに収まります（自動で上寄せに切り抜きます）。
  ・ご自身に権利のある画像（自作・依頼して利用許諾を得たもの など）をお使いください。

例）
  マイキャラ\
    ├ ここに1枚置くだけでもOK.png
    └ みかん\
        ├ 通常.png
        ├ 被弾.png
        └ 回復.png
`;

/**
 * マイキャラを読み込む。nativeImage は Electron のもの（テストでは差し替え可能）
 * 戻り値: { [id]: { id, displayName, faces:{key:dataURL}, frames:null, theme:null, art:dataURL|null, custom:true } }
 */
function scan(dir, nativeImage, cache = new Map()) {
  const out = {};
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const guide = path.join(dir, 'はじめにお読みください.txt');
    if (!fs.existsSync(guide)) fs.writeFileSync(guide, '﻿' + GUIDE.replace(/\n/g, '\r\n'));
  } catch { return out; }
  const isImg = (f) => EXTS.includes(path.extname(f).toLowerCase());
  const groups = [];
  let rootImgs = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const p = path.join(dir, e.name);
      const imgs = fs.readdirSync(p).filter(isImg).map(f => path.join(p, f));
      if (imgs.length) groups.push({ name: e.name, imgs });
    } else if (isImg(e.name)) rootImgs.push(path.join(dir, e.name));
  }
  if (rootImgs.length) groups.unshift({ name: 'マイキャラ', imgs: rootImgs });
  const load = (file, kind) => {
    let st; try { st = fs.statSync(file); } catch { return null; }
    const ck = `${file}|${st.mtimeMs}|${kind}`;
    if (cache.has(ck)) return cache.get(ck);
    let url = null;
    try {
      let im = nativeImage.createFromPath(file);
      if (!im.isEmpty()) {
        const { width: W, height: H } = im.getSize();
        if (kind === 'face') { im = im.crop(cropRect(W, H)).resize({ width: 400, height: 370, quality: 'best' }); }
        else if (H > 1400) im = im.resize({ height: 1400, quality: 'best' });
        url = im.toDataURL();
      }
    } catch { url = null; }
    cache.set(ck, url);
    return url;
  };
  for (const g of groups) {
    const a = assign(g.imgs);
    const faces = {};
    for (const [k, f] of Object.entries(a)) if (k !== 'full' && k !== 'champion') { const u = load(f, 'face'); if (u) faces[k] = u; }
    if (!faces.normal) { const k0 = Object.keys(faces)[0]; if (!k0) continue; faces.normal = faces[k0]; }
    for (const k of ['hit', 'shield_break', 'hp_low', 'healing', 'full_heal', 'kill', 'knockdown']) if (!faces[k]) faces[k] = faces.normal;
    const id = 'my:' + g.name;
    out[id] = { id, displayName: g.name, faces, frames: null, theme: { motif: 'plain' }, art: a.full ? load(a.full, 'art') : null, custom: true };
  }
  return out;
}

module.exports = { scan, keyOf, assign, cropRect, ALIASES };
