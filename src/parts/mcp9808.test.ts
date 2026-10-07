import { test } from "node:test";
import assert from "node:assert/strict";
import { I2cBus } from "../engine/i2c.ts";
import { Nets } from "../engine/nets.ts";
import type { PropValue } from "./part.ts";
import { mountPart } from "./part.ts";
import { mcp9808 } from "./mcp9808.ts";

const ADDRESS = 0x18; // A2, A1, A0 to GND

/**
 * An MCP9808 "u1" on I2C1 (SDA = PB7, SCL = PB6) with pull-ups to 3V3, VDD
 * and GND wired, and A2, A1, A0 wired to `a` (null: not wired, so floating).
 */
function setup(
  props: Record<string, PropValue> = {},
  a: (string | null)[] = ["GND", "GND", "GND"],
) {
  const wires: [string, string][] = [
    ["mcu.PB7", "u1.SDA"],
    ["mcu.PB6", "u1.SCL"],
    ["u1.VDD", "3V3"],
    ["u1.GND", "GND"],
  ];
  ["A2", "A1", "A0"].forEach((pin, i) => {
    if (a[i]) wires.push([`u1.${pin}`, a[i]]);
  });
  const nets = new Nets(wires);
  nets.addResistor("mcu.PB7", "3V3");
  nets.addResistor("mcu.PB6", "3V3");
  const u1 = mountPart(nets, mcp9808, "u1", props);
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
  /** A 16-bit register, MSB first. */
  const word = (reg: number) => {
    const [msb, lsb] = readRegs(reg, 2);
    return (msb << 8) | lsb;
  };
  return { u1, bus, write, read, readRegs, word };
}

test("answers 0011 A2 A1 A0 (0x18 to 0x1F) from its address pins, and no address with one floating", () => {
  for (let n = 0; n < 8; n++) {
    const { bus } = setup(
      {},
      [4, 2, 1].map((b) => (n & b ? "3V3" : "GND")),
    );
    for (let a = 0x10; a < 0x28; a++) {
      bus.start();
      assert.equal(
        bus.address(a, false),
        a === 0x18 + n ? "ack" : "nack",
        `A2 A1 A0 = ${n.toString(2)}, 0x${a.toString(16)}`,
      );
      bus.stop();
    }
  }
  const { bus } = setup({}, ["GND", null, "GND"]);
  for (let a = 0x18; a < 0x20; a++) {
    bus.start();
    assert.equal(bus.address(a, false), "nack", "A1 floating");
    bus.stop();
  }
});

test("powers up with Table 5-3's values, and a read without setting the pointer reads register 0x00", () => {
  const { read, readRegs, word } = setup();
  assert.deepEqual(read(2), [0x00, 0x1f], "the pointer powers up as 0x00");
  assert.equal(word(0x01), 0x0000, "CONFIG");
  assert.equal(word(0x02), 0x0000, "TUPPER");
  assert.equal(word(0x03), 0x0000, "TLOWER");
  assert.equal(word(0x04), 0x0000, "TCRIT");
  assert.equal(word(0x05), 0x0000, "TA, before the first conversion");
  assert.equal(word(0x06), 0x0054, "Manufacturer ID");
  assert.equal(word(0x07), 0x0400, "Device ID 0x04, revision 0x00");
  assert.deepEqual(readRegs(0x08, 1), [0x03], "RESOLUTION, +0.0625 °C");
});

test("the pointer doesn't move: a read without setting it reads the same register again", () => {
  const { write, read, readRegs } = setup();
  assert.deepEqual(readRegs(0x06, 2), [0x00, 0x54]);
  assert.deepEqual(read(2), [0x00, 0x54], "still Manufacturer ID");
  assert.deepEqual(
    read(4),
    [0x00, 0x54, 0x00, 0x54],
    "a third byte starts the register again (assumed)",
  );
  assert.deepEqual(write(0x07), ["ack"], "a pointer write alone");
  assert.deepEqual(read(2), [0x04, 0x00]);
  assert.deepEqual(readRegs(0x08, 2), [0x03, 0x03], "RESOLUTION is 8-bit");
});

