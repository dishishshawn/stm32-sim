// TEMPLATE: the test for templates/peripheral.ts. Copy it next to your
// peripheral as src/peripherals/<name>.test.ts (see
// docs/adding-a-peripheral.md) and fix the import paths marked below.
// `just test` runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../src/chips/stm32g031k8.ts"; // TEMPLATE: in src/peripherals/ this is "../chips/stm32g031k8.ts"
import { EventLog } from "../src/engine/events.ts"; // TEMPLATE: in src/peripherals/ this is "../engine/events.ts"
import type { SimEvent } from "../src/engine/events.ts"; // TEMPLATE: in src/peripherals/ this is "../engine/events.ts"
import { MemoryBus } from "../src/engine/memory-bus.ts"; // TEMPLATE: in src/peripherals/ this is "../engine/memory-bus.ts"
import { Nets } from "../src/engine/nets.ts"; // TEMPLATE: in src/peripherals/ this is "../engine/nets.ts"
import { tim14 } from "./peripheral.ts"; // TEMPLATE: in src/peripherals/ this is "./<name>.ts"

// TEMPLATE: your addresses (base address + offset, both in the register JSON)
// and bits.
const RCC_APBENR2 = 0x40021040;
const TIM14EN = 1 << 15;
const TIM14 = 0x40002000;
const [CR1, DIER, SR, EGR, CNT, PSC, ARR] = [
  0x00, 0x0c, 0x10, 0x14, 0x24, 0x28, 0x2c,
];
const [CEN, OPM] = [1 << 0, 1 << 3];
const UIE = 1 << 0;
const UIF = 1 << 0;
const UG = 1 << 0;

/**
 * The G031K8's memory bus, with TIM14's clock on unless `clock` is false.
 * The chip's peripheral list gets this peripheral whether or not it is
 * registered there yet. Time passes only through `bus.tick(cycles)`, which is
 * what the engine calls after each instruction.
 */
function setup(clock = true) {
  const chip = {
    ...stm32g031k8,
    peripherals: [
      ...stm32g031k8.peripherals.filter((p) => p.name !== tim14.name),
      tim14,
    ],
  };
  const pended: number[] = [];
  const events: SimEvent[] = [];
  const log = new EventLog();
  log.subscribe((e) => events.push(e));
  const bus = new MemoryBus(chip, {
    events: log,
    now: () => ({ cycle: 0, pc: 0 }),
    nets: new Nets(),
    cpu: {
      setPending: (exception) => pended.push(exception),
      clearPending() {},
      isPending: () => false,
      setPriority() {},
    },
  });
  if (clock) bus.writeUint32(RCC_APBENR2, TIM14EN);
  /** A word write or read of a TIM14 register, as the CPU makes it. */
  const w = (offset: number, value: number) =>
    bus.writeUint32(TIM14 + offset, value);
  const r = (offset: number) => bus.readUint32(TIM14 + offset);
  return { bus, w, r, pended, events };
}

/** Started the way firmware starts it: PSC, ARR, UG to load PSC, clear UIF, then CEN. */
function running(psc: number, arr: number) {
  const t = setup();
  t.w(PSC, psc);
  t.w(ARR, arr);
  t.w(EGR, UG);
  t.w(SR, 0);
  t.w(CR1, CEN);
  return t;
}

test("counts 16 MHz / (PSC + 1) from 0 to ARR, then wraps to 0 and sets UIF", () => {
  const { bus, r } = running(15, 999); // 1 MHz, so a 1 ms period
  bus.tick(16 * 500); // one big slice, as in a sleep
  assert.equal(r(CNT), 500);
  assert.equal(r(SR) & UIF, 0);
  bus.tick(16 * 499 + 15);
  assert.equal(r(CNT), 999, "one cycle short of the next count");
  bus.tick(1);
  assert.equal(r(CNT), 0);
  assert.equal(r(SR) & UIF, UIF);
});

test("a PSC write takes effect only at the next update event", () => {
  const { bus, w, r } = setup();
  w(ARR, 99);
  w(PSC, 15); // no UG, so the active prescaler is still 0
  w(CR1, CEN);
  bus.tick(50);
  assert.equal(r(CNT), 50, "still one count per cycle");
  bus.tick(50); // the overflow is an update event: it loads PSC
  assert.equal(r(CNT), 0);
  bus.tick(16 * 10);
  assert.equal(r(CNT), 10, "now one count per 16 cycles");
});

test("ARR = 0 holds the counter at 0", () => {
  const { bus, r } = running(0, 0);
  bus.tick(100);
  assert.equal(r(CNT), 0);
  assert.equal(r(SR) & UIF, 0);
});

test("SR.UIF is cleared by writing 0 to it; writing 1 leaves it as it is", () => {
  const { w, r } = setup();
  w(SR, UIF);
  assert.equal(r(SR), 0, "writing 1 doesn't set it");
  w(EGR, UG); // an update event sets it
  assert.equal(r(SR), UIF);
  w(SR, UIF);
  assert.equal(r(SR), UIF, "writing 1 doesn't clear it");
  w(SR, ~UIF);
  assert.equal(r(SR), 0);
  assert.equal(r(EGR), 0, "EGR is write-only");
});

test("with DIER.UIE, each update event pends the TIM14 interrupt (16 + 19)", () => {
  const { bus, w, pended } = running(0, 9);
  bus.tick(10);
  assert.deepEqual(pended, [], "UIE = 0: UIF only");
  w(DIER, UIE);
  bus.tick(20);
  assert.deepEqual(pended, [35, 35]);
});

test("with RCC_APBENR2.TIM14EN = 0, writes are ignored and the counter stops", () => {
  const off = setup(false);
  off.w(ARR, 9);
  off.w(CR1, CEN);
  // bus.regs is the stored values: reading it has no side effects.
  assert.deepEqual(
    [off.bus.regs.TIM14.ARR, off.bus.regs.TIM14.CR1],
    [0xffff, 0],
  );

  const { bus, r } = running(0, 999);
  bus.tick(100);
  bus.writeUint32(RCC_APBENR2, 0); // the clock gated off while it runs
  bus.tick(100);
  bus.writeUint32(RCC_APBENR2, TIM14EN);
  assert.equal(r(CNT), 100);
});

test("one-pulse mode is logged as not simulated", () => {
  const { w, events } = setup();
  w(CR1, CEN | OPM);
  assert.deepEqual(
    events.filter((e) => e.kind === "unsimulated"),
    [{ kind: "unsimulated", cycle: 0, periph: "TIM14", feature: "CR1.OPM" }],
  );
});
