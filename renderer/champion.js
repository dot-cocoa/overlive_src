/*
 * チャンピオン（優勝）の読み取り（2026-10-30）。reader.worker.js から importScripts で読み込む。
 * 試合に勝つと、ゲームの HUD が消えて画面の真ん中に「YOU ARE THE / CHAMPION」の帯が出る（バトロワ・ランクとも同じ）。
 * その「CHAMPION」の白い文字の形（下の TPL）が、まわりの帯より明るく浮かんで見えたら優勝とみなす。
 *   ユーザーの優勝動画で：帯の出ている約2秒は「文字の中 − まわり」が 95〜136、ふつうのプレイ・暗転・ロビーは ±13 以内。
 * HUD が消えているときだけ・3コマに1回だけ見るので、ふだんの読み取りは重くならない。
 * 1試合に1回だけ知らせる（HUD が 20 秒続けて出たら＝次の試合が始まったら、また知らせられる）。
 */
const CHAMP = (() => {
  // 「CHAMPION」の文字の形。ベース座標（2560x1080・高さ1080で画面の真ん中が基準）の x 800〜1736・y 428〜564 を 4px おきに見た 234×34 の白黒
  const TW = 234, TH = 34, STEP = 4, X0 = 800, Y0 = 428, PAD = 2;   // PAD：上下左右に 2 マス（8px）ずれても合うように
  const bits = atob('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////g/AA/AAP8AB/AAB+A///wD//gD//4AfgAfg////g/AA/AAf8AB/AAD+A///wH//wH//4AfwAfg////g/AA/AAf+AB/gAH+A///8H//wP//8AfwAfg////g/AA/AA/+AB/gAH+A///+H//wf//+Af4Afg////g/AA/AA/+AB/wAP+A////D//w////gf8Afg////A/AA/AA/+AB/4AP+A////D/7g/gB/gf8Afg/8AAA/AA/AA//AB/4Af+A/AB/AP4A/AA/gf+Afg/4AAA/AA/AB//gB/8Af+A/AA/AP4A/AAfgf/AfgP4AAA/AA/AB//gB/+A/+A/AA/AP4A/AAfgf/AfgP4AAA/AA/AD+/gB/+B/+A/AA/AP4A/AAfgf/gfgP4AAA/AA/AD8fgB/+B/+A/AA/AP4A/AAfgf/wfgP4AAA/AA/AD8fwB//D/+A/AA/AP4A/AAfgf/wfgP4AAA////AH8PwB//j/+A/AA/AP4A/AAfgfv4fgP4AAA////AH8P4B/fn9+A/AA/AP4A/AAfgfv8fgP4AAA////AP4H4B/f/5+A/AB/AP4A/AAfgfn8fgP4AAA////AP4H4B/P/5+A//7/AP4A/AAfgfj+fgP4AAA////AP//8B/P/x+A////AP4A/AAfgfh/fgP4AAA////AP//8B/H/h+A///+AP4A/AAfgfh//gP4AAA/AA/Af//+B/D/h+A///4AP4A/AAfgfg//gP4AAA/AA/Af//+B/D/h+A///wAP4A/AAfgfg//gP4AAA/AA/A///+B/B/B+A///gAP4A/AAfgfgf/gP4AAA/AA/A////B/B+B+A/AAAAP4A/AAfgfgP/gP4AAA/AA/A/AB/B/A+B+A/AAAAP4A/AAfgfgH/gP8AAA/AA/B/AB/h/AAB+A/AAAAP4A/gA/gfgH/gH///g/AA/B+AA/h/AAB+A/AAAH//g////gfgD/gH///g/AA/D+AAfh/AAB+A/AAAH//w////gfgD/gB///g/AA/D8AAfh/AAB+A/AAAH//gf//+AfgB/gA///g/AA/D8AAfx/AAB+A/AAAH//wH//8AfgA/gA///g/AA/D8AAPx/AAB+A/AAAH//wH//4AfgA/gAP//AfAAfD4AAPg+AAB+AfAAAD//gB//wAfgAPgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  const T = new Uint8Array(TW * TH);
  for (let i = 0; i < T.length; i++) T[i] = (bits.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  let hitN = 0, armed = true, visSince = -1, lastFire = -1e9;
  return {
    async check(frame, reading, frameNo, now) {
      // 次の試合が始まったら（HUD が 20 秒続けて出たら）、また知らせられるようにする
      if (reading.hudVisible) { if (visSince < 0) visSince = now; if (!armed && now - visSince > 20000) armed = true; hitN = 0; return false; }
      visSince = -1;
      if (!armed || frameNo % 3) return false;
      const fw = frame.displayWidth, fh = frame.displayHeight, k = fh / 1080;
      const gw = TW + PAD * 2, gh = TH + PAD * 2;
      // 画面の真ん中を基準に、見る範囲をフレームの座標へ（偶数にそろえる：YUV の制約）
      const bx = fw / 2 + (X0 - PAD * STEP - 1280) * k, by = fh / 2 + (Y0 - PAD * STEP - 540) * k;
      const X = Math.max(0, Math.floor(bx / 2) * 2), Y = Math.max(0, Math.floor(by / 2) * 2);
      const W = Math.min(fw - X, Math.ceil(gw * STEP * k / 2) * 2 + 2), H = Math.min(fh - Y, Math.ceil(gh * STEP * k / 2) * 2 + 2);
      if (W <= 0 || H <= 0) return false;
      const px = await copyRGBA(frame, { x: X, y: Y, width: W, height: H });
      // 4px おきの格子で「いちばん暗い色」（白い文字は高い・色のついた光は低い）と色の強さを取る
      const mn = new Uint8Array(gw * gh), sat = new Uint8Array(gw * gh);
      for (let j = 0; j < gh; j++) {
        const sy = Math.min(H - 1, Math.round(by - Y + j * STEP * k));
        for (let i = 0; i < gw; i++) {
          const sx = Math.min(W - 1, Math.round(bx - X + i * STEP * k)), s = (sy * W + sx) * 4;
          const r = px[s], g = px[s + 1], b = px[s + 2], lo = Math.min(r, g, b);
          mn[j * gw + i] = lo; sat[j * gw + i] = Math.max(r, g, b) - lo;
        }
      }
      let best = -999, bestIn = 0, bestSat = 999;
      for (let dy = 0; dy <= PAD * 2; dy++) for (let dx = 0; dx <= PAD * 2; dx++) {
        let si = 0, ni = 0, so = 0, no = 0, ss = 0;
        for (let j = 0; j < TH; j++) {
          const o = (j + dy) * gw + dx, t = j * TW;
          for (let i = 0; i < TW; i++) { const v = mn[o + i]; if (T[t + i]) { si += v; ni++; ss += sat[o + i]; } else { so += v; no++; } }
        }
        const inn = si / ni, c = inn - so / no;
        if (c > best) { best = c; bestIn = inn; bestSat = ss / ni; }
      }
      reading.champ = { c: Math.round(best), inn: Math.round(bestIn), sat: Math.round(bestSat) };   // 記録・確認用
      const hit = bestIn >= 180 && best >= 60 && bestSat <= 50;
      hitN = hit ? hitN + 1 : 0;
      if (hitN >= 2 && now - lastFire > 60000) { armed = false; hitN = 0; lastFire = now; return true; }   // 2回続けて（約0.1秒）
      return false;
    },
  };
})();
