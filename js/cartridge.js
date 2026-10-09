// cartridge.js — 게임보이 카트리지: 롬 헤더 파싱, MBC 뱅크 전환, 외부 RAM
// 기준: Pan Docs "The Cartridge Header", "MBC1", "MBC3", "MBC5"
// 지원: MBC 없음(NONE), MBC1, MBC3, MBC5. 그 외 타입은 생성자에서 throw.

const ROM_BANK_SIZE = 0x4000; // 16KB
const RAM_BANK_SIZE = 0x2000; // 8KB

// 0x149 RAM 크기 코드 → 바이트 수
function ramBytesFromCode(code) {
  switch (code) {
    case 0x00: return 0;
    case 0x01: return 0x0800;   // 2KB (거의 사용 안 됨)
    case 0x02: return RAM_BANK_SIZE; // 8KB, 1뱅크
    case 0x03: return 0x8000;   // 32KB, 4뱅크
    case 0x04: return 0x20000;  // 128KB, 16뱅크
    case 0x05: return 0x10000;  // 64KB, 8뱅크
    default: return 0;
  }
}

// 0x147 카트리지 타입 → MBC 종류 (미지원이면 throw)
function mbcTypeFromCode(code) {
  switch (code) {
    case 0x00: // ROM ONLY
    case 0x08: // ROM+RAM
    case 0x09: // ROM+RAM+BATTERY
      return 'NONE';
    case 0x01: // MBC1
    case 0x02: // MBC1+RAM
    case 0x03: // MBC1+RAM+BATTERY
      return 'MBC1';
    case 0x0F: // MBC3+TIMER+BATTERY
    case 0x10: // MBC3+TIMER+RAM+BATTERY
    case 0x11: // MBC3
    case 0x12: // MBC3+RAM
    case 0x13: // MBC3+RAM+BATTERY
      return 'MBC3';
    case 0x19: // MBC5
    case 0x1A: // MBC5+RAM
    case 0x1B: // MBC5+RAM+BATTERY
    case 0x1C: // MBC5+RUMBLE
    case 0x1D: // MBC5+RUMBLE+RAM
    case 0x1E: // MBC5+RUMBLE+RAM+BATTERY
      return 'MBC5';
    default:
      throw new Error(
        `지원하지 않는 카트리지 타입입니다: 0x${code.toString(16).padStart(2, '0').toUpperCase()}`
      );
  }
}

export class Cartridge {
  constructor(romData) {
    if (!(romData instanceof Uint8Array) || romData.length < 0x150) {
      throw new Error('유효한 롬 데이터가 아닙니다 (헤더 영역 부족).');
    }
    this.rom = romData;

    // --- 헤더 파싱 ---
    // 제목: 0x134-0x143 (GBC 게임은 0x143이 CGB 플래그라 0x142까지가 실질 제목)
    const titleBytes = [];
    for (let a = 0x134; a <= 0x143; a++) {
      const c = romData[a];
      if (c === 0x00) break;
      if (c >= 0x20 && c < 0x7f) titleBytes.push(c); // 출력 가능한 ASCII만
    }
    this.title = String.fromCharCode(...titleBytes);

    // CGB 플래그: 0x80 = CGB 지원, 0xC0 = CGB 전용
    const cgbFlag = romData[0x143];
    this.isGBC = cgbFlag === 0x80 || cgbFlag === 0xc0;
    this.requiresGBC = cgbFlag === 0xc0;

    this.mbcType = mbcTypeFromCode(romData[0x147]);

    // 롬 뱅크 수: 실제 데이터 길이 기준 (헤더 0x148과 다르면 데이터 기준, 마스크용)
    let romBanks = Math.max(1, romData.length >>> 14);
    // 2의 거듭제곱이 아니면 내림 (비정상 롬 대비)
    romBanks = 1 << Math.floor(Math.log2(romBanks));
    this.romBankMask = romBanks - 1;

    // 외부 RAM
    const ramBytes = ramBytesFromCode(romData[0x149]);
    this.ram = ramBytes > 0 ? new Uint8Array(ramBytes) : null;
    this.ramBankMask = this.ram ? Math.max(0, (this.ram.length / RAM_BANK_SIZE) - 1) : 0;

    // --- MBC 상태 ---
    this.ramEnabled = this.mbcType === 'NONE'; // MBC 없으면 RAM 상시 활성화 취급
    this.romBankLow5 = 1;  // MBC1: BANK1 (하위 5비트), 0 금지
    this.ramBank = 0;      // MBC1: BANK2 / RAM 뱅크, MBC3/MBC5: RAM 뱅크
    this.bankMode = 0;     // MBC1: 0 = ROM 뱅킹 모드, 1 = RAM 뱅킹 모드
    this.romBank = 1;      // MBC3: 7비트 ROM 뱅크, MBC5: 9비트 ROM 뱅크
    this.rtcSelected = false; // MBC3: RAM 대신 RTC 레지스터 선택 중 (스터브)
  }

