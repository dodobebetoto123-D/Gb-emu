# GB-EMU 설계 문서 (v0.1)

웹 기반 Game Boy / Game Boy Color 에뮬레이터. GBA는 범위 밖.
부트 롬(BIOS) 미사용 — CPU 레지스터를 직접 초기화해 부트 과정을 스킵하는 표준 방식.
롬 파일은 사용자가 직접 올림 (저작권 경계).

## 1. 파일 구조

```
~/workspace/gb-emu/
├── package.json        # {"type": "module"}
├── index.html          # 프론트엔드 셸 (canvas 160x144, 파일 로더, 버튼)
├── DESIGN.md           # 이 문서
├── README.md           # 실행 방법 (QA 페이즈에서 작성)
└── js/
    ├── cpu.js          # LR35902 CPU 인터프리터 (256 + CB 256 오프코드)
    ├── mmu.js          # 64KB 메모리맵 + I/O 레지스터 + DMA
    ├── cartridge.js    # 롬 헤더 파싱, MBC1/MBC3/MBC5, 외부 RAM
    ├── timer.js        # DIV/TIMA/TMA/TAC
    ├── interrupt.js    # IE/IF, IME, 인터럽트 서비스
    ├── ppu.js          # 스캔라인 렌더러 (DMG 팔레트 + GBC 컬러)
    ├── joypad.js       # 입력
    ├── apu.js          # v1: 레지스터 스터브 (크래시 방지), 사각파 선택 구현
    ├── emu.js          # 전체 통합 (Emulator 클래스, 프레임 루프)
    └── app.js          # 프론트엔드 로직 (canvas, 키보드, 버튼)
```

모든 JS는 ES 모듈(`import`/`export`). 주석은 한국어 위주.

## 2. 전역 타이밍

- 마스터 클럭: 4,194,304 Hz (T-사이클 기준). 1 M-사이클 = 4 T-사이클.
- 1 프레임 = 154 스캔라인 × 456 도트 = 70,224 T-사이클 (약 59.7fps).
- CPU `step()`은 1개 명령어를 실행하고 소비한 T-사이클 수를 반환.
- 메인 루프(emu.js): 프레임이 끝날 때까지 아래 반복
  ```
  c = cpu.step()
  c += mmu.takeDmaStall()      // OAM DMA/GDMA 스톨 회수
  timer.step(c); ppu.step(ppuDots(c)); apu.step(c)
  c2 = interrupt.service(cpu)   // 인터럽트 있으면 처리, 소비 사이클 반환
  timer.step(c2); ppu.step(...); apu.step(c2)
  ```
- GBC 2배속 모드: CPU는 도트당 2 T-사이클 소비. PPU/타이머에는 "도트" 단위로 전달.
  즉 `ppu.step(dots)`, `timer.step(dots, doubleSpeed)` 형태로 호출.
  - timer 내부: 16비트 sysCounter += dots * (doubleSpeed ? 2 : 1)
  - ppu 내부: 도트 카운터 그대로 (스캔라인당 456 도트)

## 3. 모듈 인터페이스

### 3.1 cartridge.js — `export class Cartridge`
```js
new Cartridge(romData: Uint8Array)
cart.read8(addr)    // 0x0000-0x7FFF, 0xA000-0xBFFF 영역
cart.write8(addr, v) // MBC 제어 + 외부 RAM 쓰기
cart.title          // 롬 제목 문자열
cart.isGBC          // CGB 플래그 (0x80 지원 / 0xC0 전용)
cart.requiresGBC
cart.mbcType        // 'NONE' | 'MBC1' | 'MBC3' | 'MBC5'
```
- 헤더: 0x134-0x143 제목, 0x143 CGB 플래그, 0x147 카트리지 타입, 0x148 ROM 크기, 0x149 RAM 크기.
- MBC1: RAMG(2비트), ROM 뱅크 하위 5비트, 상위 2비트, 모드 셀렉트. 뱅크 0 금지(→1).
- MBC3: MBC1 유사 + RTC 레지스터 (RTC는 스터브: 읽기 시 0 반환, 크래시만 방지).
- MBC5: ROM 뱅크 9비트(하위 8 + 상위 1), RAM 뱅크 4비트.
- 지원 범위: MBC1/MBC3/MBC5 + MBC 없음. 그 외 타입은 에러 throw.

