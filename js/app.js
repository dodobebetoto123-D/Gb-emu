// app.js — 프론트엔드 로직 (canvas, 키보드, 파일 로더, rAF 루프)

import { Emulator } from './emu.js';

// ---- DOM ----
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const fileInput = document.getElementById('rom-file');
const dropzone = document.getElementById('dropzone');
const btnPower = document.getElementById('btn-power');   // 시작/일시정지 토글
const btnReset = document.getElementById('btn-reset');
const statusTitle = document.getElementById('rom-title');
const statusMode = document.getElementById('rom-mode');

// ---- 에뮬레이터 ----
const emu = new Emulator();
let running = false;      // rAF 루프에서 stepFrame을 돌릴지
let romLoaded = false;

// 160x144 RGBA 프레임을 그대로 그린다 (canvas 자체는 160x144, CSS로 3배 확대)
const W = 160, H = 144;
const imageData = ctx.createImageData(W, H);

// ---- 키보드 매핑 ----
// 방향키, Z=B, X=A, Enter=Start, Shift=Select
const KEYMAP = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  z: 'b', Z: 'b',
  x: 'a', X: 'a',
  Enter: 'start',
  Shift: 'select',
};

window.addEventListener('keydown', (e) => {
  // 방향키/스페이스의 기본 동작(스크롤 등) 방지
  if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
  // 키 반복 입력은 무시 (버튼 상태가 이미 눌림이면 전이가 안 생기니 실무상 무해)
  if (e.repeat) return;
  const btn = KEYMAP[e.key];
  if (btn) emu.setButton(btn, true);
});

window.addEventListener('keyup', (e) => {
  const btn = KEYMAP[e.key];
  if (btn) emu.setButton(btn, false);
});

// ---- 롬 로드 ----
// ArrayBuffer → Uint8Array → emu.loadROM
function loadRomFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      emu.loadROM(new Uint8Array(reader.result));
      romLoaded = true;
      statusTitle.textContent = '롬: ' + (emu.romTitle || '(제목 없음)');
      statusMode.textContent = '모드: ' + (emu.isGBC ? 'GBC (컬러)' : 'DMG (흑백)');
      running = true;                 // 롬 올리면 바로 실행 시작
      btnPower.textContent = '일시정지';
    } catch (err) {
      statusTitle.textContent = '롬 로드 실패: ' + err.message;
      statusMode.textContent = '';
    }
  };
  reader.onerror = () => {
    statusTitle.textContent = '파일 읽기 실패';
  };
  reader.readAsArrayBuffer(file);
}

fileInput.addEventListener('change', () => {
  loadRomFile(fileInput.files[0]);
  fileInput.value = '';   // 같은 파일 다시 올릴 수 있게 초기화
});

// 드래그앤드롭
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragging');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  if (e.dataTransfer.files.length > 0) loadRomFile(e.dataTransfer.files[0]);
});

// ---- 버튼 ----
btnPower.addEventListener('click', () => {
  if (!romLoaded) return;
  running = !running;
  btnPower.textContent = running ? '일시정지' : '시작';
});

btnReset.addEventListener('click', () => {
  if (!romLoaded) return;
  emu.reset();
});

// ---- 메인 루프 (rAF) ----
function frame() {
  requestAnimationFrame(frame);
  if (!running || !romLoaded) return;
  emu.stepFrame();
  imageData.data.set(emu.getFrame());
  ctx.putImageData(imageData, 0, 0);
}
requestAnimationFrame(frame);
