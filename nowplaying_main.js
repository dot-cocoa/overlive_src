// OverLIVE：再生中の曲を画面に出す（2026-11-02）
// ブラウザ（YouTube・YouTube Music など）で流している曲の「曲名・チャンネル（アーティスト）・サムネイル」を、
// Windows の「メディアの操作」（音量ボタンを押すと出る再生中の表示と同じ仕組み）から読み取り、
// 自分の画面の小さな窓（透明・クリック透過）と、配信用の窓・OBS 用ページ（/renderer/nowplaying.html?full=1）に出す。
// アプリは音楽を再生しない。ゲームにも触らない。製品版（通常版・カスタム版）だけ（EDITION.obs）
'use strict';
const { spawn } = require('child_process');

// 見た目（場所・大きさ）。基準 2560x1080 での右端・上の位置。rm＝右（MENU の表示の下）／lm＝左（ミニマップの下）
const LOOK_DEF = { pos: 'rm', dx: 0, dy: 0, size: 100, opacity: 70 };
const CARD = { w: 440, h: 112 };   // デザイン上の大きさ
function lookGeom(L) {
  const s = L.size / 100, w = CARD.w * s, h = CARD.h * s;
  const right = L.pos === 'lm' ? null : 2532 + L.dx, left = L.pos === 'lm' ? 40 + L.dx : null, top = (L.pos === 'lm' ? 700 : 690) + L.dy;
  return { s, w, h, right, left, top };
}

