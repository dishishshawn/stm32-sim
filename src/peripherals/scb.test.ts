import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { CortexM0Core } from "../cpu/cortex-m0-core.ts";
import { coreCpu } from "../engine/core-cpu.ts";
import { EventLog } from "../engine/events.ts";
import type { RegEvent } from "../engine/events.ts";
import { MemoryBus } from "../engine/memory-bus.ts";
import { Nets } from "../engine/nets.ts";

const ICSR = 0xe000ed04;
const VTOR = 0xe000ed08;
const SHPR3 = 0xe000ed20;
const PENDSTSET = 1 << 26;
const PENDSTCLR = 1 << 25;

/** The G031K8's bus wired to a real core, as the engine wires them, and every register event. */
function setup() {
  const events = new EventLog();
  const seen: RegEvent[] = [];
  events.subscribe((e) => {
    if (e.kind === "reg") seen.push(e);
  });
  let core: CortexM0Core | undefined;
  const bus = new MemoryBus(stm32g031k8, {
    events,
    now: () => ({ cycle: 0, pc: 0 }),
    nets: new Nets(),
    cpu: coreCpu(() => core!),
  });
  core = new CortexM0Core(bus, stm32g031k8.irqCount);
  return { bus, core, seen };
}

test("ICSR: PENDSTSET pends SysTick in the core and reads back; PENDSTCLR un-pends it", () => {
  const { bus, core } = setup();
  assert.equal(bus.readUint32(ICSR), 0);
  bus.writeUint32(ICSR, PENDSTSET);
  assert.equal(core.pendingSystick, true);
  assert.equal(core.interruptsUpdated, true);
  assert.equal(bus.readUint32(ICSR), PENDSTSET);
  bus.writeUint32(ICSR, PENDSTCLR);
  assert.equal(core.pendingSystick, false);
  assert.equal(bus.readUint32(ICSR), 0);
});

test("SHPR3 sets SysTick's and PendSV's priority in the core, keeping only the implemented bits", () => {
  const { bus, core } = setup();
  bus.writeUint32(SHPR3, 0xffffffff);
  assert.equal(bus.readUint32(SHPR3), 0xc0c00000);
  assert.equal(core.systickPriority, 3);
  assert.equal(core.pendSVPriority, 3);
  bus.writeUint8(SHPR3 + 3, 0x40); // SysTick's byte only, as CMSIS NVIC_SetPriority might
  assert.equal(core.systickPriority, 1);
  assert.equal(core.pendSVPriority, 3);
});

test("the rest of the SCB is still unsimulated: reads 0, logged as SCS", () => {
  const { bus, seen } = setup();
  bus.writeUint32(VTOR, 0x08000000);
  assert.equal(bus.readUint32(VTOR), 0);
  assert.deepEqual(
    seen.map((e) => [e.periph, e.flags]),
    [
      ["SCS", ["unsimulated"]],
      ["SCS", ["unsimulated"]],
    ],
  );
});
