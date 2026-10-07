// i2c-pins-not-af6: the firmware asked for a START, but SCL or SDA isn't
// routed to any pin. GPIO joins a pin to an I2C signal only while the pin is in
// alternate-function mode with the AF number the chip's AF table gives (AF6
// for I2C1 on the G031), so the I2C talks to floating lines and nothing reaches
// the bus. Names what the pins are instead.
import type { BoardView } from "../engine/engine.ts";
import { alternateFunction } from "../peripherals/gpio.ts";
import { gpioOf, i2cLines, startRequested } from "./i2c-pins.ts";
import { fieldName } from "./names.ts";
import type { Rule } from "./rule.ts";

const MODES = ["an input", "an output", "", "analog"];

/** E.g. "PB6 needs AF6 but is analog (GPIOB_MODER (0x50000400) bits 13:12 MODE6 = 3)". */
function describe({ chip, regs }: BoardView, pin: string, af: number): string {
  const [port, n] = gpioOf(pin);
  const mode = (regs[port].MODER >>> (2 * n)) & 3;
  const got = alternateFunction(regs[port], n);
  const afr = n < 8 ? "AFRL" : "AFRH";
  const is =
    got === undefined
      ? `${MODES[mode]} (${fieldName(chip, port, "MODER", `MODE${n}`)} = ${mode})`
      : `AF${got} (${fieldName(chip, port, afr, `AFSEL${n}`)} = ${got})`;
  return `${pin} needs AF${af} but is ${is}`;
}

/** Whether `pin` is wired to an I2C part's SDA or SCL. */
function wiredToI2c({ parts, sameNet }: BoardView, pin: string): boolean {
  return parts.some(
    ({ id, i2c }) =>
      i2c !== undefined &&
      (sameNet(`mcu.${pin}`, `${id}.${i2c.sda}`) ||
        sameNet(`mcu.${pin}`, `${id}.${i2c.scl}`)),
  );
}

export const i2cPinsNotAf6: Rule = {
  id: "i2c-pins-not-af6",
  check(e, board) {
    if (!startRequested(e, board)) return [];
    const missing = i2cLines(board, e.periph).filter(
      (l) => !l.pins.some((p) => p.routed),
    );
    if (!missing.length) return [];
    const signals = missing.map((l) => `${e.periph}_${l.name}`);
    const pins = missing.flatMap((l) => l.pins);
    // The pins wired to an I2C part are the ones the learner meant; else all.
    const wired = pins.filter((p) => wiredToI2c(board, p.pin));
    const shown = (wired.length ? wired : pins).map((p) =>
      describe(board, p.pin, p.af),
    );
    return [
      {
        severity: "warning",
        message:
          `${fieldName(board.chip, e.periph, "CR2", "START")} was set, but ${signals.join(" and ")} ` +
          `${signals.length > 1 ? "aren't" : "isn't"} on any pin, so nothing reaches the bus. ` +
          "A pin carries an I2C signal only in alternate-function mode (MODER = 2) " +
          `with the right AF number (RM0444 §7.3.2): ${shown.join("; ")}`,
        periph: e.periph,
        reg: "CR2",
      },
    ];
  },
};
