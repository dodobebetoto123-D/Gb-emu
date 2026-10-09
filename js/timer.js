// timer.js — DIV / TIMA / TMA / TAC 타이머
// 기준: Pan Docs "Timer and Divider Registers"
// 내부 16비트 sysCounter가 마스터 클럭으로 증가하고, DIV/TIMA가 여기서 파생됨.

export class Timer {
  constructor(interrupt) {
    this.interrupt = interrupt; // timer 인터럽트(비트 2) 요청용
    this.sysCounter = 0;  // 내부 16비트 카운터
    this.tima = 0;        // 0xFF05 카운터
    this.tma = 0;         // 0xFF06 모듈로
    this.tac = 0;         // 0xFF07 제어 (하위 3비트만 유효)
  }

  // TAC 클럭 선택 → 감시할 sysCounter 비트 (4096/262144/65536/16384 Hz)
  static WATCH_BITS = [9, 3, 5, 7];

  // 폴링 엣지 검출 대상: (감시 비트) AND (TAC bit2 enable)
  _andResult(sys = this.sysCounter, tac = this.tac) {
    const bit = Timer.WATCH_BITS[tac & 0x03];
    const enabled = (tac >> 2) & 0x01;
    return ((sys >> bit) & 0x01) & enabled;
  }

  // TIMA 1 증가 + 오버플로우 처리
  _incTima() {
    this.tima++;
    if (this.tima > 0xff) {
      this.tima = this.tma;      // 오버플로우 시 TMA 로드
      this.interrupt.request(2); // timer 인터럽트 요청
    }
  }

  // dots: PPU 도트 단위. GBC 2배속이면 T-사이클이 2배로 들어감.
  step(dots, doubleSpeed) {
    const ticks = dots * (doubleSpeed ? 2 : 1);
    for (let i = 0; i < ticks; i++) {
      const before = this._andResult();
      this.sysCounter = (this.sysCounter + 1) & 0xffff;
      const after = this._andResult();
      if (before === 1 && after === 0) this._incTima(); // 1→0 폴링 엣지
    }
  }

  read8(addr) {
    switch (addr & 0xffff) {
      case 0xff04: return (this.sysCounter >> 8) & 0xff; // DIV
      case 0xff05: return this.tima;                    // TIMA
      case 0xff06: return this.tma;                     // TMA
      case 0xff07: return (this.tac & 0x07) | 0xf8;      // TAC (상위 비트는 1로 읽힘)
      default: return 0xff;
    }
  }

  write8(addr, v) {
    v &= 0xff;
    switch (addr & 0xffff) {
      case 0xff04:
        // DIV 쓰기 = sysCounter 리셋. 리셋으로 AND 결과가 1→0이 되면 TIMA 증가 (실기 동작)
        if (this._andResult() === 1) {
          this.sysCounter = 0;
          if (this._andResult() === 0) this._incTima();
        } else {
          this.sysCounter = 0;
        }
        break;
      case 0xff05:
        this.tima = v;
        break;
      case 0xff06:
        this.tma = v;
        break;
      case 0xff07: {
        // TAC 변경으로 AND 결과가 1→0이 되면 TIMA 증가 (실기 동작)
        const before = this._andResult();
        this.tac = v & 0x07;
        if (before === 1 && this._andResult() === 0) this._incTima();
        break;
      }
    }
  }
}
