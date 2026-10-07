import { test } from "node:test";
import assert from "node:assert/strict";
import { I2cBus } from "../engine/i2c.ts";
import { Nets } from "../engine/nets.ts";
import type { PropValue } from "./part.ts";
import { mountPart } from "./part.ts";
import { tmp102 } from "./tmp102.ts";

const ADDRESS = 0x48; // ADD0 to GND (Table 6-4)
const [TEMP, CONFIG, TLOW, THIGH] = [0, 1, 2, 3];

/**
 * A TMP102 "u1" on I2C1 (SDA = PB7, SCL = PB6) with pull-ups to 3V3, V+ and
 * GND wired, ALERT to PA0 with a pull-up, and ADD0 wired to `add0` (null: not
 * wired, so floating).
 */
function setup(
  props: Record<string, PropValue> = {},
  add0: string | null = "GND",
) {
  const wires: [string, string][] = [
    ["mcu.PB7", "u1.SDA"],
    ["mcu.PB6", "u1.SCL"],
    ["u1.V+", "3V3"],
    ["u1.GND", "GND"],
    ["u1.ALERT", "mcu.PA0"],
  ];
  if (add0) wires.push(["u1.ADD0", add0]);
  const nets = new Nets(wires);
  nets.addResistor("mcu.PB7", "3V3");
  nets.addResistor("mcu.PB6", "3V3");
  nets.addResistor("mcu.PA0", "3V3");
  const u1 = mountPart(nets, tmp102, "u1", props);
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
  /** A register's 16-bit word (Read Word, Figure 6-3). */
  const reg = (r: number) => {
    const [msb, lsb] = readRegs(r, 2);
    return (msb << 8) | lsb;
  };
  /** Write Word (Figure 6-2), MSB first. */
  const setReg = (r: number, word: number) =>
    assert.deepEqual(write(r, word >> 8, word & 0xff), ["ack", "ack", "ack"]);
  /** The ALERT net: pulled up, so "high" unless the TMP102 pulls it low. */
  const alert = () => nets.level("mcu.PA0");
  return { u1, bus, write, read, readRegs, reg, setReg, alert };
}

test("answers 0x48 to 0x4B with ADD0 tied to GND, V+, SDA or SCL, and no address with ADD0 floating", () => {
  for (const [add0, answers] of [
    ["GND", 0x48],
    ["3V3", 0x49],
    ["mcu.PB7", 0x4a],
    ["mcu.PB6", 0x4b],
    [null, undefined],
  ] as const) {
    const { u1, bus } = setup({}, add0);
    for (let a = 0x40; a < 0x50; a++) {
      bus.start();
      assert.equal(
        bus.address(a, false),
        a === answers ? "ack" : "nack",
        `ADD0 to ${add0}, 0x${a.toString(16)}`,
      );
      bus.stop();
    }
    assert.equal(u1.state?.().address, answers);
  }
});

test("power-up: the pointer is on TEMP, which reads 0 °C until the first conversion; CONFIG, TLOW and THIGH hold their reset values", () => {
  const { read, reg, alert } = setup({ temperature: 22 });
  assert.deepEqual(read(2), [0x00, 0x00], "TEMP, without setting the pointer");
  assert.equal(reg(CONFIG), 0x60a0);
  assert.equal(reg(TLOW), 0x4b00, "75 °C");
  assert.equal(reg(THIGH), 0x5000, "80 °C");
  assert.equal(alert(), "high", "ALERT released");
});

test("the pointer stays where it was last written, and only P1 P0 select a register", () => {
  const { u1, write, read, readRegs } = setup();
  u1.tick?.(0.011);
  assert.deepEqual(readRegs(CONFIG, 2), [0x60, 0xa0]);
  assert.deepEqual(read(2), [0x60, 0xa0], "no auto-increment");
  assert.deepEqual(
    read(3),
    [0x60, 0xa0, 0x60],
    "a third byte is the MSB again (assumed)",
  );
  assert.deepEqual(write(THIGH), ["ack"], "a pointer write alone");
  assert.deepEqual(read(2), [0x50, 0x00]);
  assert.deepEqual(write(0xfc), ["ack"], "P7-P2 ignored (assumed)");
  assert.deepEqual(read(2), [0x19, 0x00], "TEMP: 25 °C");
});

