// =============================================================================
// apu.js — Game Boy APU (사운드 처리 장치)
// =============================================================================
// [구현 범위 v1]
//  - 구현됨:
//    * 0xFF10~0xFF26 전 레지스터 읽기/쓰기 (Pan Docs 읽기 마스크 적용, 크래시 없음)
//    * NR52(0xFF26) bit7 APU 전원 제어:
//      전원 OFF 시 0xFF10~0xFF25 쓰기 무시, 읽기는 0xFF (NR52만 0x70 반환)
//    * 파형 RAM(0xFF30~0xFF3F) 읽기/쓰기 (전원 상태와 무관)
//    * 채널1(사각파) 전체: 주파수 스위프(NR10) / 듀티비+길이(NR11) /
//      엔벨로프(NR12) / 주파수+트리거(NR13/NR14) 해석 및 샘플 생성
//    * APU 프레임 시퀀서(512Hz): length / sweep / envelope 클럭
//    * getSamples(n): Float32Array로 PCM 샘플 추출 (v2 WebAudio 연결용)
//  - 스터브 (레지스터 읽기/쓰기만 동작, 소리 생성 없음):
//    * 채널2(사각파), 채널3(파형), 채널4(노이즈)
//    * NR50/NR51 마스터 볼륨·패닝 믹싱 (getSamples는 채널1 DAC 원시 출력만 반환)
//    * length 카운터의 "obscure behavior"(트리거 시점 half-step 즉시 감소) 미구현
//    * GBC 2배속 모드에서의 APU 클럭 보정 미구현
// [v2 연결 포인트]
//    * `apu.sampleRate` (44100) — AudioContext와 동일한 값 사용 권장
//    * `apu.getSamples(n)` — AudioWorklet/ScriptProcessor에서 주기적으로 호출해
//      버퍼를 채우면 됨. 버퍼가 비면 0으로 패딩됨
//    * `apu.samplesAvailable()` — 현재 쌓인 샘플 수 조회
//    * 채널2~4 + NR50/NR51 믹서를 붙이면 이 파일의 step() 내 tickT()에
//      채널별 tick 호출만 추가하면 됨
// 기준: Pan Docs (https://gbdev.io/pandocs/) — Audio Registers 항목
// =============================================================================

// 듀티비 파형 테이블 (Pan Docs: 12.5% / 25% / 50% / 75%)
const DUTY_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];

// APU 프레임 시퀀서는 512Hz = 마스터 클럭(4194304Hz)의 8192 T-사이클마다 1스텝
const FRAME_SEQ_PERIOD = 8192;

// 샘플 생성용 출력 샘플레이트 (v2에서 AudioContext와 맞출 것)
const OUT_SAMPLE_RATE = 44100;
const CPU_CLOCK = 4194304;

export class APU {
  constructor() {
    // 레지스터 저장소: 0xFF10~0xFF26 → 인덱스 0~22 (쓰인 값 그대로 보관, 읽을 때 마스크 적용)
    this.reg = new Uint8Array(0x27 - 0x10);
    // 파형 RAM: 0xFF30~0xFF3F
    this.wave = new Uint8Array(16);

    // APU 전원 (NR52 bit7). 부트 직후는 켜진 상태 (DESIGN.md 4절 초기값 0xFF26=0xF1 기준)
    this.power = true;

    // 프레임 시퀀서 상태
    this.fsCounter = 0; // T-사이클 누적
    this.fsStep = 0;    // 0~7

    // ---- 채널1 상태 ----
    this.ch1 = this._newSquareChannel();
    // ---- 채널2~4는 스터브: NR52 상태 비트용 on/off만 유지 ----
    this.ch2On = false;
    this.ch3On = false;
    this.ch4On = false;

    // 샘플 출력 버퍼 (채널1 DAC 출력 0.0~1.0)
    this.sampleBuf = [];
    this.sampleFrac = 0; // T-사이클 → 샘플 변환용 분수 누적기
    this.sampleRate = OUT_SAMPLE_RATE;

    this._applyBootDefaults();
  }

  // 사각파 채널(1/2 공용 구조체, v1에서는 채널1만 실제 구동)
  _newSquareChannel() {
    return {
      enabled: false,   // 채널 on/off (NR52 상태 비트에 반영)
      dacOn: false,      // DAC on/off (off면 채널 강제 off)
      // 스위프 (채널1 전용)
      sweepPace: 0, sweepDir: 0, sweepStep: 0,
      sweepTimer: 0, sweepEnabled: false, shadowFreq: 0,
      // 듀티비 / 주파수
      duty: 0, dutyPos: 0, freq: 0, freqTimer: 0,
      // 길이 카운터
      length: 0, lengthEnable: false,
      // 엔벨로프
      volInit: 0, envDir: 0, envPace: 0, volume: 0, envTimer: 0,
    };
  }

