// js/ppu.js
// 게임보이 / 게임보이 컬러 PPU (스캔라인 기반 렌더러)
// Pan Docs (https://gbdev.io/pandocs/) 기준.
//
// v1 단순화 사항 (알려진 한계):
// - VRAM/OAM 접근 타이밍 제한 미구현: 모드에 관계없이 언제든 읽기/쓰기 허용.
// - GBC 우선순위 규칙 단순화: BG 타일 우선순위 비트가 선 픽셀은 스프라이트를
//   BG 뒤에 그린다. 실기는 LCDC.0·스프라이트 우선순위 비트와 복합 판정한다.
// - GBC에서 LCDC bit0=0이어도 BG/윈도우는 그린다 (실기는 우선순위만 바뀜).
// - DMG에서 LCDC bit0=0이면 BG/윈도우 미표시(흰색), 스프라이트는 그대로 표시.

const WIDTH = 160;
const HEIGHT = 144;
const DOTS_PER_LINE = 456;
const MODE2_DOTS = 80;            // 모드2 (OAM 스캔)
const MODE3_DOTS = 172;           // 모드3 (픽셀 전송)
const MODE2_END = MODE2_DOTS;                 // 80
const MODE3_END = MODE2_DOTS + MODE3_DOTS;    // 252

// DMG 2비트 회색조 → 8비트 (Pan Docs: 0=#FFFFFF, 1=#AAAAAA, 2=#555555, 3=#000000)
const DMG_GRAY = [255, 170, 85, 0];

export class PPU {
  constructor(interrupt) {
    this.interrupt = interrupt;
    this.mmu = null;          // emu가 설정 (hdmaHBlank 콜백용)
    this.isGBC = false;       // emu가 설정 (컬러 게임일 때만 true)
    this.doubleSpeed = false; // emu가 KEY1에서 읽어 설정 (참고용, PPU 타이밍엔 영향 없음)

    this.frameReady = false;  // 프레임 완성 시 true, emu가 false로 리셋

    // VRAM 8KB × 2뱅크 (뱅크1은 GBC에서만 사용), OAM 160바이트
    this._vram = [new Uint8Array(0x2000), new Uint8Array(0x2000)];
    this._oam = new Uint8Array(0xA0);

    // 프레임버퍼 (내부, 매 라인 모드3 진입 시 픽셀 기록)
    this._frame = new Uint8ClampedArray(WIDTH * HEIGHT * 4);

    // GBC 컬러 팔레트 원시 데이터 (팔레트 8개 × 색 4개 × 2바이트)
    this._bgPalData = new Uint8Array(64);
    this._objPalData = new Uint8Array(64);
    this._bgpi = 0; // 0xFF68 (bit7: 자동증가, bit5-0: 인덱스)
    this._obpi = 0; // 0xFF6A

    // LCD 레지스터 (DESIGN.md 4절 부트 스킵 기본값)
    this._lcdc = 0x91;
    this._lcdOn = true;
    this._statEn = 0x00;      // STAT 쓰기 가능 비트 (bit6-3: 인터럽트 enable)
    this._coincidence = false;// LYC 일치 플래그 (STAT bit2)
    this._statLine = false;   // STAT 인터럽트 신호 이전 상태 (상승 엣지 검출용)
    this._scy = 0x00;
    this._scx = 0x00;
    this._ly = 0x00;          // 0xFF44 읽기 전용
    this._lyc = 0x00;
    this._bgp = 0xFC;
    this._obp0 = 0xFF;
    this._obp1 = 0xFF;
    this._wy = 0x00;
    this._wx = 0x00;
    this._vbk = 0x00;         // 0xFF4F (bit0: VRAM 뱅크 선택)

    // 타이밍 상태
    this._dot = 0;            // 현재 라인 내 도트 카운터 (0-455)
    this._mode = 2;           // 현재 PPU 모드 (0-3)
    this._windowLine = 0;     // 윈도우 내부 라인 카운터 (프레임 시작 시 리셋)

    // 라인 렌더링용 마스크 (BG → 스프라이트 우선순위 판정)
    this._bgPrio = new Uint8Array(WIDTH); // GBC BG 타일 우선순위 비트
    this._bgZero = new Uint8Array(WIDTH); // BG 색상 비트 == 0 (투명 취급)

    this._updateStatLine();
  }