### 3.2 mmu.js — `export class MMU`
```js
new MMU({ cart, ppu, timer, joypad, apu, interrupt })
mmu.read8(addr) -> 0-255
mmu.write8(addr, v)
mmu.takeDmaStall() -> number  // 쌓인 DMA 스톨 T-사이클을 반환하고 0으로 리셋
mmu.hdmaHBlank()              // PPU가 HBlank 시작 시 호출 (GBC HDMA용)
mmu.doubleSpeed               // boolean, KEY1 반영
```
- 메모리맵:
  - 0x0000-0x3FFF: ROM 뱅크 0 → cart
  - 0x4000-0x7FFF: ROM 뱅크 N → cart
  - 0x8000-0x9FFF: VRAM → ppu (GBC: VBK 뱅크)
  - 0xA000-0xBFFF: 외부 RAM → cart
  - 0xC000-0xCFFF: WRAM 뱅크 0
  - 0xD000-0xDFFF: WRAM 뱅크 1-7 (GBC: SVBK, 0은 1로 취급)
  - 0xE000-0xFDFF: 에코 RAM (0xC000-0xDDFF 미러)
  - 0xFE00-0xFE9F: OAM → ppu
  - 0xFEA0-0xFEFF: 미사용 (읽기 0xFF)
  - 0xFF00: JOYP → joypad
  - 0xFF01/0xFF02: 시리얼 (스터브: 저장만)
  - 0xFF04-0xFF07: 타이머 → timer
  - 0xFF0F: IF → interrupt
  - 0xFF10-0xFF3F: APU → apu
  - 0xFF40-0xFF4B: PPU → ppu
  - 0xFF4D: KEY1 (GBC 2배속 준비/상태)
  - 0xFF4F: VBK → ppu
  - 0xFF51-0xFF55: HDMA → mmu 내부 처리
  - 0xFF68-0xFF6B: GBC 팔레트 → ppu
  - 0xFF70: SVBK (mmu 내부)
  - 0xFF80-0xFFFE: HRAM (내부 배열)
  - 0xFFFF: IE → interrupt
- OAM DMA (0xFF46 쓰기): 160바이트 복사 (src=v<<8), `dmaStall += 640` T-사이클.
- GBC HDMA:
  - HDMA5(0xFF55) 쓰기, bit7=0 → GDMA: 즉시 복사, 스톨 = (바이트수/16)*8 M-사이클 = 바이트수*2 T-사이클.
  - bit7=1 → HDMA 모드: HBlank마다 16바이트씩. `hdmaHBlank()`가 PPU HBlank 진입 시 호출됨.
  - 복사 방향: 0xFF51/52(출발) → 0xFF53/54(도착, 상위 0x80-0x9F만 → VRAM).
- v1에서는 VRAM/OAM 접근 타이밍 제한 미구현 (언제든 접근 허용) — 알려진 한계.

### 3.3 timer.js — `export class Timer`
```js
new Timer(interrupt)
timer.step(dots, doubleSpeed)
timer.read8(addr)   // 0xFF04-0xFF07
timer.write8(addr, v)
```
- 내부 16비트 sysCounter. DIV = (sysCounter >> 8) & 0xFF (읽기 전용, 쓰기 시 0으로 리셋).
- TAC bit2=enable, bit1-0 클럭 선택 → 감시 비트: [9, 3, 5, 7] (각각 4096/262144/65536/16384Hz).
- 폴링 엣지 검출: 이전 (감시비트 & enable) 값이 1→0으로 떨어지면 TIMA++.
- TIMA 오버플로우(0xFF→0x00): TMA 값을 TIMA에 로드, timer 인터럽트 요청.
- 쓰기 동작: DIV 쓰기=리셋, TIMA/TMA/TAC 쓰기는 값 저장.

### 3.4 interrupt.js — `export class Interrupt`
```js
new Interrupt()
interrupt.request(bit)   // bit 0-4: IF 세트
interrupt.service(cpu) -> cycles  // 처리했으면 20, 아니면 0
interrupt.readIE() / writeIE(v)
interrupt.readIF() / writeIF(v)
interrupt.ime             // boolean, DI/EI/RETI가 조작
```
- 벡터: VBlank 0x40, STAT 0x48, Timer 0x50, Serial 0x58, Joypad 0x60.
- 처리: IME && (IE & IF) != 0 → IME=false, 스택에 PC 푸시, PC=벡터, IF 비트 클리어, 20 T-사이클.
- 우선순위: 비트 번호 낮은 순.

