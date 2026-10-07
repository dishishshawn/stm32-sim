import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { EventLog } from "../engine/events.ts";
import { MemoryBus } from "../engine/memory-bus.ts";
import { Nets } from "../engine/nets.ts";
import { alternateFunction } from "./gpio.ts";

const RCC_IOPENR = 0x40021034;
const GPIOA = 0x50000000;
const GPIOB = 0x50000400;
const [MODER, OTYPER, PUPDR, IDR, ODR, BSRR, AFRL, BRR] = [
  0x00, 0x04, 0x0c, 0x10, 0x14, 0x18, 0x20, 0x28,
];
const [INPUT, OUTPUT, AF] = [0, 1, 2];

/** The G031K8 on `nets`, with IOPENR set to `iopenr` (both ports on by default). */
function setup(nets = new Nets(), iopenr = 0b11) {
  const bus = new MemoryBus(stm32g031k8, {
    events: new EventLog(),
    now: () => ({ cycle: 0, pc: 0 }),
    nets,
    cpu: {
      setPending() {},
      clearPending() {},
      isPending: () => false,
      setPriority() {},
    },
  });
  bus.writeUint32(RCC_IOPENR, iopenr);
  /** Read-modify-write a 2-bit field (MODER, PUPDR) for pin n, as firmware does. */
  const set2 = (port: number, reg: number, n: number, v: number) =>
    bus.writeUint32(
      port + reg,
      (bus.readUint32(port + reg) & ~(3 << (2 * n))) | (v << (2 * n)),
    );
  return { bus, nets, set2 };
}

test("with IOPENR.GPIOAEN = 0, a MODER write has no effect and the pin doesn't change", () => {
  const { bus, nets, set2 } = setup(new Nets(), 0b10); // GPIOB on, GPIOA off
  set2(GPIOA, MODER, 0, OUTPUT);
  bus.writeUint32(GPIOA + ODR, 1);
  assert.equal(bus.regs.GPIOA.MODER, 0xebffffff);
  assert.equal(bus.regs.GPIOA.ODR, 0);
  assert.equal(nets.level("mcu.PA0"), "floating");

  // The gate is RCC's stored IOPENR: enabling it makes the same writes work.
  bus.writeUint32(RCC_IOPENR, 0b11);
  set2(GPIOA, MODER, 0, OUTPUT);
  assert.equal(nets.level("mcu.PA0"), "low");
});

test("PA0 as a push-pull output follows ODR", () => {
  const { bus, nets, set2 } = setup();
  set2(GPIOA, MODER, 0, OUTPUT);
  bus.writeUint32(GPIOA + ODR, 1);
  assert.equal(nets.level("mcu.PA0"), "high");
  assert.equal(bus.readUint32(GPIOA + IDR) & 1, 1); // the input reads the pin back
  bus.writeUint32(GPIOA + ODR, 0);
  assert.equal(nets.level("mcu.PA0"), "low");
});

test("BSRR sets and resets, set winning; BRR resets; both read 0", () => {
  const { bus, nets, set2 } = setup();
  set2(GPIOA, MODER, 0, OUTPUT);
  bus.writeUint32(GPIOA + BSRR, (1 << 16) | 1); // BR0 and BS0: set wins
  assert.equal(bus.regs.GPIOA.ODR, 1);
  assert.equal(nets.level("mcu.PA0"), "high");
  assert.equal(bus.readUint32(GPIOA + BSRR), 0);

  bus.writeUint16(GPIOA + BSRR + 2, 1); // BR0 alone, as a halfword
  assert.equal(nets.level("mcu.PA0"), "low");

  bus.writeUint32(GPIOA + BSRR, 0b11);
  bus.writeUint32(GPIOA + BRR, 0b01);
  assert.equal(bus.regs.GPIOA.ODR, 0b10);
  assert.equal(nets.level("mcu.PA0"), "low");
  assert.equal(bus.readUint32(GPIOA + BRR), 0);
});

test("IDR follows the net, including a pull-up on a floating net", () => {
  const { bus, nets, set2 } = setup();
  const pa1 = () => (bus.readUint32(GPIOA + IDR) >> 1) & 1;
  set2(GPIOA, MODER, 1, INPUT);
  assert.equal(nets.level("mcu.PA1"), "floating");
  assert.equal(pa1(), 0); // assumed: floating reads 0

  set2(GPIOA, PUPDR, 1, 1); // pull-up
  assert.equal(nets.level("mcu.PA1"), "high");
  assert.equal(pa1(), 1);
  nets.setSwitch("mcu.PA1", "GND", true); // a button to GND, pressed
  assert.equal(pa1(), 0);
  nets.setSwitch("mcu.PA1", "GND", false);
  assert.equal(pa1(), 1);

  set2(GPIOA, PUPDR, 1, 2); // pull-down
  assert.equal(pa1(), 0);
  nets.setSwitch("mcu.PA1", "3V3", true);
  assert.equal(pa1(), 1);
  bus.writeUint32(GPIOA + IDR, 0); // read-only
  assert.equal(pa1(), 1);
});

