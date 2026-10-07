// Acceptance 3, the fault tests. Each fault is a working example with one
// mistake, and each must fail the way the real board does: no simulator error
// and no HardFault. The first two are tc74-read, which waits forever for a flag
// that never comes, because its wait loops have no timeout. The last three are
// the thermometer's own ELF on its circuit with one wiring mistake; its I2C
// helpers give up on a NACK, so it runs on and shows the wrong thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rules } from "../../src/diagnostics/index.ts";
import { diagnose } from "../../src/diagnostics/rule.ts";
import { parseCircuit } from "../../src/engine/circuit.ts";
import { catalog, Engine } from "../../src/engine/engine.ts";
import type { I2cEvent } from "../../src/engine/i2c.ts";

const root = new URL("../../", import.meta.url);
const path = (p: string) => fileURLToPath(new URL(p, root));

// I2C1 bits: CR2 (RM0444 §32.9.2) and ISR (§32.9.7).
const CR2_START = 1 << 13;
const CR2_RD_WRN = 1 << 10;
const ISR_TXIS = 1 << 1;
const ISR_BUSY = 1 << 15;

/** The line in `file` that starts with `text`, as file:line the way the engine gives it. */
function line(file: string, text: string): string {
  const lines = readFileSync(path(file), "utf8").split("\n");
  const n = lines.findIndex((l) => l.trimStart().startsWith(text)) + 1;
  assert.ok(n > 0, `no line starting ${text} in ${file}`);
  return `${path(file)}:${n}`;
}

/** Runs `elf` on `circuit` for 1 s, then 20 instructions more to see where the PC goes. */
function run(elf: string, circuit: string) {
  assert.ok(existsSync(path(elf)), `${elf} is missing: run \`just fw\``);
  const engine = new Engine();
  const trace: I2cEvent[] = [];
  engine.events.subscribe((e) => {
    if (e.kind === "i2c") trace.push(e.step);
  });
  engine.load(
    readFileSync(path(elf)),
    parseCircuit(readFileSync(path(circuit), "utf8"), catalog),
  );
  const diagnosed = diagnose(engine.events, engine.view(), rules);
  engine.runFor(1);
  const snapshot = engine.snapshot();
  const next = new Set<string>();
  for (let i = 0; i < 20; i++) {
    engine.step();
    next.add(engine.snapshot().at);
  }
  return {
    trace,
    snapshot,
    next,
    board: engine.view(),
    diagnostics: diagnosed(),
  };
}

/** The firmware in `file` hangs in wait_for(I2C_ISR_TXIS): a hang, not a crash, and nothing on the bus. */
function assertHangsOnTxis(r: ReturnType<typeof run>, file: string) {
  const s = r.snapshot;
  assert.equal(s.halt, null, "the CPU stopped");
  assert.equal(s.fault, null, "HardFault");
  assert.deepEqual(s.log, []);
  assert.ok(s.seconds >= 1, `ran ${s.seconds} s`);
  // Not even a START.
  assert.deepEqual(r.trace, []);
  // The PC is in wait_for()'s polling loop, and stays there.
  const loop = [
    "uint32_t isr = I2C1->ISR;",
    "if (isr & flag)",
    "if (isr & I2C_ISR_NACKF)",
  ].map((text) => line(file, text));
  for (const at of [s.at, ...r.next]) assert.ok(loop.includes(at), at);
  // Waiting on TXIS: START is still pending for a write (the I2C clears it
  // once the address is sent), and TXIS never came.
  const { CR2, ISR } = s.registers.I2C1;
  assert.equal(CR2 & (CR2_START | CR2_RD_WRN), CR2_START);
  assert.equal(ISR & ISR_TXIS, 0);
}

test("GPIOA's clock instead of GPIOB's: PB6/PB7 stay analog, I2C never starts", () => {
  const main = "firmware/faults/gpio-clock/main.c";
  const r = run(
    "build/faults/gpio-clock.elf",
    "firmware/faults/gpio-clock/circuit.json",
  );
  // GPIOB ignored every write: MODER is still its reset value (all analog),
  // no AF6, no open drain.
  const { GPIOB } = r.snapshot.registers;
  assert.equal(GPIOB.MODER, 0xffffffff);
  assert.equal(GPIOB.AFRL, 0);
  assert.equal(GPIOB.OTYPER, 0);
  // So I2C1 isn't on the pins: the pull-ups hold PB6/PB7 high, and I2C1's
  // own lines don't see it.
  assert.equal(r.snapshot.pins.PB6, "high");
  assert.equal(r.snapshot.pins.PB7, "high");
  assert.equal(r.board.level("mcu.I2C1_SCL"), "floating");
  assert.equal(r.board.level("mcu.I2C1_SDA"), "floating");
  // ISR.BUSY isn't asserted: RM0444 doesn't say what an unrouted I2C input reads.
  assertHangsOnTxis(r, main);

  // The diagnostic says why, at the line whose write was ignored.
  const moder = r.diagnostics.find((d) =>
    d.message.startsWith("wrote GPIOB_MODER "),
  );
  assert.ok(moder, "no diagnostic for the GPIOB_MODER write");
  assert.equal(moder.rule, "gpio-clock-off");
  assert.match(
    moder.message,
    /^wrote GPIOB_MODER \(0x50000400\) while RCC_IOPENR \(0x40021034\) bit 1 \w+ = 0 .* the write was ignored$/,
  );
  assert.equal(moder.at, line(main, "GPIOB->MODER ="));
});

