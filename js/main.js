// 起動・モード切替・入力。
//  - VR：Quest Browser の immersive-vr。参照空間は 'local'（開始時の頭の位置が原点）で着席プレイ前提。
//  - PCプレビュー：マウスドラッグで見回す。描画ロジック（city / effects / fall）は VR と共通。
// プレイヤー（カメラ）は一切動かさない。動くのは街だけ。視点への介入（揺れ・回転・切替）はしない。
import * as THREE from '../vendor/three.module.min.js';
import { City } from './city.js';
import { Streaks, Vignette } from './effects.js';
import { Wind } from './audio.js';
import { Fall, SPEEDS, WAIT_SECONDS } from './fall.js';
import { Hud } from './hud.js';

const $ = (id) => document.getElementById(id);
const titleEl = $('title');
const startBtn = $('btn-start');
const previewBtn = $('btn-preview');
const statusEl = $('xr-status');
const pcHud = $('pc-hud');
const pcPause = $('pc-pause');
const pcSpeed = $('pc-speed');
const pcVig = $('pc-vig');
const pcBack = $('pc-back');
const pcToast = $('pc-toast');

// ---------- 設定（タイトル画面で選択、ブラウザに記憶） ----------
const settings = { level: 0, vignette: true };
try {
  const s = JSON.parse(localStorage.getItem('ochite-iku-settings') || '{}');
  if (s.level >= 0 && s.level <= 2) settings.level = s.level;
  if (typeof s.vignette === 'boolean') settings.vignette = s.vignette;
} catch (e) { /* 保存できない環境では既定値 */ }
function saveSettings() {
  try { localStorage.setItem('ochite-iku-settings', JSON.stringify(settings)); } catch (e) { /* noop */ }
}
document.querySelectorAll('input[name=speed]').forEach((el) => {
  el.checked = Number(el.value) === settings.level;
  el.addEventListener('change', () => { settings.level = Number(el.value); fallModel.level = settings.level; saveSettings(); });
});
const vigBox = $('opt-vignette');
vigBox.checked = settings.vignette;
vigBox.addEventListener('change', () => { settings.vignette = vigBox.checked; saveSettings(); });

// ---------- レンダラーとシーン ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.2, 12000);
scene.add(camera);

const city = new City(scene);
const streaks = new Streaks(scene);
const vignette = new Vignette(scene);
const hud = new Hud(scene);
const wind = new Wind();
const fallModel = new Fall();
fallModel.level = settings.level;

let mode = 'title'; // 'title' | 'xr' | 'preview'

// PC用の視線（ヨー・ピッチ）。タイトル背景では少し見下ろす
let yaw = 0.35, pitch = -0.32;
function applyLook() {
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}
applyLook();

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- タイトル：WebXR 対応確認 ----------
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}
async function checkXR() {
  if (!window.isSecureContext) {
    setStatus('VRは HTTPS（または localhost）でのみ動きます。GitHub Pages の https:// のURLで開いてください。', true);
    return;
  }
  if (!('xr' in navigator)) {
    setStatus('このブラウザは WebXR に対応していません。Meta Quest 3 のブラウザで開くとVRで体験できます。', true);
    return;
  }
  let ok = false;
  try { ok = await navigator.xr.isSessionSupported('immersive-vr'); } catch (e) { console.warn(e); }
  if (ok) {
    startBtn.disabled = false;
    setStatus('VRで体験できます。座った状態で「落下開始」を押してください。');
  } else {
    setStatus('この環境はVR（immersive-vr）に対応していません。PCプレビューで体験できます。', true);
  }
}
checkXR();

// ---------- 共通：開始・終了 ----------
function beginFall() {
  fallModel.reset();
  fallModel.level = settings.level;
  city.reset();
  elapsed = 0;
}

// ---------- VR ----------
const pads = new Map(); // handedness → 前フレームのボタン状態
let gripHold = 0;
const EXIT_HOLD = 1.5;