  // DESIGN.md 4절 부트 스킵 초기값 (DMG 기준, NR52=0xF1)
  // 실제 부트롬처럼 채널1은 트리거된 상태로 둔다 (NR14=0xBF의 bit7).
  _applyBootDefaults() {
    const d = {
      0xFF10: 0x80, 0xFF11: 0xBF, 0xFF12: 0xF3, 0xFF14: 0xBF,
      0xFF16: 0x3F, 0xFF17: 0x00, 0xFF19: 0xBF,
      0xFF1A: 0x7F, 0xFF1B: 0xFF, 0xFF1C: 0x9F, 0xFF1E: 0xBF,
      0xFF20: 0xFF, 0xFF21: 0x00, 0xFF22: 0x00, 0xFF23: 0xBF,
      0xFF24: 0x77, 0xFF25: 0xF3,
    };
    for (const [addrHex, v] of Object.entries(d)) {
      const addr = Number(addrHex);
      this.reg[addr - 0xFF10] = v;
      // NR14만 트리거 비트를 실제 처리 → 부트 후 채널1 on, NR52 읽기 0xF1
      this._decodeWrite(addr, v, addr === 0xFF14);
    }
    this.power = true;
  }

  // ==========================================================================
  // 외부 인터페이스 (DESIGN.md 3.8)
  // ==========================================================================

  // tCycles: 이번에 진행할 T-사이클 수
  step(tCycles) {
    for (let i = 0; i < tCycles; i++) this._tickT();
  }

  read8(addr) {
    addr &= 0xFFFF;
    // 파형 RAM (전원 상태 무관하게 접근 가능)
    if (addr >= 0xFF30 && addr <= 0xFF3F) return this.wave[addr - 0xFF30];
    if (addr < 0xFF10 || addr > 0xFF26) return 0xFF;

    // 전원 OFF: NR52 제외하고 전부 0xFF 반환
    if (!this.power) {
      if (addr === 0xFF26) return 0x70;
      return 0xFF;
    }

    const r = this.reg[addr - 0xFF10];
    switch (addr) {
      case 0xFF10: return 0x80 | (r & 0x7F); // NR10: bit7은 항상 1
      case 0xFF11: return 0x3F | (r & 0xC0); // NR11: 듀티비(bit7-6)만 읽기 가능
      case 0xFF12: return r;                 // NR12: 전체 읽기 가능
      case 0xFF13: return 0xFF;              // NR13: 쓰기 전용
      case 0xFF14: return 0xBF | (r & 0x40); // NR14: length enable(bit6)만 읽기 가능
      case 0xFF15: return 0xFF;              // 미사용
      case 0xFF16: return 0x3F | (r & 0xC0); // NR21
      case 0xFF17: return r;                 // NR22
      case 0xFF18: return 0xFF;              // NR23: 쓰기 전용
      case 0xFF19: return 0xBF | (r & 0x40); // NR24
      case 0xFF1A: return 0x7F | (r & 0x80); // NR30: DAC(bit7)만 읽기 가능
      case 0xFF1B: return 0xFF;              // NR31: 쓰기 전용
      case 0xFF1C: return 0x9F | (r & 0x60); // NR32: 출력 레벨(bit6-5)만 읽기 가능
      case 0xFF1D: return 0xFF;              // NR33: 쓰기 전용
      case 0xFF1E: return 0xBF | (r & 0x40); // NR34
      case 0xFF1F: return 0xFF;              // 미사용
      case 0xFF20: return 0xFF;              // NR41: 쓰기 전용
      case 0xFF21: return r;                 // NR42
      case 0xFF22: return r;                 // NR43
      case 0xFF23: return 0xBF | (r & 0x40); // NR44
      case 0xFF24: return r;                 // NR50
      case 0xFF25: return r;                 // NR51
      case 0xFF26: {                         // NR52
        let v = 0x70; // bit6-4는 항상 1
        if (this.power) v |= 0x80;
        if (this.ch1.enabled) v |= 0x01;
        if (this.ch2On) v |= 0x02;
        if (this.ch3On) v |= 0x04;
        if (this.ch4On) v |= 0x08;
        return v;
      }
      default: return 0xFF;
    }
  }

  write8(addr, v) {
    addr &= 0xFFFF;
    v &= 0xFF;
    // 파형 RAM (전원 상태 무관하게 쓰기 가능)
    if (addr >= 0xFF30 && addr <= 0xFF3F) {
      this.wave[addr - 0xFF30] = v;
      return;
    }
    if (addr < 0xFF10 || addr > 0xFF26) return;

    // 전원 OFF: NR52를 제외한 0xFF10~0xFF25 쓰기는 무시 (Pan Docs)
    if (!this.power && addr !== 0xFF26) return;

    if (addr === 0xFF26) {
      const wasOn = this.power;
      this.power = (v & 0x80) !== 0;
      if (wasOn && !this.power) this._powerOff();
      else if (!wasOn && this.power) { this.fsCounter = 0; this.fsStep = 0; }
      // NR52의 bit3-0은 읽기 전용(채널 상태)이므로 저장하지 않음
      return;
    }

    this.reg[addr - 0xFF10] = v;
    this._decodeWrite(addr, v, true);
  }