  // ---- 타이밍 ----

  // 도트 단위 진행 (emu 루프에서 호출)
  step(dots) {
    if (!this._lcdOn) return; // LCD 꺼져 있으면 PPU 정지
    for (let i = 0; i < dots; i++) this._tickDot();
  }

  _tickDot() {
    this._dot++;
    if (this._dot >= DOTS_PER_LINE) {
      this._dot = 0;
      this._nextLine();
    }
    let mode;
    if (this._ly >= 144) mode = 1;             // 144-153: VBlank
    else if (this._dot < MODE2_END) mode = 2;  // 0-79: OAM 스캔
    else if (this._dot < MODE3_END) mode = 3;  // 80-251: 픽셀 전송
    else mode = 0;                             // 252-455: HBlank
    if (mode !== this._mode) this._enterMode(mode);
  }

  _enterMode(mode) {
    this._mode = mode;
    if (mode === 3) {
      // 모드3 진입: 현재 라인을 픽셀 단위로 프레임버퍼에 기록
      this._renderScanline(this._ly);
    } else if (mode === 0) {
      // HBlank 진입: GBC HDMA가 16바이트씩 복사
      if (this.mmu) this.mmu.hdmaHBlank();
    }
    this._updateStatLine();
  }

  _nextLine() {
    this._ly++;
    if (this._ly > 153) {
      this._ly = 0;
      this._windowLine = 0; // 새 프레임: 윈도우 라인 카운터 리셋
    }
    if (this._ly === 144) {
      this.interrupt.request(0); // VBlank 인터럽트
      this.frameReady = true;    // emu가 false로 리셋
    }
    this._checkLyc();
  }

  // ---- STAT ----

  _checkLyc() {
    const c = this._ly === this._lyc;
    if (c !== this._coincidence) {
      this._coincidence = c;
      this._updateStatLine();
    }
  }

  // STAT 인터럽트 신호 = (LYC일치&en) | (모드0&en) | (모드1&en) | (모드2&en)
  // 0→1 상승 엣지에서만 인터럽트 요청 (Pan Docs 권장 방식)
  _updateStatLine() {
    const en = this._statEn;
    const line =
      ((en & 0x40) !== 0 && this._coincidence) ||
      ((en & 0x20) !== 0 && this._mode === 2) ||
      ((en & 0x10) !== 0 && this._mode === 1) ||
      ((en & 0x08) !== 0 && this._mode === 0);
    if (line && !this._statLine) this.interrupt.request(1); // STAT 인터럽트
    this._statLine = line;
  }

  // ---- 렌더링 ----

  getFrame() {
    return this._frame;
  }

  // 타일맵 한 픽셀의 색상 비트(0-3), GBC 팔레트 번호, GBC 우선순위 비트를 구한다.
  // xbit: 타일 내 x 위치(0-7, 반전 전), yline: 타일 내 y 위치(0-7, 반전 전)
  _fetchTile(mapAddr, xbit, yline) {
    const tileNo = this._vram[0][mapAddr];
    let bank = 0, pal = 0, prio = 0, fx = false, fy = false;
    if (this.isGBC) {
      const a = this._vram[1][mapAddr]; // VRAM 뱅크1: 타일 속성
      pal = a & 0x07;                   // bit0-2: 팔레트
      bank = (a >> 3) & 0x01;           // bit3: VRAM 뱅크
      fx = (a & 0x20) !== 0;            // bit5: x반전
      fy = (a & 0x40) !== 0;            // bit6: y반전
      prio = (a >> 7) & 0x01;           // bit7: 우선순위
    }
    const unsigned = (this._lcdc & 0x10) !== 0;
    // LCDC bit4=1: 0x8000 기준 unsigned / bit4=0: 0x9000 기준 signed
    const taddr = unsigned ? tileNo * 16 : 0x1000 + (((tileNo << 24) >> 24) << 4);
    const ln = fy ? 7 - yline : yline;
    const b1 = this._vram[bank][taddr + ln * 2];
    const b2 = this._vram[bank][taddr + ln * 2 + 1];
    const bit = fx ? xbit : 7 - xbit;
    const cb = ((b1 >> bit) & 1) | (((b2 >> bit) & 1) << 1);
    return { cb, pal, prio };
  }

