// Acceptance 3, the first two fault tests. Each fault is tc74-read with one
// mistake, and each must fail the way the real board does: no simulator error
// and no HardFault, just firmware waiting forever for a flag that never comes,
// because tc74-read's wait loops have no timeout.
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
    d.message.startsWith("wrote GPIOB->MODER"),
  );
  assert.ok(moder, "no diagnostic for the GPIOB->MODER write");
  assert.equal(moder.rule, "gpio-clock-off");
  assert.match(
    moder.message,
    /^wrote GPIOB->MODER while RCC->IOPENR\.\w+ \(bit 1\) = 0 .* the write was ignored$/,
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
