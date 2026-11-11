/*
 * キル・アシスト・味方のキル（ランクのチームポイント）・ウルトの読み取り（2026-11-02）。reader.worker.js から importScripts で読み込む。
 * 試作（Python）：scratchpad/killproto/kp3.py・ultproto/up2.py。詳しい記録はプロジェクトの kill-detection.md・ult-detection.md
 *
 * ■ キル：画面右上「部隊残存」の下の欄の白い数字（キル／アシスト／（ランクだけ）チームポイント／ダメージ）
 *   - カジュアル・ボットマッチは3つ、ランクは4つ並び。ランクは欄が左に約80pxずれ、キル・アシストの数字が大きい → 読む範囲を広くとる
 *   - 数字は、実際の録画から切り出した見本（白黒 14×22）と照合（±1px ずらして一番近いもの）。2番目と差がないときは「読めない」
 *   - 0.5秒同じなら確定。最初の基準は1秒同じとき。基準より小さい値が2秒続いたら基準の読み違い（または新しい試合）として黙って直す
 *   - 増えたら kill（一度に4以上は2秒待つ）／アシストだけ増えたら assist。減った・一瞬だけ変わったは無視
 * ■ 味方のキル（ランクのチームポイント）：3つ目の欄は白い地に黒い小さな数字。見本がまだ「0」しかないので、
 *   値ではなく「数字の形が変わって1秒そのまま」で team_kill（欄が赤く点滅して地が白くないときは見ない）
 * ■ ウルト：画面下の真ん中の◆の下の「21%」などの数字。100%は数字が消える（枠の色はキャラごとに違うので見ない）
 *   - %の数字が読める → 0〜99%、数字が無くて◆のアイコンが見えている（readUltIcon）→ 100%
 *   - 1秒同じなら確定（%は差3以内）。確定した%が95以上 → 100% で ult_ready、100% → 15%以下で ult_used。同じ知らせは10秒あけ
 * どれも HUD が出ているときだけ、0.25秒に1回見る（重くしない）
 */