  _writePixelRGB(o, r, g, b) {
    const buf = this._frame;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
  }

  // 15비트 BGR → 8비트 RGB (5비트→8비트: (v<<3)|(v>>2))
  _writePixel15(o, v15) {
    const r5 = v15 & 0x1F, g5 = (v15 >> 5) & 0x1F, b5 = (v15 >> 10) & 0x1F;
    this._writePixelRGB(o, (r5 << 3) | (r5 >> 2), (g5 << 3) | (g5 >> 2), (b5 << 3) | (b5 >> 2));
  }

  // BG/윈도우 공통: 타일 픽셀을 프레임버퍼에 기록하고 우선순위 마스크 갱신
  _drawTilePixel(o, x, t) {
    if (this.isGBC) {
      const p = (t.pal * 4 + t.cb) * 2;
      const v15 = this._bgPalData[p] | (this._bgPalData[p + 1] << 8);
      this._writePixel15(o, v15);
      this._bgPrio[x] = t.prio;
    } else {
      const g = DMG_GRAY[(this._bgp >> (t.cb * 2)) & 3];
      this._writePixelRGB(o, g, g, g);
    }
    this._bgZero[x] = t.cb === 0 ? 1 : 0;
  }

  _renderScanline(ly) {
    const rowBase = ly * WIDTH * 4;
    const lcdc = this._lcdc;
    const bgEn = (lcdc & 0x01) !== 0;
    const useColor = this.isGBC;

    // ---- 배경 (BG) ----
    if (useColor || bgEn) {
      // v1 단순화: GBC에서는 LCDC bit0=0이어도 BG를 그린다 (실기는 우선순위만 변경).
      const mapBase = (lcdc & 0x08) ? 0x1C00 : 0x1800; // bit3: 0x9800/0x9C00
      const scy = this._scy, scx = this._scx;
      for (let x = 0; x < WIDTH; x++) {
        const px = (x + scx) & 0xFF;
        const py = (ly + scy) & 0xFF;
        const t = this._fetchTile(mapBase + ((py >> 3) << 5) + (px >> 3), px & 7, py & 7);
        this._drawTilePixel(rowBase + x * 4, x, t);
      }
    } else {
      // DMG + BG 비활성: 흰색으로 채움
      for (let x = 0; x < WIDTH; x++) {
        this._writePixelRGB(rowBase + x * 4, 255, 255, 255);
        this._bgZero[x] = 1;
        this._bgPrio[x] = 0;
      }
    }

    // ---- 윈도우 ----
    // WX-7이 화면 x좌표, WY가 화면 y좌표. WX>166이면 화면 밖.
    const winEn = (lcdc & 0x20) !== 0;
    if (winEn && (useColor || bgEn) && ly >= this._wy && this._wx <= 166) {
      const mapBase = (lcdc & 0x40) ? 0x1C00 : 0x1800; // bit6: 0x9800/0x9C00
      let drawn = false;
      for (let x = 0; x < WIDTH; x++) {
        const wxp = x - (this._wx - 7);
        if (wxp < 0) continue;
        drawn = true;
        const t = this._fetchTile(mapBase + ((this._windowLine >> 3) << 5) + (wxp >> 3), wxp & 7, this._windowLine & 7);
        this._drawTilePixel(rowBase + x * 4, x, t);
      }
      if (drawn) this._windowLine++;
    }

    // ---- 스프라이트 ----
    this._renderSprites(ly, rowBase);
  }

