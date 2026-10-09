// mmu.js — 64KB 메모리맵 + I/O 레지스터 + DMA/HDMA + GBC 속도 전환
// 기준: Pan Docs "Memory Map", "OAM DMA Transfer", "HDMA", "CGB Registers"
// v1 단순화: VRAM/OAM 접근 타이밍 제한 없음 (언제든 접근 허용).

export class MMU {
  constructor({ cart, ppu, timer, joypad, apu, interrupt }) {
    this.cart = cart;
    this.ppu = ppu;
    this.timer = timer;
    this.joypad = joypad;
    this.apu = apu;
    this.interrupt = interrupt;

    this.wram = new Uint8Array(0x8000); // WRAM 32KB (뱅크 0-7, DMG는 8KB만 사용)
    this.wramBank = 1;                 // SVBK (0xFF70), 0은 1로 취급
    this.hram = new Uint8Array(0x80);  // HRAM 0xFF80-0xFFFE

    this.dmaStall = 0; // OAM DMA/GDMA로 쌓인 스톨 (T-사이클), takeDmaStall()로 회수

    // 시리얼 스터브 (0xFF01/0xFF02): 값 저장만, 통신 미구현
    this.serialData = 0x00;
    this.serialControl = 0x00;

    // KEY1 (0xFF4D): GBC 2배속
    this.doubleSpeed = false; // 현재 속도 (bit7 읽기)
    this.speedArmed = false;  // 전환 준비 (bit0 쓰기)

    // HDMA 레지스터 상태
    this.hdmaSrc = 0x0000;     // 0xFF51/0xFF52 (하위 4비트 무시)
    this.hdmaDst = 0x8000;     // 0xFF53/0xFF54 (0x8000-0x9FFF, VRAM 고정)
    this.hdmaRemaining = 0;    // 남은 바이트 수 (HDMA 모드)
    this.hdmaActive = false;   // HDMA 진행 중 여부
  }

  // 쌓인 DMA 스톨을 반환하고 0으로 리셋 (emu 메인 루프에서 매 명령어 후 호출)
  takeDmaStall() {
    const stall = this.dmaStall;
    this.dmaStall = 0;
    return stall;
  }

  // PPU가 HBlank에 진입할 때 호출 → HDMA 모드면 16바이트 전송
  hdmaHBlank() {
    if (!this.hdmaActive) return;
    let src = this.hdmaSrc;
    let dst = this.hdmaDst;
    for (let i = 0; i < 16; i++) {
      this.write8(dst, this.read8(src));
      src = (src + 1) & 0xffff;
      dst = 0x8000 | ((dst + 1) & 0x1fff); // VRAM 범위 내에서 순환
    }
    this.hdmaSrc = src;
    this.hdmaDst = dst;
    this.hdmaRemaining -= 16;
    if (this.hdmaRemaining <= 0) {
      this.hdmaRemaining = 0;
      this.hdmaActive = false;
    }
  }

  // CPU STOP 명령에서 호출. KEY1 bit0(전환 준비)이 서 있으면 속도 토글.
  requestSpeedSwitch() {
    if (this.speedArmed) {
      this.doubleSpeed = !this.doubleSpeed;
      this.speedArmed = false;
    }
  }

  read8(addr) {
    addr &= 0xffff;
    if (addr < 0x8000) return this.cart.read8(addr);          // ROM
    if (addr < 0xa000) return this.ppu.read8(addr);           // VRAM
    if (addr < 0xc000) return this.cart.read8(addr);          // 외부 RAM
    if (addr < 0xd000) return this.wram[addr - 0xc000];       // WRAM 뱅크 0
    if (addr < 0xe000) {                                     // WRAM 뱅크 1-7 (SVBK)
      return this.wram[this.wramBank * 0x1000 + (addr - 0xd000)];
    }
    if (addr < 0xfe00) return this.read8(addr - 0x2000);      // 에코 RAM
    if (addr < 0xfea0) return this.ppu.read8(addr);           // OAM
    if (addr < 0xff00) return 0xff;                           // 미사용
    if (addr < 0xff80) return this._readIO(addr);             // I/O 레지스터
    if (addr < 0xffff) return this.hram[addr - 0xff80];       // HRAM
    return this.interrupt.readIE();                           // 0xFFFF: IE
  }

