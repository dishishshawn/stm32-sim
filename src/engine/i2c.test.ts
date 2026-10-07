import { test } from "node:test";
import assert from "node:assert/strict";
import type { PartInstance } from "../parts/part.ts";
import type { Ack, I2cEvent, I2cTarget } from "./i2c.ts";
import { I2cBus } from "./i2c.ts";
import { Nets } from "./nets.ts";

const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** A fake target that logs every call into `log`. Set `addr` to move it at run time. */
function fake(
  log: string[],
  name: string,
  addr: number | undefined,
  reply = 0,
  writeAck: Ack = "ack",
) {
  const target: I2cTarget & { addr: number | undefined } = {
    addr,
    sda: "SDA",
    scl: "SCL",
    address: () => target.addr,
    write(byte: number): Ack {
      log.push(`${name} write ${hex(byte)}`);
      return writeAck;
    },
    read() {
      log.push(`${name} read`);
      return reply;
    },
    start: () => log.push(`${name} start`),
    stop: () => log.push(`${name} stop`),
  };
  return target;
}

/** Targets "a" and "b" wired to I2C1's pins (SDA = PB7, SCL = PB6), with pull-ups to 3V3. */
function setup(a: I2cTarget, b: I2cTarget, pullUps = true) {
  const nets = new Nets([
    ["mcu.PB7", "a.SDA"],
    ["mcu.PB6", "a.SCL"],
    ["mcu.PB7", "b.SDA"],
    ["mcu.PB6", "b.SCL"],
  ]);
  if (pullUps) {
    nets.addResistor("mcu.PB7", "3V3");
    nets.addResistor("mcu.PB6", "3V3");
  }
  const parts = new Map<string, PartInstance>([
    ["a", { i2c: a }],
    ["b", { i2c: b }],
  ]);
  const events: I2cEvent[] = [];
  let t = 0;
  const bus = new I2cBus({
    nets,
    sda: "mcu.PB7",
    scl: "mcu.PB6",
    parts,
    now: () => ++t,
    trace: (e) => events.push(e),
  });
  return { nets, parts, bus, events };
}

test("each transaction reaches only the target at its address", () => {
  const log: string[] = [];
  const { bus } = setup(fake(log, "a", 0x48, 0x16), fake(log, "b", 0x20, 0xab));

  bus.start();
  assert.equal(bus.address(0x48, false), "ack");
  assert.equal(bus.write(0x01), "ack");
  bus.stop();
  bus.start();
  assert.equal(bus.address(0x20, true), "ack");
  assert.equal(bus.read("nack"), 0xab);
  bus.stop();

  const io = log.filter((l) => /write|read/.test(l));
  assert.deepEqual(io, ["a write 0x01", "b read"]);
});

test("NACK when no target answers: wrong address, no address, or not on the bus", () => {
  const log: string[] = [];
  const a = fake(log, "a", 0x48, 0x16);
  const { nets, parts, bus } = setup(a, fake(log, "b", 0x20));

  bus.start();
  assert.equal(bus.address(0x49, false), "nack");
  assert.equal(bus.write(0x00), "nack", "nobody selected, so nobody ACKs");
  assert.equal(bus.read("nack"), 0xff, "nobody selected: SDA stays released");
  bus.stop();

  // The address can change at run time: undefined (RESET low) answers nothing.
  a.addr = undefined;
  bus.start();
  assert.equal(bus.address(0x48, false), "nack");
  a.addr = 0x48;
  bus.start();
  assert.equal(bus.address(0x48, false), "ack");
  bus.stop();

  // A target is on the bus only if both its SDA and SCL are on the bus's nets.
  const elsewhere = fake(log, "c", 0x50);
  parts.set("c", { i2c: elsewhere });
  nets.setSwitch("c.SDA", "mcu.PA0", true); // SDA on the wrong pin
  nets.setSwitch("c.SCL", "mcu.PB6", true);
  bus.start();
  assert.equal(bus.address(0x50, false), "nack");
  nets.setSwitch("c.SDA", "mcu.PA0", false);
  nets.setSwitch("c.SDA", "mcu.PB7", true); // now on the bus
  bus.start();
  assert.equal(bus.address(0x50, false), "ack");
  bus.stop();

  assert.ok(!log.some((l) => /write|read/.test(l)), log.join("; "));
});

test("not idle without pull-ups, or with a line held low", () => {
  const log: string[] = [];
  const { nets, bus } = setup(
    fake(log, "a", 0x48),
    fake(log, "b", 0x20),
    false,
  );
  assert.equal(nets.level("mcu.PB7"), "floating");
  assert.equal(bus.isIdle(), false, "no pull-ups: both lines float");

  nets.addResistor("mcu.PB7", "3V3");
  assert.equal(bus.isIdle(), false, "SCL still floats");
  nets.addResistor("mcu.PB6", "3V3");
  assert.equal(bus.isIdle(), true);

  nets.drive("b.SDA", "low"); // a target holding SDA low
  assert.equal(bus.isIdle(), false);
});

test("the exact trace and target calls for a write, then a read", () => {
  const log: string[] = [];
  const { bus, events } = setup(
    fake(log, "a", 0x48, 0x16),
    fake(log, "b", 0x20),
  );

  // Set the pointer to 0x00, then a repeated START and read one byte.
  bus.start();
  bus.address(0x48, false);
  bus.write(0x00);
  bus.start();
  bus.address(0x48, true);
  bus.read("nack");
  bus.stop();

  assert.deepEqual(events, [
    { t: 1, kind: "start" },
    { t: 2, kind: "addr", addr: 0x48, read: false, ack: "ack" },
    { t: 3, kind: "data", byte: 0x00, read: false, ack: "ack" },
    { t: 4, kind: "start" },
    { t: 5, kind: "addr", addr: 0x48, read: true, ack: "ack" },
    { t: 6, kind: "data", byte: 0x16, read: true, ack: "nack" },
    { t: 7, kind: "stop" },
  ]);
  // START and STOP reach every target on the bus; bytes only the addressed one.
  assert.deepEqual(log, [
    "a start",
    "b start",
    "a write 0x00",
    "a start",
    "b start",
    "a read",
    "a stop",
    "b stop",
  ]);
});

test("two targets at one address both respond, and a read ANDs their bytes", () => {
  const log: string[] = [];
  const { bus } = setup(
    fake(log, "a", 0x48, 0b1100_1010),
    fake(log, "b", 0x48, 0b1010_0110, "nack"),
  );

  bus.start();
  assert.equal(bus.address(0x48, false), "ack");
  assert.equal(bus.write(0x05), "ack", "a ACKs, b NACKs: SDA is low, so ACK");
  bus.start();
  assert.equal(bus.address(0x48, true), "ack");
  assert.equal(bus.read("nack"), 0b1000_0010);
  bus.stop();

  const io = log.filter((l) => /write|read/.test(l));
  assert.deepEqual(io, ["a write 0x05", "b write 0x05", "a read", "b read"]);
});