  _renderSprites(ly, rowBase) {
    const lcdc = this._lcdc;
    if ((lcdc & 0x02) === 0) return; // 스프라이트 비활성
    const tall = (lcdc & 0x04) !== 0; // bit2: 8x8 / 8x16
    const h = tall ? 16 : 8;
    const useColor = this.isGBC;

    // 라인에 걸치는 스프라이트 수집 (OAM 순서대로, 라인당 최대 10개)
    const found = [];
    for (let i = 0; i < 40 && found.length < 10; i++) {
      const sy = this._oam[i * 4] - 16;
      if (ly >= sy && ly < sy + h) found.push(i);
    }
    if (found.length === 0) return;

    // 그리기 순서: 나중에 그릴수록 위에 보인다.
    // DMG: x좌표 작은 순, 동점이면 OAM 인덱스 작은 순이 우선 → 역순 그리기.
    // GBC: OAM 인덱스 작은 순이 우선 → 역순 그리기.
    if (useColor) found.reverse();
    else found.sort((a, b) => {
      const dx = this._oam[b * 4 + 1] - this._oam[a * 4 + 1];
      return dx !== 0 ? dx : b - a;
    });

    const buf = this._frame;
    for (const i of found) {
      const base = i * 4;
      const sy = this._oam[base] - 16;
      const sx = this._oam[base + 1] - 8;
      let tile = this._oam[base + 2];
      const flags = this._oam[base + 3];
      if (tall) tile &= 0xFE; // 8x16: 하위 비트 무시, 위쪽 타일 기준
      const flipX = (flags & 0x20) !== 0;
      const flipY = (flags & 0x40) !== 0;
      let line = ly - sy;
      if (flipY) line = h - 1 - line;
      const bank = useColor ? ((flags >> 3) & 0x01) : 0; // GBC bit3: VRAM 뱅크
      // 8x16이면 line 8-15가 (tile+1) 영역에 걸린다 (tile이 짝수이므로 자동 처리)
      const taddr = tile * 16 + line * 2;
      const b1 = this._vram[bank][taddr];
      const b2 = this._vram[bank][taddr + 1];
      for (let p = 0; p < 8; p++) {
        const x = sx + p;
        if (x < 0 || x >= WIDTH) continue;
        const bit = flipX ? p : 7 - p;
        const cb = ((b1 >> bit) & 1) | (((b2 >> bit) & 1) << 1);
        if (cb === 0) continue; // 색상 0 = 투명
        const bgIsZero = this._bgZero[x] === 1;
        const o = rowBase + x * 4;
        if (useColor) {
          // v1 단순화: BG 타일 우선순위 비트가 선 픽셀은 스프라이트를 BG 뒤에 그린다.
          if (this._bgPrio[x] === 1 && !bgIsZero) continue;
          if ((flags & 0x80) !== 0 && !bgIsZero) continue; // 스프라이트 우선순위 비트
          const pi = ((flags & 0x07) * 4 + cb) * 2; // GBC bit0-2: OBJ 팔레트
          const v15 = this._objPalData[pi] | (this._objPalData[pi + 1] << 8);
          const r5 = v15 & 0x1F, g5 = (v15 >> 5) & 0x1F, b5 = (v15 >> 10) & 0x1F;
          buf[o] = (r5 << 3) | (r5 >> 2);
          buf[o + 1] = (g5 << 3) | (g5 >> 2);
          buf[o + 2] = (b5 << 3) | (b5 >> 2);
          buf[o + 3] = 255;
        } else {
          if ((flags & 0x80) !== 0 && !bgIsZero) continue; // BG 색 1-3 뒤로
          const preg = (flags & 0x10) !== 0 ? this._obp1 : this._obp0; // bit4: 팔레트 선택
          const g = DMG_GRAY[(preg >> (cb * 2)) & 3];
          buf[o] = g; buf[o + 1] = g; buf[o + 2] = g; buf[o + 3] = 255;
        }
      }
    }
  }

  // ---- 레지스터 / 메모리 접근 ----

  // GBC 팔레트 데이터 쓰기 + 자동증가 처리 → 갱신된 인덱스 값 반환
  _writePal(data, pi, v) {
    data[pi & 0x3F] = v & 0xFF;
    if ((pi & 0x80) !== 0) return 0x80 | (((pi & 0x3F) + 1) & 0x3F); // 자동증가
    return pi;
  }

