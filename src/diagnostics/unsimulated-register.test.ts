import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { EventLog } from "../engine/events.ts";
import type { Flag, RegEvent } from "../engine/events.ts";
import { diagnose } from "./rule.ts";
import { unsimulatedRegister } from "./unsimulated-register.ts";

const board = {
  chip: stm32g031k8,
  regs: {},
  level: () => "floating" as const,
  where: (pc: number) => `main.c:${pc}`,
  sameNet: () => false,
  parts: [],
};

/** An access at `cycle`, with the PC equal to the cycle. */
function access(
  periph: string,
  reg: string,
  address: number,
  op: "read" | "write",
  cycle: number,
  flags: Flag[] = ["unsimulated"],
): RegEvent {
  const e = { periph, reg, address, op, cycle, pc: cycle, flags };
  return { kind: "reg", old: 0, value: 0, ...e };
}

test("an unsimulated register: one diagnostic, counting every access", () => {
  const log = new EventLog();
  const found = diagnose(log, board, [unsimulatedRegister]);
  log.emit(access("I2C1", "OAR2", 0x4000540c, "read", 10));
  log.emit(access("I2C1", "OAR2", 0x4000540c, "write", 20));
  log.emit(access("I2C1", "OAR2", 0x4000540c, "read", 30));
  log.emit(access("GPIOA", "ODR", 0x50000014, "write", 40, [])); // simulated
  assert.deepEqual(found(), [
    {
      rule: "unsimulated-register",
      severity: "info",
      message:
        "I2C1->OAR2: this register isn't simulated yet; it reads back what was written",
      periph: "I2C1",
      reg: "OAR2",
      count: 3,
      cycle: 10,
      pc: 10,
      at: "main.c:10",
    },
  ]);
});

test("the system control space has no register names: the address, and it reads 0", () => {
  const log = new EventLog();
  const found = diagnose(log, board, [unsimulatedRegister]);
  log.emit(access("SCS", "", 0xe000e100, "write", 5));
  const [d] = found();
  assert.equal(
    d.message,
    "SCS 0xe000e100: this register isn't simulated yet; it reads 0 and ignores writes",
  );
  assert.equal(d.reg, "0xe000e100");
});
