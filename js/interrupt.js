// interrupt.js — IE/IF, IME, 인터럽트 서비스
// 기준: Pan Docs "Interrupts"
// 비트: 0=VBlank, 1=STAT, 2=Timer, 3=Serial, 4=Joypad
// 벡터: 0x40, 0x48, 0x50, 0x58, 0x60 (우선순위는 비트 번호 낮은 순)

const VECTORS = [0x40, 0x48, 0x50, 0x58, 0x60];

export class Interrupt {
  constructor() {
    this.ime = false; // 인터럽트 마스터 활성화 (DI/EI/RETI가 조작)
    this.ie = 0x00;   // 0xFFFF 인터럽트 활성화 레지스터
    this._if = 0x00;  // 0xFF0F 인터럽트 플래그 (하위 5비트만 유효)
  }

  // 인터럽트 발생 요청 (bit 0-4)
  request(bit) {
    this._if |= (1 << (bit & 0x07));
    this._if &= 0x1f;
  }

  // 인터럽트 처리. cpu는 { pc, sp, mmu } 를 제공해야 함.
  // 처리했으면 소비한 20 T-사이클 반환, 아니면 0.
  service(cpu) {
    const pending = this.ie & this._if & 0x1f;
    if (!this.ime || pending === 0) return 0;

    // 우선순위: 비트 번호 낮은 순
    let bit = 0;
    while (((pending >> bit) & 0x01) === 0) bit++;

    this.ime = false;            // 처리 중에는 인터럽트 비활성화
    this._if &= ~(1 << bit);     // 해당 IF 비트 클리어

    // PC를 스택에 푸시 (리틀 엔디언)
    const pc = cpu.pc & 0xffff;
    cpu.sp = (cpu.sp - 2) & 0xffff;
    cpu.mmu.write8(cpu.sp, pc & 0xff);
    cpu.mmu.write8((cpu.sp + 1) & 0xffff, (pc >> 8) & 0xff);

    cpu.pc = VECTORS[bit]; // 벡터로 점프
    return 20; // 인터럽트 서비스 고정 소비 사이클
  }

  readIE() {
    return this.ie & 0xff;
  }

  writeIE(v) {
    this.ie = v & 0xff;
  }

  readIF() {
    return (this._if & 0x1f) | 0xe0; // 상위 3비트는 1로 읽힘
  }

  writeIF(v) {
    this._if = v & 0x1f; // 하위 5비트만 쓰기 가능
  }
}
