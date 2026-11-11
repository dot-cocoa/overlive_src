// 配信用の窓：Apex のウィンドウの映像を下に敷き、その上に配信用ページ（/obs）の HUD を重ねる（2026-10-30）
'use strict';
const v = document.getElementById('v');
const msg = document.getElementById('msg');
let busy = false;
async function start() {
  if (busy) return; busy = true;
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    v.srcObject = s; msg.hidden = true;
    const t = s.getVideoTracks()[0];
    if (t) t.addEventListener('ended', () => { v.srcObject = null; msg.hidden = false; busy = false; setTimeout(start, 3000); });
  } catch (e) {
    // ゲームがまだ起動していない → 少し待ってやり直す
    msg.hidden = false; busy = false; setTimeout(start, 3000);
  }
}
start();
