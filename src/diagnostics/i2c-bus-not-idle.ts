// i2c-bus-not-idle: the firmware asked for a START while SCL or SDA isn't
// high. The I2C sends START only "once the bus is free" (RM0444 §32.9.2), and
// here free means both lines high (docs/decisions.md §12), so START never goes
// out. Names the likely cause from the line levels. Pins not routed at all are
// i2c-pins-not-af6's.
import type { Level } from "../engine/nets.ts";
import { i2cLines, startRequested } from "./i2c-pins.ts";
import type { Rule } from "./rule.ts";

const CAUSE: Readonly<Record<Exclude<Level, "high">, string>> = {
  floating:
    "Floating means nothing pulls the line high: I2C lines are open drain, " +
    "so each needs a pull-up resistor to 3V3 (e.g. 4.7 kΩ)",
  low: "Low means something holds the line down: a part pulling it low, or a wire to GND",
  conflict: "Conflict means two outputs drive the line opposite ways",
};

export const i2cBusNotIdle: Rule = {
  id: "i2c-bus-not-idle",
  check(e, board) {
    if (!startRequested(e, board)) return [];
    const lines = i2cLines(board, e.periph);
    if (lines.some((l) => !l.pins.some((p) => p.routed))) return [];
    const bad = lines.flatMap((l) => {
      const level = board.level(l.endpoint);
      return level === "high" ? [] : [{ ...l, level }];
    });
    if (!bad.length) return [];
    const states = bad.map(
      (l) =>
        `${l.name} (${l.pins.flatMap((p) => (p.routed ? [p.pin] : [])).join(", ")}) is ${l.level}`,
    );
    const causes = [...new Set(bad.map((l) => CAUSE[l.level]))];
    return [
      {
        severity: "warning",
        message:
          `${e.periph}->CR2.START was set while the bus isn't free, so START never goes out ` +
          `and ISR.BUSY stays 1 (RM0444 §32.9.2: START is sent "once the bus is free"): ` +
          `${states.join(" and ")}. ${causes.join(". ")}`,
        periph: e.periph,
        reg: "CR2",
      },
    ];
  },
};
