import { test } from "node:test";
import assert from "node:assert/strict";
import { BusFault } from "../cpu/bus.ts";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { Peripheral } from "../peripherals/peripheral.ts";
import { EventLog } from "./events.ts";
import type { RegEvent } from "./events.ts";
import { MemoryBus } from "./memory-bus.ts";
import { Nets } from "./nets.ts";

const RCC_IOPENR = 0x40021034;
const GPIOA = 0x50000000; // MODER at +0x00, reset 0xEBFFFFFF
const I2C1_OAR2 = 0x4000540c;
const I2C1_TIMINGR = 0x40005410;

/** A bus with `peripherals` registered, and every event it emits. */
function setup(...peripherals: Peripheral[]) {
  const events = new EventLog();
  const seen: RegEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const chip = { ...stm32g031k8, peripherals };
  const bus = new MemoryBus(chip, {
    events,
    now: () => ({ cycle: 42, pc: 0x08000100 }),
    nets: new Nets(),
  });
  return { bus, seen };
}

const plainGpioA: Peripheral = {
  name: "GPIOA",
  gate: { register: "RCC.IOPENR", field: "IOPAEN" },
  create: () => ({}),
};

test("with the clock gated off, a write changes nothing and is flagged", () => {
  const { bus, seen } = setup(plainGpioA);
  bus.writeUint32(GPIOA, 0x12345678);
  assert.equal(bus.regs.GPIOA.MODER, 0xebffffff);
  assert.deepEqual(seen.at(-1), {
    kind: "reg",
    cycle: 42,
    pc: 0x08000100,
    address: GPIOA,
    periph: "GPIOA",
    reg: "MODER",
    op: "write",
    old: 0xebffffff,
    value: 0x12345678,
    flags: ["clock-off"],
  });
  assert.equal(bus.readUint32(GPIOA), 0); // assumed: RM0444 doesn't say
  assert.deepEqual(seen.at(-1)?.flags, ["clock-off"]);

  // RCC isn't simulated yet, but its stored IOPENR already drives the gate.
  bus.writeUint32(RCC_IOPENR, 1);
  bus.writeUint32(GPIOA, 0x12345678);
  assert.equal(bus.readUint32(GPIOA), 0x12345678);
  assert.deepEqual(seen.at(-1)?.flags, []);
});

test("an unsimulated register stores its value and is logged by name", () => {
  const { bus, seen } = setup();
  assert.equal(bus.readUint32(I2C1_OAR2), 0);
  bus.writeUint32(I2C1_OAR2, 0x8000);
  assert.equal(bus.readUint32(I2C1_OAR2), 0x8000);
  assert.deepEqual(
    seen.map((e) => [e.periph, e.reg, e.op, e.value, e.flags]),
    [
      ["I2C1", "OAR2", "read", 0, ["unsimulated"]],
      ["I2C1", "OAR2", "write", 0x8000, ["unsimulated"]],
      ["I2C1", "OAR2", "read", 0x8000, ["unsimulated"]],
    ],
  );
});

test("an unmapped address throws BusFault", () => {
  const { bus } = setup();
  for (const address of [
    0x08010000, // past the end of flash
    0x20002000, // past the end of SRAM
    0x40001000, // a peripheral-space hole
    0x1fff7590, // system memory: not mapped yet
    0xe000f000, // past the system control space
  ]) {
    assert.throws(() => bus.readUint32(address), BusFault);
    assert.throws(() => bus.writeUint8(address, 1), BusFault);
  }
  assert.throws(() => bus.readUint32(I2C1_TIMINGR + 2), BusFault); // unaligned
});

test("byte and halfword accesses use the register's lanes", () => {
  const { bus, seen } = setup();
  bus.writeUint32(I2C1_TIMINGR, 0x44332211);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => bus.readUint8(I2C1_TIMINGR + i)),
    [0x11, 0x22, 0x33, 0x44],
  );
  assert.equal(bus.readUint16(I2C1_TIMINGR + 2), 0x4433);
  bus.writeUint8(I2C1_TIMINGR + 2, 0xaa);
  assert.equal(bus.regs.I2C1.TIMINGR, 0x44aa2211);
  bus.writeUint16(I2C1_TIMINGR + 2, 0xbbcc);
  assert.equal(bus.regs.I2C1.TIMINGR, 0xbbcc2211);
  assert.deepEqual(seen.at(-1), {
    ...seen.at(-1),
    old: 0x44aa2211,
    value: 0xbbcc2211,
  });
});