// Windows PowerShell（5.1）で「メディアの操作」のセッションを 1.5 秒ごとに見て、変わったときだけ 1 行の JSON を出す。
// ブラウザ以外（Spotify アプリなど）は出さない。再生中のものを優先。サムネイルは曲が変わったときだけ送る
const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') })[0]
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(5000); if ($task.IsCompleted) { $task.Result } else { $null } }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
if (-not $mgr) { [Console]::Out.WriteLine('{"error":"nomgr"}'); exit 1 }
[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()
$last = ''; $lastThumbKey = ''; $tries = 0; $triesKey = ''
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$script:thumbErr = ''
function ReadThumb($ref) {
  # 2026-11-03：DataReader だけだと読めない環境があった（「サムネイルを読み取れませんでした」）→ .NET のストリームに変えて読む方法を先に試し、だめなら DataReader。失敗した段階を thumbErr に残す
  $st = $null
  try { $st = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]) } catch { $script:thumbErr = 'open:' + $_.Exception.Message; return $null }
  if (-not $st) { $script:thumbErr = 'open'; return $null }
  $ct = ''; try { $ct = [string]$st.ContentType } catch {}
  if (-not $ct -or $ct -notmatch '^image/') { $ct = 'image/jpeg' }
  $bytes = $null; $script:thumbErr = ''
  # 11/03 4:30 ユーザーの PC：PowerShell の型変換（[IInputStream]$st）が「__ComObject を IInputStream に変換できません」で失敗
  #   → ① 型変換をせず、.NET の呼び出し（リフレクション）で AsStreamForRead に渡す（中で COM の型の問い合わせが行われる）
  try {
    $mi = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
    $ns = $mi.Invoke($null, @($st))
    $ms = New-Object System.IO.MemoryStream
    $ns.CopyTo($ms); $bytes = $ms.ToArray(); $ns.Dispose()
  } catch { $script:thumbErr = 'net:' + $_.Exception.InnerException.Message + $_.Exception.Message; $bytes = $null }
  #   → ② だめなら DataReader。大きさ（Size）が 0 と出るストリームがあるので、大きさに頼らず 64KB ずつ「あるだけ」読む
  if (-not $bytes -or $bytes.Length -eq 0) {
    try {
      $rd = New-Object Windows.Storage.Streams.DataReader($st.GetInputStreamAt(0))
      $rd.InputStreamOptions = [Windows.Storage.Streams.InputStreamOptions]::Partial
      $all = New-Object System.Collections.Generic.List[byte]
      for ($i = 0; $i -lt 60; $i++) {
        $n = Await ($rd.LoadAsync([uint32]65536)) ([uint32])
        if (-not $n) { break }
        $chunk = New-Object byte[] $n; $rd.ReadBytes($chunk); $all.AddRange($chunk)
      }
      if ($all.Count -gt 0) { $bytes = $all.ToArray() } else { $script:thumbErr = $script:thumbErr + ' dr:empty'; return $null }
    } catch { $script:thumbErr = $script:thumbErr + ' dr:' + $_.Exception.Message; return $null }
  }
  if ($bytes.Length -ge 3000000) { $script:thumbErr = 'big'; return $null }
  # 画像の頭のバイトで種類を決める（ブラウザが種類を空で渡すことがある）
  if ($bytes.Length -gt 4) {
    if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $ct = 'image/png' }
    elseif ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { $ct = 'image/jpeg' }
    elseif ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46 -and $bytes[3] -eq 0x46) { $ct = 'image/webp' }
  }
  $script:thumbErr = ''
  return 'data:' + $ct + ';base64,' + [Convert]::ToBase64String($bytes)
}
while ($true) {
  $best = $null
  foreach ($s in $mgr.GetSessions()) {
    $app = [string]$s.SourceAppUserModelId
    if ($app -notmatch '(?i)chrome|msedge|edge|firefox|brave|opera|vivaldi|youtube') { continue }
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if (-not $p -or -not $p.Title) { continue }
    $playing = ([string]$s.GetPlaybackInfo().PlaybackStatus) -eq 'Playing'
    $c = @{ title = [string]$p.Title; artist = [string]$p.Artist; album = [string]$p.AlbumTitle; app = $app; playing = $playing; th = $p.Thumbnail }
    if (-not $best -or ($playing -and -not $best.playing)) { $best = $c }
  }
  if ($best) { $key = $best.title + '|' + $best.artist + '|' + $best.playing } else { $key = '' }
  # サムネイルは曲が変わった直後はまだ用意されていないことがある（ブラウザが少し遅れて渡す）→ 取れるまで 1.5 秒ごとに最大 20 回やり直す
  $thumb = $null
  if ($best) {
    $tk = $best.title + '|' + $best.artist
    if ($tk -ne $triesKey) { $triesKey = $tk; $tries = 0 }
    if ($tk -ne $lastThumbKey -and $tries -lt 20) {
      $tries++
      if ($best.th) { $thumb = ReadThumb $best.th; if ($thumb) { $lastThumbKey = $tk } }
      if ($tries -eq 20 -and -not $thumb) { if ($best.th) { $why = 'read' } else { $why = 'none' }; $fo = [ordered]@{ thumbFail = $why; err = ([string]$script:thumbErr) }; if ($fo.err.Length -gt 160) { $fo.err = $fo.err.Substring(0, 160) }; [Console]::Out.WriteLine(($fo | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
    }
  }
  if ($key -ne $last -or $thumb) {
    $last = $key
    if ($best) {
      $o = [ordered]@{ title = $best.title; artist = $best.artist; album = $best.album; app = $best.app; playing = $best.playing; thumb = $thumb; sameThumb = ($tk -eq $lastThumbKey -and -not $thumb) }
      [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush()
    } else { [Console]::Out.WriteLine('{"none":true}'); [Console]::Out.Flush() }
  }
  Start-Sleep -Milliseconds 1500
}
`;

function create({ BrowserWindow, screen, OBS_PORT, readSettings, writeSettings, getControl, isHudOn, protect }) {
  const clients = new Set();
  let ps = null, win = null, retry = null, cur = null, thumb = null, status = 'off', thumbNote = '';
  const on = () => readSettings().nowPlaying === true;
  const clamp = (v, a, b, d) => { v = +v; return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  function look() {
    const L = { ...LOOK_DEF, ...(readSettings().nowPlayingLook || {}) };
    return { pos: L.pos === 'lm' ? 'lm' : 'rm', dx: clamp(L.dx, -800, 800, 0), dy: clamp(L.dy, -600, 300, 0), size: clamp(L.size, 50, 180, 100), opacity: clamp(L.opacity, 0, 95, 70) };
  }
  function broadcast(msg) { const d = 'data: ' + JSON.stringify(msg) + '\n\n'; for (const res of clients) { try { res.write(d); } catch { clients.delete(res); } } }
  const snapshot = () => ({ on: on(), look: look(), track: cur ? { ...cur, thumb } : null });

  // ---- 読み取り（PowerShell）----
  function startReader() {
    if (ps || process.platform !== 'win32' || !on()) { if (process.platform !== 'win32') { status = 'unsupported'; sendState(); } return; }
    clearTimeout(retry); retry = null;
    const enc = Buffer.from(PS, 'utf16le').toString('base64');
    try {
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { ps = null; status = 'error'; sendState(); return later(); }
    status = 'starting'; sendState();
    let buf = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
      if (buf.length > 8e6) buf = '';   // 念のため
    });
    ps.on('exit', () => { ps = null; if (on()) { status = 'error'; sendState(); later(); } });
  }
  function later() { if (on() && !retry) retry = setTimeout(startReader, 10000); }
  function stopReader() { clearTimeout(retry); retry = null; if (ps) { try { ps.kill(); } catch { /* 終わっている */ } ps = null; } }
  function onLine(line) {
    let m; try { m = JSON.parse(line.replace(/^﻿/, '')); } catch { return; }
    if (m.ready) { status = 'ready'; sendState(); return; }
    if (m.error) { status = 'error'; sendState(); return; }
    if (m.thumbFail) { thumbNote = m.thumbFail === 'none' ? 'ブラウザからサムネイルが届いていません' : 'サムネイルを読み取れませんでした' + (m.err ? `（${String(m.err).slice(0, 160)}）` : ''); sendState(); return; }
    if (m.none) { cur = null; thumb = null; broadcast({ track: null }); sendState(); return; }
    const t = { title: String(m.title || '').slice(0, 200), artist: String(m.artist || '').replace(/ - Topic$/, '').slice(0, 120), album: String(m.album || '').slice(0, 120), playing: !!m.playing };
    if (!cur || cur.title !== String(m.title || '').slice(0, 200)) thumbNote = '';
    if (m.thumb && /^data:image\/[a-z+]+;base64,/i.test(m.thumb)) { thumb = m.thumb; thumbNote = ''; }
    else if (!m.sameThumb && (!cur || cur.title !== t.title)) thumb = null;
    cur = t; status = 'ready';
    broadcast({ track: { ...cur, thumb } });
    sendState();
  }

  // ---- 自分の画面の窓（クリック透過）----
  function winBounds() {
    const d = (global.__overliveDisplay ? global.__overliveDisplay() : screen.getPrimaryDisplay()), b = d.bounds, k = b.height / 1080, g = lookGeom(look());
    const x = g.right != null ? b.x + Math.round(b.width - (2560 - (g.right - g.w)) * k) : b.x + Math.round(g.left * k);
    return { x, y: b.y + Math.round(g.top * k), width: Math.max(40, Math.round(g.w * k)), height: Math.max(30, Math.round(g.h * k)) };
  }
  function showWin() {
    const st = readSettings();
    const hudVisibleOrStreamOnly = isHudOn() || st.screenHud === false;
    if (!on() || st.nowPlayingScreen === false || !hudVisibleOrStreamOnly) { if (win && !win.isDestroyed()) win.hide(); return; }
    if (win && !win.isDestroyed()) { win.showInactive(); return; }
    win = new BrowserWindow({
      ...winBounds(),
      transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false, title: 'OverLIVE now playing',
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    if (protect) win.setContentProtection(true);
    win.loadURL(`http://127.0.0.1:${OBS_PORT}/renderer/nowplaying.html?fit=1`);
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => { win = null; });
  }
  function hideWin() { if (win && !win.isDestroyed()) win.hide(); }

  // ---- メニューとのやりとり ----
  function state() { return { on: on(), screen: readSettings().nowPlayingScreen !== false, status, track: cur, hasThumb: !!thumb, thumbNote, look: look(), url: `http://127.0.0.1:${OBS_PORT}/renderer/nowplaying.html?full=1` }; }
  function sendState() { const ctl = getControl(); if (ctl && !ctl.isDestroyed()) ctl.webContents.send('hud:input', { nowPlayingState: state() }); }
  function setOn(v) {
    writeSettings({ nowPlaying: !!v });
    if (v) { startReader(); showWin(); } else { stopReader(); hideWin(); cur = null; thumb = null; status = 'off'; }
    broadcast(snapshot()); sendState();
  }
  function setScreen(v) { writeSettings({ nowPlayingScreen: !!v }); showWin(); sendState(); }
  function setLook(patch) {
    writeSettings({ nowPlayingLook: { ...look(), ...(patch || {}) } });
    broadcast({ look: look() });
    if (win && !win.isDestroyed()) win.setBounds(winBounds());
    sendState();
  }
  // 見え方の確認用：見本の曲を 8 秒だけ出す
  function test() {
    const sample = { title: 'テスト曲 ― OverLIVE Theme（見本）', artist: 'ルピフレ', album: '', playing: true };
    let th = null; try { th = 'data:image/png;base64,' + require('fs').readFileSync(require('path').join(__dirname, 'assets', 'icon.png')).toString('base64'); } catch { /* 無ければ ♪ */ }
    broadcast({ track: { ...sample, thumb: th }, test: true });
    setTimeout(() => broadcast({ track: cur ? { ...cur, thumb } : null }), 8000);
    return { ok: true };
  }
  function sse(req, res, head) {
    res.writeHead(200, { ...head, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    res.write('data: ' + JSON.stringify({ hello: true, ...snapshot() }) + '\n\n');
    clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* 切れた */ } }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
  }
  function start() { if (on()) { startReader(); setTimeout(showWin, 1500); } }
  function stop() { stopReader(); }
  return { start, stop, setOn, setScreen, setLook, test, state, sse, showWin, hideWin, sendState };
}
module.exports = { create, lookGeom, LOOK_DEF, CARD };