test("TA is 13-bit two's complement, 1/16 °C per LSB, rounded down to the resolution", () => {
  const { u1, write, word } = setup();
  // TUPPER and TCRIT at +255.75 °C, TLOWER at -256 °C: all three flags clear.
  write(0x02, 0x0f, 0xfc);
  write(0x04, 0x0f, 0xfc);
  write(0x03, 0x10, 0x00);
  const ta = (celsius: number) => {
    u1.setProp?.("temperature", celsius);
    u1.tick?.(0.25);
    return word(0x05);
  };
  const rows: [number, number][] = [
    [25.25, 0x0194], // Figure 5-5
    [90, 0x05a0], // Figure 5-4's +90 °C, the same format
    [0, 0x0000],
    [-0.0625, 0x1fff],
    [-25.25, 0x1e6c], // SIGN set: 0x0E6C / 16 - 256 (Equation 5-1)
    [125, 0x07d0],
    [-40, 0x1d80],
    [0.1, 0x0001], // rounded down (assumed)
    [-0.01, 0x1fff], // rounded down (assumed)
  ];
  for (const [celsius, value] of rows)
    assert.equal(ta(celsius), value, `${celsius} °C`);

  // Coarser resolutions keep the low bits clear (Register 5-4 note 2).
  write(0x08, 0x00);
  assert.equal(ta(25.4375), 0x0190, "+0.5 °C/bit");
  assert.equal(ta(-0.0625), 0x1ff8, "+0.5 °C/bit");
  write(0x08, 0x01);
  assert.equal(ta(25.4375), 0x0194, "+0.25 °C/bit");
  write(0x08, 0x02);
  assert.equal(ta(25.4375), 0x0196, "+0.125 °C/bit");
});

test("TA<15:13> compare each conversion with TCRIT, TUPPER and TLOWER, with hysteresis as it falls (Figure 5-10)", () => {
  const { u1, write, word } = setup({ temperature: 25 });
  u1.tick?.(0.25);
  assert.equal(
    word(0x05),
    0xc190,
    "with every limit at its 0 °C power-up value: TA >= TCRIT and TA > TUPPER",
  );
  write(0x03, 0x01, 0x40); // TLOWER +20 °C
  write(0x02, 0x01, 0xe0); // TUPPER +30 °C
  write(0x04, 0x02, 0x80); // TCRIT +40 °C
  write(0x01, 0x02, 0x00); // THYST +1.5 °C
  assert.equal(
    word(0x05) >> 13,
    0b110,
    "a limit write leaves the flags (assumed)",
  );
  const flags = (celsius: number) => {
    u1.setProp?.("temperature", celsius);
    u1.tick?.(0.25);
    return word(0x05) >> 13;
  };
  assert.equal(flags(25), 0b000);
  assert.equal(flags(19), 0b000, "below TLOWER, not below TLOWER - THYST");
  assert.equal(flags(18.4375), 0b001, "Note 2: TA < TLOWER - THYST");
  assert.equal(flags(19.9375), 0b001, "still below TLOWER");
  assert.equal(flags(20), 0b000, "Note 1: TA >= TLOWER");
  assert.equal(flags(30), 0b000, "TA = TUPPER is not above it");
  assert.equal(flags(30.0625), 0b010, "Note 3: TA > TUPPER");
  assert.equal(flags(28.5625), 0b010, "above TUPPER - THYST");
  assert.equal(flags(28.5), 0b000, "Note 4: TA <= TUPPER - THYST");
  assert.equal(flags(40), 0b110, "Note 5: TA >= TCRIT");
  assert.equal(flags(38.5), 0b110, "not below TCRIT - THYST");
  assert.equal(flags(38.4375), 0b010, "Note 7: TA < TCRIT - THYST");
});

test("the limits keep bits 12-2; a 16-bit write lands with its LSB; read-only registers ignore writes", () => {
  const { write, read, readRegs, word } = setup();
  assert.deepEqual(write(0x02, 0xff, 0xff), ["ack", "ack", "ack"]);
  assert.equal(word(0x02), 0x1ffc);
  write(0x02, 0x05, 0xa0); // +90 °C, Figure 5-4
  assert.equal(word(0x02), 0x05a0);
  write(0x02, 0x01);
  assert.equal(
    word(0x02),
    0x05a0,
    "a STOP after the MSB changes nothing (assumed)",
  );
  write(0x03, 0x01, 0x00, 0x02, 0x00);
  assert.equal(
    word(0x03),
    0x0200,
    "a second word overwrites the first (assumed)",
  );
  write(0x04, 0x1d, 0x80); // -40 °C
  assert.equal(word(0x04), 0x1d80);

  for (const [reg, value] of [
    [0x00, 0x001f],
    [0x05, 0x0000],
    [0x06, 0x0054],
    [0x07, 0x0400],
  ]) {
    assert.deepEqual(write(reg, 0x12, 0x34), ["ack", "ack", "ack"]);
    assert.equal(word(reg), value, `register 0x0${reg} is read-only`);
  }

  write(0x08, 0xff);
  assert.deepEqual(read(1), [0x03], "RESOLUTION keeps bits 1-0");
  write(0x08, 0x00);
  assert.deepEqual(readRegs(0x08), [0x00]);
});

