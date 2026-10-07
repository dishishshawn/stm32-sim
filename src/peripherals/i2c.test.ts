import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { EventLog } from "../engine/events.ts";
import type { SimEvent } from "../engine/events.ts";
import type { Ack, I2cEvent } from "../engine/i2c.ts";
import { MemoryBus } from "../engine/memory-bus.ts";
import { Nets } from "../engine/nets.ts";
import { mountPart } from "../parts/part.ts";
import type { PartInstance } from "../parts/part.ts";
import { tc74 } from "../parts/tc74.ts";

const RCC = 0x40021000;
const [IOPENR, APBENR1] = [0x34, 0x3c];
const I2C1EN = 1 << 21;
const GPIOA = 0x50000000;
const GPIOB = 0x50000400;
const [MODER, OTYPER, AFRL, AFRH] = [0x00, 0x04, 0x20, 0x24];
const I2C1 = 0x40005400;
const [CR1, CR2, TIMINGR, ISR, ICR, RXDR, TXDR] = [
  0x00, 0x04, 0x10, 0x18, 0x1c, 0x24, 0x28,
];
const PE = 1;
const [RD_WRN, START, AUTOEND, RELOAD] = [1 << 10, 1 << 13, 1 << 25, 1 << 24];
const FLAGS = {
  TXIS: 1 << 1,
  RXNE: 1 << 2,
  NACKF: 1 << 4,
  STOPF: 1 << 5,
  TC: 1 << 6,
  BUSY: 1 << 15,
};
const STOPCF = 1 << 5;
/** RM0444 Table 173: 100 kHz at a 16 MHz I2CCLK. PRESC 3, SCLH 0x0F, SCLL 0x13. */
const TIMING_100K = 0x30420f13;
/** Its SCL period in cycles: (16 + 20) × 4, plus 4 for the sync delays. */
const SCL = (16 + 20) * 4 + 4;
/** Cycles per tick: about one instruction. */
const STEP = 4;

/** CR2 for a 7-bit transfer of `n` bytes, with START. */
const cr2 = (addr: number, n: number, read: boolean, autoend: boolean) =>
  (addr << 1) |
  (read ? RD_WRN : 0) |
  (n << 16) |
  (autoend ? AUTOEND : 0) |
  START;

interface BoardOptions {
  /** The MCU pins for SCL and SDA. */
  pins?: [scl: string, sda: string];
  /** The endpoints wired to them. */
  target?: [scl: string, sda: string];
  pullUps?: boolean;
  /** The AF number the pins are set to. */
  af?: number;
  iopenr?: number;
  apbenr1?: number;
}

/**
 * The G031K8 with I2C1 enabled at 100 kHz, its pins in AF mode (open-drain),
 * wired to a target (by default the endpoints "t.SCL" and "t.SDA"), with
 * pull-ups to 3V3. Time advances only through run() and until().
 */
function board(o: BoardOptions = {}) {
  const [scl, sda] = o.pins ?? ["PB6", "PB7"];
  const [tScl, tSda] = o.target ?? ["t.SCL", "t.SDA"];
  const nets = new Nets([
    [`mcu.${scl}`, tScl],
    [`mcu.${sda}`, tSda],
  ]);
  if (o.pullUps ?? true) {
    nets.addResistor("3V3", `mcu.${scl}`);
    nets.addResistor("3V3", `mcu.${sda}`);
  }
  const parts = new Map<string, PartInstance>();
  const log = new EventLog();
  const trace: I2cEvent[] = [];
  const all: SimEvent[] = [];
  log.subscribe((e) => {
    all.push(e);
    if (e.kind === "i2c") trace.push(e.step);
  });
  let cycle = 0;
  const bus = new MemoryBus(stm32g031k8, {
    events: log,
    now: () => ({ cycle, pc: 0 }),
    nets,
    cpu: { setPending() {} },
    parts,
  });
  const isr = () => bus.regs.I2C1.ISR; // no read side effects

  /** Each flag change, after every tick and every I2C1 access, e.g. "+TXIS". */
  const flags: string[] = [];
  let last = isr();
  const sample = () => {
    for (const [name, bit] of Object.entries(FLAGS)) {
      if ((isr() ^ last) & bit) flags.push(`${isr() & bit ? "+" : "-"}${name}`);
    }
    last = isr();
  };
  const w = (offset: number, v: number) => {
    bus.writeUint32(I2C1 + offset, v);
    sample();
  };
  const r = (offset: number) => {
    const v = bus.readUint32(I2C1 + offset);
    sample();
    return v;
  };

  const rmw = (a: number, mask: number, v: number) =>
    bus.writeUint32(a, (bus.readUint32(a) & ~mask) | v);
  bus.writeUint32(RCC + IOPENR, o.iopenr ?? 0b11);
  bus.writeUint32(RCC + APBENR1, o.apbenr1 ?? I2C1EN);
  for (const pin of [scl, sda]) {
    const port = pin[1] === "A" ? GPIOA : GPIOB;
    const n = Number(pin.slice(2));
    rmw(port + MODER, 3 << (2 * n), 2 << (2 * n)); // AF
    rmw(port + OTYPER, 1 << n, 1 << n); // open-drain
    const shift = (n % 8) * 4;
    rmw(port + (n < 8 ? AFRL : AFRH), 0xf << shift, (o.af ?? 6) << shift);
  }
  w(TIMINGR, TIMING_100K);
  w(CR1, PE);

  const tick = () => {
    cycle += STEP;
    bus.tick(STEP);
    sample();
  };
  const run = (cycles: number) => {
    for (const end = cycle + cycles; cycle < end;) tick();
  };
  /** Ticks until `flag` is set; returns the cycles that took. */
  const until = (flag: number, limit = 100 * SCL) => {
    const start = cycle;
    while (!(isr() & flag)) {
      if (cycle - start > limit)
        assert.fail(`flag 0x${flag.toString(16)} never set`);
      tick();
    }
    return cycle - start;
  };
  return { bus, nets, parts, w, r, isr, run, until, flags, trace, all };
}