  read8(addr) {
    addr &= 0xFFFF;
    if (addr >= 0x8000 && addr <= 0x9FFF) {
      // v1: VRAM 접근 타이밍 제한 없음 (모드3 중에도 읽기 허용)
      const bank = this.isGBC ? (this._vbk & 1) : 0;
      return this._vram[bank][addr - 0x8000];
    }
    if (addr >= 0xFE00 && addr <= 0xFE9F) {
      // v1: OAM 접근 타이밍 제한 없음
      return this._oam[addr - 0xFE00];
    }
    switch (addr) {
      case 0xFF40: return this._lcdc;
      // STAT: bit7은 항상 1, bit6-3은 쓰기 가능, bit2=LYC일치, bit1-0=모드
      case 0xFF41: return 0x80 | this._statEn | (this._coincidence ? 0x04 : 0) | this._mode;
      case 0xFF42: return this._scy;
      case 0xFF43: return this._scx;
      case 0xFF44: return this._ly; // 읽기 전용
      case 0xFF45: return this._lyc;
      case 0xFF46: return 0xFF; // OAM DMA는 MMU가 처리
      case 0xFF47: return this._bgp;
      case 0xFF48: return this._obp0;
      case 0xFF49: return this._obp1;
      case 0xFF4A: return this._wy;
      case 0xFF4B: return this._wx;
      case 0xFF4F: return this.isGBC ? (0xFE | (this._vbk & 1)) : 0xFF; // VBK (GBC 전용)
      case 0xFF68: return this.isGBC ? this._bgpi : 0xFF;
      case 0xFF69: return this.isGBC ? this._bgPalData[this._bgpi & 0x3F] : 0xFF;
      case 0xFF6A: return this.isGBC ? this._obpi : 0xFF;
      case 0xFF6B: return this.isGBC ? this._objPalData[this._obpi & 0x3F] : 0xFF;
      default: return 0xFF;
    }
  }

  write8(addr, v) {
    addr &= 0xFFFF;
    v &= 0xFF;
    if (addr >= 0x8000 && addr <= 0x9FFF) {
      // v1: VRAM 접근 타이밍 제한 없음 (모드3 중에도 쓰기 허용)
      const bank = this.isGBC ? (this._vbk & 1) : 0; // VBK bit0으로 뱅크 선택
      this._vram[bank][addr - 0x8000] = v;
      return;
    }
    if (addr >= 0xFE00 && addr <= 0xFE9F) {
      // v1: OAM 접근 타이밍 제한 없음
      this._oam[addr - 0xFE00] = v;
      return;
    }
    switch (addr) {
      case 0xFF40: {
        const wasOn = this._lcdOn;
        this._lcdc = v;
        const nowOn = (v & 0x80) !== 0;
        if (wasOn && !nowOn) {
          // LCD 끄기: LY=0, 모드=0으로 리셋 (Pan Docs)
          this._lcdOn = false;
          this._ly = 0;
          this._dot = 0;
          this._mode = 0;
          this._checkLyc();
        } else if (!wasOn && nowOn) {
          // LCD 켜기: 모드2부터 시작
          this._lcdOn = true;
          this._dot = 0;
          this._mode = 2;
          this._updateStatLine();
        }
        break;
      }
      case 0xFF41:
        this._statEn = v & 0x78; // bit6-3만 쓰기 가능
        this._updateStatLine();
        break;
      case 0xFF42: this._scy = v; break;
      case 0xFF43: this._scx = v; break;
      case 0xFF44: break; // LY 읽기 전용: 쓰기 무시
      case 0xFF45:
        this._lyc = v;
        this._checkLyc(); // LYC 비교 → STAT 일치 플래그 + STAT 인터럽트
        break;
      case 0xFF46: break; // OAM DMA는 MMU가 처리
      case 0xFF47: this._bgp = v; break;
      case 0xFF48: this._obp0 = v; break;
      case 0xFF49: this._obp1 = v; break;
      case 0xFF4A: this._wy = v; break;
      case 0xFF4B: this._wx = v; break;
      case 0xFF4F: // VBK (GBC 전용)
        if (this.isGBC) this._vbk = v & 1;
        break;
      case 0xFF68: // BGPI (GBC 전용)
        if (this.isGBC) this._bgpi = v;
        break;
      case 0xFF69: // BGPD (GBC 전용, 자동증가)
        if (this.isGBC) this._bgpi = this._writePal(this._bgPalData, this._bgpi, v);
        break;
      case 0xFF6A: // OBPI (GBC 전용)
        if (this.isGBC) this._obpi = v;
        break;
      case 0xFF6B: // OBPD (GBC 전용, 자동증가)
        if (this.isGBC) this._obpi = this._writePal(this._objPalData, this._obpi, v);
        break;
      default: break;
    }
  }
}
