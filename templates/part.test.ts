// TEMPLATE: the test for templates/part.ts. Copy it next to your part as
// src/parts/<your-part>.test.ts (see docs/adding-a-part.md) and fix the
// import paths marked below. `just test` runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { I2cBus } from "../src/engine/i2c.ts"; // TEMPLATE: in src/parts/ this is "../engine/i2c.ts"
import { Nets } from "../src/engine/nets.ts"; // TEMPLATE: in src/parts/ this is "../engine/nets.ts"
import type { PropValue } from "../src/parts/part.ts"; // TEMPLATE: in src/parts/ this is "./part.ts"
import { mountPart } from "../src/parts/part.ts"; // TEMPLATE: in src/parts/ this is "./part.ts"
import { lx01 } from "./part.ts"; // TEMPLATE: in src/parts/ this is "./<your-part>.ts"

const ADDRESS = 0x44; // TEMPLATE: your part's default address

/**
 * An LX01 "u1" on I2C1 (SDA = PB7, SCL = PB6) with pull-ups to 3V3, and its
 * ADDR pin wired to `addr` (null: not wired, so floating).
 */
function setup(
  props: Record<string, PropValue> = {},
  addr: string | null = "GND",
) {
  const wires: [string, string][] = [
    ["mcu.PB7", "u1.SDA"],
    ["mcu.PB6", "u1.SCL"],
  ];
  if (addr) wires.push(["u1.ADDR", addr]);
  const nets = new Nets(wires);
  nets.addResistor("mcu.PB7", "3V3");
  nets.addResistor("mcu.PB6", "3V3");
  const u1 = mountPart(nets, lx01, "u1", props);
  const bus = new I2cBus({
    nets,
    sda: "mcu.PB7",
    scl: "mcu.PB6",
    parts: new Map([["u1", u1]]),
    now: () => 0,
    trace: () => {},
  });

  /** START, address + W, the pointer byte, then `data`, STOP. Returns each byte's ACK. */
  const write = (pointer: number, ...data: number[]) => {
    bus.start();
    assert.equal(bus.address(ADDRESS, false), "ack");
    const acks = [pointer, ...data].map((byte) => bus.write(byte));
    bus.stop();
    return acks;
  };
  /** Reads `n` bytes without setting the pointer: START, address + R, the bytes (the last one NACKed), STOP. */
  const read = (n: number) => {
    bus.start();
    assert.equal(bus.address(ADDRESS, true), "ack");
    const bytes = Array.from({ length: n }, (_, i) =>
      bus.read(i === n - 1 ? "nack" : "ack"),
    );
    bus.stop();
    return bytes;
  };
  /** Sets the pointer to `reg`, then a repeated START and reads `n` bytes. */
  const readRegs = (reg: number, n = 1) => {
    bus.start();
    assert.equal(bus.address(ADDRESS, false), "ack");
    assert.equal(bus.write(reg), "ack");
    return read(n); // its start() is the repeated START
  };
  return { u1, bus, write, read, readRegs };
}

test("answers 0x44 with ADDR low, 0x45 with ADDR high, and no address with ADDR floating", () => {
  for (const [addr, answers] of [
    ["GND", 0x44],
    ["3V3", 0x45],
    [null, undefined],
  ] as const) {
    const { bus } = setup({}, addr);
    for (let a = 0x40; a < 0x48; a++) {
      bus.start();
      assert.equal(
        bus.address(a, false),
        a === answers ? "ack" : "nack",
        `ADDR to ${addr}, 0x${a.toString(16)}`,
      );
      bus.stop();
    }
  }
});

test("a read without setting the pointer starts where the pointer was left", () => {
  const { read, readRegs } = setup();
  assert.deepEqual(read(1), [0xa1], "the pointer powers up on ID");
  assert.deepEqual(readRegs(0x02, 2), [0x00, 0x64], "DATA_H, DATA_L: 100 lux");
  assert.deepEqual(read(1), [0x00], "past DATA_L, not back at DATA_H");
});

test("DATA is the lux prop, MSB first, and follows the slider", () => {
  const { u1, readRegs } = setup({ lux: 1234 });
  assert.deepEqual(readRegs(0x02, 2), [0x04, 0xd2]);
  u1.setProp?.("lux", 65535);
  assert.deepEqual(readRegs(0x02, 2), [0xff, 0xff]);
  assert.deepEqual(u1.state?.(), { lux: 65535, address: 0x44 });
});

test("CONFIG is read/write; a write to read-only ID is ACKed and ignored", () => {
  const { write, readRegs } = setup();
  assert.deepEqual(
    write(0x00, 0x11, 0x22),
    ["ack", "ack", "ack"],
    "pointer, ID, CONFIG",
  );
  assert.deepEqual(readRegs(0x00, 2), [0xa1, 0x22]);
});