/** A fake target at `address` that ACKs every write and sends `replies` in turn. */
function fake(address: number, replies: number[] = []) {
  const written: number[] = [];
  const part: PartInstance = {
    i2c: {
      sda: "SDA",
      scl: "SCL",
      address: () => address,
      write(byte): Ack {
        written.push(byte);
        return "ack";
      },
      read: () => replies.shift() ?? 0xff,
    },
  };
  return { part, written };
}

/** The trace without timestamps. */
const steps = (trace: I2cEvent[]) => trace.map(({ t, ...e }) => e);

test("a 1-byte write with AUTOEND: the trace, TXIS → STOPF, and the time it takes", () => {
  const b = board();
  const t = fake(0x50);
  b.parts.set("t", t.part);

  b.w(CR2, cr2(0x50, 1, false, true));
  b.run(SCL);
  assert.equal(
    b.isr() & FLAGS.TXIS,
    0,
    "not instantly: START + address take time",
  );
  b.until(FLAGS.TXIS);
  b.w(TXDR, 0xa5);
  b.until(FLAGS.STOPF);

  assert.deepEqual(steps(b.trace), [
    { kind: "start" },
    { kind: "addr", addr: 0x50, read: false, ack: "ack" },
    { kind: "data", byte: 0xa5, read: false, ack: "ack" },
    { kind: "stop" },
  ]);
  assert.deepEqual(t.written, [0xa5]);
  assert.deepEqual(b.flags, ["+BUSY", "+TXIS", "-TXIS", "+STOPF", "-BUSY"]);
  // START + address is 10 SCL periods, a byte 9, a STOP 1 (approximate).
  const [start, addr, data, stop] = b.trace.map((e) => e.t);
  assert.equal(addr - start, 10 * SCL);
  assert.equal(stop - data, SCL);
  assert.equal(
    b.bus.regs.I2C1.CR2 & START,
    0,
    "START clears once the address is sent",
  );

  b.w(ICR, STOPCF);
  assert.equal(b.isr() & FLAGS.STOPF, 0);
  assert.equal(b.r(ICR), 0, "ICR is write-only");
});

test("a 2-byte read: ACK then NACK, and SCL held while RXDR is unread", () => {
  const b = board();
  b.parts.set("t", fake(0x50, [0x12, 0x34]).part);

  b.w(CR2, cr2(0x50, 2, true, true));
  b.until(FLAGS.RXNE);
  b.run(30 * SCL); // don't read yet: the second byte waits before its ACK
  assert.equal(b.trace.filter((e) => e.kind === "data").length, 1);
  assert.equal(b.r(RXDR), 0x12);
  assert.ok(
    b.until(FLAGS.RXNE) <= STEP,
    "the next byte was already shifted in",
  );
  assert.equal(b.r(RXDR), 0x34);
  b.until(FLAGS.STOPF);

  assert.deepEqual(steps(b.trace), [
    { kind: "start" },
    { kind: "addr", addr: 0x50, read: true, ack: "ack" },
    { kind: "data", byte: 0x12, read: true, ack: "ack" },
    { kind: "data", byte: 0x34, read: true, ack: "nack" },
    { kind: "stop" },
  ]);
  assert.deepEqual(b.flags, [
    "+BUSY",
    "+RXNE",
    "-RXNE",
    "+RXNE",
    "-RXNE",
    "+STOPF",
    "-BUSY",
  ]);
});

test("an address NACK sets NACKF and sends a STOP, even with AUTOEND = 0", () => {
  const b = board();
  b.parts.set("t", fake(0x50).part);

  b.w(CR2, cr2(0x51, 1, false, false));
  b.until(FLAGS.STOPF);
  assert.deepEqual(steps(b.trace), [
    { kind: "start" },
    { kind: "addr", addr: 0x51, read: false, ack: "nack" },
    { kind: "stop" },
  ]);
  assert.deepEqual(b.flags, ["+BUSY", "+NACKF", "+STOPF", "-BUSY"]);
});

