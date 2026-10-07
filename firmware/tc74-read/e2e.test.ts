// End to end: build/tc74-read.elf on firmware/tc74-read/circuit.json, where the
// TC74A0 (0x48) has its temperature prop (the slider) at 22 °C. The firmware
// reads TEMP every 250 ms, the first time at 250 ms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCircuit } from "../../src/engine/circuit.ts";
import { loadElf } from "../../src/engine/elf.ts";
import { catalog, Engine } from "../../src/engine/engine.ts";
import type { I2cEvent } from "../../src/engine/i2c.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ELF = "build/tc74-read.elf";
const CIRCUIT = "firmware/tc74-read/circuit.json";

function elf(): Uint8Array {
  const path = join(root, ELF);
  assert.ok(existsSync(path), `${ELF} is missing: run \`just fw\` first`);
  return readFileSync(path);
}

/** One read of TEMP at 22 °C. The trace puts each ACK/NACK on its address or byte. */
const READ = [
  { kind: "start" },
  { kind: "addr", addr: 0x48, read: false, ack: "ack" },
  { kind: "data", byte: 0x00, read: false, ack: "ack" },
  { kind: "start" }, // repeated START
  { kind: "addr", addr: 0x48, read: true, ack: "ack" },
  { kind: "data", byte: 0x16, read: true, ack: "nack" },
  { kind: "stop" },
];

/** The steps without their timestamps. */
const untimed = (steps: I2cEvent[]) => steps.map(({ t: _, ...s }) => s);

/** Runs the firmware for `seconds`, with the circuit's props overridden by `props`. */
function run(seconds: number, props: Record<string, string> = {}) {
  const bytes = elf();
  const circuit = parseCircuit(
    readFileSync(join(root, CIRCUIT), "utf8"),
    catalog,
  );
  Object.assign(circuit.parts.find((p) => p.id === "temp")!.props, props);
  const engine = new Engine();
  const trace: I2cEvent[] = [];
  engine.events.subscribe((e) => {
    if (e.kind === "i2c") trace.push(e.step);
  });
  engine.load(bytes, circuit);
  engine.runFor(seconds);
  const at = loadElf(bytes).symbol("g_temp");
  assert.ok(at !== undefined, "no g_temp symbol");
  const gTemp = Int8Array.from(engine.readSram(at, 1))[0];
  return { trace, gTemp, snapshot: engine.snapshot() };
}

test("at 300 ms, one read: g_temp is 22, and the trace is that read", () => {
  const { trace, gTemp } = run(0.3);
  assert.equal(gTemp, 22);
  assert.deepEqual(untimed(trace), READ);
  // The first START comes at 250 ms (16 MHz).
  assert.ok(trace[0].t >= 0.25 * 16e6, `START at cycle ${trace[0].t}`);
});

test("a NACK is cleared and retried next period: the TC74A5 isn't at 0x48", () => {
  const { trace, gTemp, snapshot } = run(0.6, { variant: "A5" });
  const miss = [
    { kind: "start" },
    { kind: "addr", addr: 0x48, read: false, ack: "nack" },
    { kind: "stop" },
  ];
  assert.deepEqual(untimed(trace), [...miss, ...miss]);
  assert.equal(gTemp, 0);
  // NACKF and STOPF were cleared after each miss.
  const isr = snapshot.registers.I2C1.ISR;
  assert.equal(isr & 0x30, 0, `ISR ${isr.toString(16)}`);
});

test("sim inspect --at 1s --json includes the trace: three reads", () => {
  elf(); // a missing ELF fails here with "run `just fw`", not as exit code 2
  const r = spawnSync(
    process.execPath,
    [
      join(root, "src/cli/sim.ts"),
      "inspect",
      ELF,
      "--circuit",
      CIRCUIT,
      "--at",
      "1s",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "completed");
  const steps = out.i2c.map((e: { step: I2cEvent }) => e.step);
  assert.deepEqual(untimed(steps), [...READ, ...READ, ...READ]);
  assert.equal(out.parts.temp.temperature, 22);
});
