// timingr-while-pe: a write to an I2C's TIMINGR while CR1.PE = 1. RM0444
// §32.9.5 says TIMINGR must be configured with PE = 0; the simulator ignores
// such a write, silently (docs/decisions.md §12), so the timing never changes.
import { PE } from "./i2c-pins.ts";
import type { Rule } from "./rule.ts";

export const timingrWhilePe: Rule = {
  id: "timingr-while-pe",
  check(e, { regs }) {
    if (
      e.kind !== "reg" ||
      e.op !== "write" ||
      !e.periph.startsWith("I2C") ||
      e.reg !== "TIMINGR" ||
      e.flags.length > 0 || // clock off or unsimulated: another rule's
      !(regs[e.periph].CR1 & PE)
    ) {
      return [];
    }
    const p = e.periph;
    return [
      {
        severity: "warning",
        message:
          `wrote ${p}->TIMINGR while ${p}->CR1.PE = 1, so the write was ignored: ` +
          "TIMINGR must be configured when the I2C is disabled, PE = 0 (RM0444 §32.9.5). " +
          "Write TIMINGR before setting PE, or clear PE first",
        periph: p,
        reg: "TIMINGR",
      },
    ];
  },
};
