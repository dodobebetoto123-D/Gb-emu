/**
 * cpu.js — Sharp LR35902 CPU 인터프리터 (Game Boy / Game Boy Color)
 *
 * Prompt to Reality Inc. — GB-EMU 프로젝트, CPU 모듈.
 * ES 모듈. 주석은 한국어.
 *
 * 인터페이스 (DESIGN.md 3.5):
 *   new CPU(mmu, interrupt) — mmu: read8/write8, interrupt: {ime, service, readIE, readIF}
 *   cpu.reset() — DESIGN.md 4절 부트 스킵 초기화 (DMG/GBC는 cpu.isGBC 플래그로 구분, emu가 설정)
 *   cpu.step()  — 1 명령어 실행 후 소비한 T-사이클 수 반환
 *   레지스터 필드: a, f, b, c, d, e, h, l, sp, pc, halted(boolean), isGBC(boolean)
 *   F 플래그: Z=bit7, N=bit6, H=bit5, C=bit4 (하위 4비트는 항상 0)
 *
 * 구현 범위: 기본 오프코드 256개 + CB 프리픽스 256개 전부.
 * 사이클은 T-사이클 기준, 조건 분기는 taken/not-taken을 구분.
 *
 * 단순화/편의 사항 (v1):
 *  1. EI는 즉시 적용한다. 실기는 1명령어 지연이지만 DESIGN.md 3.5에서 v1 즉시 적용을 허용.
 *  2. HALT 버그는 구현함: IME=0인 상태에서 인터럽트가 pending(IE&IF)일 때 HALT를 실행하면
 *     halt 상태에 진입하지 않고, 다음 명령어 fetch 때 PC가 증가하지 않는다
 *     (HALT 다음 바이트가 두 번 읽히는 하드웨어 버그 재현).
 *  3. HALT 대기 중에는 step() 호출마다 4 T-사이클(1 M-사이클)을 반환한다.
 *     IME=1 + pending이면 halt를 풀고 즉시 4를 반환 → emu 루프의 interrupt.service()가
 *     같은 반복에서 인터럽트를 처리한다 (다음 명령어가 먼저 실행되지 않음).
 *     IME=0 + pending이면 halt만 풀고 서비스 없이 다음 명령어로 진행한다 (실기 동작).
 *  4. STOP(0x10): 두 번째 바이트(관례상 0x00)를 소비한 뒤 mmu.requestSpeedSwitch()를
 *     호출하고 계속 진행한다. DMG에서는 MMU가 무시하므로 NOP처럼 동작한다.
 *     속도 전환에 걸리는 추가 스톨은 MMU 담당 (CPU는 4 T-사이클만 반환).
 *  5. 유효하지 않은 오프코드($D3,$DB,$DD,$E3,$E4,$EB,$EC,$ED,$F4,$FC,$FD)는
 *     실기처럼 CPU를 hard-lock시킨다. locked 플래그가 서면 이후 step()은 PC를
 *     진행시키지 않고 계속 4를 반환한다 (전원 차단까지 해제 불가).
 *  6. reset()의 TAC(0xFF07)=0x00은 DESIGN.md 4절 기준. Pan Docs 실측값은 0xF8이나
 *     어느 쪽이든 타이머 비활성화 상태라 기능상 동일하다.
 *  7. reset()에서 HDMA5(0xFF55) 쓰기를 생략한다. 0xFF 쓰기가 MMU의 HDMA 개시로
 *     해석될 수 있어 스킵하고, MMU 전원 투입 초기값(0xFF = 비활성)을 신뢰한다.
 *     HDMA1-4(0xFF51-0xFF54)는 0xFF로 설정한다.
 *  8. NR52(0xFF26)는 DESIGN.md 기준 DMG=0xF1, CGB=0xF0.
 *  9. GBC 2배속 모드에서도 CPU는 항상 T-사이클을 반환한다. 도트 단위 변환은
 *     emu.js 담당 (DESIGN.md 2절).
 * 10. console.log 없음. 롬/BIOS 파일을 포함하거나 참조하지 않음.
 *
 * 참고 자료:
 *  - Pan Docs: https://gbdev.io/pandocs/
 *    (CPU_Instruction_Set 인코딩 블록 구조, Interrupts의 IME/서비스 절차·HALT 버그 언급,
 *     Power_Up_Sequence의 부트 레지스터/I-O 초기값 표)
 *  - pastraiser Gameboy(LR35902) OPCODES 표:
 *    https://www.pastraiser.com/cpu/gameboy/gameboy_opcodes.html
 *    (오프코드별 사이클·플래그 영향 대조)
 */

// ---- F 레지스터 플래그 비트 ----
const FLAG_Z = 0x80; // Zero
const FLAG_N = 0x40; // Subtract
const FLAG_H = 0x20; // Half Carry
const FLAG_C = 0x10; // Carry

// 유효하지 않은 오프코드: 실기에서 CPU를 hard-lock시킴 (Pan Docs)
const INVALID_OPCODES = new Set([
  0xD3, 0xDB, 0xDD, 0xE3, 0xE4, 0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD,
]);

