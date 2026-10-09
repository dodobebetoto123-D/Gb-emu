// emu.js — 전체 통합 (Emulator 클래스, 프레임 루프)
//
// 생성 순서: interrupt → timer → ppu → joypad → apu
// loadROM 시: cartridge → mmu → cpu, 모듈 간 배선(ppu.mmu, ppu.isGBC, cpu.isGBC)
//
// 타이밍 (DESIGN.md 2절):
// - 마스터 클럭 4,194,304Hz (T-사이클). 1 프레임 = 70,224 T-사이클.
// - CPU/인터럽트가 소비한 T-사이클 c → PPU/타이머에는 도트 단위로 전달.
// - GBC 2배속: CPU는 도트당 2 T-사이클 소비 → dots = c/2.

import { Interrupt } from './interrupt.js';
import { Timer } from './timer.js';
import { PPU } from './ppu.js';
import { Joypad } from './joypad.js';
import { APU } from './apu.js';
import { Cartridge } from './cartridge.js';
import { MMU } from './mmu.js';
import { CPU } from './cpu.js';

// 안전장치: 1프레임 최대 T-사이클 (70,224 * 4)
const MAX_CYCLES_PER_FRAME = 70224 * 4;

export class Emulator {
  constructor() {
    this.interrupt = new Interrupt();
    this.timer = new Timer(this.interrupt);
    this.ppu = new PPU(this.interrupt);
    this.joypad = new Joypad(this.interrupt);
    this.apu = new APU();
    // loadROM 전까지는 없음
    this.cart = null;
    this.mmu = null;
    this.cpu = null;
    this.romLoaded = false;
  }

  // 롬 로드: 카트리지 생성 → GBC 판별 → mmu/cpu 생성 → 전체 리셋
  loadROM(uint8) {
    this.cart = new Cartridge(uint8);
    this.ppu.isGBC = this.cart.isGBC;
    this.mmu = new MMU({
      cart: this.cart,
      ppu: this.ppu,
      timer: this.timer,
      joypad: this.joypad,
      apu: this.apu,
      interrupt: this.interrupt,
    });
    this.ppu.mmu = this.mmu;        // HDMA 콜백(hdmaHBlank)용
    this.cpu = new CPU(this.mmu, this.interrupt);
    this.cpu.isGBC = this.cart.isGBC;
    this.reset();
    this.romLoaded = true;
  }

  // 부트 스킵 초기화 (DESIGN.md 4절은 cpu.reset이 담당)
  reset() {
    if (!this.cpu) return;   // 롬 미로드 상태에서는 아무 것도 안 함
    this.cpu.reset();
    this.ppu.frameReady = false;
  }

  // 프레임 완성(ppu.frameReady)까지 메인 루프 실행
  stepFrame() {
    if (!this.cpu) return;
    this.ppu.doubleSpeed = this.mmu.doubleSpeed; // DESIGN 3.6: emu가 KEY1 반영 값을 설정 (참고용)
    let elapsed = 0;
    while (!this.ppu.frameReady && elapsed < MAX_CYCLES_PER_FRAME) {
      // 1) CPU 1 명령어 실행 (+ DMA 스톨 회수)
      let c = this.cpu.step();
      c += this.mmu.takeDmaStall();
      elapsed += c;

      // 2) T-사이클 → 도트로 환산해 주변 장치에 전달
      const dots = this.mmu.doubleSpeed ? Math.floor(c / 2) : c;
      this.timer.step(dots, this.mmu.doubleSpeed);
      this.ppu.step(dots);
      this.apu.step(c);

      // 3) 인터럽트 서비스 (있으면 20 T-사이클 소비)
      const c2 = this.interrupt.service(this.cpu);
      if (c2 > 0) {
        elapsed += c2;
        const dots2 = this.mmu.doubleSpeed ? Math.floor(c2 / 2) : c2;
        this.timer.step(dots2, this.mmu.doubleSpeed);
        this.ppu.step(dots2);
        this.apu.step(c2);
      }
    }
    // 프레임이 끝났으면 플래그 리셋 (다음 프레임을 위해)
    this.ppu.frameReady = false;
  }

  // 현재 프레임 이미지 (160*144*4 RGBA)
  getFrame() {
    return this.ppu.getFrame();
  }

  // 프론트엔드 입력 전달
  setButton(name, pressed) {
    this.joypad.setButton(name, pressed);
  }

  get isGBC() {
    return this.cart ? this.cart.isGBC : false;
  }

  get romTitle() {
    return this.cart ? this.cart.title : '';
  }
}