async function startXR() {
  wind.init(); // ユーザー操作の中で音を有効化
  startBtn.disabled = true;
  setStatus('起動中…');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local'] });
  } catch (e) {
    console.error(e);
    setStatus(`VRを開始できませんでした（${e.name || 'Error'}: ${e.message || e}）。`, true);
    startBtn.disabled = false;
    return;
  }
  try {
    await renderer.xr.setSession(session);
  } catch (e) {
    console.error(e);
    setStatus(`VRの初期化に失敗しました（${e.message || e}）。`, true);
    startBtn.disabled = false;
    session.end().catch(() => {});
    return;
  }
  session.addEventListener('end', onXREnd);
  // Questのメニューを開いた等で体験が隠れたら、自動で一時停止しておく
  session.addEventListener('visibilitychange', () => {
    if (session.visibilityState !== 'visible' && !fallModel.paused) togglePause();
  });
  mode = 'xr';
  titleEl.hidden = true;
  camera.rotation.set(0, 0, 0);
  pads.clear();
  gripHold = 0;
  beginFall();
  xrIntroShown = false;
}

let xrIntroShown = false;
function onXREnd() {
  mode = 'title';
  titleEl.hidden = false;
  startBtn.disabled = false;
  setStatus('おつかれさまでした。もう一度落ちるには「落下開始」。');
  hud.hide();
  hud.mesh.visible = false;
  wind.suspend();
  fallModel.reset();
  city.reset();
  yaw = 0.35; pitch = -0.32;
  applyLook();
  camera.position.set(0, 0, 0);
}

startBtn.addEventListener('click', startXR);

function headPose() {
  const xrCam = renderer.xr.getCamera();
  return { position: xrCam.position.clone(), quaternion: xrCam.quaternion.clone() };
}

function pulse(src, strength, ms) {
  const h = src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
  if (h && h.pulse) { try { h.pulse(strength, ms); } catch (e) { /* noop */ } }
}

function xrInput(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  let anyGrip = false;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const key = src.handedness || 'none';
    const btn = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.6));
    const now = { trig: btn(0), grip: btn(1), a: btn(4), b: btn(5) };
    const prev = pads.get(key) || now; // 初回フレームは押しっぱなしを誤検出しない
    if (now.trig && !prev.trig) { togglePause(); pulse(src, 0.3, 40); }
    if (now.a && !prev.a) { cycleSpeed(); pulse(src, 0.2, 30); }
    if (now.b && !prev.b) { toggleVignette(); pulse(src, 0.2, 30); }
    if (now.grip) anyGrip = true;
    pads.set(key, now);
  }
  if (anyGrip) {
    gripHold += dt;
    hud.show(['終了しますか？', 'グリップを握ったままで終了', '離すとキャンセル'], headPose(), { sticky: true, reposition: gripHold <= dt });
    hud.setProgress(Math.min(gripHold / EXIT_HOLD, 1));
    if (gripHold >= EXIT_HOLD) {
      gripHold = -999; // 二重に終了処理しない
      session.end().catch(() => {});
    }
  } else if (gripHold > 0) {
    gripHold = 0;
    hud.setProgress(0);
    showPauseOrHide();
  }
}

function showPauseOrHide() {
  if (mode !== 'xr') return;
  if (fallModel.paused) {
    hud.show(['一時停止中', 'トリガー：再開', 'グリップ長押し：終了'], headPose(), { sticky: true });
  } else {
    hud.hide();
  }
}

// ---------- 操作（VR・PC共通） ----------
function togglePause() {
  if (mode === 'title') return;
  fallModel.paused = !fallModel.paused;
  if (mode === 'xr') showPauseOrHide();
  else toast(fallModel.paused ? '一時停止' : '再開');
  syncPcHud();
}
function cycleSpeed() {
  setSpeed((fallModel.level + 1) % SPEEDS.length);
}
function setSpeed(level) {
  fallModel.level = settings.level = level;
  saveSettings();
  document.querySelectorAll('input[name=speed]').forEach((el) => { el.checked = Number(el.value) === level; });
  notify(`落下速度：${SPEEDS[level].name}`);
}
function toggleVignette() {
  settings.vignette = !settings.vignette;
  vigBox.checked = settings.vignette;
  saveSettings();
  notify(`視野制限：${settings.vignette ? 'ON' : 'OFF'}`);
}
function notify(text) {
  if (mode === 'xr') {
    if (fallModel.paused) hud.show(['一時停止中', text, 'トリガー：再開'], headPose(), { sticky: true, reposition: false });
    else hud.show([text], headPose(), { duration: 2 });
  } else toast(text);
  syncPcHud();
}

