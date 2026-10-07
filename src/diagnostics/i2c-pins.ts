// What the I2C rules share: when firmware asks for a START, and which pins can
// carry an I2C's SCL and SDA (the chip's AF table) and which do now.
import type { BoardView } from "../engine/engine.ts";
import type { RegEvent, SimEvent } from "../engine/events.ts";
import { alternateFunction } from "../peripherals/gpio.ts";

/** I2C_CR1.PE (RM0444 §32.9.1). */
export const PE = 1 << 0;
/** I2C_CR2.START (RM0444 §32.9.2). */
const START = 1 << 13;

/** "PB6" → its port's register block and bit: ["GPIOB", 6]. */
export function gpioOf(pin: string): [port: string, n: number] {
  return [`GPIO${pin[1]}`, Number(pin.slice(2))];
}

/**
 * A write to an I2C's CR2 that sets START while PE = 1, with the clock on: the
 * moment its pins and the bus matter. (With PE = 0 START can't be set.)
 */
export function startRequested(
  e: SimEvent,
  { regs }: BoardView,
): e is RegEvent {
  return (
    e.kind === "reg" &&
    e.op === "write" &&
    e.periph.startsWith("I2C") &&
    e.reg === "CR2" &&
    e.flags.length === 0 &&
    (e.value & START) !== 0 &&
    (regs[e.periph].CR1 & PE) !== 0
  );
}

/** One of an I2C's lines, e.g. I2C1's SCL. */
export interface I2cLine {
  readonly name: "SCL" | "SDA";
  /** The signal's endpoint, e.g. "mcu.I2C1_SCL". */
  readonly endpoint: string;
  /** The pins that can carry it, the AF number each needs, and whether it does now. */
  readonly pins: readonly { pin: string; af: number; routed: boolean }[];
}

/** `periph`'s SCL and SDA. */
export function i2cLines({ chip, regs }: BoardView, periph: string): I2cLine[] {
  return (["SCL", "SDA"] as const).map((name) => {
    const signal = `${periph}_${name}`;
    const pins = Object.entries(chip.af).flatMap(([pin, afs]) =>
      Object.entries(afs).flatMap(([af, s]) => {
        if (s !== signal) return [];
        const [port, n] = gpioOf(pin);
        const routed = alternateFunction(regs[port], n) === Number(af);
        return [{ pin, af: Number(af), routed }];
      }),
    );
    return { name, endpoint: `mcu.${signal}`, pins };
  });
}