export class CPU {
  /**
   * @param {object} mmu — read8(addr), write8(addr, v), requestSpeedSwitch()
   * @param {object} interrupt — ime(boolean), service(cpu), readIE(), readIF()
   */
  constructor(mmu, interrupt) {
    this.mmu = mmu;
    this.interrupt = interrupt;

    // 8비트 레지스터
    this.a = 0; this.f = 0;
    this.b = 0; this.c = 0;
    this.d = 0; this.e = 0;
    this.h = 0; this.l = 0;
    // 16비트 레지스터
    this.sp = 0;
    this.pc = 0;
    // 상태 플래그
    this.halted = false;  // HALT 대기 중
    this.isGBC = false;   // emu가 설정 (부트 초기화 값 선택용)
    this.haltBug = false; // 다음 fetch에서 PC 미증가 (HALT 버그)
    this.locked = false;  // invalid opcode hard-lock
  }

  /**
   * 부트 스킵 초기화 (DESIGN.md 4절).
   * DMG: A=0x01 F=0xB0 / GBC: A=0x11 F=0x80, 나머지 레지스터는 동일.
   * I/O 레지스터는 mmu.write8 경유로 각 모듈(timer/ppu/apu/interrupt)에 전달.
   */
  reset() {
    const gbc = this.isGBC;

    this.a = gbc ? 0x11 : 0x01;
    this.f = gbc ? 0x80 : 0xB0;
    this.b = 0x00; this.c = 0x13;
    this.d = 0x00; this.e = 0xD8;
    this.h = 0x01; this.l = 0x4D;
    this.sp = 0xFFFE;
    this.pc = 0x0100;

    this.halted = false;
    this.haltBug = false;
    this.locked = false;
    if (this.interrupt) this.interrupt.ime = false;

    const W = (addr, v) => this.mmu.write8(addr, v);

    // 타이머 (DIV는 쓰기 시 리셋이라 목록에 없음)
    W(0xFF05, 0x00); // TIMA
    W(0xFF06, 0x00); // TMA
    W(0xFF07, 0x00); // TAC (DESIGN.md 기준, 주석 6번 참고)
    // 인터럽트
    W(0xFF0F, 0x00); // IF (하위 5비트만 유효)
    W(0xFFFF, 0x00); // IE
    // PPU
    W(0xFF40, 0x91); // LCDC
    W(0xFF42, 0x00); // SCY
    W(0xFF43, 0x00); // SCX
    W(0xFF44, 0x00); // LY (읽기 전용이라 PPU가 무시)
    W(0xFF45, 0x00); // LYC
    W(0xFF47, 0xFC); // BGP
    W(0xFF48, 0xFF); // OBP0
    W(0xFF49, 0xFF); // OBP1
    W(0xFF4A, 0x00); // WY
    W(0xFF4B, 0x00); // WX
    // APU
    W(0xFF10, 0x80); W(0xFF11, 0xBF); W(0xFF12, 0xF3); W(0xFF14, 0xBF);
    W(0xFF16, 0x3F); W(0xFF17, 0x00); W(0xFF19, 0xBF);
    W(0xFF1A, 0x7F); W(0xFF1B, 0xFF); W(0xFF1C, 0x9F); W(0xFF1E, 0xBF);
    W(0xFF20, 0xFF); W(0xFF21, 0x00); W(0xFF22, 0x00); W(0xFF23, 0xBF);
    W(0xFF24, 0x77); W(0xFF25, 0xF3);
    W(0xFF26, gbc ? 0xF0 : 0xF1); // NR52 (DESIGN.md 기준)
    // GBC 전용
    if (gbc) {
      W(0xFF4D, 0x00); // KEY1
      W(0xFF4F, 0x00); // VBK
      W(0xFF51, 0xFF); W(0xFF52, 0xFF); // HDMA1-2
      W(0xFF53, 0xFF); W(0xFF54, 0xFF); // HDMA3-4
      // 0xFF55(HDMA5)는 생략 — 주석 7번 참고
      W(0xFF68, 0x00); W(0xFF69, 0x00); // BGPI/BGPD
      W(0xFF6A, 0x00); W(0xFF6B, 0x00); // OBPI/OBPD
      W(0xFF70, 0x01); // SVBK: WRAM 뱅크 1
    }
  }

  /**
   * 1 명령어를 실행하고 소비한 T-사이클 수를 반환.
   */
  step() {
    // invalid opcode hard-lock: 영원히 4 T-사이클만 소모
    if (this.locked) return 4;

    // HALT 대기: 인터럽트 요청(IE & IF)이 올 때까지 저전력 대기
    if (this.halted) {
      if (this._pendingIrqs() !== 0) {
        this.halted = false;
        if (this.interrupt && this.interrupt.ime) {
          // IME=1이면 다음 명령어를 실행하지 않고 즉시 반환.
          // emu 루프의 interrupt.service(cpu)가 같은 반복에서 인터럽트를 처리한다.
          return 4;
        }
        // IME=0이면 서비스 없이 halt만 풀고 다음 명령어로 진행 (실기 동작)
      } else {
        return 4;
      }
    }

    // 명령어 fetch (HALT 버그가 서 있으면 PC를 증가시키지 않음)
    let opcode;
    if (this.haltBug) {
      opcode = this.mmu.read8(this.pc);
      this.haltBug = false;
    } else {
      opcode = this._fetch();
    }

    return this._execute(opcode);
  }