  // n개 샘플을 Float32Array로 추출 (v2 WebAudio 연결용).
  // 버퍼에 모자라면 0으로 패딩, 남으면 버퍼에 유지.
  getSamples(n) {
    const out = new Float32Array(n);
    const m = Math.min(n, this.sampleBuf.length);
    for (let i = 0; i < m; i++) out[i] = this.sampleBuf[i];
    this.sampleBuf.splice(0, m);
    return out;
  }

  // 현재 버퍼에 쌓인 샘플 수
  samplesAvailable() {
    return this.sampleBuf.length;
  }

  // ==========================================================================
  // 내부: 전원 제어
  // ==========================================================================

  // 전원 OFF: 레지스터·채널 상태 전부 리셋 (파형 RAM은 유지, Pan Docs)
  _powerOff() {
    this.reg.fill(0);
    this.ch1 = this._newSquareChannel();
    this.ch2On = false;
    this.ch3On = false;
    this.ch4On = false;
    this.fsCounter = 0;
    this.fsStep = 0;
  }

  // ==========================================================================
  // 내부: 레지스터 쓰기 해석
  // trigger: 트리거 비트(NR14/NR24/NR34/NR44 bit7)를 실제 처리할지 여부.
  //          부트 초기값 적용 시에는 파라미터만 반영하고 트리거는 무시.
  // ==========================================================================
  _decodeWrite(addr, v, trigger) {
    const ch1 = this.ch1;
    switch (addr) {
      // ---- 채널1 ----
      case 0xFF10: // NR10 스위프
        ch1.sweepPace = (v >> 4) & 0x07;
        ch1.sweepDir = (v >> 3) & 0x01; // 0=주파수 증가, 1=감소
        ch1.sweepStep = v & 0x07;
        break;
      case 0xFF11: // NR11 듀티비/길이
        ch1.duty = (v >> 6) & 0x03;
        ch1.length = 64 - (v & 0x3F);
        break;
      case 0xFF12: // NR12 엔벨로프
        ch1.volInit = (v >> 4) & 0x0F;
        ch1.envDir = (v >> 3) & 0x01; // 0=감소, 1=증가
        ch1.envPace = v & 0x07;
        ch1.dacOn = (v & 0xF8) !== 0;
        if (!ch1.dacOn) ch1.enabled = false; // DAC OFF → 채널 OFF
        break;
      case 0xFF13: // NR13 주파수 하위 8비트
        ch1.freq = (ch1.freq & 0x700) | v;
        break;
      case 0xFF14: { // NR14 주파수 상위 3비트 + 제어
        ch1.freq = (ch1.freq & 0xFF) | ((v & 0x07) << 8);
        ch1.lengthEnable = (v & 0x40) !== 0;
        if (trigger && (v & 0x80)) this._triggerCh1();
        break;
      }
      // ---- 채널2 (스터브: NR52 상태 비트용) ----
      case 0xFF17: // NR22 엔벨로프 → DAC 판정
        this._ch2DacOn = (v & 0xF8) !== 0;
        if (!this._ch2DacOn) this.ch2On = false;
        break;
      case 0xFF19: // NR24 트리거
        if (trigger && (v & 0x80)) this.ch2On = !!this._ch2DacOn;
        break;
      // ---- 채널3 (스터브) ----
      case 0xFF1A: // NR30 DAC
        this._ch3DacOn = (v & 0x80) !== 0;
        if (!this._ch3DacOn) this.ch3On = false;
        break;
      case 0xFF1E: // NR34 트리거
        if (trigger && (v & 0x80)) this.ch3On = !!this._ch3DacOn;
        break;
      // ---- 채널4 (스터브) ----
      case 0xFF21: // NR42 엔벨로프 → DAC 판정
        this._ch4DacOn = (v & 0xF8) !== 0;
        if (!this._ch4DacOn) this.ch4On = false;
        break;
      case 0xFF23: // NR44 트리거
        if (trigger && (v & 0x80)) this.ch4On = !!this._ch4DacOn;
        break;
      default:
        break;
    }
  }

