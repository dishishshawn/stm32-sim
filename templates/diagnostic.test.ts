// TEMPLATE: the test for templates/diagnostic.ts. Copy it next to your rule
// as src/diagnostics/<rule-id>.test.ts (see docs/adding-a-diagnostic.md) and
// fix the import paths marked below. `just test` runs it; the last test needs
// `just fw` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stm32g031k8 } from "../src/chips/stm32g031k8.ts"; // TEMPLATE: in src/diagnostics/ this is "../chips/stm32g031k8.ts"
import { diagnose } from "../src/diagnostics/rule.ts"; // TEMPLATE: in src/diagnostics/ this is "./rule.ts"
import type { Rule } from "../src/diagnostics/rule.ts"; // TEMPLATE: in src/diagnostics/ this is "./rule.ts"
import { parseCircuit } from "../src/engine/circuit.ts"; // TEMPLATE: in src/diagnostics/ this is "../engine/circuit.ts"
import { catalog, Engine } from "../src/engine/engine.ts"; // TEMPLATE: in src/diagnostics/ this is "../engine/engine.ts"
import type { BoardView } from "../src/engine/engine.ts"; // TEMPLATE: in src/diagnostics/ this is "../engine/engine.ts"
import type { Flag, RegEvent, SimEvent } from "../src/engine/events.ts"; // TEMPLATE: in src/diagnostics/ this is "../engine/events.ts"
import { i2cTxdrNotEmpty } from "./diagnostic.ts"; // TEMPLATE: in src/diagnostics/ this is "./<rule-id>.ts"

/** The repository root. TEMPLATE: in src/diagnostics/ this is "../../". */
const root = new URL("../", import.meta.url);

/**
 * A board whose I2C1 registers are `i2c1`. Only what the rule reads needs a
 * value. TEMPLATE: the registers, levels and parts your rule reads.
 */
const board = (i2c1: Record<string, number>): BoardView => ({
  chip: stm32g031k8,
  regs: { I2C1: i2c1 },
  level: () => "floating",
  where: () => "",
  sameNet: () => false,
  parts: [],
});

/** A word write of `value` to I2C1->`reg`, as the memory bus emits it. */
const write = (reg: string, value: number, flags: Flag[] = []): RegEvent => ({
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0x40005428, // TXDR; the rule goes by name
  periph: "I2C1",
  reg,
  op: "write",
  old: 0,
  value,
  flags,
});

test("a TXDR write while TXE = 0: names the bit, the section and the fix", () => {
  assert.deepEqual(
    i2cTxdrNotEmpty.check(write("TXDR", 0x55), board({ CR1: 1, ISR: 0 })),
    [
      {
        severity: "warning",
        message:
          "wrote I2C1_TXDR (0x40005428) while I2C1_ISR (0x40005418) bit 0 TXE = 0, " +
          "so the write was ignored and that byte never goes out: TXDR can be written only " +
          "when TXE = 1 (RM0444 §32.9.11). Wait for I2C1_ISR (0x40005418) bit 1 TXIS = 1 " +
          "before writing each byte",
        periph: "I2C1",
        reg: "TXDR",
      },
    ],
  );
});

test("nothing while TXE = 1, for another register, or with the clock off", () => {
  const busy = board({ CR1: 1, ISR: 0 });
  assert.deepEqual(
    i2cTxdrNotEmpty.check(write("TXDR", 0x55), board({ CR1: 1, ISR: 1 })),
    [],
  );
  assert.deepEqual(i2cTxdrNotEmpty.check(write("CR2", 0x55), busy), []);
  assert.deepEqual(
    i2cTxdrNotEmpty.check(write("TXDR", 0x55, ["clock-off"]), busy),
    [],
  );
});

/**
 * Runs build/<elf>.elf on firmware/<circuit>/circuit.json (null: the chip
 * alone) for 0.3 s with `rules`: every event, the end snapshot, and the
 * diagnostics found.
 */
function run(elf: string, circuit: string | null, rules: readonly Rule[]) {
  const url = new URL(`build/${elf}.elf`, root);
  assert.ok(existsSync(url), `build/${elf}.elf is missing: run \`just fw\``);
  const engine = new Engine();
  const events: SimEvent[] = [];
  engine.events.subscribe((e) => events.push(e));
  engine.load(
    readFileSync(url),
    circuit === null
      ? { chip: "stm32g031k8", parts: [], wires: [] }
      : parseCircuit(
          readFileSync(
            new URL(`firmware/${circuit}/circuit.json`, root),
            "utf8",
          ),
          catalog,
        ),
  );
  const found = diagnose(engine.events, engine.view(), rules);
  engine.runFor(0.3);
  return { events, snapshot: engine.snapshot(), found: found() };
}

// The purity check for this rule's scenario: the same events and snapshot with
// and without it. TEMPLATE: firmware your rule is about. tc74-read waits for
// TXIS, so the rule must stay silent; with firmware that makes the mistake
// (firmware/faults/<name>/), assert the finding instead.
test("only observes: tc74-read runs the same with and without it, and is clean", () => {
  const without = run("tc74-read", "tc74-read", []);
  const with_ = run("tc74-read", "tc74-read", [i2cTxdrNotEmpty]);
  assert.ok(without.events.length > 0);
  assert.deepEqual(with_.events, without.events);
  assert.deepEqual(with_.snapshot, without.snapshot);
  assert.deepEqual(with_.found, []);
});