  // ================= 내부 헬퍼 =================

  /** 1바이트 fetch (PC 증가) */
  _fetch() {
    const v = this.mmu.read8(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    return v;
  }

  /** 2바이트 fetch, 리틀 엔디안 */
  _fetch16() {
    const lo = this._fetch();
    const hi = this._fetch();
    return (hi << 8) | lo;
  }

  /** 부호 있는 8비트 변환 */
  _s8(v) {
    return v < 0x80 ? v : v - 0x100;
  }

  /** 8비트 레지스터 읽기. 인덱스: 0=B 1=C 2=D 3=E 4=H 5=L 6=(HL) 7=A */
  _getR8(i) {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.mmu.read8((this.h << 8) | this.l);
      default: return this.a; // 7
    }
  }

  /** 8비트 레지스터 쓰기 */
  _setR8(i, v) {
    v &= 0xFF;
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 6: this.mmu.write8((this.h << 8) | this.l, v); break;
      default: this.a = v; break; // 7
    }
  }

  /** 16비트 레지스터 읽기. 0=BC 1=DE 2=HL 3=SP */
  _getRP(i) {
    switch (i) {
      case 0: return (this.b << 8) | this.c;
      case 1: return (this.d << 8) | this.e;
      case 2: return (this.h << 8) | this.l;
      default: return this.sp; // 3
    }
  }

  /** 16비트 레지스터 쓰기 */
  _setRP(i, v) {
    v &= 0xFFFF;
    switch (i) {
      case 0: this.b = v >> 8; this.c = v & 0xFF; break;
      case 1: this.d = v >> 8; this.e = v & 0xFF; break;
      case 2: this.h = v >> 8; this.l = v & 0xFF; break;
      default: this.sp = v; break; // 3
    }
  }

  /** PUSH/POP용 16비트 레지스터 읽기. 0=BC 1=DE 2=HL 3=AF */
  _getRP2(i) {
    switch (i) {
      case 0: return (this.b << 8) | this.c;
      case 1: return (this.d << 8) | this.e;
      case 2: return (this.h << 8) | this.l;
      default: return (this.a << 8) | this.f; // 3: AF
    }
  }

  /** PUSH/POP용 16비트 레지스터 쓰기 (AF는 F 하위 4비트 마스크) */
  _setRP2(i, v) {
    v &= 0xFFFF;
    switch (i) {
      case 0: this.b = v >> 8; this.c = v & 0xFF; break;
      case 1: this.d = v >> 8; this.e = v & 0xFF; break;
      case 2: this.h = v >> 8; this.l = v & 0xFF; break;
      default: this.a = v >> 8; this.f = v & 0xF0; break; // 3: AF
    }
  }

  /** 스택에 16비트 push (상위 바이트 먼저) */
  _push(v) {
    this.sp = (this.sp - 1) & 0xFFFF;
    this.mmu.write8(this.sp, (v >> 8) & 0xFF);
    this.sp = (this.sp - 1) & 0xFFFF;
    this.mmu.write8(this.sp, v & 0xFF);
  }

  /** 스택에서 16비트 pop */
  _pop() {
    const lo = this.mmu.read8(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    const hi = this.mmu.read8(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    return (hi << 8) | lo;
  }

  /** 대기 중인 인터럽트 (IE & IF 하위 5비트). mock interrupt 대비 방어. */
  _pendingIrqs() {
    const intr = this.interrupt;
    if (intr && typeof intr.readIE === 'function' && typeof intr.readIF === 'function') {
      return (intr.readIE() & intr.readIF()) & 0x1F;
    }
    return 0;
  }

  /** 조건 코드 판정. 0=NZ 1=Z 2=NC 3=C */
  _checkCond(cc) {
    const z = (this.f & FLAG_Z) !== 0;
    const c = (this.f & FLAG_C) !== 0;
    switch (cc) {
      case 0: return !z;
      case 1: return z;
      case 2: return !c;
      default: return c; // 3
    }
  }

  /** 8비트 덧셈 (c: 캐리 입력 0/1). 결과 반환, 플래그 ZNHC 설정. */
  _add8(a, b, c) {
    const r = a + b + c;
    let f = 0;
    if ((r & 0xFF) === 0) f |= FLAG_Z;
    if (((a & 0xF) + (b & 0xF) + c) > 0xF) f |= FLAG_H;
    if (r > 0xFF) f |= FLAG_C;
    this.f = f;
    return r & 0xFF;
  }

  /** 8비트 뺄셈 (c: 보로우 입력 0/1). 결과 반환, 플래그 ZNHC 설정 (N=1). */
  _sub8(a, b, c) {
    const r = a - b - c;
    let f = FLAG_N;
    if ((r & 0xFF) === 0) f |= FLAG_Z;
    if (((a & 0xF) - (b & 0xF) - c) < 0) f |= FLAG_H;
    if (r < 0) f |= FLAG_C;
    this.f = f;
    return r & 0xFF;
  }

  /** INC r8: ZNH 반영, C 유지 */
  _inc(v) {
    const r = (v + 1) & 0xFF;
    let f = this.f & FLAG_C; // C 유지, N=0
    if (r === 0) f |= FLAG_Z;
    if ((v & 0x0F) === 0x0F) f |= FLAG_H;
    this.f = f;
    return r;
  }

  /** DEC r8: ZNH 반영(N=1), C 유지 */
  _dec(v) {
    const r = (v - 1) & 0xFF;
    let f = (this.f & FLAG_C) | FLAG_N; // C 유지, N=1
    if (r === 0) f |= FLAG_Z;
    if ((v & 0x0F) === 0x00) f |= FLAG_H;
    this.f = f;
    return r;
  }

  /** ALU A,r (op: 0=ADD 1=ADC 2=SUB 3=SBC 4=AND 5=XOR 6=OR 7=CP) */
  _alu(op, v) {
    const a = this.a;
    const carryIn = (this.f & FLAG_C) ? 1 : 0; // _add8/_sub8 호출 전에 캡처
    switch (op) {
      case 0: this.a = this._add8(a, v, 0); break;
      case 1: this.a = this._add8(a, v, carryIn); break;
      case 2: this.a = this._sub8(a, v, 0); break;
      case 3: this.a = this._sub8(a, v, carryIn); break;
      case 4: // AND: H=1
        this.a = a & v;
        this.f = (this.a === 0 ? FLAG_Z : 0) | FLAG_H;
        break;
      case 5: // XOR
        this.a = a ^ v;
        this.f = this.a === 0 ? FLAG_Z : 0;
        break;
      case 6: // OR
        this.a = a | v;
        this.f = this.a === 0 ? FLAG_Z : 0;
        break;
      default: // CP: SUB와 같으나 결과 버림
        this._sub8(a, v, 0);
        break;
    }
  }

  /** ADD HL,rr: Z 유지, N=0, H(bit11 캐리)/C(bit15 캐리) */
  _addHL(v) {
    const hl = (this.h << 8) | this.l;
    const r = hl + v;
    let f = this.f & FLAG_Z; // Z 유지, N=0
    if (((hl & 0xFFF) + (v & 0xFFF)) > 0xFFF) f |= FLAG_H;
    if (r > 0xFFFF) f |= FLAG_C;
    this.f = f;
    this.h = (r >> 8) & 0xFF;
    this.l = r & 0xFF;
  }

  /**
   * ADD SP,r8 / LD HL,SP+r8 공용: 부호 있는 오프셋을 더하고
   * Z=0 N=0, H/C는 하위 바이트(무부호 해석) 덧셈 기준으로 설정.
   */
  _addSP(imm) {
    const sp = this.sp;
    const r = (sp + this._s8(imm)) & 0xFFFF;
    let f = 0; // Z=0, N=0
    if (((sp & 0xF) + (imm & 0xF)) > 0xF) f |= FLAG_H;
    if (((sp & 0xFF) + imm) > 0xFF) f |= FLAG_C;
    this.f = f;
    return r;
  }

  /** DAA: BCD 보정. N에 따라 가감산 보정 분기. */
  _daa() {
    let a = this.a;
    let adjust = 0;
    let carry = (this.f & FLAG_C) !== 0;
    if ((this.f & FLAG_N) === 0) {
      if ((this.f & FLAG_H) || (a & 0x0F) > 0x09) adjust |= 0x06;
      if (carry || a > 0x99) { adjust |= 0x60; carry = true; }
      a = (a + adjust) & 0xFF;
    } else {
      if (this.f & FLAG_H) adjust |= 0x06;
      if (carry) adjust |= 0x60;
      a = (a - adjust) & 0xFF;
    }
    this.a = a;
    // Z는 결과 기준, H=0, N 유지, C는 보정 과정에서 발생한 캐리
    this.f = (this.f & FLAG_N) | (a === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0);
  }

  /** JR cc,r8: taken 12 / not-taken 8 */
  _jrCC(cc) {
    const off = this._s8(this._fetch());
    if (this._checkCond(cc)) {
      this.pc = (this.pc + off) & 0xFFFF;
      return 12;
    }
    return 8;
  }

  /** JP cc,a16: taken 16 / not-taken 12 */
  _jpCC(cc) {
    const addr = this._fetch16();
    if (this._checkCond(cc)) {
      this.pc = addr;
      return 16;
    }
    return 12;
  }

  /** RET cc: taken 20 / not-taken 8 */
  _retCC(cc) {
    if (this._checkCond(cc)) {
      this.pc = this._pop();
      return 20;
    }
    return 8;
  }

  /** CALL cc,a16: taken 24 / not-taken 12 */
  _callCC(cc) {
    const addr = this._fetch16();
    if (this._checkCond(cc)) {
      this._push(this.pc);
      this.pc = addr;
      return 24;
    }
    return 12;
  }

  /** RST tgt: PC push 후 PC=tgt. 16 사이클. */
  _rst(tgt) {
    this._push(this.pc);
    this.pc = tgt;
  }

  /**
   * 오프코드 실행. 소비한 T-사이클 수 반환.
   * Pan Docs의 블록 구조를 따라 규칙적인 영역은 디코딩으로 처리:
   *  - 0x40-0x7F (블록 01): LD r,r' — 0x76은 HALT
   *  - 0x80-0xBF (블록 10): ALU A,r
   *  나머지는 명시적 switch.
   */
  _execute(opcode) {
    // ---- 블록 01: LD r8,r8' (dst=(op>>3)&7, src=op&7) ----
    if (opcode >= 0x40 && opcode < 0x80) {
      if (opcode === 0x76) {
        // HALT: 인터럽트 대기 진입
        const pending = this._pendingIrqs() !== 0;
        const ime = !!(this.interrupt && this.interrupt.ime);
        if (ime) {
          if (!pending) this.halted = true;
          // pending이면 halt 진입 없이 emu 루프의 service()가 바로 처리
        } else if (pending) {
          // HALT 버그: halt 진입 없이 다음 fetch에서 PC 미증가
          this.haltBug = true;
        } else {
          this.halted = true;
        }
        return 4;
      }
      const dst = (opcode >> 3) & 7;
      const src = opcode & 7;
      this._setR8(dst, this._getR8(src));
      return (dst === 6 || src === 6) ? 8 : 4; // (HL) 포함 시 8
    }

    // ---- 블록 10: ALU A,r8 (op=(op>>3)&7, r=op&7) ----
    if (opcode >= 0x80 && opcode < 0xC0) {
      const op = (opcode >> 3) & 7;
      const r = opcode & 7;
      this._alu(op, this._getR8(r));
      return r === 6 ? 8 : 4; // (HL) 포함 시 8
    }

    let cycles = 4;
    switch (opcode) {
      // ============ 0x00-0x0F ============
      case 0x00: // NOP
        cycles = 4;
        break;
      case 0x01: // LD BC,d16
        this._setRP(0, this._fetch16());
        cycles = 12;
        break;
      case 0x02: // LD (BC),A
        this.mmu.write8(this._getRP(0), this.a);
        cycles = 8;
        break;
      case 0x03: // INC BC
        this._setRP(0, this._getRP(0) + 1);
        cycles = 8;
        break;
      case 0x04: // INC B
        this.b = this._inc(this.b);
        cycles = 4;
        break;
      case 0x05: // DEC B
        this.b = this._dec(this.b);
        cycles = 4;
        break;
      case 0x06: // LD B,d8
        this.b = this._fetch();
        cycles = 8;
        break;
      case 0x07: // RLCA (Z=0)
        {
          const c = (this.a >> 7) & 1;
          this.a = ((this.a << 1) | c) & 0xFF;
          this.f = c ? FLAG_C : 0;
        }
        cycles = 4;
        break;
      case 0x08: // LD (a16),SP
        {
          const addr = this._fetch16();
          this.mmu.write8(addr, this.sp & 0xFF);
          this.mmu.write8((addr + 1) & 0xFFFF, (this.sp >> 8) & 0xFF);
        }
        cycles = 20;
        break;
      case 0x09: // ADD HL,BC
        this._addHL(this._getRP(0));
        cycles = 8;
        break;
      case 0x0A: // LD A,(BC)
        this.a = this.mmu.read8(this._getRP(0));
        cycles = 8;
        break;
      case 0x0B: // DEC BC
        this._setRP(0, this._getRP(0) - 1);
        cycles = 8;
        break;
      case 0x0C: // INC C
        this.c = this._inc(this.c);
        cycles = 4;
        break;
      case 0x0D: // DEC C
        this.c = this._dec(this.c);
        cycles = 4;
        break;
      case 0x0E: // LD C,d8
        this.c = this._fetch();
        cycles = 8;
        break;
      case 0x0F: // RRCA (Z=0)
        {
          const c = this.a & 1;
          this.a = (this.a >> 1) | (c << 7);
          this.f = c ? FLAG_C : 0;
        }
        cycles = 4;
        break;

      // ============ 0x10-0x1F ============
      case 0x10: // STOP
        this._fetch(); // 두 번째 바이트(관례상 0x00) 소비
        // GBC 2배속 전환은 MMU가 처리. DMG에서는 무시 → NOP처럼 계속 진행.
        if (this.mmu && typeof this.mmu.requestSpeedSwitch === 'function') {
          this.mmu.requestSpeedSwitch();
        }
        cycles = 4;
        break;
      case 0x11: // LD DE,d16
        this._setRP(1, this._fetch16());
        cycles = 12;
        break;
      case 0x12: // LD (DE),A
        this.mmu.write8(this._getRP(1), this.a);
        cycles = 8;
        break;
      case 0x13: // INC DE
        this._setRP(1, this._getRP(1) + 1);
        cycles = 8;
        break;
      case 0x14: // INC D
        this.d = this._inc(this.d);
        cycles = 4;
        break;
      case 0x15: // DEC D
        this.d = this._dec(this.d);
        cycles = 4;
        break;
      case 0x16: // LD D,d8
        this.d = this._fetch();
        cycles = 8;
        break;
      case 0x17: // RLA (Z=0)
        {
          const nc = (this.a >> 7) & 1;
          const oc = (this.f & FLAG_C) ? 1 : 0;
          this.a = ((this.a << 1) | oc) & 0xFF;
          this.f = nc ? FLAG_C : 0;
        }
        cycles = 4;
        break;
      case 0x18: // JR r8
        this.pc = (this.pc + this._s8(this._fetch())) & 0xFFFF;
        cycles = 12;
        break;
      case 0x19: // ADD HL,DE
        this._addHL(this._getRP(1));
        cycles = 8;
        break;
      case 0x1A: // LD A,(DE)
        this.a = this.mmu.read8(this._getRP(1));
        cycles = 8;
        break;
      case 0x1B: // DEC DE
        this._setRP(1, this._getRP(1) - 1);
        cycles = 8;
        break;
      case 0x1C: // INC E
        this.e = this._inc(this.e);
        cycles = 4;
        break;
      case 0x1D: // DEC E
        this.e = this._dec(this.e);
        cycles = 4;
        break;
      case 0x1E: // LD E,d8
        this.e = this._fetch();
        cycles = 8;
        break;
      case 0x1F: // RRA (Z=0)
        {
          const nc = this.a & 1;
          const oc = (this.f & FLAG_C) ? 0x80 : 0;
          this.a = (this.a >> 1) | oc;
          this.f = nc ? FLAG_C : 0;
        }
        cycles = 4;
        break;

      // ============ 0x20-0x2F ============
      case 0x20: // JR NZ,r8
        cycles = this._jrCC(0);
        break;
      case 0x21: // LD HL,d16
        this._setRP(2, this._fetch16());
        cycles = 12;
        break;
      case 0x22: // LD (HL+),A — LDI
        {
          const hl = this._getRP(2);
          this.mmu.write8(hl, this.a);
          this._setRP(2, hl + 1);
        }
        cycles = 8;
        break;
      case 0x23: // INC HL
        this._setRP(2, this._getRP(2) + 1);
        cycles = 8;
        break;
      case 0x24: // INC H
        this.h = this._inc(this.h);
        cycles = 4;
        break;
      case 0x25: // DEC H
        this.h = this._dec(this.h);
        cycles = 4;
        break;
      case 0x26: // LD H,d8
        this.h = this._fetch();
        cycles = 8;
        break;
      case 0x27: // DAA
        this._daa();
        cycles = 4;
        break;
      case 0x28: // JR Z,r8
        cycles = this._jrCC(1);
        break;
      case 0x29: // ADD HL,HL
        this._addHL(this._getRP(2));
        cycles = 8;
        break;
      case 0x2A: // LD A,(HL+) — LDI
        {
          const hl = this._getRP(2);
          this.a = this.mmu.read8(hl);
          this._setRP(2, hl + 1);
        }
        cycles = 8;
        break;
      case 0x2B: // DEC HL
        this._setRP(2, this._getRP(2) - 1);
        cycles = 8;
        break;
      case 0x2C: // INC L
        this.l = this._inc(this.l);
        cycles = 4;
        break;
      case 0x2D: // DEC L
        this.l = this._dec(this.l);
        cycles = 4;
        break;
      case 0x2E: // LD L,d8
        this.l = this._fetch();
        cycles = 8;
        break;
      case 0x2F: // CPL (N=1, H=1)
        this.a = (~this.a) & 0xFF;
        this.f |= FLAG_N | FLAG_H;
        cycles = 4;
        break;

      // ============ 0x30-0x3F ============
      case 0x30: // JR NC,r8
        cycles = this._jrCC(2);
        break;
      case 0x31: // LD SP,d16
        this.sp = this._fetch16();
        cycles = 12;
        break;
      case 0x32: // LD (HL-),A — LDD
        {
          const hl = this._getRP(2);
          this.mmu.write8(hl, this.a);
          this._setRP(2, hl - 1);
        }
        cycles = 8;
        break;
      case 0x33: // INC SP
        this.sp = (this.sp + 1) & 0xFFFF;
        cycles = 8;
        break;
      case 0x34: // INC (HL)
        {
          const hl = this._getRP(2);
          this.mmu.write8(hl, this._inc(this.mmu.read8(hl)));
        }
        cycles = 12;
        break;
      case 0x35: // DEC (HL)
        {
          const hl = this._getRP(2);
          this.mmu.write8(hl, this._dec(this.mmu.read8(hl)));
        }
        cycles = 12;
        break;
      case 0x36: // LD (HL),d8
        this.mmu.write8(this._getRP(2), this._fetch());
        cycles = 12;
        break;
      case 0x37: // SCF (Z 유지, N=0, H=0, C=1)
        this.f = (this.f & FLAG_Z) | FLAG_C;
        cycles = 4;
        break;
      case 0x38: // JR C,r8
        cycles = this._jrCC(3);
        break;
      case 0x39: // ADD HL,SP
        this._addHL(this.sp);
        cycles = 8;
        break;
      case 0x3A: // LD A,(HL-) — LDD
        {
          const hl = this._getRP(2);
          this.a = this.mmu.read8(hl);
          this._setRP(2, hl - 1);
        }
        cycles = 8;
        break;
      case 0x3B: // DEC SP
        this.sp = (this.sp - 1) & 0xFFFF;
        cycles = 8;
        break;
      case 0x3C: // INC A
        this.a = this._inc(this.a);
        cycles = 4;
        break;
      case 0x3D: // DEC A
        this.a = this._dec(this.a);
        cycles = 4;
        break;
      case 0x3E: // LD A,d8
        this.a = this._fetch();
        cycles = 8;
        break;
      case 0x3F: // CCF (Z 유지, N=0, H=0, C 반전)
        this.f = (this.f & FLAG_Z) | ((this.f & FLAG_C) ? 0 : FLAG_C);
        cycles = 4;
        break;

      // ============ 0xC0-0xCF ============
      case 0xC0: // RET NZ
        cycles = this._retCC(0);
        break;
      case 0xC1: // POP BC
        this._setRP2(0, this._pop());
        cycles = 12;
        break;
      case 0xC2: // JP NZ,a16
        cycles = this._jpCC(0);
        break;
      case 0xC3: // JP a16
        this.pc = this._fetch16();
        cycles = 16;
        break;
      case 0xC4: // CALL NZ,a16
        cycles = this._callCC(0);
        break;
      case 0xC5: // PUSH BC
        this._push(this._getRP2(0));
        cycles = 16;
        break;
      case 0xC6: // ADD A,d8
        this._alu(0, this._fetch());
        cycles = 8;
        break;
      case 0xC7: // RST 00H
        this._rst(0x00);
        cycles = 16;
        break;
      case 0xC8: // RET Z
        cycles = this._retCC(1);
        break;
      case 0xC9: // RET
        this.pc = this._pop();
        cycles = 16;
        break;
      case 0xCA: // JP Z,a16
        cycles = this._jpCC(1);
        break;
      case 0xCB: // PREFIX CB
        cycles = this._execCB(this._fetch()); // 총 사이클(프리픽스 포함): 8/12/16
        break;
      case 0xCC: // CALL Z,a16
        cycles = this._callCC(1);
        break;
      case 0xCD: // CALL a16
        {
          const addr = this._fetch16();
          this._push(this.pc);
          this.pc = addr;
        }
        cycles = 24;
        break;
      case 0xCE: // ADC A,d8
        this._alu(1, this._fetch());
        cycles = 8;
        break;
      case 0xCF: // RST 08H
        this._rst(0x08);
        cycles = 16;
        break;

      // ============ 0xD0-0xDF ============
      case 0xD0: // RET NC
        cycles = this._retCC(2);
        break;
      case 0xD1: // POP DE
        this._setRP2(1, this._pop());
        cycles = 12;
        break;
      case 0xD2: // JP NC,a16
        cycles = this._jpCC(2);
        break;
      case 0xD3: // (invalid: hard-lock)
        this.locked = true;
        cycles = 4;
        break;
      case 0xD4: // CALL NC,a16
        cycles = this._callCC(2);
        break;
      case 0xD5: // PUSH DE
        this._push(this._getRP2(1));
        cycles = 16;
        break;
      case 0xD6: // SUB d8
        this._alu(2, this._fetch());
        cycles = 8;
        break;
      case 0xD7: // RST 10H
        this._rst(0x10);
        cycles = 16;
        break;
      case 0xD8: // RET C
        cycles = this._retCC(3);
        break;
      case 0xD9: // RETI (EI + RET)
        if (this.interrupt) this.interrupt.ime = true;
        this.pc = this._pop();
        cycles = 16;
        break;
      case 0xDA: // JP C,a16
        cycles = this._jpCC(3);
        break;
      case 0xDB: // (invalid: hard-lock)
      case 0xDD: // (invalid: hard-lock)
        this.locked = true;
        cycles = 4;
        break;
      case 0xDC: // CALL C,a16
        cycles = this._callCC(3);
        break;
      case 0xDE: // SBC A,d8
        this._alu(3, this._fetch());
        cycles = 8;
        break;
      case 0xDF: // RST 18H
        this._rst(0x18);
        cycles = 16;
        break;

      // ============ 0xE0-0xEF ============
      case 0xE0: // LDH (a8),A — LD (0xFF00+a8),A
        this.mmu.write8(0xFF00 + this._fetch(), this.a);
        cycles = 12;
        break;
      case 0xE1: // POP HL
        this._setRP2(2, this._pop());
        cycles = 12;
        break;
      case 0xE2: // LD (C),A — LD (0xFF00+C),A
        this.mmu.write8(0xFF00 + this.c, this.a);
        cycles = 8;
        break;
      case 0xE3: // (invalid: hard-lock)
      case 0xE4: // (invalid: hard-lock)
        this.locked = true;
        cycles = 4;
        break;
      case 0xE5: // PUSH HL
        this._push(this._getRP2(2));
        cycles = 16;
        break;
      case 0xE6: // AND d8
        this._alu(4, this._fetch());
        cycles = 8;
        break;
      case 0xE7: // RST 20H
        this._rst(0x20);
        cycles = 16;
        break;
      case 0xE8: // ADD SP,r8 (Z=0, H/C는 하위 바이트 기준)
        this.sp = this._addSP(this._fetch());
        cycles = 16;
        break;
      case 0xE9: // JP (HL)
        this.pc = this._getRP(2);
        cycles = 4;
        break;
      case 0xEA: // LD (a16),A
        this.mmu.write8(this._fetch16(), this.a);
        cycles = 16;
        break;
      case 0xEB: // (invalid: hard-lock)
      case 0xEC: // (invalid: hard-lock)
      case 0xED: // (invalid: hard-lock)
        this.locked = true;
        cycles = 4;
        break;
      case 0xEE: // XOR d8
        this._alu(5, this._fetch());
        cycles = 8;
        break;
      case 0xEF: // RST 28H
        this._rst(0x28);
        cycles = 16;
        break;

      // ============ 0xF0-0xFF ============
      case 0xF0: // LDH A,(a8) — LD A,(0xFF00+a8)
        this.a = this.mmu.read8(0xFF00 + this._fetch());
        cycles = 12;
        break;
      case 0xF1: // POP AF (F 하위 4비트 마스크)
        this._setRP2(3, this._pop());
        cycles = 12;
        break;
      case 0xF2: // LD A,(C) — LD A,(0xFF00+C)
        this.a = this.mmu.read8(0xFF00 + this.c);
        cycles = 8;
        break;
      case 0xF3: // DI
        if (this.interrupt) this.interrupt.ime = false;
        cycles = 4;
        break;
      case 0xF4: // (invalid: hard-lock)
        this.locked = true;
        cycles = 4;
        break;
      case 0xF5: // PUSH AF
        this._push(this._getRP2(3));
        cycles = 16;
        break;
      case 0xF6: // OR d8
        this._alu(6, this._fetch());
        cycles = 8;
        break;
      case 0xF7: // RST 30H
        this._rst(0x30);
        cycles = 16;
        break;
      case 0xF8: // LD HL,SP+r8 (Z=0, H/C는 하위 바이트 기준)
        this._setRP(2, this._addSP(this._fetch()));
        cycles = 12;
        break;
      case 0xF9: // LD SP,HL
        this.sp = this._getRP(2);
        cycles = 8;
        break;
      case 0xFA: // LD A,(a16)
        this.a = this.mmu.read8(this._fetch16());
        cycles = 16;
        break;
      case 0xFB: // EI — v1에서는 즉시 적용 (실기는 1명령어 지연, 주석 1번 참고)
        if (this.interrupt) this.interrupt.ime = true;
        cycles = 4;
        break;
      case 0xFC: // (invalid: hard-lock)
      case 0xFD: // (invalid: hard-lock)
        this.locked = true;
        cycles = 4;
        break;
      case 0xFE: // CP d8
        this._alu(7, this._fetch());
        cycles = 8;
        break;
      case 0xFF: // RST 38H
        this._rst(0x38);
        cycles = 16;
        break;

      default:
        // 위에서 256개 전부 처리하므로 도달 불가. 방어용으로 hard-lock.
        this.locked = true;
        cycles = 4;
        break;
    }
    return cycles;
  }

  /**
   * CB 프리픽스 오프코드 실행. 총 T-사이클(프리픽스 fetch 포함) 반환:
   *  레지스터 대상 8, BIT b,(HL) 12, 그 외 (HL) 대상 16.
   * 인코딩: op2=(cb>>6) [0:회전/시프트 1:BIT 2:RES 3:SET],
   *         y=(cb>>3)&7 [서브연산/비트번호], z=cb&7 [레지스터, 6=(HL)]
   */
  _execCB(cb) {
    const op2 = cb >> 6;
    const y = (cb >> 3) & 7;
    const z = cb & 7;
    const isHL = (z === 6);

    if (op2 === 0) {
      // 회전/시프트: RLC RRC RL RR SLA SRA SWAP SRL
      let v = this._getR8(z);
      const oldC = (this.f & FLAG_C) ? 1 : 0; // RL/RR용 캐리 입력 캡처
      let c = 0;
      switch (y) {
        case 0: // RLC r8
          c = (v >> 7) & 1;
          v = ((v << 1) | c) & 0xFF;
          break;
        case 1: // RRC r8
          c = v & 1;
          v = (v >> 1) | (c << 7);
          break;
        case 2: // RL r8 (캐리 경유)
          c = (v >> 7) & 1;
          v = ((v << 1) | oldC) & 0xFF;
          break;
        case 3: // RR r8 (캐리 경유)
          c = v & 1;
          v = (v >> 1) | (oldC << 7);
          break;
        case 4: // SLA r8
          c = (v >> 7) & 1;
          v = (v << 1) & 0xFF;
          break;
        case 5: // SRA r8 (부호 비트 유지)
          c = v & 1;
          v = (v >> 1) | (v & 0x80);
          break;
        case 6: // SWAP r8 (니블 교환)
          v = ((v << 4) | (v >> 4)) & 0xFF;
          c = 0;
          break;
        default: // SRL r8
          c = v & 1;
          v = v >> 1;
          break;
      }
      this._setR8(z, v);
      this.f = (v === 0 ? FLAG_Z : 0) | (c ? FLAG_C : 0); // N=0, H=0
      return isHL ? 16 : 8;
    }

    if (op2 === 1) {
      // BIT b3,r8: Z=비트 반전, N=0, H=1, C 유지
      const v = this._getR8(z);
      const bit = (v >> y) & 1;
      this.f = (this.f & FLAG_C) | FLAG_H | (bit ? 0 : FLAG_Z);
      return isHL ? 12 : 8;
    }

    // RES b3,r8 (op2=2) / SET b3,r8 (op2=3): 플래그 불변
    let v = this._getR8(z);
    v = op2 === 2 ? (v & ~(1 << y)) & 0xFF : (v | (1 << y)) & 0xFF;
    this._setR8(z, v);
    return isHL ? 16 : 8;
  }
}
