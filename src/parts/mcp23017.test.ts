import { test } from "node:test";
import assert from "node:assert/strict";
import { I2cBus } from "../engine/i2c.ts";
import { Nets } from "../engine/nets.ts";
import { mcp23017 } from "./mcp23017.ts";
import { mountPart } from "./part.ts";

const GND_ADDR: [string, string][] = [
  ["u.A0", "GND"],
  ["u.A1", "GND"],
  ["u.A2", "GND"],
];

/**
 * An MCP23017 "u" on I2C1 (SDA = PB7, SCL = PB6) with pull-ups, plus `wires`.
 * GPA0..7 are wired to mcu.PA0..7 and GPB0 to mcu.PB0, so a test can drive them.
 */
function setup(wires: [string, string][]) {
  const nets = new Nets([
    ["mcu.PB7", "u.SDA"],
    ["mcu.PB6", "u.SCL"],
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(
      (i) => [`mcu.PA${i}`, `u.GPA${i}`] as [string, string],
    ),
    ["mcu.PB0", "u.GPB0"],
    ...wires,
  ]);
  nets.addResistor("mcu.PB7", "3V3");
  nets.addResistor("mcu.PB6", "3V3");
  const u = mountPart(nets, mcp23017, "u");
  const bus = new I2cBus({
    nets,
    sda: "mcu.PB7",
    scl: "mcu.PB6",
    parts: new Map([["u", u]]),
    now: () => 0,
    trace: () => {},
  });
  /** One write transaction: the register address, then the data bytes. */
  const write = (addr: number, ...bytes: number[]) => {
    bus.start();
    const ack = bus.address(addr, false);
    for (const b of bytes) bus.write(b);
    bus.stop();
    return ack;
  };
  /** Set the pointer to `reg`, repeated START, read `n` bytes. */
  const read = (reg: number, n = 1, addr = 0x20) => {
    write(addr, reg);
    bus.start();
    bus.address(addr, true);
    const out = Array.from({ length: n }, (_, i) =>
      bus.read(i < n - 1 ? "ack" : "nack"),
    );
    bus.stop();
    return out;
  };
  return { nets, u, write, read };
}

test("the address follows the A pins", () => {
  const all = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  assert.equal(all.write(0x20), "ack");
  assert.equal(all.write(0x21), "nack");

  const { write } = setup([
    ["u.A0", "3V3"],
    ["u.A1", "GND"],
    ["u.A2", "3V3"],
    ["u.RESET", "3V3"],
  ]);
  assert.equal(write(0x25), "ack");
  assert.equal(write(0x20), "nack");

  // Assumed: a floating A pin matches no address.
  const floating = setup([
    ["u.A0", "GND"],
    ["u.A1", "GND"],
    ["u.RESET", "3V3"],
  ]);
  for (let a = 0x20; a <= 0x27; a++) assert.equal(floating.write(a), "nack");
});

test("RESET floating or low NACKs every address", () => {
  for (const wires of [GND_ADDR, [...GND_ADDR, ["u.RESET", "GND"]]] as [
    string,
    string,
  ][][]) {
    const { u, write } = setup(wires);
    for (let a = 0; a < 0x80; a++) assert.equal(write(a), "nack");
    assert.equal(u.state?.().reset, true);
  }
});

test("releasing RESET restores the power-on registers", () => {
  const { nets, write, read } = setup([...GND_ADDR, ["u.RESET", "mcu.PC0"]]);
  nets.drive("mcu.PC0", "high");
  write(0x20, 0x00, 0x00); // IODIRA = 0x00: port A outputs
  write(0x20, 0x14, 0xff); // OLATA = 0xFF
  write(0x20, 0x0c, 0x00, 0x01); // GPPUB = 0x01
  assert.equal(nets.level("u.GPA0"), "high");

  nets.drive("mcu.PC0", "low");
  assert.equal(write(0x20), "nack");
  assert.equal(nets.level("u.GPA0"), "floating", "outputs hi-z in reset");
  assert.equal(nets.level("u.GPB0"), "floating", "pull-up off in reset");

  nets.drive("mcu.PC0", "high");
  assert.deepEqual(read(0x00, 2), [0xff, 0xff], "IODIRA, IODIRB");
  assert.deepEqual(read(0x0c, 2), [0x00, 0x00], "GPPUA, GPPUB");
  assert.deepEqual(read(0x14, 2), [0x00, 0x00], "OLATA, OLATB");
  assert.equal(nets.level("u.GPA0"), "floating");
});

