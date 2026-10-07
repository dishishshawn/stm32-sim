import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseCircuit } from "../engine/circuit.ts";
import { catalog, Engine } from "../engine/engine.ts";
import type { SimEvent } from "../engine/events.ts";
import { rules } from "./index.ts";
import { diagnose } from "./rule.ts";
import type { Rule } from "./rule.ts";

/** Reads every register, every pin's level and every I2C part's address on every event, to show the views have no side effects. */
const nosy: Rule = {
  id: "nosy",
  check(_, { chip, regs, level, parts, sameNet }) {
    for (const r of Object.values(regs)) Object.values(r);
    for (const pin of chip.pins) level(`mcu.${pin}`);
    for (const p of parts) {
      p.i2c?.address();
      sameNet(`${p.id}.${p.pins[0]}`, "mcu.I2C1_SDA");
    }
    return [];
  },
};

/** Throws on every I2C event. */
const broken: Rule = {
  id: "broken",
  check(e) {
    if (e.kind === "i2c") throw new Error(`no ${e.step.kind}`);
    return [];
  },
};

const root = new URL("../../", import.meta.url);

/** Runs build/<elf>.elf on firmware/<circuit>/circuit.json (no circuit: the chip alone) for `seconds`. */
function run(
  elf: string,
  circuit: string | null,
  seconds: number,
  with_: readonly Rule[],
) {
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
  const found = diagnose(engine.events, engine.view(), with_);
  engine.runFor(seconds);
  return { events, snapshot: engine.snapshot(), found: found() };
}

const SCENARIOS: [elf: string, circuit: string | null][] = [
  ["clock-off", null],
  ["tc74-read", "tc74-read"],
  ["faults/gpio-clock", "faults/gpio-clock"],
  ["tc74-read", "faults/no-pullups"],
  ["faults/flash-latency", null], // the clock tree: PLL, SYSCLK switch
];

test("diagnostics are pure observers: the same events and snapshot with and without them", () => {
  for (const [elf, circuit] of SCENARIOS) {
    const without = run(elf, circuit, 0.3, []);
    const with_ = run(elf, circuit, 0.3, [...rules, nosy]);
    assert.ok(without.events.length > 0);
    assert.deepEqual(with_.events, without.events, `${elf} on ${circuit}`);
    assert.deepEqual(with_.snapshot, without.snapshot, `${elf} on ${circuit}`);
    if (elf !== "tc74-read" || circuit !== "tc74-read")
      assert.ok(with_.found.length > 0, `nothing found: ${elf} on ${circuit}`);
  }
});

test("a rule that throws is reported as rule-error, and the run is unchanged", () => {
  const without = run("tc74-read", "tc74-read", 0.3, []);
  const with_ = run("tc74-read", "tc74-read", 0.3, [broken, ...rules]);
  assert.deepEqual(with_.events, without.events);
  assert.deepEqual(with_.snapshot, without.snapshot);
  const errors = with_.found.filter((d) => d.rule === "rule-error");
  // One per distinct error message, counted: one read is START, ADDR, DATA, START, ADDR, DATA, STOP.
  assert.deepEqual(
    errors.map((d) => [d.message, d.count]),
    [
      [
        'the diagnostic rule "broken" failed: no start. The run is unaffected, ' +
          "but that rule's findings may be missing",
        2,
      ],
      [
        'the diagnostic rule "broken" failed: no addr. The run is unaffected, ' +
          "but that rule's findings may be missing",
        2,
      ],
      [
        'the diagnostic rule "broken" failed: no data. The run is unaffected, ' +
          "but that rule's findings may be missing",
        2,
      ],
      [
        'the diagnostic rule "broken" failed: no stop. The run is unaffected, ' +
          "but that rule's findings may be missing",
        1,
      ],
    ],
  );
  assert.equal(errors[0].severity, "info");
});

test("faults/gpio-clock: i2c-pins-not-af6 at the START, after gpio-clock-off", () => {
  const { found } = run("faults/gpio-clock", "faults/gpio-clock", 0.3, rules);
  const ids = new Set(found.map((d) => d.rule));
  assert.deepEqual([...ids], ["gpio-clock-off", "i2c-pins-not-af6"]);
  const d = found.find((d) => d.rule === "i2c-pins-not-af6")!;
  assert.ok(
    d.message.endsWith(
      ": PB6 needs AF6 but is analog (GPIOB_MODER (0x50000400) bits 13:12 MODE6 = 3); " +
        "PB7 needs AF6 but is analog (GPIOB_MODER (0x50000400) bits 15:14 MODE7 = 3)",
    ),
    d.message,
  );
  assert.match(d.at!, /firmware\/faults\/gpio-clock\/main\.c:\d+$/);
});

test("faults/no-pullups: i2c-bus-not-idle names the missing pull-ups", () => {
  const { found } = run("tc74-read", "faults/no-pullups", 0.3, rules);
  assert.deepEqual(
    found.map((d) => d.rule),
    ["i2c-bus-not-idle"],
  );
  assert.match(
    found[0].message,
    /SCL \(PB6\) is floating and SDA \(PB7\) is floating\. .* needs a pull-up resistor/,
  );
});

test("tc74-read: no diagnostics at all", () => {
  assert.deepEqual(run("tc74-read", "tc74-read", 0.6, rules).found, []);
});