test("CONFIG: Int. Clear and Alert Stat. read 0, and the Lock bits hold the bits Register 5-2 says they hold", () => {
  const { u1, write, word } = setup();
  write(0x01, 0x06, 0x0f); // THYST +6 °C, Alert Cnt., Sel., Pol., Mod.
  write(0x01, 0x06, 0x3f); // and Int. Clear, Alert Stat.
  assert.equal(word(0x01), 0x060f);
  assert.deepEqual(u1.state?.().notSimulated, ["Alert output"]);

  write(0x01, 0x06, 0x4f); // Win. Lock
  write(0x01, 0x01, 0x00); // try to clear everything and set SHDN
  assert.equal(
    word(0x01),
    0x064f,
    "locked: nothing changes, SHDN can't be set",
  );
  write(0x01, 0x00, 0x80); // Crit. Lock as well
  assert.equal(word(0x01), 0x06cf, "the Lock bits can't be cleared");

  // TUPPER and TLOWER are held by Win. Lock, TCRIT by Crit. Lock.
  const { write: write2, word: word2 } = setup();
  write2(0x01, 0x00, 0x40);
  write2(0x02, 0x05, 0xa0);
  write2(0x03, 0x05, 0xa0);
  write2(0x04, 0x05, 0xa0);
  assert.deepEqual([word2(0x02), word2(0x03), word2(0x04)], [0, 0, 0x05a0]);
  write2(0x01, 0x00, 0x80);
  write2(0x04, 0x01, 0x00);
  assert.equal(word2(0x04), 0x05a0);
  assert.equal(word2(0x01), 0x00c0);
});

test("TA stays 0 until the first conversion, tCONV after power-up: 250 ms at +0.0625 °C, 30 ms at +0.5 °C", () => {
  const { u1, word } = setup({ temperature: 25.25 });
  u1.tick?.(0.24);
  assert.equal(word(0x05) & 0x1fff, 0x0000, "240 ms");
  u1.tick?.(0.02);
  assert.equal(word(0x05) & 0x1fff, 0x0194, "260 ms");
  u1.setProp?.("temperature", 30);
  assert.equal(
    word(0x05) & 0x1fff,
    0x0194,
    "a slider move waits for a conversion",
  );
  u1.tick?.(0.25);
  assert.equal(word(0x05) & 0x1fff, 0x01e0);

  const { u1: fast, write, word: fastWord } = setup({ temperature: 25.25 });
  write(0x08, 0x00);
  fast.tick?.(0.029);
  assert.equal(fastWord(0x05) & 0x1fff, 0x0000, "29 ms");
  fast.tick?.(0.002);
  assert.equal(fastWord(0x05) & 0x1fff, 0x0190, "31 ms");
});

test("SHDN stops conversions and TA keeps its last reading; clearing SHDN converts again after tCONV", () => {
  const { u1, write, word } = setup({ temperature: 22 });
  u1.tick?.(0.25);
  write(0x01, 0x01, 0x00);
  assert.equal(word(0x01), 0x0100);
  u1.setProp?.("temperature", -5);
  u1.tick?.(5);
  assert.equal(word(0x05) & 0x1fff, 0x0160, "frozen at +22 °C");
  assert.deepEqual(u1.state?.(), {
    temperature: -5,
    address: 0x18,
    shutdown: true,
    resolution: 0.0625,
    notSimulated: [],
  });

  write(0x01, 0x00, 0x00);
  u1.tick?.(0.24);
  assert.equal(word(0x05) & 0x1fff, 0x0160, "240 ms after leaving shutdown");
  u1.tick?.(0.02);
  assert.equal(word(0x05) & 0x1fff, 0x1fb0, "-5 °C");
});

test("a reserved pointer reads 0 and is listed as not simulated", () => {
  const { u1, write, readRegs } = setup();
  assert.deepEqual(readRegs(0x09, 2), [0x00, 0x00]);
  write(0x15, 0x12, 0x34);
  assert.deepEqual(readRegs(0x15, 2), [0x00, 0x00], "bits 7-4 set");
  assert.deepEqual(u1.state?.().notSimulated, [
    "register 0x9",
    "register 0x15",
  ]);
});