  _readIO(addr) {
    switch (addr) {
      case 0xff00: return this.joypad.read8();        // JOYP
      case 0xff01: return this.serialData;            // SB (스터브)
      case 0xff02: return this.serialControl;         // SC (스터브)
      case 0xff04:                                    // DIV
      case 0xff05:                                    // TIMA
      case 0xff06:                                    // TMA
      case 0xff07:                                    // TAC
        return this.timer.read8(addr);
      case 0xff0f: return this.interrupt.readIF();    // IF
      case 0xff4d:                                    // KEY1
        return (this.doubleSpeed ? 0x80 : 0x00)
          | (this.speedArmed ? 0x01 : 0x00)
          | 0x7e;
      case 0xff51: return (this.hdmaSrc >> 8) & 0xff; // HDMA1
      case 0xff52: return this.hdmaSrc & 0xf0;        // HDMA2 (하위 4비트 무시)
      case 0xff53: return (this.hdmaDst >> 8) & 0xff; // HDMA3
      case 0xff54: return this.hdmaDst & 0xf0;        // HDMA4 (하위 4비트 무시)
      case 0xff55:                                    // HDMA5: bit7=전송 중, 하위=남은 블록 수-1
        return (this.hdmaActive ? 0x00 : 0x80)
          | ((this.hdmaRemaining / 16 - 1) & 0x7f);
      case 0xff68:                                    // BGPI
      case 0xff69:                                    // BGPD
      case 0xff6a:                                    // OBPI
      case 0xff6b:                                    // OBPD
        return this.ppu.read8(addr); // GBC 팔레트 → ppu 위임
      case 0xff70:                                    // SVBK
        return (this.wramBank & 0x07) | 0xf8;
      default:
        break;
    }
    if (addr >= 0xff10 && addr <= 0xff3f) return this.apu.read8(addr);
    if ((addr >= 0xff40 && addr <= 0xff4b) || addr === 0xff4f) {
      return this.ppu.read8(addr); // LCD 레지스터 + VBK → ppu 위임
    }
    return 0xff; // 미구현/미사용 I/O는 0xFF
  }

  write8(addr, v) {
    addr &= 0xffff;
    v &= 0xff;
    if (addr < 0x8000) { this.cart.write8(addr, v); return; }   // ROM/MBC 제어
    if (addr < 0xa000) { this.ppu.write8(addr, v); return; }    // VRAM
    if (addr < 0xc000) { this.cart.write8(addr, v); return; }   // 외부 RAM
    if (addr < 0xd000) { this.wram[addr - 0xc000] = v; return; }// WRAM 뱅크 0
    if (addr < 0xe000) {                                       // WRAM 뱅크 1-7
      this.wram[this.wramBank * 0x1000 + (addr - 0xd000)] = v;
      return;
    }
    if (addr < 0xfe00) { this.write8(addr - 0x2000, v); return; }// 에코 RAM
    if (addr < 0xfea0) { this.ppu.write8(addr, v); return; }    // OAM
    if (addr < 0xff00) return;                                  // 미사용: 무시
    if (addr < 0xff80) { this._writeIO(addr, v); return; }      // I/O
    if (addr < 0xffff) { this.hram[addr - 0xff80] = v; return; }// HRAM
    this.interrupt.writeIE(v);                                  // 0xFFFF: IE
  }