const KU = (() => {
  const TPL = {"kill": {"w": 14, "h": 22, "n": 149, "labels": [6, 1, 1, 1, 3, 2, 7, 1, 1, 5, 0, 2, 9, 1, 1, 5, 6, 8, 6, 1, 1, 1, 8, 4, 4, 1, 6, 8, 1, 5, 1, 2, 3, 4, 3, 8, 0, 8, 2, 1, 2, 2, 6, 1, 0, 3, 1, 0, 1, 2, 0, 4, 4, 1, 0, 1, 2, 0, 7, 4, 5, 3, 9, 7, 5, 6, 3, 2, 3, 7, 5, 6, 1, 1, 1, 9, 3, 9, 1, 1, 5, 6, 8, 7, 1, 1, 5, 0, 2, 6, 1, 6, 1, 1, 1, 3, 2, 9, 1, 1, 5, 6, 8, 9, 1, 9, 1, 5, 3, 1, 1, 3, 4, 6, 3, 1, 2, 8, 4, 1, 0, 1, 2, 0, 4, 4, 2, 3, 6, 1, 8, 6, 1, 5, 0, 5, 1, 7, 2, 7, 3, 8, 3, 1, 0, 2, 0, 5, 1], "bits": "AAAAAAAAAAAAAAAAA4A/gO8HHBwgcAH+B/wcMHDBwwcMD/AfgAAAAAAAAAAAAAAAAAAAAAfAHwAcAHABwAcAHABwAcAHABwAcACAAAAAAAAAAAAAAAAAAAAAAHgA8AHABwAcAHABwAcAHABgAYAGAAgAAAAAAAAAAAAAAAAAAAAAB8APAAwAMADAAwAMADAAwAMADAAwAIAAAAAAAAAAAAAAAAAAAAAAP8D/ADgBwAYAPgD8ADAgwcMHHA/wH4AAAAAAAAAAAAAAAAAAADwD+B7wccGHABwA4AcAOAHADgA4Af8H+AAAAAAAAAAAAAAAAAAAAAB/gf4AOADAAwAcAGADgAwAMAHABgAQAAAAAAAAAAAAAAAAAAAAAAfADwAMADAAwAMAHAAwAMADAAwAMADAAAAAAAAAAAAAAAAAAAAAAHwA8ADAAwAMADAAwAMADAAwAMADAAgAAAAAAAAAAAAAAAAAAAAAB/gfwGABgAcAH8A/gAYEGBhgYYH+A/AAAAAAAAAAAAAAAAAAAANAP8DvgwYMOHDhwYcOHDhw4cODDg/wH4AAAAAAAAAAAAAAAAAAAHgD+A7wccCHABwA4AcAOAHABgA4Af8D+AAAAAAAAAAAAAAAAAAAA4A/gc4GGBhgYYHGA/gAYAGBhgcYD+AeAAAAAAAAAAAAAAAAAAAAAAAAHgB4AHABgAYAGABgAYAGABgAYAGAAAAAAAAAAAAAAAAAAAAAAHgB4AGABgAYAGABgAYAGABgAYAGABgAAAAAAAAAAAAAAAAAAAAAB/gf4DABwAMAH+A/wAcEHBhwccH+A/gAAAAAAAAAAAAAAAAAAAeAP4H+BhgYYHAB/gf4GHBhwYcHGB/gPwAAAAAAAAAAAAAAAAAAADwD/A/wMMDDAwwP8D/AwwcOHDBwwP8B+AAAAAAAAAAAAAAAAAAAAAA/gP4DDAwgMAD+A/wMMDDAwwcMD/AfAAAAAAAAAAAAAAAAAAAAQAfAHwAcAHABwAcAHABwAcAHABwAcACAAAAAAAAAAAAAAAAAAAAAAHgB4AGABgAYAGABgAYAGABgAYAGAAgAAAAAAAAAAAAAAAAAAAAAAAAfADwAMADAAwAMADAAwAMADAAwAMAAAAAAAAAAAAAAAAAAAAOAP4HeBhgYYGGA/gf4GGBhwYcGHB/gPwAAAAAAAAAAAAAAAAAAAAAAOADwB8A3ANwGYDmA5wf+D/gBgAYACAAAAAAAAAAAAAAAAAAAAAADgB4AfANgHYBmAxgMcH/g/wAYAGABgAAAAAAAAAAAAAAAAAAAwAfAHwAcAHABwAcAHABwAcAHABwAcACAAAAAAAAAAAAAAAAAAAAHgD+B7gccGCBwAf4H/BxwYcHHBxwf4D8AAAAAAAAAAAAAAAAAAAB4A/gf4GGBhgYYD+B/gYcGHBhwYcH+A/gAAAAAAAAAAAAAAAAAAAQAfAHwAcAHABwAcAHAAwAcAHAAwAcADAAAAAAAAAAAAAAAAAAAAB4D/x/+D/gfgD4B+AfgPwB4AYAOACAAgAAAAAAAAAAAAAAAAAAAD8B/gf4HABwAfwH+B/gAYGGBhgc4H+A/AAAAAAAAAAAAAAAAAAAAOAP4H+BhgYcAGADgBwA4AcAOAHwB/gf4AAAAAAAAAAAAAAAAAAADwH+B/gBwA4AOAHwB+ABgQYGGBjgf4D8AAAAAAAAAAAAAAAAAAAAAADgB4A+ANgGYDmAxgc4H/B/wAYAGABgAAAAAAAAAAAAAAAAAAAAgP8D/ADgBwA4APgD8ADAgwcMHHA/wH4AAAAAAAAAAAAAAAAAAAHgD+B/wccGHBxwP4H+BhwYMGDBxwf4D+AAAAAAAAAAAAAAAAAAAD8B/gf8GHBhwYcGHBhwYMGDBgwYcH+A/gAAAAAAAAAAAAAAAAAAAPAP8D/AwwMMDDA/wP8DDBw4cOHDA/wH4AAAAAAAAAAAAAAAAAAAAAHgB4AGABgAYAGABgAYAGABgAYAGABgAAAAAAAAAAAAAAAAAAAAAB8AfABwAcAHABwAcAHABwAcAHABwAYAAAAAAAAAAAAAAAAAAAAAAfAHwAcAHABwAcAHABwAcAHABgAYACAAAAAAAAAAAAAAAAAAAAHgD+B7wcMGDBhwf8D/AXwAMDHBxwP4B+AAAAAAAAAAAAAAAAAAAAAB/gf4AcAGADAB8AfgAYEGBhgYYH+A/AAAAAAAAAAAAAAAAAAAAIAfAHwAcAHABwAcAHABwAcAHABwAcACAAAAAAAAAAAAAAAAAAAAPwH+B/wYcGHBgwYMGDBgwYMGDBhwf4D+AAAAAAAAAAAAAAAAAAAAAB/gf4AMAGADgB+AfgAYGGBhgYYH+A/AAAAAAAAAAAAAAAAAAAAAAeAHgAYAGABgAYAGABgAYAGABgAYAGAAAAAAAAAAAAAAAAAAAADwD/B/wYMGDBgwYMGDBgwYMGDBwwP8B+AAAAAAAAAAAAAAAAAAABAB8APAAwAMAHABwAcAHAAwAMADABwAIAAAAAAAAAAAAAAAAAAAAeAP4H+BhgYYAGADgBwA4AcAOAHgB/gf4AAAAAAAAAAAAAAAAAAADwD/B/wYMGDBgwYMGDBgwYMGDBwwf8D+AAAAAAAAAAAAAAAAAAAAAADgB4AeANgHYBmAxgccH/B/wAYAGABgAAAAAAAAAAAAAAAAAAAAAA4AeAHgDYB2AZgMYHHB/4f8AGABgAYAAAAAAAAAAAAAAAAAAAOAHwB8AHABwAcAHABwAcAHABwAcAHAAgAAAAAAAAAAAAAAAAAAAB+A/wP+HDhw4MGDBgwYMGDBgwYMOD/gfwAAAAAAAAAAAAAAAAAAB4AeAHwAYAGABgAYAGABgAYAGABgAYAGAAAAAAAAAAAAAAAAAAAADwD+B/wcMDHABwA4AcAPADgBwA4Af8D/AAAAAAAAAAAAAAAAAAAB8A/wP+HDhw4cOHDhw4cOHDhw4MOD/AfgAAAAAAAAAAAAAAAAAAAAAf4H+ADAAwAcAGADgA4AMAHABgAYAEAAAAAAAAAAAAAAAAAAAAAAAAADgB4AeANgHYBmAxwfcH/A/wAYAGAAAAAAAAAAAAAAAAAAAAAA/gf4HABwAcAH+AvwAcEHBhwYYH+A/AAAAAAAAAAAAAAAAAAAAAAP8D/ADgBwAYAPgD8ADAgwcMHHA/wH4AAAAAAAAAAAAAAAAAAADgD+B/wYcGHBhwecD+AfwAcGHBxgP4D8AAAAAAAAAAAAAAAAAAAAAB/gf4AOADABwAcAGADgAwAMAHABgAQAAAAAAAAAAAAAAAAAAAAAAP4D+AwAMADwA/gP8AHBgwcMHHB/gPwAAAAAAAAAAAAAAAAAAAHAH8B3gYYGGBgAfwH+BhgYYGGBhgf4D8AAAAAAAAAAAAAAAAAAAAAB/gf4AMAGADgB+AfgAYEHBhwYYH+A/AAAAAAAAAAAAAAAAAAAAfAP4D/AwwMMAHADgA4AcAOAHADgB/wP8AAAAAAAAAAAAAAAAAAAAwH/A/gAwAcAOAD4A/ABwYcGHBxwf4D+AAAAAAAAAAAAAAAAAAAAAB/gf4AOADABwAcAGADgAwAMAHABgAYAAAAAAAAAAAAAAAAAAAAAAP4H+BwAMADAA/gP8AHBhwYcHHB/gP4AAAAAAAAAAAAAAAAAAAHgD+B/gYYGGBgAf4H+BhwYcGHBxwf4D8AAAAAAAAAAAAAAAAAAABAB8APAAwAMADAAwAMADAAwAMADAAwAMAAAAAAAAAAAAAAAAAAAA4AfAHwAcAHABwAcAHABwAcAHABwAcACAAAAAAAAAAAAAAAAAAAAIAHwB8AHABwAcAHABwAcAHABwAYAGABgAAAAAAAAAAAAAAAAAAAB8A/gf8HHBxwccHfA/wD8AHBxwMcD+AfgAAAAAAAAAAAAAAAAAAA/Af4H+AHADgA4AfAH4AGBBgYYGGB/gPwAAAAAAAAAAAAAAAAAAAHgD+B/wYcGHBhwfcD/ALwAcHHBxwP4B8AAAAAAAAAAAAAAAAAAABAB4AeABgAYAGABgAYAGABwAcAGABgAYAAAAAAAAAAAAAAAAAAAAAAeAHgAYAGABgAYAGABgAYAGABgAYAGAAAAAAAAAAAAAAAAAAAAAAH+B/gcAHAA8Af4D/ABwAcGHBhwf4D+AAAAAAAAAAAAAAAAAAAB4A/gf4GGBhgYAH+B/gYcGHBhwYYH+A/AAAAAAAAAAAAAAAAAAAAPAP8D/AwwMMDDA/wP8DDBw4cOHDA/wH4AAAAAAAAAAAAAAAAAAADAH+B/gA4AMAHABwAYAOADAAwAcAGABgAAAAAAAAAAAAAAAAAAABAB8AfAAwAMADAAwAMADAAwAMADAAwAMAAAAAAAAAAAAAAAAAAAAAAfADwAMADAAwAMADAAwAcADAAwAMACAAAAAAAAAAAAAAAAAAAAAAD/A/gMADAA8AP8D/AAwIMDDBwwP8B+AAAAAAAAAAAAAAAAAAAB8A/wO+HDhw4cOHBhw4cOHDgw4cOD/AfgAAAAAAAAAAAAAAAAAAAOAP4D/BxwIcAHADgBwA4AcAHADgB/wP4AAAAAAAAAAAAAAAAAAAPgH8B/gYYGGBwAfwH+BhgYYGGBjgf4D8AAAAAAAAAAAAAAAAAAAAAB8AfAAwAMADAAwAMADAAwAMADAAwAMAAAAAAAAAAAAAAAAAAAAMAP4DHBwwcIDAA/gP8DDBwwcMDDA/gHwAAAAAAAAAAAAAAAAAAAAAHwB8AHABwAcAHABwAcAHABwAcAHAAgAAAAAAAAAAAAAAAAAAAAAB4AOABgAYAGABgAYAGABgAYAGABgAIAAAAAAAAAAAAAAAAAAAAAAfADwAMADAAwAMADAAwAMADAAwAMACAAAAAAAAAAAAAAAAAAAAAAD/A/wA4AMAOAD4A/AAwIMDDBwwP8B8AAAAAAAAAAAAAAAAAAAAYA/gO8HDBgwAYAOAHABgBwAYAeAH/A/gAAAAAAAAAAAAAAAAAAAeAP4H/BhwYcGHB/wP8B/ABwccHHA/gHwAAAAAAAAAAAAAAAAAAAEAHgB4AGABgAYAGABgAYAHABgAYAGABgAAAAAAAAAAAAAAAAAAAAAB4AeABgAYAGABgAYAGABgAYAGABgAIAAAAAAAAAAAAAAAAAAAAAAf4H+BwAcAHQB/gP8AHBhwYMHHB/gHwAAAAAAAAAAAAAAAAAAAHgD+B/gYYGGBgAf4H+BhwYcGHBxwf4B8AAAAAAAAAAAAAAAAAAAB4B/Af4GGBhgYYH+B/gYYGGBhgYYH+A/AAAAAAAAAAAAAAAAAAAASAP4HOBhwYcGHB5wP8AHABwccHGA/gHwAAAAAAAAAAAAAAAAAAAAAHgB4AGABgAYAGABgAYAGABgAYAGABgAAAAAAAAAAAAAAAAAAAB4B/gf4GHBhwccHfB/wHcAHBxwccD+A/gAAAAAAAAAAAAAAAAAAA4AfAD8AOADgA4AOADgA4AOADgA4AOADAAAAAAAAAAAAAAAAAAAAAAD+A/gMADAAwAP4D/AAwIMHDBxwP8B+AAAAAAAAAAAAAAAAAAAAAB/gf4AMAGADgB+AfgAYGHBhwcYH+A/AAAAAAAAAAAAAAAAAAAAAAfADwAMADAAwAMADAAwAMADAAwAMADAAAAAAAAAAAAAAAAAAAAAAHgB8AGABgAcAHABwAcAGABgAcAGABgAAAAAAAAAAAAAAAAAAAAAB/gf4AMAGADgB+APgAcEHBhwcYH+A/AAAAAAAAAAAAAAAAAAAAAAA4AeAHgDYB2AZgMYHHB/4f8AGABgAYAAAAAAAAAAAAAAAAAAADAH8BzgYYGEBgAfwH+BhgYYGGBhgf4D8AAAAAAAAAAAAAAAAAAAAAB/gP4AMAGADgB8AfgAYAHBhgYYH+A/AAAAAAAAAAAAAAAAAAAAAAeAHgAYAGABgAYAGABgAYAGABgAYAGAAAAAAAAAAAAAAAAAAAAHAH8BzgYYGGABgAwAYAMAHADgBwAf4H+AAAAAAAAAAAAAAAAAAABwB/gd4GGBhgYYH+B/gYYGGBhgYYH+A/AAAAAAAAAAAAAAAAAAAAAAA4AeAHgDYB2AZgMYHHB/4P8AGABgAYAAAAAAAAAAAAAAAAAAAAAAAB4AeABgAYAGABgAYAGABgAYAGABgAAAAAAAAAAAAAAAAAAAAEA/wccGDBgwYMGDBgwYMGDBgwcMD/AfgAAAAAAAAAAAAAAAAAAAAAAAHwA4ADAAwAMADAAwAMADAAwAMADAAAAAAAAAAAAAAAAAAAAAAD+BzgYYGGABgA4AcAOAHABgBwAf4D+AAAAAAAAAAAAAAAAAAAAAA/wccGDBgwYMGDBgwYMGDBgwYMH/AfAAAAAAAAAAAAAAAAAAAAAAAAAOAHgB4A2AZgGYDGBxwf8D/ABgAYAAAAAAAAAAAAAAAAAAAAAAAADgB4AeANgGYBmAxgMcH/A/wAYAGAAAAAAAAAAAAAAAAAAAAAA/gf4GGBhgAYAGAGABgBwAYAfgH+AfgAAAAAAAAAAAAAAAAAAAAAf4D+AHADgA4APAD4AGBBgYcGOB/gPgAAAAAAAAAAAAAAAAAAAAAD+B/gYYGGBwAf4H+BxwYcGHBxwP8A4AAAAAAAAAAAAAAAAAAAAAAAAeAHgAYAGABgAYAGABgAcAHABgAYAAAAAAAAAAAAAAAAAAAADAP4D/AwwMMDHA/wP8DDAwwMMHDA/wDwAAAAAAAAAAAAAAAAAAAHgH8B/gYYGGBgAfwH+BhgYYGGBhgf4D8AAAAAAAAAAAAAAAAAAAAAB8APAAwAMAHAAwAMADAAwAMADAAwAMAAAAAAAAAAAAA/8P/DgA4AOADgA/4P/B/wAcAHHAxwccHD/w/4D8AAAAAAAAAAH4P/D/5wOcDnA5wOcDnA5wOcDnA5wOcDnA4/+P/A/gAAAAAAAAAH+H/h/4cAHABwAeAH/h/4P/ABwAccHHBxw8f/H/gfgAAAAAAAAAAAB+AfgA4AOADgA4AOADgA4AOADgA4AOADgA4AOAAgAAAAAAAAAAAAAAH/h/4AeAHgBwA8AOADgBwAcAHADgA4AeAHABwAAAAAAAAAAD4D/h/8eHHBxwcAHADwB4A+AeAPgHwD4B+Af/H/wf4AAAAAAAAAAAAAAf+H/gA4AOAHABwAcAOADgB4AcAHADgA4AOAHAAAAAAAAAAAAAP/D/wA4AOAHADgB8A/wH8ADABwwMcHnh4/8P/A/AAAAAAAAAAB8B/w/8ODDg44eODDxwf4P/DgxwOcDnA5wOP/D/wPwAAAAAAAAAAAB/4f+AHgBwA4AcAPgD+A/gAYAHGBxwccHH/h/4AYAAAAAAAAAAAAAAH4A+ADgA4AOADgA4AOADgA4AOADgA4AOADgA4AAAAAAAAAAAAAAA/8P/HAxwMcDnAxwMcDHAxwMcDHAxwMcDD/w/8AAAAAAAAAAAAPAP8H/hw8cHGBwAYAOAHADgBwA8AeAPAHgB/4f+AAAAAAAAAADwP/D/xwMcDnA5wOcDnA5wOcDnA5wOcDHAw/8P/AcAAAAAAAAAAAAH/h/4cAHABwAcAH/B/4L/ABwAcYHHBxwcf+H/gPwAAAAAAAAAAAAQAfgH4AOADgA4AOADgA4AOADgA4AOADgA4AOADgAAAA=="}, "pct": {"w": 14, "h": 18, "n": 39, "labels": [9, 0, 10, 9, 2, 10, 8, 2, 10, 8, 3, 10, 8, 4, 10, 1, 10, 5, 0, 10, 5, 1, 10, 7, 9, 10, 2, 0, 10, 6, 2, 10, 2, 1, 10, 1, 10, 2, 10], "bits": "AAAQA/wMMGBBgQYEGBAwwP8ADAAQMEDBAwwH8AcAAAAAAAB/wYOGBhgYYGGBhgYYGGBhgYYGGBhgwf8AEAAAAAAAAAAYwCIAmAJgCQBsADABgAbAEgDIAyAIgGMAAAAAAAA/wcMGBBgQYEGBAwwP8ADAAQMECBAwwP8AoAAAAAAAAYAP8HDBgwYMADAAwAYAMAGADgBwA4APQH/AAAAAAAAAAYwCMAmAJgCQBsADABgAbAGgDIAyAIgGMAAAAAAAAAAP8HDhgYYGGBggQH8D/BgYYGGBhgYMOD/AAAAAAAAAAP4HDBgQYEADAAwAYAMAGADgBwAYAeAH/AAAAAAAAAAYwCMAmAJgCYBsADAAgAbAGgDIAyAIgGEAAAAAAAAGAP4GDBgwYEGDBgwP4H/BgQYEGBBgQYMD+AAAAAAAAAAf8AGADABwAYAOAH4ADAAwAMEDBgwYMH+AAAAAAAAAAeEExBEgTYE2B9gAwAMACQBsATAMwDMAhAAAAAAAAAAP8HDhgYYGGBggQP8D/BgYYGGBhgYMOD/AAAAAAAAAAA4AeAHgDYBmAZgMYCGBhgf8H/ABgAYAGAAAAAAAAAAYwCMAmAJgCYBsADABgAbAGgDIAyAIgGMAAAAAAAAAAeABgAYAGABgAYAGABgAYAGABgAYAGABgAAAAAAAAAAYwCIAmAJgCwBsACABgAbAMgDYAmAYgGMAAAAAAAA/wMADAAwAMADAA/wAMABAAQYEGBAwwP8AgAAAAAAAB/wYEGBhgYYGGBhgYYGGBhgYYGGBhg4P8AEAAAAAAAAAAYwCIAmAJgCQBsADABgAbAEgDIAyAYgGMAAAAAAAAAAP8DAAwAMADAA/AP8ADAAQAEGBBgQMMD/AAAAAB8B/wYOGBhkYZmGZhmYZmGZhmYZmGBhg4f8B+AAAAAAAAAAYwCMAmAJgCwBsADABgAbAEgDIAyAYgGMAAAAAAAAAAf4AGABgAYAEADAAgAYAGABgAwAMAGABgAAAAAAAAAAf4EGBAgQIECBBgYYH+ABgAYEGBBgYYH+AAAAAAAAAAfEETBEwRIE2A9gAwAMADeAsgTIEyDMgx4AAAAAAAAAf4GGBAgQIACABgA4AcAGADABgAwAcAH+AAAAAAAAAAP8DBggIICGAhgIICCAggIICCBggYMGD/AAAAAAAAAAQwGYAmALACwBMAGABgATANgCYAmAZgEMAAAAAAcA/wMMGDBgwYAHAB/wcMCBggYIGCBgw4P8AeAAAAAAAADAP8DDBgwYEADAAwAYAMAGADgBwAYAOAH/AAAAAAAAAAYwCMAmAJgCYBsADABgAbAGgDIAyAIgGMAAAAAAAAAAf4GGBgwQMADABgA4AcAOADABgAwAcAH/AAAAAAAAAAfABwAMADAAwAMADAAwAMADAAwAMADAAwAAAAAAAAAAQgGYBmAbAGwBMAGABgAyANgDYBmAZgEIAAAAAAAAAAeABgAYAGABgAYAGABgAYAGABgAYAGABgAAAAAAAAAAYwCYAmAJgCwBsACABgAbwNkDZg2YZmGPAAAAAAAAAAfAAwAMADAAwAMADAAwAMADAAwAMADAAwAAAAAAAAAAYwCIAmAJgCwBsACABgAbAEgDYA2AZgGMAAAA="}};
  const unpack = (t) => { const s = atob(t.bits), n = t.w * t.h, out = [];
    for (let k = 0; k < t.n; k++) { const a = new Float32Array(n); for (let i = 0; i < n; i++) { const b = k * n + i; a[i] = (s.charCodeAt(b >> 3) >> (7 - (b & 7))) & 1; } out.push(a); }
    return out; };
  const KT = unpack(TPL.kill), KL = TPL.kill.labels, PT = unpack(TPL.pct), PL = TPL.pct.labels;

  // 8近傍でつながった塊（x, y, w, h, 画素数）
  function comps(mask, W, H) {
    const lab = new Int32Array(W * H), out = [], st = [];
    let id = 0;
    for (let p = 0; p < W * H; p++) {
      if (!mask[p] || lab[p]) continue;
      id++; let x0 = W, y0 = H, x1 = -1, y1 = -1, a = 0; st.push(p); lab[p] = id;
      while (st.length) {
        const q = st.pop(), qx = q % W, qy = (q / W) | 0; a++;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const r = ny * W + nx; if (mask[r] && !lab[r]) { lab[r] = id; st.push(r); }
        }
      }
      out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, a });
    }
    return out;
  }
  // 面積平均で縮小・拡大（0〜1 の値）
  function resize(src, W, x0, y0, w, h, W2, H2) {
    const out = new Float32Array(W2 * H2);
    for (let j = 0; j < H2; j++) for (let i = 0; i < W2; i++) {
      const sx0 = x0 + i * w / W2, sx1 = x0 + (i + 1) * w / W2, sy0 = y0 + j * h / H2, sy1 = y0 + (j + 1) * h / H2;
      let s = 0, c = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0), wx = Math.min(x + 1, sx1) - Math.max(x, sx0); if (wx <= 0 || wy <= 0) continue;
        s += src[y * W + x] * wx * wy; c += wx * wy;
      }
      out[j * W2 + i] = c ? s / c : 0;
    }
    return out;
  }
  // 塊を固定の枠（CW×CH）に、左下をそろえて置く（読み取りの見本と同じ置き方）
  function place(mask, W, c, CW, CH) {
    let m = mask, MW = W, x = c.x, y = c.y, w = c.w, h = c.h;
    if (h < 12) {   // 小さい数字は高さ13にそろえる
      const w2 = Math.max(2, Math.round(w * 13 / h)), r = resize(mask, W, x, y, w, h, w2, 13);
      m = new Uint8Array(w2 * 13); for (let i = 0; i < r.length; i++) m[i] = r[i] > 0.43 ? 1 : 0; MW = w2; x = 0; y = 0; w = w2; h = 13;
    }
    const g = new Float32Array(CW * CH), w2 = Math.min(w, CW - 2), h2 = Math.min(h, CH - 2);
    for (let j = 0; j < h2; j++) for (let i = 0; i < w2; i++) g[(CH - 1 - h2 + j) * CW + 1 + i] = m[(y + h - h2 + j) * MW + x + i];
    return g;
  }
  function classify(F, CW, CH, T, L, nLab) {
    let sum = 0; for (const v of F) sum += v; sum = Math.max(1, sum);
    const best = new Array(nLab).fill(9);
    for (let k = 0; k < T.length; k++) {
      const t = T[k]; let b = 1e9;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        let d = 0;
        for (let j = 0; j < CH; j++) { const sj = ((j - dy) % CH + CH) % CH; for (let i = 0; i < CW; i++) d += Math.abs(t[j * CW + i] - F[sj * CW + ((i - dx) % CW + CW) % CW]); }
        if (d < b) b = d;
      }
      const v = b / sum; if (v < best[L[k]]) best[L[k]] = v;
    }
    const o = best.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    if (o[1][0] - o[0][0] < 0.04) return [o[0][1], 9];   // 2番目と差がない → 自信なし（6 と 8 は差が小さいことがあり、そのときは読めない扱い。数コマ後に読めれば判定される）
    return [o[0][1], o[0][0]];
  }

  // ---------- キルの欄 ----------
  const KRECT = { anchor: 'right', x: 2040, y: 78, w: 400, h: 76 };
  // 2026-11-02：欄は試合中に上下へ約15pxずれることがあり、ずれると上の「部隊残存」の数字（白）が同じ範囲に入る
  //   → 下端のそろう行ごとに分けて、下の行から順に「数字が1・3・4グループ」に読めるものを使う
  function killGroups(rows) {
    const W = KRECT.w, H = KRECT.h, mask = new Uint8Array(W * H);
    rows.forEach((row, y) => { for (let x = 0; x < W; x++) { const i = x * 4, mn = Math.min(row[i], row[i + 1], row[i + 2]), mx = Math.max(row[i], row[i + 1], row[i + 2]); mask[y * W + x] = mn > 200 && mx - mn < 50 ? 1 : 0; } });
    const all = comps(mask, W, H).filter(c => c.h >= 9 && c.h <= 19 && c.w >= 3 && c.w <= 13 && c.a >= 12 && c.a >= c.w * c.h * 0.2);   // 細い斜めの区切り線（明るい景色で白く見える）は塗りが薄いので除く
    const bots = [...new Set(all.map(c => c.y + c.h))].sort((a, b) => b - a);
    const rowsets = [];
    for (const b0 of bots) {
      if (rowsets.some(r => Math.abs(r - b0) <= 5)) continue;
      const near = all.filter(c => Math.abs(c.y + c.h - b0) <= 5);
      if (near.length < 2 && bots.length > 1) continue;
      rowsets.push(b0);
    }
    const sets = [];
    for (const b0 of rowsets) {
      const cs = all.filter(c => Math.abs(c.y + c.h - b0) <= 5).sort((a, b) => a.x - b.x);
      const gs = []; let cur = [];
      for (const c of cs) { if (cur.length && c.x - (cur[cur.length - 1].x + cur[cur.length - 1].w) <= 4) cur.push(c); else { if (cur.length) gs.push(cur); cur = [c]; } }
      if (cur.length) gs.push(cur);
      sets.push(gs);
    }
    return { mask, sets };
  }
  function readKill(rows) {
    const { mask, sets } = killGroups(rows);
    for (const gs of sets) {   // 下の行から
      if (gs.length === 1 && gs[0].length >= 2) return { k: 0, a: 0, gs, mask };   // 0キルの間はダメージだけ（2桁以上）
      if (gs.length !== 3 && gs.length !== 4) continue;
      const out = []; let ok = true;
      for (const g of gs.slice(0, 2)) {
        let s = '';
        for (const c of g) { const [d, dist] = classify(place(mask, KRECT.w, c, 14, 22), 14, 22, KT, KL, 10); if (dist > 0.35) { ok = false; break; } s += d; }
        if (!ok) break; out.push(+s);
      }
      if (ok) return { k: out[0], a: out[1], gs, mask };
    }
    return null;
  }
  function teamSig(rows, gs) {
    if (!gs || gs.length !== 4) return null;
    const g1 = gs[1][gs[1].length - 1], x0 = g1.x + g1.w + 8 + 36, x1 = gs[3][0].x - 2, y0 = 18, H = 26, W = x1 - x0;
    if (W < 10) return null;
    const mn = new Uint8Array(W * H), dark = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const row = rows[y0 + y]; for (let x = 0; x < W; x++) { const i = (x0 + x) * 4, v = Math.min(row[i], row[i + 1], row[i + 2]); mn[y * W + x] = v; dark[y * W + x] = v < 90 ? 1 : 0; } }
    const cs = comps(dark, W, H).filter(c => c.h >= 10 && c.h <= 14 && c.w >= 2 && c.w <= 10 && c.a >= 8).sort((a, b) => a.x - b.x);
    if (!cs.length) return null;
    const grp = [cs[0]];
    for (const c of cs.slice(1)) { const l = grp[grp.length - 1]; if (c.x - (l.x + l.w) <= 3) grp.push(c); else break; }
    const xa = grp[0].x, xb = grp[grp.length - 1].x + grp[grp.length - 1].w, ya = Math.min(...grp.map(c => c.y)), yb = Math.max(...grp.map(c => c.y + c.h));
    const around = []; for (let y = Math.max(0, ya - 1); y < Math.min(H, yb + 1); y++) for (let x = Math.max(0, xa - 3); x < xa; x++) around.push(mn[y * W + x]);
    if (!around.length) return null;
    around.sort((a, b) => a - b); if (around[around.length >> 1] < 170) return null;   // 欄が赤く点滅している
    const df = new Float32Array(W * H); for (let i = 0; i < df.length; i++) df[i] = dark[i];
    return { w: xb - xa, n: grp.length, m: resize(df, W, xa, ya, xb - xa, yb - ya, 8 * grp.length, 12) };
  }
  const sigSame = (a, b) => { if (!a || !b) return false; if (Math.abs(a.w - b.w) > 2 || a.n !== b.n) return false; let d = 0; for (let i = 0; i < a.m.length; i++) d += Math.abs(a.m[i] - b.m[i]); return d / a.m.length < 0.18; };

  const K = { cand: null, n: 0, cur: null, need: 2 };
  function killFeed(r) {
    if (!r) return null;
    const key = [r.k, r.a];
    if (K.cand && K.cand[0] === key[0] && K.cand[1] === key[1]) K.n++; else { K.cand = key; K.n = 1; }
    if (K.n < K.need) return null;
    if (!K.cur) { if (K.n >= K.need * 4) K.cur = key; return null; }
    if ((key[0] < K.cur[0] || key[1] < K.cur[1]) && K.n >= K.need * 8) { K.cur = key; return null; }
    if (key[0] - K.cur[0] >= 4 && K.n < K.need * 4) return null;
    let ev = null;
    if (key[0] > K.cur[0]) ev = { type: 'kill', n: key[0] - K.cur[0], total: key[0] };
    else if (key[1] > K.cur[1] && key[0] === K.cur[0]) ev = { type: 'assist', n: key[1] - K.cur[1], total: key[1] };
    if (key[0] >= K.cur[0] && key[1] >= K.cur[1]) K.cur = key;
    return ev;
  }
  const TM = { base: null, cand: null, n: 0, need: 4 };
  function teamFeed(sig) {
    if (!sig) return null;
    if (TM.cand && sigSame(sig, TM.cand)) TM.n++; else { TM.cand = sig; TM.n = 1; }
    if (TM.n < TM.need) return null;
    if (!TM.base) { TM.base = TM.cand; return null; }
    if (!sigSame(TM.cand, TM.base)) { TM.base = TM.cand; return { type: 'team_kill' }; }
    return null;
  }

  // ---------- ウルトの % ----------
  const URECT = { anchor: 'center', x: 1200, y: 900, w: 160, h: 170 };
  function readPct(rows) {
    const X0 = 20, Y0 = 128, W = 120, H = 34, mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const row = rows[Y0 + y]; for (let x = 0; x < W; x++) { const i = (X0 + x) * 4, mn = Math.min(row[i], row[i + 1], row[i + 2]), mx = Math.max(row[i], row[i + 1], row[i + 2]); mask[y * W + x] = mn > 195 && mx - mn < 50 ? 1 : 0; } }
    let cs = comps(mask, W, H).filter(c => c.h >= 8 && c.h <= 16 && c.w >= 2 && c.w <= 14 && c.a >= 10).sort((a, b) => a.x - b.x);
    if (!cs.length) return null;
    const cnt = {}; for (const c of cs) cnt[c.y + c.h] = (cnt[c.y + c.h] || 0) + 1;
    const b0 = +Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    cs = cs.filter(c => Math.abs(c.y + c.h - b0) <= 2);
    const gl = [];   // 「%」は丸と斜線に分かれることがあるので重なる塊はまとめる
    for (const c of cs) { const l = gl[gl.length - 1]; if (l && c.x - (l.x + l.w) <= 0) { const x1 = Math.max(l.x + l.w, c.x + c.w), y0 = Math.min(l.y, c.y), y1 = Math.max(l.y + l.h, c.y + c.h); l.w = x1 - l.x; l.y = y0; l.h = y1 - y0; l.a += c.a; } else gl.push({ ...c }); }
    if (gl.length < 2 || gl.length > 4) return null;
    let s = '';
    for (const c of gl) { const [d, dist] = classify(place(mask, W, c, 14, 18), 14, 18, PT, PL, 11); if (dist > 0.4) return null; s += d === 10 ? '%' : String(d); }
    if (!/^\d{1,2}%$/.test(s)) return null;
    return +s.slice(0, -1);
  }
  const U = { hist: [], cur: null, need: 4, n: 0, lastEv: {} };
  function ultFeed(pct, iconVisible) {
    U.n++;
    const st = pct != null ? ['pct', pct] : iconVisible ? ['ready', null] : null;
    if (!st) return null;
    U.hist.push(st); if (U.hist.length > U.need) U.hist.shift();
    if (U.hist.length < U.need || U.hist.some(h => h[0] !== st[0])) return null;
    let cur = st;
    if (st[0] === 'pct') { const v = U.hist.map(h => h[1]).sort((a, b) => a - b); if (v[v.length - 1] - v[0] > 3) return null; cur = ['pct', v[v.length >> 1]]; }
    const prev = U.cur; U.cur = cur;
    const out = [];
    if (cur[0] === 'pct' && (!prev || prev[0] !== 'pct' || prev[1] !== cur[1])) out.push({ type: 'ult_charge', pct: cur[1] });
    if (!prev) return out;
    let ev = null;
    if (prev[0] === 'pct' && cur[0] === 'ready' && prev[1] >= 95) ev = 'ult_ready';
    if (prev[0] === 'ready' && cur[0] === 'pct' && cur[1] <= 15) ev = 'ult_used';
    if (ev && U.n - (U.lastEv[ev] ?? -1e9) >= U.need * 10) { U.lastEv[ev] = U.n; out.push({ type: ev }); }
    return out;
  }

  let lastAt = -1e9;
  return {
    _t: { readKill, killFeed, teamSig, teamFeed, readPct, ultFeed, KRECT, URECT },   // 確認用（テストから中身を呼ぶ）
    // reading.hudVisible のときだけ呼ぶ。0.25秒に1回だけ読む。返り値は出来事の配列（無ければ null）
    async check(frame, reading, now) {
      if (!reading.hudVisible || now - lastAt < 250) return null;
      lastAt = now;
      const evs = [];
      try {
        const kr = await regionRows(frame, KRECT);
        const r = readKill(kr);
        const e = killFeed(r); if (e) evs.push(e);
        if (r && r.gs) { const t = teamFeed(teamSig(kr, r.gs)); if (t) evs.push(t); }
        reading.killPanel = r ? { k: r.k, a: r.a } : null;
      } catch (e) { /* 読めなくても続ける */ }
      try {
        const ur = await regionRows(frame, URECT);
        const p = readPct(ur);
        reading.ultPct = p;
        const u = ultFeed(p, (reading.ultIcon || 0) > 0.6); if (u && u.length) evs.push(...u);
      } catch (e) { /* 読めなくても続ける */ }
      return evs.length ? evs : null;
    },
  };
})();
