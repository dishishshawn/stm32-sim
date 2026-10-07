// gpio-clock-off: an access to a peripheral while its clock enable bit is 0.
// The bus has already ignored the write (or returned 0 for the read) and
// flagged it "clock-off"; this names the bit, from the peripheral's declared
// clock gate. Any clock-gated peripheral, not only GPIO.
import type { Rule } from "./rule.ts";

export const gpioClockOff: Rule = {
  id: "gpio-clock-off",
  check(e, { chip }) {
    if (e.kind !== "reg" || !e.flags.includes("clock-off")) return [];
    const gate = chip.peripherals.find((p) => p.name === e.periph)?.gate;
    if (!gate) return [];
    const [periph, reg] = gate.register.split(".");
    // The bus checked the gate's field exists when it loaded the chip.
    const { bitOffset } =
      chip.registers.peripherals[periph].registers[reg].fields[gate.field];
    const [did, so] =
      e.op === "write"
        ? ["wrote", "the write was ignored"]
        : ["read", "the read returned 0"];
    return [
      {
        severity: "warning",
        message:
          `${did} ${e.periph}->${e.reg} while ${periph}->${reg}.${gate.field} ` +
          `(bit ${bitOffset}) = 0 — ${e.periph}'s clock is off, so ${so}`,
        periph: e.periph,
        reg: e.reg,
      },
    ];
  },
};