test("TEMP is 12-bit two's complement, left-justified, per Table 6-2", () => {
  const { u1, reg } = setup();
  const table: [number, number][] = [
    [128, 0x7ff],
    [127.9375, 0x7ff],
    [100, 0x640],
    [80, 0x500],
    [75, 0x4b0],
    [50, 0x320],
    [25, 0x190],
    [0.25, 0x004],
    [0, 0x000],
    [-0.25, 0xffc],
    [-25, 0xe70],
    [-55, 0xc90],
    [150, 0x7ff], // past 12 bits, as 128 °C (assumed)
    [25.03, 0x190], // rounds down (assumed)
    [-0.03, 0xfff],
  ];
  for (const [celsius, code] of table) {
    u1.setProp?.("temperature", celsius);
    u1.tick?.(0.25);
    assert.equal(reg(TEMP), code << 4, `${celsius} °C`);
  }
});

test("with EM set, TEMP, TLOW and THIGH are 13-bit per Table 6-3, and TEMP's D0 reads 1", () => {
  const { u1, reg, setReg } = setup();
  setReg(CONFIG, 0x60b0);
  assert.equal(reg(CONFIG), 0x60b0);
  assert.equal(reg(THIGH), 0x2800, "80 °C in 13 bits");
  const table: [number, number][] = [
    [150, 0x0960],
    [128, 0x0800],
    [127.9375, 0x07ff],
    [25, 0x0190],
    [0.25, 0x0004],
    [0, 0x0000],
    [-0.25, 0x1ffc],
    [-25, 0x1e70],
    [-55, 0x1c90],
  ];
  for (const [celsius, code] of table) {
    u1.setProp?.("temperature", celsius);
    u1.tick?.(0.25);
    assert.equal(reg(TEMP), ((code << 3) & 0xffff) | 1, `${celsius} °C`);
  }
});

test("the first conversion ends 10 ms after power-up, then one starts every 250 ms; CR sets the rate", () => {
  const { u1, reg, setReg } = setup({ temperature: 22 });
  u1.tick?.(0.009);
  assert.equal(reg(TEMP), 0x0000, "9 ms");
  u1.tick?.(0.002);
  assert.equal(reg(TEMP), 0x1600, "11 ms: 22 °C");
  // A slider move shows at the end of the next conversion, 250 + 10 ms.
  u1.setProp?.("temperature", 30);
  u1.tick?.(0.248);
  assert.equal(reg(TEMP), 0x1600, "259 ms");
  u1.tick?.(0.002);
  assert.equal(reg(TEMP), 0x1e00, "261 ms");
  // CR = 00: 0.25 Hz, one conversion every 4 s.
  setReg(CONFIG, 0x6000);
  u1.setProp?.("temperature", 40);
  u1.tick?.(3.98);
  assert.equal(reg(TEMP), 0x1e00, "3.991 s after the last start");
  u1.tick?.(0.015);
  assert.equal(reg(TEMP), 0x1e00, "converting");
  u1.tick?.(0.005);
  assert.equal(reg(TEMP), 0x2800, "40 °C");
});

test("CONFIG: R1 R0 and AL are read-only, D3-D0 read 0, and the rest reads back as written", () => {
  const { reg, setReg, write } = setup();
  // F1 F0 POL TM = 1111, R1 R0 written 00; CR1 CR0 = 11, AL written 0, EM = 1, D3-D0 written 1111.
  setReg(CONFIG, 0x1edf);
  assert.equal(reg(CONFIG), 0x7ed0, "AL reads 0: not tripped, POL = 1");
  setReg(CONFIG, 0x60a0);
  assert.equal(reg(CONFIG), 0x60a0);
  // Byte by byte: a STOP after the MSB leaves the LSB as it was.
  assert.deepEqual(write(CONFIG, 0x02), ["ack", "ack"]);
  assert.equal(reg(CONFIG), 0x62a0);
});

test("TLOW and THIGH read back in the TEMP format, update byte by byte, and TEMP is read-only", () => {
  const { u1, reg, setReg, write } = setup();
  u1.tick?.(0.011);
  setReg(THIGH, 0x6a5f);
  assert.equal(reg(THIGH), 0x6a50, "D3-D0 read 0");
  setReg(TLOW, 0xe70f);
  assert.equal(reg(TLOW), 0xe700, "-25 °C");
  write(THIGH, 0x20);
  assert.equal(reg(THIGH), 0x2050, "MSB only");
  setReg(TEMP, 0x1234); // ACKed and ignored (assumed)
  assert.equal(reg(TEMP), 0x1900);
});

