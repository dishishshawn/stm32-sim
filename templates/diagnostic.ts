// TEMPLATE: a diagnostic rule. Copy it to src/diagnostics/<rule-id>.ts and
// follow docs/adding-a-diagnostic.md. Each "TEMPLATE:" comment says what to
// change; delete those comments when you are done. The worked examples are
// src/diagnostics/timingr-while-pe.ts and gpio-clock-off.ts.
//
// i2c-txdr-not-empty: a write to an I2C's TXDR while ISR.TXE = 0. RM0444
// §32.9.11: TXDATA "can be written only when TXE = 1", and I2C1 ignores such
// a write (src/peripherals/i2c.ts), so that byte never goes out. The usual
// cause is writing the next byte without waiting for TXIS.
import type { Rule } from "../src/diagnostics/rule.ts"; // TEMPLATE: in src/diagnostics/ this is "./rule.ts"

/** I2C_ISR.TXE (RM0444 §32.9.7). TEMPLATE: the bits your rule reads. */
const TXE = 1 << 0;

// TEMPLATE: rename the export and the id after your rule. The id is
// kebab-case, the file's name, and what `sim` prints in [brackets].
export const i2cTxdrNotEmpty: Rule = {
  id: "i2c-txdr-not-empty",
  check(e, { regs }) {
    // check() runs on every event, so return [] fast for the ones that aren't
    // yours. TEMPLATE: the event your rule is about.
    if (
      e.kind !== "reg" ||
      e.op !== "write" ||
      !e.periph.startsWith("I2C") ||
      e.reg !== "TXDR" ||
      e.flags.length > 0 // clock off or not simulated: another rule says so
    ) {
      return [];
    }
    // A write's event comes before the write takes effect, so `regs` is the
    // state the firmware wrote into. TXE is set while PE = 0 (§32.9.7), so
    // this is also a write with the I2C enabled.
    if (regs[e.periph].ISR & TXE) return [];
    const p = e.periph;
    return [
      {
        severity: "warning",
        // The exact register and bit (CMSIS names), what happened, RM0444's
        // section, then the fix. Nothing that changes between repeats (the
        // byte, the cycle): an identical message is counted, not repeated.
        message:
          `wrote ${p}->TXDR while ${p}->ISR.TXE (bit 0) = 0, so the write was ignored ` +
          "and that byte never goes out: TXDR can be written only when TXE = 1 " +
          `(RM0444 §32.9.11). Wait for ${p}->ISR.TXIS = 1 before writing each byte`,
        periph: p,
        reg: "TXDR",
      },
    ];
  },
};
