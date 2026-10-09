// joypad.js — 조이패드 (JOYP 0xFF00) 입력 처리
//
// P1 레지스터 비트 구성:
//   bit0-3: 버튼 상태 (눌림=0, 안 눌림=1)
//   bit4: 방향키 그룹 선택 (0=선택)
//   bit5: 버튼(A/B/Start/Select) 그룹 선택 (0=선택)
//   bit6-7: 읽기 시 항상 1
// 선택되지 않은 그룹의 하위 4비트는 1로 읽힌다.

export class Joypad {
  // interrupt: Interrupt 인스턴스 (버튼 눌림 시 조이패드 인터럽트 요청용)
  constructor(interrupt) {
    this.interrupt = interrupt;
    // 셀렉트 비트: bit4(방향키), bit5(버튼). 쓰기 시 저장됨.
    this.selectDir = false;   // bit4=0 → 방향키 그룹 선택
    this.selectBtn = false;   // bit5=0 → 버튼 그룹 선택
    // 버튼 상태 (true=눌림). 내부 비트는 눌림=0.
    this.buttons = {
      right: false,
      left: false,
      up: false,
      down: false,
      a: false,
      b: false,
      select: false,
      start: false,
    };
  }

  // name: 'up','down','left','right','a','b','start','select'
  // pressed: true(누름) / false(뗌)
  setButton(name, pressed) {
    if (!(name in this.buttons)) return;
    pressed = !!pressed;
    const prev = this.buttons[name];
    this.buttons[name] = pressed;
    // 눌림 전이(1→0, 즉 뗌→누름) 시 조이패드 인터럽트 요청 (IF bit4)
    if (!prev && pressed) {
      this.interrupt.request(4);
    }
  }

  // P1 읽기
  read8() {
    // 방향키 그룹 비트: bit0=Right, bit1=Left, bit2=Up, bit3=Down
    let dir = 0x0f;
    if (this.selectDir) {
      dir = (this.buttons.right ? 0 : 1) |
            (this.buttons.left  ? 0 : 2) |
            (this.buttons.up    ? 0 : 4) |
            (this.buttons.down  ? 0 : 8);
    }
    // 버튼 그룹 비트: bit0=A, bit1=B, bit2=Select, bit3=Start
    let btn = 0x0f;
    if (this.selectBtn) {
      btn = (this.buttons.a      ? 0 : 1) |
            (this.buttons.b      ? 0 : 2) |
            (this.buttons.select ? 0 : 4) |
            (this.buttons.start  ? 0 : 8);
    }
    const low = dir & btn;   // 양쪽 다 선택되면 AND (둘 중 하나라도 눌리면 0)
    const high = (this.selectDir ? 0 : 0x10) | (this.selectBtn ? 0 : 0x20) | 0xc0;
    return high | low;
  }

  // P1 쓰기 (하위 4비트는 읽기 전용, 셀렉트 비트만 저장)
  write8(v) {
    this.selectDir = (v & 0x10) === 0;
    this.selectBtn = (v & 0x20) === 0;
  }
}