### 3.5 cpu.js — `export class CPU`
```js
new CPU(mmu, interrupt)
cpu.reset()          // 부트 스킵 초기화 (아래 7절)
cpu.step() -> tCycles // 1 명령어 실행
cpu.halted           // HALT 상태 플래그
// 레지스터: a,f,b,c,d,e,h,l, sp, pc, ime는 interrupt.ime 사용
```
- 256 기본 + 256 CB 오프코드 전부 구현. 사이클 카운팅 정확히 (조건 분기 taken/not-taken 구분).
- HALT: 인터럽트 대기. IME=0 + pending이면 "halt bug" (다음 바이트 스킵) — v1 선택 구현, 미구현 시 명시.
- STOP: GBC에서 KEY1 bit0 세트 시 2배속 전환 후 계속. DMG에서는 그냥 정지(무한 루프 방지: NOP처럼 처리).
- DI/EI: interrupt.ime 조작. EI는 1 명령어 지연 (v1에서는 즉시 적용 허용, 명시).

### 3.6 ppu.js — `export class PPU`
```js
new PPU(interrupt)
ppu.step(dots)
ppu.getFrame() -> Uint8ClampedArray  // 160*144*4 RGBA
ppu.read8(addr) / write8(addr)       // VRAM/OAM/레지스터
ppu.frameReady                       // boolean, 프레임 완성 시 true (emu가 리셋)
ppu.isGBC                            // emu가 설정 (카트리지 보고 결정)
ppu.mmu = null                       // emu가 설정 (hdmaHBlank 콜백용)
ppu.doubleSpeed                      // emu가 KEY1에서 읽어 설정 (참고용)
```
- 모드: 2(OAM 탐색, 80도트) → 3(그리기, 172도트) → 0(HBlank, 204도트) → ... 144-153: 모드 1(VBlank).
- LY(0xFF44) 읽기 전용. LYC 비교 → STAT 일치 플래그 + STAT 인터럽트.
- STAT 인터럽트 조건: LYC 일치, 모드 0/1/2 (각각 enable 비트).
- VBlank 진입 시 VBlank 인터럽트 요청.
- 배경: LCDC bit3 타일맵 선택(0x9800/0x9C00), bit4 타일데이터(0x8800 signed / 0x8000 unsigned), bit0 BG 표시.
- 윈도우: LCDC bit5, WY(0xFF4A), WX(0xFF4B)-7.
- 스프라이트: LCDC bit1, 8x8/8x16(bit2), OAM 40개, 라인당 10개, x좌우반전/y상하반전/우선순위.
- DMG 팔레트: BGP(0xFF47), OBP0(0xFF48), OBP1(0xFF49). 2비트 → 4단계 회색.
  - RGB: 0=#FFFFFF(255,255,255), 1=#AAAAAA(170,170,170), 2=#555555(85,85,85), 3=#000000.
- GBC 컬러: BGPI(0xFF68)/BGPD(0xFF69), OBPI(0xFF6A)/OBPD(0xFF6B), 자동증가 비트.
  - 15비트 BGR → 24비트 RGB 변환 (5비트 → 8비트: (v<<3)|(v>>2)).
  - 타일 속성 (VRAM 뱅크1): bit0-2 팔레트, bit3 뱅크, bit5 x반전, bit6 y반전, bit7 우선순위.
  - DMG 게임이 GBC에서 돌 때는 DMG 팔레트 경로 사용 (isGBC && cart.isGBC 일 때만 컬러).
- 렌더링: 스캔라인 단위. 모드 3에서 현재 라인을 픽셀 단위로 그림.
- 우선순위 규칙 v1: BG 우선순위 비트가 있으면 스프라이트 뒤에 그림 (단순화 허용, 명시).

### 3.7 joypad.js — `export class Joypad`
```js
new Joypad(interrupt)
joypad.setButton(name, pressed)  // 'up','down','left','right','a','b','start','select'
joypad.read8()  -> P1 값
joypad.write8(v) // 셀렉트 비트 (bit4=방향키, bit5=버튼)
```
- 눌린 버튼: 해당 비트 0. 선택되지 않은 그룹은 비트 1.
- 버튼 눌림(1→0 전이) 시 조이패드 인터럽트 요청.

### 3.8 apu.js — `export class APU`
```js
new APU()
apu.step(tCycles)
apu.read8(addr) / write8(addr)  // 0xFF10-0xFF3F, 파형 RAM 포함
```
- v1 필수: 모든 레지스터 읽기/쓰기가 크래시 없이 동작. NR52 읽기 시 적절 값.
- v1 선택: 채널1 사각파를 WebAudio 없이 샘플 버퍼로 생성 (프론트엔드 연동은 v2).
  - 범위 초과 시 스터브만으로 충분. 무엇을 했는지 명시할 것.

