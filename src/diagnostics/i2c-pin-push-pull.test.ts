import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { RegEvent } from "../engine/events.ts";
import { i2cPinPushPull } from "./i2c-pin-push-pull.ts";

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

/** I2C1 enabled, PB6/PB7 routed to it (AF6), with GPIOB->OTYPER = `otyper`. */
const board = (otyper: number) => ({
  chip: stm32g031k8,
  regs: {
    I2C1: { CR1: 1 },
    GPIOA: { MODER: 0xebffffff, AFRL: 0, AFRH: 0, OTYPER: 0 },
    GPIOB: { MODER: 0xffffafff, AFRL: 0x66000000, AFRH: 0, OTYPER: otyper },
  },
  level: () => "high" as const,
  where: () => "",
  sameNet: () => false,
  parts: [],
});

test("an I2C pin in AF6 but push-pull: one diagnostic for that pin", () => {
  // PB6 (SCL) open drain, PB7 (SDA) push-pull. PA9, not routed, doesn't count.
  assert.deepEqual(i2cPinPushPull.check(start, board(1 << 6)), [
    {
      severity: "warning",
      message:
        "PB7 is I2C1_SDA (AF6) but push-pull (GPIOB_OTYPER (0x50000404) bit 7 OT7 = 0): I2C lines must be " +
        "open drain (OT7 = 1), so devices only ever pull them low. Push-pull drives the " +
        "line high while a target pulls it low (an ACK, or clock stretching). The " +
        "simulator doesn't show that fight; on a real board it can lose the ACK or " +
        "damage a pin",
      pin: "PB7",
    },
  ]);
  assert.deepEqual(
    i2cPinPushPull.check(start, board(0)).map((f) => f.pin),
    ["PB6", "PB7"],
  );
});

test("nothing when both pins are open drain", () => {
  assert.deepEqual(i2cPinPushPull.check(start, board(0b11 << 6)), []);
});
