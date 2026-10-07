import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { Flag, RegEvent } from "../engine/events.ts";
import { timingrWhilePe } from "./timingr-while-pe.ts";

/** A board whose I2C1->CR1 is `cr1`. */
const board = (cr1: number) => ({
  chip: stm32g031k8,
  regs: { I2C1: { CR1: cr1 } },
  level: () => "floating" as const,
  where: () => "",
  sameNet: () => false,
  parts: [],
});

const write = (reg: string, flags: Flag[] = []): RegEvent => ({
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0x40005410,
  periph: "I2C1",
  reg,
  op: "write",
  old: 0,
  value: 0x30420f13,
  flags,
});

test("a TIMINGR write with PE = 1 was ignored: says so, and when to write it", () => {
  assert.deepEqual(timingrWhilePe.check(write("TIMINGR"), board(1)), [
    {
      severity: "warning",
      message:
        "wrote I2C1_TIMINGR (0x40005410) while I2C1_CR1 (0x40005400) bit 0 PE = 1, " +
        "so the write was ignored: " +
        "TIMINGR must be configured when the I2C is disabled, PE = 0 (RM0444 §32.9.5). " +
        "Write TIMINGR before setting PE, or clear PE first",
      periph: "I2C1",
      reg: "TIMINGR",
    },
  ]);
});

test("nothing with PE = 0, for another register, or with the clock off", () => {
  assert.deepEqual(timingrWhilePe.check(write("TIMINGR"), board(0)), []);
  assert.deepEqual(timingrWhilePe.check(write("CR2"), board(1)), []);
  assert.deepEqual(
    timingrWhilePe.check(write("TIMINGR", ["clock-off"]), board(1)),
    [],
  );
});
