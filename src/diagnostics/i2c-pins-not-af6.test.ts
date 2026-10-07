import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { RegEvent } from "../engine/events.ts";
import { i2cPinsNotAf6 } from "./i2c-pins-not-af6.ts";

const CR2_START = 1 << 13;
const start: RegEvent = {
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0x40005404,
  periph: "I2C1",
  reg: "CR2",
  op: "write",
  old: 0,
  value: (0x48 << 1) | CR2_START,
  flags: [],
};

/** I2C1 enabled; GPIOB as given (GPIOA at reset); `wires` join endpoints pairwise. */
function board(
  gpiob: Record<string, number>,
  wires: [string, string][] = [],
  cr1 = 1,
) {
  return {
    chip: stm32g031k8,
    regs: {
      I2C1: { CR1: cr1 },
      GPIOA: { MODER: 0xebffffff, AFRL: 0, AFRH: 0 },
      GPIOB: { MODER: 0xffffffff, AFRL: 0, AFRH: 0, ...gpiob },
    },
    level: () => "high" as const,
    where: () => "",
    sameNet: (a: string, b: string) =>
      a === b || wires.some((w) => w.includes(a) && w.includes(b)),
    parts: [
      {
        id: "temp",
        type: "tc74",
        pins: ["NC", "SDA", "GND", "SCLK", "VDD"],
        props: { variant: "A0", temperature: 25 },
        i2c: { sda: "SDA", scl: "SCLK", address: () => 0x48 },
      },
    ],
  };
}

const TC74_ON_PB6_PB7: [string, string][] = [
  ["mcu.PB6", "temp.SCLK"],
  ["mcu.PB7", "temp.SDA"],
];

test("neither line routed: names what the pins wired to the TC74 are instead", () => {
  // PB6 an output (MODE6 = 01), PB7 in AF mode (MODE7 = 10) but AF1.
  const b = board({ MODER: 0xffff9fff, AFRL: 0x10000000 }, TC74_ON_PB6_PB7);
  assert.deepEqual(i2cPinsNotAf6.check(start, b), [
    {
      severity: "warning",
      message:
        "I2C1->CR2.START was set, but I2C1_SCL and I2C1_SDA aren't on any pin, so nothing " +
        "reaches the bus. A pin carries an I2C signal only in alternate-function mode " +
        "(MODER = 2) with the right AF number (RM0444 §7.3.2): " +
        "PB6 needs AF6 but is an output (GPIOB->MODER.MODE6 = 1); " +
        "PB7 needs AF6 but is AF1 (GPIOB->AFRL.AFSEL7 = 1)",
      periph: "I2C1",
      reg: "CR2",
    },
  ]);
});

test("SDA missing and nothing wired: every pin that could carry SDA", () => {
  // PB6 is SCL (AF6); PB9 is in AF mode with AF0.
  const b = board({ MODER: 0xfffbefff, AFRL: 0x06000000, AFRH: 0 });
  const [d] = i2cPinsNotAf6.check(start, b);
  assert.match(d.message, /^I2C1->CR2\.START was set, but I2C1_SDA isn't on/);
  assert.ok(
    d.message.endsWith(
      ": PA10 needs AF6 but is analog (GPIOA->MODER.MODE10 = 3); " +
        "PB7 needs AF6 but is analog (GPIOB->MODER.MODE7 = 3); " +
        "PB9 needs AF6 but is AF0 (GPIOB->AFRH.AFSEL9 = 0)",
    ),
    d.message,
  );
});

test("nothing when both lines are routed, or PE = 0", () => {
  const routed = { MODER: 0xffffafff, AFRL: 0x66000000 };
  assert.deepEqual(i2cPinsNotAf6.check(start, board(routed)), []);
  assert.deepEqual(i2cPinsNotAf6.check(start, board({}, [], 0)), []);
});
