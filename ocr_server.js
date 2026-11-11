// チャット翻訳用 OCR（tesseract.js、オフライン）。メインプロセスから require して使う。
// Electron 上では tesseract.js が言語データをネットから取ろうとするので、
// 同梱の eng.traineddata.gz をキャッシュ用フォルダに展開しておき、そこから読ませる。
const path = require('path'), fs = require('fs'), zlib = require('zlib');
let ready = null, worker = null;
function init(cacheDir) {
  if (ready) return ready;
  ready = (async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const dst = path.join(cacheDir, 'eng.traineddata');
    if (!fs.existsSync(dst)) fs.writeFileSync(dst, zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets', 'chat', 'eng.traineddata.gz'))));
    const { createWorker } = require('tesseract.js');
    worker = await createWorker('eng', 1, { cachePath: cacheDir, langPath: 'http://127.0.0.1:9/', gzip: false, logger: () => {} });
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    return worker;
  })();
  return ready;
}
async function recognize(cacheDir, png) {
  const w = await init(cacheDir);
  const r = await w.recognize(Buffer.from(png));
  return r.data.text;
}
async function terminate() { if (worker) await worker.terminate(); }
module.exports = { init, recognize, terminate };
