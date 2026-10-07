import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { RegEvent } from "../engine/events.ts";
import type { Level } from "../engine/nets.ts";
import { i2cBusNotIdle } from "./i2c-bus-not-idle.ts";

const start: RegEvent = {
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0x40005404,
  periph: "I2C1",
  reg: "CR2",
  op: "write",
  old: 0,
  value: 1 << 13,
  flags: [],
};

/** I2C1 enabled; PB6/PB7 routed to it (AF6) unless `moder` says otherwise; levels by endpoint, else high. */
function board(levels: Record<string, Level>, moder = 0xffffafff) {
  return {
    chip: stm32g031k8,
    regs: {
      I2C1: { CR1: 1 },
      GPIOA: { MODER: 0xebffffff, AFRL: 0, AFRH: 0 },
      GPIOB: { MODER: moder, AFRL: 0x66000000, AFRH: 0 },
    },
    level: (e: string) => levels[e] ?? "high",
    where: () => "",
    sameNet: () => false,
    parts: [],
  };
}

const PREFIX =
  "I2C1_CR2 (0x40005404) bit 13 START was set while the bus isn't free, so START never goes out and " +
  'I2C1_ISR (0x40005418) bit 15 BUSY stays 1 (RM0444 §32.9.2: START is sent "once the bus is free"): ';

test("both lines floating: no pull-ups", () => {
  const b = board({ "mcu.I2C1_SCL": "floating", "mcu.I2C1_SDA": "floating" });
  assert.deepEqual(i2cBusNotIdle.check(start, b), [
    {
      severity: "warning",
      message:
        PREFIX +
        "SCL (PB6) is floating and SDA (PB7) is floating. Floating means nothing pulls " +
        "the line high: I2C lines are open drain, so each needs a pull-up resistor to " +
        "3V3 (e.g. 4.7 kΩ)",
      periph: "I2C1",
      reg: "CR2",
    },
  ]);
});

test("SDA held low", () => {
  const [d] = i2cBusNotIdle.check(start, board({ "mcu.I2C1_SDA": "low" }));
  assert.equal(
    d.message,
    PREFIX +
      "SDA (PB7) is low. Low means something holds the line down: a part pulling it " +
      "low, or a wire to GND",
  );
});

test("nothing when both lines are high, or when a line isn't routed (i2c-pins-not-af6's)", () => {
  assert.deepEqual(i2cBusNotIdle.check(start, board({})), []);
  const floating = { "mcu.I2C1_SCL": "floating" as const };
  assert.deepEqual(i2cBusNotIdle.check(start, board(floating, 0xffffffff)), []);
});