test("a sequential IODIRA/IODIRB write auto-increments and rolls over", () => {
  const { write, read } = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  write(0x20, 0x00, 0x12, 0x34);
  assert.deepEqual(read(0x00, 3), [0x12, 0x34, 0x00], "IODIRA, IODIRB, IPOLA");
  assert.deepEqual(read(0x15, 2), [0x00, 0x12], "OLATB rolls over to IODIRA");
});

test("SEQOP=1 stops the increment: with BANK=0 the pointer toggles A/B", () => {
  const { write, read } = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  write(0x20, 0x0a, 0x20); // IOCON.SEQOP = 1
  write(0x20, 0x00, 0x11, 0x22, 0x33);
  // §3.2.1: byte mode with BANK=0 toggles between IODIRA and IODIRB.
  assert.deepEqual(read(0x00, 3), [0x33, 0x22, 0x33]);
  write(0x20, 0x0a, 0x00); // SEQOP = 0 again
  assert.deepEqual(read(0x00, 3), [0x33, 0x22, 0x00], "IPOLA untouched");
});

test("GPPU makes an unconnected input read 1", () => {
  const { nets, write, read } = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  assert.deepEqual(read(0x12), [0x00], "inputs float with no pull-ups");
  write(0x20, 0x0c, 0x81); // GPPUA: GPA0 and GPA7
  assert.equal(nets.level("u.GPA0"), "high");
  assert.deepEqual(read(0x12), [0x81]);
});

test("IPOL inverts a read", () => {
  const { nets, write, read } = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  nets.drive("mcu.PA0", "high");
  nets.drive("mcu.PA1", "low");
  assert.deepEqual(read(0x12), [0b01]);
  write(0x20, 0x02, 0b11); // IPOLA
  assert.deepEqual(read(0x12), [0b10]);
});

test("OLAT drives the GPA nets when they are outputs, and a GPIO write goes to OLAT", () => {
  const { nets, write, read } = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  write(0x20, 0x14, 0xa5); // OLATA, while still inputs
  assert.equal(nets.level("u.GPA0"), "floating");
  write(0x20, 0x00, 0x00); // IODIRA: all outputs
  const levels = (n: number) =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ((n >> i) & 1 ? "high" : "low"));
  const gpa = () =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) => nets.level(`u.GPA${i}`));
  assert.deepEqual(gpa(), levels(0xa5));

  write(0x20, 0x12, 0x3c); // GPIOA write
  assert.deepEqual(read(0x14), [0x3c], "lands in OLATA");
  assert.deepEqual(gpa(), levels(0x3c));
  assert.deepEqual(read(0x12), [0x3c], "an output reads its pin");

  nets.drive("mcu.PA2", "low"); // shorted against GPA2 driving high
  assert.equal(nets.level("u.GPA2"), "conflict");
  assert.deepEqual(read(0x12), [0x38], "the pin, not the latch");
});

test("an input pin follows an external drive", () => {
  const { nets, read } = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  nets.drive("mcu.PA3", "high");
  nets.drive("mcu.PB0", "high");
  assert.deepEqual(read(0x12, 2), [0x08, 0x01], "GPIOA, GPIOB");
  nets.drive("mcu.PA3", "low");
  assert.deepEqual(read(0x12), [0x00]);
});

test("BANK=1 and interrupt-on-change are stored but logged as not simulated", () => {
  const { u, write, read } = setup([...GND_ADDR, ["u.RESET", "3V3"]]);
  write(0x20, 0x04, 0xff); // GPINTENA
  write(0x20, 0x0b, 0x80); // IOCON.BANK = 1, through its second address
  assert.deepEqual(read(0x04), [0xff]);
  assert.deepEqual(read(0x0a), [0x80], "IOCON at both addresses");
  assert.deepEqual(u.state?.().notSimulated, ["GPINTENA", "IOCON.BANK"]);
});