test("no pull-ups on SDA/SCL: BUSY is set, and the firmware hangs waiting on TXIS", () => {
  // tc74-read's own ELF: the circuit is the only mistake.
  const r = run(
    "build/tc74-read.elf",
    "firmware/faults/no-pullups/circuit.json",
  );
  const s = r.snapshot;
  // The firmware did its part: PB6/PB7 are AF6 (MODER 10), open drain.
  const { GPIOB } = s.registers;
  assert.equal((GPIOB.MODER >>> 12) & 0xf, 0b1010);
  assert.equal(GPIOB.AFRL >>> 24, 0x66);
  assert.equal((GPIOB.OTYPER >>> 6) & 3, 3);
  // But nothing pulls the lines high, so the bus never looks free.
  assert.equal(s.pins.PB6, "floating");
  assert.equal(s.pins.PB7, "floating");
  assert.equal(s.registers.I2C1.ISR & ISR_BUSY, ISR_BUSY);
  assertHangsOnTxis(r, "firmware/tc74-read/main.c");
});

// ----- The thermometer (firmware/thermometer) with one wiring mistake ------

const THERMOMETER = "build/thermometer.elf";

/** The firmware's DIGITS table (firmware/thermometer/main.c): bit 0 is A ... bit 6 G, 1 = pin high. */
const DIGITS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

/** A 7-segment part's values (A–G, DP) as a bit mask, bit 0 = A. */
const lit = (part: Readonly<Record<string, unknown>>) =>
  (part.values as number[]).reduce((b, v, i) => b | (v << i), 0);

/** A thermometer fault runs on: no hang in a wait loop, no HardFault, no core message. */
function assertRunsOn(r: ReturnType<typeof run>) {
  const s = r.snapshot;
  assert.equal(s.halt, null, "the CPU stopped");
  assert.equal(s.fault, null, "HardFault");
  assert.deepEqual(s.log, []);
  assert.ok(s.seconds >= 1, `ran ${s.seconds} s`);
}

test("MCP23017 RESET left floating: every transaction to 0x20 NACKs, the TC74 still answers, the display stays dark", () => {
  const r = run(THERMOMETER, "firmware/faults/reset-floating/circuit.json");
  assertRunsOn(r);
  const addrs = r.trace.filter((e) => e.kind === "addr");
  const mcp = addrs.filter((e) => e.addr === 0x20);
  const tc74 = addrs.filter((e) => e.addr === 0x48);
  assert.equal(mcp.length + tc74.length, addrs.length, "another address");
  // Two setup writes, then a poll of GPIOB every 20 ms and a redraw every
  // 250 ms: the firmware keeps trying, and the chip, held in reset, answers
  // none of them.
  assert.ok(mcp.length >= 50, `${mcp.length} transactions to 0x20`);
  for (const e of mcp) assert.equal(e.ack, "nack", JSON.stringify(e));
  // The TC74 on the same bus is fine: a read every 250 ms, each a write of
  // the pointer then a read, and 22 comes back.
  assert.ok(tc74.length >= 6, `${tc74.length} transactions to 0x48`);
  for (const e of tc74) assert.equal(e.ack, "ack", JSON.stringify(e));
  assert.ok(r.trace.some((e) => e.kind === "data" && e.read && e.byte === 22));
  // In reset every MCP23017 pin is an input (IODIR = 0xFF, hi-z), so the
  // segment anodes float and nothing lights.
  const { io, tens, units } = r.snapshot.parts;
  assert.equal(io.reset, true);
  assert.deepEqual(tens.values, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(units.values, [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("tens segments one pin over (GPA1..GPA7 to A..G): a 2 lights A C D F, which is no digit", () => {
  // The seven wires sit one pin along the MCP23017's header: segment A's wire
  // is on GPA1 instead of GPA0, ..., G's on GPA7, and GPA0 drives nothing. So
  // each segment shows the next bit of the pattern, and G shows GPA7, an
  // output the firmware always drives low: the pattern shifted right by one.
  const r = run(THERMOMETER, "firmware/faults/segments-shifted/circuit.json");
  assertRunsOn(r);
  const { tens, units } = r.snapshot.parts;
  assert.equal(DIGITS[2] >> 1, 0x2d);
  assert.deepEqual(tens.values, [1, 0, 1, 1, 0, 1, 0, 0]); // A C D F
  assert.equal(lit(tens), DIGITS[2] >> 1);
  assert.ok(!DIGITS.includes(lit(tens)), "the tens digit reads as a digit");
  // The units digit, wired right, still shows its 2.
  assert.equal(lit(units), DIGITS[2]);
});

test("common-anode digits driven with common-cathode patterns: 22 lights only C and F on each digit", () => {
  // COM is at 3V3, so a segment lights when its pin is low: the complement
  // of the pattern. The firmware drives 2 (A B D E G) high on both digits;
  // C and F are the pins it drives low. DP's pin isn't wired, so stays dark.
  const r = run(THERMOMETER, "firmware/faults/wrong-polarity/circuit.json");
  assertRunsOn(r);
  const { tens, units } = r.snapshot.parts;
  assert.equal(~DIGITS[2] & 0x7f, 0x24);
  for (const digit of [tens, units]) {
    assert.deepEqual(digit.values, [0, 0, 1, 0, 0, 1, 0, 0]); // C F
    assert.equal(lit(digit), ~DIGITS[2] & 0x7f);
    assert.ok(!DIGITS.includes(lit(digit)), "a digit reads as a digit");
  }
});