### 3.9 emu.js — `export class Emulator`
```js
new Emulator()
emu.loadROM(uint8: Uint8Array)  // Cartridge 생성, GBC 판별, 전체 리셋
emu.reset()
emu.stepFrame()                // 프레임 완성까지 실행
emu.getFrame() -> Uint8ClampedArray
emu.setButton(name, pressed)
emu.isGBC, emu.romTitle
```
- 생성 순서: interrupt → timer → ppu → joypad → apu → (loadROM 시) cartridge → mmu → cpu.
- `ppu.mmu = mmu`, `ppu.isGBC = cart.isGBC` 설정.
- KEY1 처리: STOP 명령 시 mmu가 doubleSpeed 토글 → emu 루프가 dots 계산에 반영.
  (CPU STOP 구현이 mmu.doubleSpeed를 직접 바꾸도록. mmu에 `requestSpeedSwitch()` 메서드.)

### 3.10 app.js + index.html
- canvas 160×144, CSS로 3배(480×432) 표시, `image-rendering: pixelated`.
- 파일 입력(`<input type="file">`) + 드래그앤드롭(선택).
- 버튼: 시작/일시정지 토글, 리셋.
- 키보드: 방향키, Z=B, X=A, Enter=Start, Shift=Select. 방향키 기본 스크롤 방지.
- rAF 루프: 일시정지 아닐 때 `emu.stepFrame()` → `putImageData`.
- 상태 표시: 롬 제목, GBC/DMG 모드.

## 4. 부트 스킵 초기화 (cpu.reset)

DMG:
- A=0x01, F=0xB0, B=0x00, C=0x13, D=0x00, E=0xD8, H=0x01, L=0x4D, SP=0xFFFE, PC=0x0100
GBC (CGB 게임 실행 시):
- A=0x11, F=0x80, 나머지는 DMG와 동일
I/O (Pan Docs Power Up Sequence 기준):
- 0xFF05=0x00, 0xFF06=0x00, 0xFF07=0x00, 0xFF0F=0x00(쓰기 시 하위 5비트만), 0xFFFF=0x00
- 0xFF40=0x91, 0xFF42=0x00, 0xFF43=0x00, 0xFF44=0x00, 0xFF45=0x00
- 0xFF47=0xFC, 0xFF48=0xFF, 0xFF49=0xFF, 0xFF4A=0x00, 0xFF4B=0x00
- APU: 0xFF10=0x80, 0xFF11=0xBF, 0xFF12=0xF3, 0xFF14=0xBF, 0xFF16=0x3F, 0xFF17=0x00,
  0xFF19=0xBF, 0xFF1A=0x7F, 0xFF1B=0xFF, 0xFF1C=0x9F, 0xFF1E=0xBF,
  0xFF20=0xFF, 0xFF21=0x00, 0xFF22=0x00, 0xFF23=0xBF,
  0xFF24=0x77, 0xFF25=0xF3, 0xFF26=0xF1(DMG)/0xF0(CGB)
- GBC: 0xFF4D=0x00, 0xFF4F=0x00, 0xFF51-0xFF55=0x00/0xFF..., 0xFF68-0xFF6B=0x00, 0xFF70: WRAM 뱅크=1
- IME=false, halted=false

## 5. 테스트

- `node --check` 전 파일 문법 검증.
- CPU 단위 테스트: `js/cpu_test.js` (node 실행). mock MMU(단순 배열 기반)로 주요 오프코드 검증:
  LD r,r / LD r,n / ADD / SUB / AND/OR/XOR / INC/DEC / JP / CALL/RET / PUSH/POP / CB BIT/SET/RES/RLC.
- 부팅 경로 리뷰: loadROM → reset → stepFrame 크래시 없이 N프레임 실행 (롬 없이 더미 카트리지로).

## 6. 알려진 한계 (v1)

- VRAM/OAM 접근 타이밍 제한 미구현.
- APU는 스터브 (무음).
- HALT 버그/EI 지연 등 엣지 케이스 일부 단순화 (구현 시 명시).
- 세이브 (배터리 RAM 영속화) 미구현.
- 시리얼 통신 미구현.

## 7. 참고 자료 (자식 에이전트용)

- Pan Docs: https://gbdev.io/pandocs/
- 오프코드 표: https://www.pastraiser.com/cpu/gameboy/gameboy_opcodes.html
- 테스트 롬 (사용자용, README에 기재): Blargg's test ROMs