test("comparator mode: ALERT pulls low and AL clears at THIGH, until the temperature falls below TLOW", () => {
  const { u1, reg, alert } = setup({ temperature: 79.9375 });
  u1.tick?.(0.011);
  assert.equal(alert(), "high");
  u1.setProp?.("temperature", 80);
  u1.tick?.(0.25);
  assert.equal(alert(), "low", "80 °C reaches THIGH");
  assert.equal(reg(CONFIG), 0x6080, "AL = 0");
  assert.equal(u1.state?.().alert, true);
  u1.setProp?.("temperature", 75);
  u1.tick?.(0.25);
  assert.equal(alert(), "low", "75 °C is not below TLOW");
  u1.setProp?.("temperature", 74.9375);
  u1.tick?.(0.25);
  assert.equal(alert(), "high");
  assert.equal(reg(CONFIG), 0x60a0);
});

test("the fault queue needs F1 F0 consecutive faults: 4 with F = 10", () => {
  const { u1, setReg, alert } = setup({ temperature: 90 });
  setReg(CONFIG, 0x70a0);
  u1.tick?.(0.011);
  u1.tick?.(0.25);
  u1.setProp?.("temperature", 25);
  u1.tick?.(0.25);
  u1.setProp?.("temperature", 90);
  for (let i = 1; i <= 3; i++) {
    u1.tick?.(0.25);
    assert.equal(alert(), "high", `${i} consecutive`);
  }
  u1.tick?.(0.25);
  assert.equal(alert(), "low", "4 consecutive");
});

test("interrupt mode: ALERT latches at THIGH, a read of any register clears it, and it latches again below TLOW", () => {
  const { u1, reg, write, setReg, alert } = setup({ temperature: 85 });
  setReg(CONFIG, 0x62a0);
  u1.tick?.(0.011);
  assert.equal(alert(), "low");
  write(CONFIG, 0x02); // a write doesn't clear it
  assert.equal(alert(), "low");
  assert.equal(reg(TLOW), 0x4b00);
  assert.equal(alert(), "high", "cleared by reading TLOW");
  u1.tick?.(0.25);
  assert.equal(alert(), "high", "still above THIGH: no new event");
  assert.equal(reg(CONFIG), 0x6280, "AL follows the comparator");
  u1.setProp?.("temperature", 70);
  u1.tick?.(0.25);
  assert.equal(alert(), "low", "below TLOW");
  reg(TEMP);
  assert.equal(alert(), "high");
  // Shutdown clears it too.
  u1.setProp?.("temperature", 85);
  u1.tick?.(0.25);
  assert.equal(alert(), "low");
  write(CONFIG, 0x03);
  assert.equal(alert(), "high");
});

test("POL = 1 inverts ALERT and AL", () => {
  const { u1, reg, setReg, alert } = setup({ temperature: 25 });
  setReg(CONFIG, 0x64a0);
  u1.tick?.(0.011);
  assert.equal(alert(), "low", "inactive");
  assert.equal(reg(CONFIG), 0x6480);
  u1.setProp?.("temperature", 85);
  u1.tick?.(0.25);
  assert.equal(alert(), "high", "active: released");
  assert.equal(reg(CONFIG), 0x64a0);
});

test("SD stops conversions after the current one; OS starts one conversion and reads 0 until it ends", () => {
  const { u1, reg, write } = setup({ temperature: 25 });
  write(CONFIG, 0x01); // during the power-up conversion
  u1.tick?.(0.011);
  assert.equal(reg(TEMP), 0x1900, "the conversion in progress completes");
  u1.setProp?.("temperature", 30);
  u1.tick?.(5);
  assert.equal(reg(TEMP), 0x1900, "shut down");
  assert.equal(reg(CONFIG), 0x61a0);

  write(CONFIG, 0x81);
  assert.equal(reg(CONFIG), 0x61a0, "OS reads 0 while converting");
  u1.tick?.(0.009);
  assert.equal(reg(TEMP), 0x1900);
  u1.tick?.(0.002);
  assert.equal(reg(CONFIG), 0xe1a0, "OS reads 1 after");
  assert.equal(reg(TEMP), 0x1e00);
  u1.setProp?.("temperature", 35);
  u1.tick?.(5);
  assert.equal(reg(TEMP), 0x1e00, "back in shutdown");
  assert.deepEqual(u1.state?.(), {
    temperature: 35,
    address: 0x48,
    shutdown: true,
    alert: false,
  });

  write(CONFIG, 0x00); // leaving shutdown converts at once (assumed)
  u1.tick?.(0.011);
  assert.equal(reg(TEMP), 0x2300);
  assert.equal(u1.state?.().shutdown, false);
});