test("a write hook gets the merged value and the written bits", () => {
  const writes: [number, number][] = [];
  const gpio: Peripheral = {
    name: "GPIOA",
    create: ({ regs }) => ({
      read: { IDR: () => 0xbeef },
      write: { BSRR: (value, mask) => writes.push([value, mask]) },
      reset: () => (regs.ODR = 0x1),
    }),
  };
  const { bus } = setup(gpio);
  bus.writeUint16(GPIOA + 0x1a, 0x0004); // BSRR upper half: BR2
  assert.deepEqual(writes, [[0x00040000, 0xffff0000]]);
  assert.equal(bus.regs.GPIOA.BSRR, 0); // the hook didn't store it
  assert.equal(bus.readUint8(GPIOA + 0x11), 0xbe); // IDR, lane 1
  assert.equal(bus.regs.GPIOA.ODR, 1); // reset() ran

  bus.regs.GPIOA.ODR = 0xff;
  bus.regs.GPIOA.MODER = 0;
  bus.reset();
  assert.deepEqual([bus.regs.GPIOA.ODR, bus.regs.GPIOA.MODER], [1, 0xebffffff]);
});

test("system control space: logged, reads 0, writes ignored", () => {
  const { bus, seen } = setup();
  assert.equal(bus.readUint32(0xe000ed00), 0); // SCB CPUID
  bus.writeUint32(0xe000e010, 5); // SysTick CSR
  assert.equal(bus.readUint32(0xe000e010), 0);
  assert.deepEqual(
    seen.map((e) => [e.periph, e.address, e.op, e.flags]),
    [
      ["SCS", 0xe000ed00, "read", ["unsimulated"]],
      ["SCS", 0xe000e010, "write", ["unsimulated"]],
      ["SCS", 0xe000e010, "read", ["unsimulated"]],
    ],
  );
});

test("a reserved offset in a peripheral block reads 0 and ignores writes", () => {
  const { bus, seen } = setup();
  bus.writeUint32(GPIOA + 0x30, 7);
  assert.equal(bus.readUint32(GPIOA + 0x30), 0);
  assert.deepEqual(
    seen.map((e) => [e.periph, e.reg, e.flags]),
    [
      ["GPIOA", "", ["reserved"]],
      ["GPIOA", "", ["reserved"]],
    ],
  );
});

test("flash is read-only and aliased at 0; flash and SRAM raise no events", () => {
  const { bus, seen } = setup();
  bus.flash.set([0x00, 0x20, 0x00, 0x20]); // initial SP
  assert.equal(bus.readUint32(0), 0x20002000);
  assert.equal(bus.readUint32(0x08000000), 0x20002000);
  bus.writeUint32(0x20001ffc, 0xdeadbeef);
  assert.equal(bus.readUint16(0x20001ffe), 0xdead);
  assert.equal(seen.length, 0);

  bus.writeUint32(0x08000000, 0);
  assert.equal(bus.readUint32(0x08000000), 0x20002000);
  assert.deepEqual(
    seen.map((e) => [e.periph, e.op, e.old, e.value, e.flags]),
    [["flash", "write", 0x20002000, 0, ["read-only"]]],
  );
});

test("every SVD register is mapped at its address", () => {
  const { bus, seen } = setup();
  for (const [periph, p] of Object.entries(stm32g031k8.registers.peripherals)) {
    for (const r of Object.values(p.registers)) {
      bus.readUint32(parseInt(p.baseAddress, 16) + parseInt(r.offset, 16));
      assert.equal(seen.at(-1)?.periph, periph);
    }
  }
});

test("registration mistakes throw", () => {
  const bad = (p: Partial<Peripheral>) => () =>
    setup({ name: "GPIOA", create: () => ({}), ...p });
  assert.throws(bad({ name: "GPIOZ" }), /GPIOZ is not in the register map/);
  assert.throws(
    bad({ create: () => ({ read: { ODRR: () => 0 } }) }),
    /GPIOA has no register ODRR/,
  );
  assert.throws(
    bad({ gate: { register: "RCC.IOPENR", field: "GPIOAEN" } }),
    /clock gate RCC.IOPENR.GPIOAEN/,
  );
});

test("an unsubscribed listener hears nothing more", () => {
  const events = new EventLog();
  const seen: unknown[] = [];
  const off = events.subscribe((e) => seen.push(e));
  const bus = new MemoryBus(stm32g031k8, {
    events,
    now: () => ({ cycle: 0, pc: 0 }),
    nets: new Nets(),
  });
  bus.readUint32(I2C1_OAR2);
  off();
  assert.equal(events.active, false);
  bus.readUint32(I2C1_OAR2);
  assert.equal(seen.length, 1);
});