  _writeIO(addr, v) {
    switch (addr) {
      case 0xff00: this.joypad.write8(v); break;      // JOYP
      case 0xff01: this.serialData = v; break;        // SB (스터브)
      case 0xff02: this.serialControl = v; break;     // SC (스터브)
      case 0xff04:                                    // DIV
      case 0xff05:                                    // TIMA
      case 0xff06:                                    // TMA
      case 0xff07:                                    // TAC
        this.timer.write8(addr, v);
        break;
      case 0xff0f: this.interrupt.writeIF(v); break;  // IF
      case 0xff46: this._oamDma(v); break;            // OAM DMA
      case 0xff4d:                                    // KEY1: bit0 쓰기 = 전환 준비
        if (v & 0x01) this.speedArmed = true;
        break;
      case 0xff4f: this.ppu.write8(addr, v); break;    // VBK → ppu 위임
      case 0xff51:                                    // HDMA1: 출발 상위
        this.hdmaSrc = (this.hdmaSrc & 0x00ff) | (v << 8);
        break;
      case 0xff52:                                    // HDMA2: 출발 하위 (하위 4비트 무시)
        this.hdmaSrc = (this.hdmaSrc & 0xff00) | (v & 0xf0);
        break;
      case 0xff53:                                    // HDMA3: 도착 상위 (0x80-0x9F만)
        this.hdmaDst = 0x8000 | ((v & 0x1f) << 8) | (this.hdmaDst & 0x00f0);
        break;
      case 0xff54:                                    // HDMA4: 도착 하위 (하위 4비트 무시)
        this.hdmaDst = (this.hdmaDst & 0xff00) | (v & 0xf0);
        break;
      case 0xff55: this._hdma5(v); break;             // HDMA5: GDMA/HDMA 시작
      case 0xff68:                                    // BGPI
      case 0xff69:                                    // BGPD
      case 0xff6a:                                    // OBPI
      case 0xff6b:                                    // OBPD
        this.ppu.write8(addr, v); // GBC 팔레트 → ppu 위임
        break;
      case 0xff70:                                    // SVBK: WRAM 뱅크 (0은 1로 취급)
        this.wramBank = v & 0x07;
        if (this.wramBank === 0) this.wramBank = 1;
        break;
      default:
        break;
    }
    if (addr >= 0xff10 && addr <= 0xff3f) this.apu.write8(addr, v);
    else if (addr >= 0xff40 && addr <= 0xff4b) this.ppu.write8(addr, v);
    // 그 외 I/O (0xFF03, 0xFF08-0xFF0E, 0xFF4C, 0xFF4E, 0xFF50, 0xFF56-0xFF67,
    // 0xFF6C-0xFF6F, 0xFF71-0xFF7F): 무시
  }

  // OAM DMA (0xFF46): src=(v<<8)부터 160바이트를 OAM으로 복사, 640 T-사이클 스톨
  _oamDma(v) {
    const src = (v << 8) & 0xffff;
    for (let i = 0; i < 160; i++) {
      this.ppu.write8(0xfe00 + i, this.read8((src + i) & 0xffff));
    }
    this.dmaStall += 640;
  }

  // HDMA5 (0xFF55) 쓰기
  _hdma5(v) {
    const len = ((v & 0x7f) + 1) * 16; // 전송 바이트 수
    if (v & 0x80) {
      // HDMA 모드: HBlank마다 16바이트씩 (hdmaHBlank에서 처리, CPU 스톨 없음)
      this.hdmaRemaining = len;
      this.hdmaActive = true;
    } else if (this.hdmaActive) {
      // HDMA 진행 중 bit7=0 쓰기 = 전송 중단
      this.hdmaActive = false;
    } else {
      // GDMA: 즉시 복사, 스톨 = 바이트 수 * 2 T-사이클
      let src = this.hdmaSrc;
      let dst = this.hdmaDst;
      for (let i = 0; i < len; i++) {
        this.write8(dst, this.read8(src));
        src = (src + 1) & 0xffff;
        dst = 0x8000 | ((dst + 1) & 0x1fff);
      }
      this.hdmaSrc = src;
      this.hdmaDst = dst;
      this.hdmaRemaining = 0;
      this.dmaStall += len * 2;
    }
  }
}