  // 0x0000-0x3FFF: ROM 뱅크 0 영역에 매핑될 실제 뱅크 번호
  _romBank0() {
    if (this.mbcType === 'MBC1' && this.bankMode === 1) {
      return (this.ramBank << 5) & this.romBankMask; // RAM 뱅킹 모드에서는 상위 2비트 적용
    }
    return 0;
  }

  // 0x4000-0x7FFF: 전환 가능한 ROM 뱅크 번호
  _romBankN() {
    let bank;
    switch (this.mbcType) {
      case 'NONE':
        return 1 & this.romBankMask;
      case 'MBC1': {
        bank = this.bankMode === 0
          ? (this.ramBank << 5) | this.romBankLow5
          : this.romBankLow5;
        if ((bank & 0x1f) === 0) bank |= 0x01; // 뱅크 0 금지 → 1로 보정
        break;
      }
      case 'MBC3': {
        bank = this.romBank & 0x7f;
        if (bank === 0) bank = 1; // 뱅크 0 금지 → 1로 보정
        break;
      }
      case 'MBC5':
        bank = this.romBank & 0x1ff; // 뱅크 0 허용 (보정 없음)
        break;
    }
    return bank & this.romBankMask;
  }

  // 외부 RAM 읽기 오프셋 (RTC 선택 시 -1)
  _ramOffset(addr) {
    if (!this.ramEnabled || !this.ram) return -1;
    if (this.rtcSelected) return -2; // RTC 스터브 표시
    let bank = 0;
    if (this.mbcType === 'MBC1') {
      bank = this.bankMode === 1 ? this.ramBank : 0;
    } else {
      bank = this.ramBank;
    }
    bank &= this.ramBankMask;
    return bank * RAM_BANK_SIZE + (addr - 0xa000);
  }

  read8(addr) {
    addr &= 0xffff;
    if (addr < 0x4000) {
      const off = this._romBank0() * ROM_BANK_SIZE + addr;
      return off < this.rom.length ? this.rom[off] : 0xff;
    }
    if (addr < 0x8000) {
      const off = this._romBankN() * ROM_BANK_SIZE + (addr - 0x4000);
      return off < this.rom.length ? this.rom[off] : 0xff;
    }
    if (addr >= 0xa000 && addr < 0xc000) {
      const off = this._ramOffset(addr);
      if (off === -2) return 0x00; // RTC 스터브: 읽기 시 0
      if (off < 0 || off >= this.ram.length) return 0xff;
      return this.ram[off];
    }
    return 0xff;
  }

  write8(addr, v) {
    addr &= 0xffff;
    v &= 0xff;
    if (addr < 0x8000) {
      this._mbcControl(addr, v);
      return;
    }
    if (addr >= 0xa000 && addr < 0xc000) {
      const off = this._ramOffset(addr);
      if (off >= 0 && off < this.ram.length) this.ram[off] = v;
      // RTC 스터브: 쓰기 무시. 비활성 RAM 쓰기 무시.
    }
  }

  // MBC 제어 레지스터 쓰기 (0x0000-0x7FFF)
  _mbcControl(addr, v) {
    switch (this.mbcType) {
      case 'NONE':
        break; // 제어 레지스터 없음
      case 'MBC1':
        if (addr < 0x2000) {
          // RAMG: 하위 니블이 0xA일 때만 RAM 활성화
          this.ramEnabled = (v & 0x0f) === 0x0a;
        } else if (addr < 0x4000) {
          // BANK1: ROM 뱅크 하위 5비트
          this.romBankLow5 = v & 0x1f;
        } else if (addr < 0x6000) {
          // BANK2: RAM 뱅크 번호 / ROM 뱅크 상위 2비트
          this.ramBank = v & 0x03;
        } else {
          // MODE: 뱅킹 모드 선택
          this.bankMode = v & 0x01;
        }
        break;
      case 'MBC3':
        if (addr < 0x2000) {
          // RAMG + RTC 활성화
          this.ramEnabled = (v & 0x0f) === 0x0a;
        } else if (addr < 0x4000) {
          // ROM 뱅크 번호 (7비트)
          this.romBank = v & 0x7f;
        } else if (addr < 0x6000) {
          // RAM 뱅크 번호 / RTC 레지스터 선택
          if (v <= 0x03) {
            this.ramBank = v;
            this.rtcSelected = false;
          } else if (v >= 0x08 && v <= 0x0c) {
            this.rtcSelected = true; // RTC 스터브
          }
        } else {
          // 래치 클럭 (0 → 1): RTC 스터브라 무시
        }
        break;
      case 'MBC5':
        if (addr < 0x2000) {
          // RAMG: 하위 니블이 0xA일 때만 RAM 활성화
          this.ramEnabled = (v & 0x0f) === 0x0a;
        } else if (addr < 0x3000) {
          // ROM 뱅크 하위 8비트
          this.romBank = (this.romBank & 0x100) | v;
        } else if (addr < 0x4000) {
          // ROM 뱅크 최상위 1비트 (bit 8)
          this.romBank = (this.romBank & 0xff) | ((v & 0x01) << 8);
        } else {
          // RAM 뱅크 번호 (4비트)
          this.ramBank = v & 0x0f;
        }
        break;
    }
  }
}