// ---------- PCプレビュー ----------
let toastTimer = 0;
function toast(text) {
  pcToast.textContent = text;
  pcToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => pcToast.classList.remove('show'), 1800);
}
function syncPcHud() {
  pcPause.textContent = fallModel.paused ? '▶ 再開 (Space)' : '❚❚ 一時停止 (Space)';
  pcSpeed.textContent = `速度：${SPEEDS[fallModel.level].name} (1/2/3)`;
  pcVig.textContent = `視野制限：${settings.vignette ? 'ON' : 'OFF'} (V)`;
}

function startPreview() {
  wind.init();
  mode = 'preview';
  titleEl.hidden = true;
  pcHud.hidden = false;
  document.body.classList.add('preview');
  yaw = 0.35; pitch = -0.25;
  applyLook();
  beginFall();
  syncPcHud();
  toast('ドラッグで見回す。数秒後に落ち始めます');
}
function endPreview() {
  mode = 'title';
  titleEl.hidden = false;
  pcHud.hidden = true;
  document.body.classList.remove('preview');
  wind.suspend();
  fallModel.reset();
  city.reset();
  yaw = 0.35; pitch = -0.32;
  applyLook();
}
previewBtn.addEventListener('click', startPreview);
pcPause.addEventListener('click', togglePause);
pcSpeed.addEventListener('click', cycleSpeed);
pcVig.addEventListener('click', toggleVignette);
pcBack.addEventListener('click', endPreview);

let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode !== 'preview') return;
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  const k = 0.0042;
  yaw += (e.clientX - drag.x) * k;
  pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag.y) * k));
  drag.x = e.clientX; drag.y = e.clientY;
  applyLook();
});
const endDrag = () => { drag = null; };
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

window.addEventListener('keydown', (e) => {
  if (mode !== 'preview') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1' || e.key === '2' || e.key === '3') setSpeed(Number(e.key) - 1);
  else if (e.key === 'v' || e.key === 'V') toggleVignette();
  else if (e.key === 'Escape') endPreview();
  else if (e.key === 'ArrowLeft') { yaw += 0.08; applyLook(); }
  else if (e.key === 'ArrowRight') { yaw -= 0.08; applyLook(); }
  else if (e.key === 'ArrowUp') { pitch = Math.min(1.5, pitch + 0.08); applyLook(); }
  else if (e.key === 'ArrowDown') { pitch = Math.max(-1.5, pitch - 0.08); applyLook(); }
});

// ---------- ループ ----------
const clock = new THREE.Clock();
let elapsed = 0;
let titleTime = 0;

function loop() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (mode === 'xr' || mode === 'preview') {
    if (mode === 'xr') {
      xrInput(dt);
      if (!xrIntroShown && renderer.xr.isPresenting) {
        xrIntroShown = true;
        hud.show(['落ちていく', 'トリガー：一時停止　A/X：速度', 'B/Y：視野制限　グリップ長押し：終了'], headPose(), { duration: WAIT_SECONDS + 3 });
      }
    }
    fallModel.update(dt);
    elapsed += dt;
    city.update(fallModel.fall, elapsed);
    streaks.update(fallModel.fall, fallModel.v);
    vignette.update(settings.vignette, fallModel.speedFrac, dt);
    wind.update(fallModel.v, dt, 1);
  } else {
    // タイトル背景：静止した上空の眺め（屋上の灯りや広告だけが動く）
    titleTime += dt;
    city.update(0, titleTime);
    streaks.update(0, 0);
    vignette.update(false, 0, dt);
  }
  hud.update(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(loop);

// 自動検証用（PCプレビュー）
window.__ochite = { fallModel, city, settings, camera, renderer, hud, startPreview, endPreview, togglePause, setSpeed,
  look: (y, p) => { yaw = y; pitch = p; applyLook(); } };
