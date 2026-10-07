// i2c-pin-push-pull: the firmware asked for a START with an I2C pin in its
// alternate function but push-pull (OTYPER bit 0). I2C lines must be open
// drain: devices only pull them low, and the pull-ups bring them high. A
// push-pull pin drives high against a target's ACK or clock stretching. The
// simulator's bus works one transaction at a time and never shows that fight
// (docs/decisions.md §7), so this diagnostic is the only sign of it.
import { gpioOf, i2cLines, startRequested } from "./i2c-pins.ts";
import type { Rule } from "./rule.ts";

export const i2cPinPushPull: Rule = {
  id: "i2c-pin-push-pull",
  check(e, board) {
    if (!startRequested(e, board)) return [];
    return i2cLines(board, e.periph).flatMap(({ name, pins }) =>
      pins.flatMap(({ pin, af, routed }) => {
        const [port, n] = gpioOf(pin);
        if (!routed || (board.regs[port].OTYPER >>> n) & 1) return [];
        return [
          {
            severity: "warning" as const,
            message:
              `${pin} is ${e.periph}_${name} (AF${af}) but push-pull (${port}->OTYPER.OT${n} = 0): ` +
              `I2C lines must be open drain (OT${n} = 1), so devices only ever pull them low. ` +
              "Push-pull drives the line high while a target pulls it low (an ACK, or clock " +
              "stretching). The simulator doesn't show that fight; on a real board it can lose " +
              "the ACK or damage a pin",
            pin,
          },
        ];
      }),
    );
  },
};