test("open-drain outputs with an external pull-up are wired-AND", () => {
  const nets = new Nets([["mcu.PA0", "mcu.PA1"]]);
  nets.addResistor("3V3", "mcu.PA0");
  const { bus, set2 } = setup(nets);
  bus.writeUint32(GPIOA + OTYPER, 0b11);
  set2(GPIOA, MODER, 0, OUTPUT);
  set2(GPIOA, MODER, 1, OUTPUT);
  const levels = (odr: number) => {
    bus.writeUint32(GPIOA + ODR, odr);
    return [nets.level("mcu.PA0"), bus.readUint32(GPIOA + IDR) & 0b11];
  };
  assert.deepEqual(levels(0b11), ["high", 0b11]);
  assert.deepEqual(levels(0b01), ["low", 0b00]);
  assert.deepEqual(levels(0b10), ["low", 0b00]);
  assert.deepEqual(levels(0b00), ["low", 0b00]);
});

test("analog mode (the reset state) leaves the pin floating and reads 0", () => {
  const { bus, nets, set2 } = setup();
  assert.equal(nets.level("mcu.PA0"), "floating");
  set2(GPIOA, PUPDR, 0, 1); // pull-up: disconnected in analog mode
  assert.equal(nets.level("mcu.PA0"), "floating");
  nets.setSwitch("mcu.PA0", "3V3", true);
  assert.equal(bus.readUint32(GPIOA + IDR) & 1, 0);
  // PA13 and PA14 reset to AF (SWD) with a pull-up and a pull-down.
  assert.deepEqual(
    [nets.level("mcu.PA13"), nets.level("mcu.PA14")],
    ["high", "low"],
  );
  assert.equal(nets.level("mcu.PB0"), "floating");
});

test("AF mode: the pull applies, and the AF peripheral owns the drive", () => {
  const { bus, nets, set2 } = setup();
  set2(GPIOB, MODER, 6, AF);
  set2(GPIOB, PUPDR, 6, 1);
  bus.writeUint32(GPIOB + AFRL, 6 << 24); // PB6: AF6, I2C1 SCL
  assert.equal(alternateFunction(bus.regs.GPIOB, 6), 6);
  assert.equal(alternateFunction(bus.regs.GPIOB, 7), undefined); // analog
  assert.equal(nets.level("mcu.PB6"), "high");

  nets.drive("mcu.PB6", "low"); // what I2C1 would do through ctx.nets
  set2(GPIOB, MODER, 0, OUTPUT); // a write for another pin leaves PB6 alone
  assert.equal(nets.level("mcu.PB6"), "low");
});

test("a pin that isn't on the package isn't connected", () => {
  const { bus, nets, set2 } = setup();
  set2(GPIOB, MODER, 12, OUTPUT);
  bus.writeUint32(GPIOB + ODR, 1 << 12);
  assert.equal(nets.level("mcu.PB12"), "floating");
  assert.equal(bus.readUint32(GPIOB + IDR), 0);
});

test("AF routing: PB6 in AF6 joins mcu.I2C1_SCL, and leaving AF6 cuts it off", () => {
  const { bus, nets, set2 } = setup();
  set2(GPIOB, PUPDR, 6, 1); // pull-up, stays on the pin
  set2(GPIOB, MODER, 6, AF);
  bus.writeUint32(GPIOB + AFRL, 6 << 24);
  assert.ok(nets.sameNet("mcu.PB6", "mcu.I2C1_SCL"));
  assert.equal(nets.level("mcu.I2C1_SCL"), "high");

  bus.writeUint32(GPIOB + AFRL, 1 << 24); // AF1: TIM1_CH3
  assert.ok(!nets.sameNet("mcu.PB6", "mcu.I2C1_SCL"));
  assert.equal(nets.level("mcu.I2C1_SCL"), "floating");

  bus.writeUint32(GPIOB + AFRL, 6 << 24);
  set2(GPIOB, MODER, 6, OUTPUT); // AFR still 6, but not AF mode
  assert.equal(nets.level("mcu.I2C1_SCL"), "floating");
});