test("a TIMINGR write while PE = 1 is ignored; with PE = 0 it takes", () => {
  const b = board();
  b.w(TIMINGR, 0);
  assert.equal(b.r(TIMINGR), TIMING_100K);
  b.w(CR1, 0);
  b.w(TIMINGR, 0x10420f13);
  assert.equal(b.r(TIMINGR), 0x10420f13);
});

test("no pull-ups: the lines float, BUSY, and START never goes out", () => {
  const b = board({ pullUps: false });
  b.parts.set("t", fake(0x50).part);
  b.w(CR2, cr2(0x50, 1, false, true));
  b.run(50 * SCL);
  assert.ok(b.isr() & FLAGS.BUSY);
  assert.ok(b.r(CR2) & START, "START stays pending");
  assert.deepEqual(b.trace, []);
});

test("SDA held low: BUSY and no START; released, the START goes out", () => {
  const b = board();
  b.parts.set("t", fake(0x50).part);
  b.nets.setSwitch("t.SDA", "GND", true);
  b.w(CR2, cr2(0x50, 0, false, true));
  b.run(50 * SCL);
  assert.ok(b.isr() & FLAGS.BUSY);
  assert.equal(b.trace.length, 0);

  b.nets.setSwitch("t.SDA", "GND", false);
  b.until(FLAGS.STOPF);
  assert.deepEqual(
    b.trace.map((e) => e.kind),
    ["start", "addr", "stop"],
  );
});

test("with I2C1EN = 0, writes are ignored", () => {
  const b = board({ apbenr1: 0 });
  b.parts.set("t", fake(0x50).part);
  b.w(CR2, cr2(0x50, 1, false, true));
  b.run(50 * SCL);
  // board() wrote TIMINGR and CR1.PE too.
  const regs = b.bus.regs.I2C1;
  assert.deepEqual([regs.CR1, regs.CR2, regs.TIMINGR], [0, 0, 0]);
  assert.deepEqual(b.trace, []);
});

for (const [why, options] of [
  ["PB6/PB7 on AF1, not AF6", { af: 1 }],
  ["GPIOB's clock off, so MODER never left analog", { iopenr: 0b01 }],
] as const) {
  test(`pins not routed (${why}): I2C1's lines float, BUSY, empty trace`, () => {
    const b = board(options);
    b.parts.set("t", fake(0x50).part);
    b.w(CR2, cr2(0x50, 1, false, true));
    b.run(50 * SCL);
    assert.equal(b.nets.level("mcu.PB6"), "high", "the pins are pulled up");
    assert.equal(b.nets.level("mcu.I2C1_SCL"), "floating");
    assert.ok(b.isr() & FLAGS.BUSY);
    assert.deepEqual(b.trace, []);
  });
}

test("a TC74 on the Nucleo's I2C pins (PA9/PA10): set the pointer, then read 22 °C", () => {
  const b = board({ pins: ["PA9", "PA10"], target: ["u1.SCLK", "u1.SDA"] });
  const u1 = mountPart(b.nets, tc74, "u1", { variant: "A0", temperature: 22 });
  b.parts.set("u1", u1);
  u1.tick!(0.125); // the first conversion

  b.w(CR2, cr2(0x48, 1, false, false)); // pointer write, then a repeated START
  b.until(FLAGS.TXIS);
  b.w(TXDR, 0x00); // TEMP
  b.until(FLAGS.TC);
  b.w(CR2, cr2(0x48, 1, true, true));
  b.until(FLAGS.RXNE);
  assert.equal(b.r(RXDR), 22);
  b.until(FLAGS.STOPF);

  assert.deepEqual(steps(b.trace), [
    { kind: "start" },
    { kind: "addr", addr: 0x48, read: false, ack: "ack" },
    { kind: "data", byte: 0x00, read: false, ack: "ack" },
    { kind: "start" },
    { kind: "addr", addr: 0x48, read: true, ack: "ack" },
    { kind: "data", byte: 22, read: true, ack: "nack" },
    { kind: "stop" },
  ]);
  assert.deepEqual(b.flags, [
    "+BUSY",
    "+TXIS",
    "-TXIS",
    "+TC",
    "-TC",
    "+RXNE",
    "-RXNE",
    "+STOPF",
    "-BUSY",
  ]);
});

test("RELOAD is logged as not simulated", () => {
  const b = board();
  b.w(CR2, RELOAD);
  assert.deepEqual(
    b.all.filter((e) => e.kind === "unsimulated"),
    [{ kind: "unsimulated", cycle: 0, periph: "I2C1", feature: "CR2.RELOAD" }],
  );
});

test("clearing PE resets the transfer and the flags, and sets TXE", () => {
  const b = board();
  b.parts.set("t", fake(0x50).part);
  b.w(CR2, cr2(0x50, 1, false, true));
  b.until(FLAGS.TXIS);
  b.w(CR1, 0);
  assert.equal(b.isr(), 1); // TXE only
  assert.equal(b.r(CR2) & START, 0);
  b.w(CR1, PE);
  b.run(30 * SCL);
  assert.equal(b.isr(), 1, "idle: nothing resumes");
});