  // 채널1 트리거 (NR14 bit7) — Pan Docs "Trigger" 동작
  _triggerCh1() {
    const ch = this.ch1;
    ch.enabled = ch.dacOn;
    if (ch.length === 0) ch.length = 64; // 길이 카운터 리로드
    ch.freqTimer = (2048 - ch.freq) * 4; // 주파수 타이머 리로드
    ch.envTimer = ch.envPace;
    ch.volume = ch.volInit;              // 엔벨로프 리로드
    ch.dutyPos = 0;
    // 스위프 초기화
    ch.shadowFreq = ch.freq;
    ch.sweepTimer = ch.sweepPace;
    ch.sweepEnabled = ch.sweepPace > 0 || ch.sweepStep > 0;
    // 트리거 시점 스위프 오버플로우 체크 (Pan Docs)
    if (ch.sweepStep > 0 && this._sweepCalc() > 2047) ch.enabled = false;
  }

  // 스위프 주파수 계산: shadow ± (shadow >> step), 오버플로우 시 2048 초과 값 반환
  _sweepCalc() {
    const ch = this.ch1;
    let nf = ch.shadowFreq >> ch.sweepStep;
    nf = ch.sweepDir === 0 ? ch.shadowFreq + nf : ch.shadowFreq - nf;
    return nf;
  }

  // ==========================================================================
  // 내부: T-사이클 단위 진행
  // ==========================================================================

  _tickT() {
    // 프레임 시퀀서 (512Hz)
    this.fsCounter++;
    if (this.fsCounter >= FRAME_SEQ_PERIOD) {
      this.fsCounter = 0;
      this._clockFrameSequencer();
    }

    // 채널1 주파수 타이머: (2048 - freq) * 4 T-사이클마다 듀티비 위치 전진
    const ch = this.ch1;
    if (ch.enabled || ch.dacOn) {
      ch.freqTimer--;
      if (ch.freqTimer <= 0) {
        ch.freqTimer += (2048 - ch.freq) * 4;
        ch.dutyPos = (ch.dutyPos + 1) & 0x07;
      }
    }

    // 샘플 생성: OUT_SAMPLE_RATE에 맞춰 T-사이클을 샘플로 변환
    this.sampleFrac += OUT_SAMPLE_RATE / CPU_CLOCK;
    while (this.sampleFrac >= 1) {
      this.sampleFrac -= 1;
      this.sampleBuf.push(this._ch1Sample());
    }
    // v1 무음 모드에서 버퍼가 무한정 커지는 것 방지 (2초치까지만 유지)
    if (this.sampleBuf.length > OUT_SAMPLE_RATE * 2) {
      this.sampleBuf.splice(0, this.sampleBuf.length - OUT_SAMPLE_RATE * 2);
    }
  }

  // 채널1 현재 DAC 출력 (0.0~1.0). 비활성화/DAC OFF면 0.
  _ch1Sample() {
    const ch = this.ch1;
    if (!ch.enabled || !ch.dacOn) return 0;
    const high = DUTY_TABLE[ch.duty][ch.dutyPos];
    return high ? ch.volume / 15 : 0;
  }

  // 프레임 시퀀서 1스텝 (Pan Docs 순서: L=length, S=sweep, E=envelope)
  // step: 0:L 1:- 2:L+S 3:- 4:L 5:- 6:L+S 7:E
  _clockFrameSequencer() {
    const s = this.fsStep;
    if (s === 0 || s === 2 || s === 4 || s === 6) this._clockLength();
    if (s === 2 || s === 6) this._clockSweep();
    if (s === 7) this._clockEnvelope();
    this.fsStep = (this.fsStep + 1) & 0x07;
  }

  // 길이 카운터 (256Hz): 0이 되면 채널 OFF
  _clockLength() {
    const ch = this.ch1;
    if (ch.lengthEnable && ch.length > 0) {
      ch.length--;
      if (ch.length === 0) ch.enabled = false;
    }
    // 채널2~4 스터브: 길이 미구현 (명시)
  }

  // 스위프 (128Hz) — Pan Docs 의사코드 기준
  _clockSweep() {
    const ch = this.ch1;
    if (ch.sweepTimer > 0) {
      ch.sweepTimer--;
      if (ch.sweepTimer === 0) {
        ch.sweepTimer = ch.sweepPace;
        if (ch.sweepEnabled && ch.sweepPace > 0) {
          const nf = this._sweepCalc();
          if (nf <= 2047 && ch.sweepStep > 0) {
            ch.shadowFreq = nf;
            ch.freq = nf; // 실제 주파수에 반영
          }
          // 두 번째 계산으로 오버플로우 재확인 (Pan Docs)
          if (this._sweepCalc() > 2047) ch.enabled = false;
        }
      }
    }
  }

  // 엔벨로프 (64Hz)
  _clockEnvelope() {
    const ch = this.ch1;
    if (ch.envPace > 0) {
      ch.envTimer--;
      if (ch.envTimer === 0) {
        ch.envTimer = ch.envPace;
        if (ch.envDir === 0 && ch.volume > 0) ch.volume--;
        else if (ch.envDir === 1 && ch.volume < 15) ch.volume++;
      }
    }
  }
}
