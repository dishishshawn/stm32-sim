import { test } from "node:test";
import assert from "node:assert/strict";
import { I2cBus } from "../engine/i2c.ts";
import { Nets } from "../engine/nets.ts";
import type { PropValue } from "./part.ts";
import { mountPart } from "./part.ts";
import { tc74 } from "./tc74.ts";

/** A TC74 "t" on I2C1 (SDA = PB7, SCL = PB6) with pull-ups to 3V3. */
function setup(props: Record<string, PropValue> = {}) {
  const nets = new Nets([
    ["mcu.PB7", "t.SDA"],
    ["mcu.PB6", "t.SCLK"],
  ]);
  nets.addResistor("mcu.PB7", "3V3");
  nets.addResistor("mcu.PB6", "3V3");
  const t = mountPart(nets, tc74, "t", props);
  const bus = new I2cBus({
    nets,
    sda: "mcu.PB7",
    scl: "mcu.PB6",
    parts: new Map([["t", t]]),
    now: () => 0,
    trace: () => {},
  });
  const addr = 0x48 + Number(String(props.variant ?? "A5").slice(1));
  /** Receive Byte: read without writing the pointer. */
  const receive = () => {
    bus.start();
    assert.equal(bus.address(addr, true), "ack");
    const byte = bus.read("nack");
    bus.stop();
    return byte;
  };
  /** Read Byte: write the pointer, repeated START, read. */
  const readReg = (reg: number) => {
    bus.start();
    assert.equal(bus.address(addr, false), "ack");
    assert.equal(bus.write(reg), "ack");
    return receive();
  };
  /** Write Byte: pointer, then data. */
  const writeReg = (reg: number, value: number) => {
    bus.start();
    assert.equal(bus.address(addr, false), "ack");
    assert.equal(bus.write(reg), "ack");
    assert.equal(bus.write(value), "ack");
    bus.stop();
  };
  return { t, bus, receive, readReg, writeReg };
}

test("a read without setting the pointer returns TEMP, the power-up pointer", () => {
  const { t, receive } = setup({ temperature: 22 });
  t.tick?.(0.2);
  assert.equal(receive(), 22);
});

test("TEMP is two's complement, rounded down per Table 4-4", () => {
  const { t, readReg } = setup();
  const table: [number, number][] = [
    [-5, 0xfb],
    [25.25, 0x19],
    [0.5, 0x00],
    [-0.25, 0xff],
    [-25.25, 0xe6],
    [-54.75, 0xc9],
    [126.5, 0x7e],
  ];
  for (const [celsius, byte] of table) {
    t.setProp?.("temperature", celsius);
    t.tick?.(0.2);
    assert.equal(readReg(0x00), byte, `${celsius} °C`);
  }
});

test("the temperature is clamped to the register range", () => {
  const { t, readReg } = setup();
  for (const [celsius, byte] of [
    [127, 0x7f],
    [130, 0x7f],
    [150, 0x7f],
    [-65, 0xbf],
  ]) {
    t.setProp?.("temperature", celsius);
    t.tick?.(0.2);
    assert.equal(readReg(0x00), byte, `${celsius} °C`);
  }
});

test("the address follows the variant (default A5 = 0x4D), and a wrong address NACKs", () => {
  for (let i = 0; i < 8; i++) {
    const { bus } = setup({ variant: `A${i}` });
    for (let a = 0x40; a < 0x58; a++) {
      bus.start();
      assert.equal(bus.address(a, false), a === 0x48 + i ? "ack" : "nack");
      bus.stop();
    }
  }
  const { bus } = setup();
  bus.start();
  assert.equal(bus.address(0x4d, true), "ack");
  bus.stop();
});

test("pointer 0x01 reads CONFIG, and the pointer stays there until rewritten", () => {
  const { t, receive, readReg, writeReg } = setup({ temperature: 22 });
  t.tick?.(0.2);
  assert.equal(readReg(0x01), 0x40, "DATA_RDY");
  assert.equal(
    receive(),
    0x40,
    "no auto-increment: a forgotten pointer reads CONFIG",
  );
  writeReg(0x00, 0x55); // TEMP is read-only: ACKed and ignored (assumed)
  assert.equal(receive(), 22);
  // DATA_RDY is read-only and bits 5-0 read zero.
  writeReg(0x01, 0x7f);
  assert.equal(receive(), 0x40);
});

test("DATA_RDY and TEMP stay 0 until the first conversion, 125 ms after power-up", () => {
  const { t, readReg } = setup({ temperature: 22 });
  assert.equal(readReg(0x01), 0x00);
  assert.equal(readReg(0x00), 0x00);
  t.tick?.(0.06);
  t.tick?.(0.06);
  assert.equal(readReg(0x01), 0x00, "120 ms");
  assert.equal(readReg(0x00), 0x00);
  t.tick?.(0.01);
  assert.equal(readReg(0x01), 0x40, "130 ms");
  assert.equal(readReg(0x00), 22);
  // A slider move shows at the next conversion.
  t.setProp?.("temperature", 30);
  assert.equal(readReg(0x00), 22);
  t.tick?.(0.125);
  assert.equal(readReg(0x00), 30);
});

test("SHDN clears DATA_RDY and freezes TEMP; leaving standby converts again", () => {
  const { t, readReg, writeReg } = setup({ temperature: 22 });
  t.tick?.(0.2);
  writeReg(0x01, 0x80);
  assert.equal(readReg(0x01), 0x80, "SHDN set, DATA_RDY cleared");
  assert.deepEqual(t.state?.(), {
    temperature: 22,
    shutdown: true,
    dataReady: false,
  });
  t.setProp?.("temperature", -5);
  t.tick?.(5);
  assert.equal(readReg(0x00), 22, "frozen");
  assert.equal(readReg(0x01), 0x80);

  writeReg(0x01, 0x00);
  assert.equal(readReg(0x01), 0x00, "DATA_RDY waits for a conversion");
  t.tick?.(0.1);
  assert.equal(readReg(0x00), 22);
  t.tick?.(0.03);
  assert.equal(readReg(0x01), 0x40);
  assert.equal(readReg(0x00), 0xfb);
});
