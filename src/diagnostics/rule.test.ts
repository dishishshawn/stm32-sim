import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Engine } from "../engine/engine.ts";
import type { SimEvent } from "../engine/events.ts";
import { rules } from "./index.ts";
import { diagnose } from "./rule.ts";
import type { Rule } from "./rule.ts";

/** Reads every register and every pin's level on every event, to show the views have no side effects. */
const nosy: Rule = {
  id: "nosy",
  check(_, { chip, regs, level }) {
    for (const r of Object.values(regs)) Object.values(r);
    for (const pin of chip.pins) level(`mcu.${pin}`);
    return [];
  },
};

test("diagnostics are pure observers: the same events and snapshot with and without them", () => {
  const url = new URL("../../build/clock-off.elf", import.meta.url);
  assert.ok(existsSync(url), "build/clock-off.elf is missing: run `just fw`");
  const elf = readFileSync(url);
  const run = (withRules: boolean) => {
    const engine = new Engine();
    const events: SimEvent[] = [];
    engine.events.subscribe((e) => events.push(e));
    engine.load(elf, { chip: "stm32g031k8", parts: [], wires: [] });
    const found = withRules
      ? diagnose(engine.events, engine.view(), [...rules, nosy])
      : () => [];
    engine.runFor(0.3);
    return { events, snapshot: engine.snapshot(), found: found() };
  };
  const without = run(false);
  const with_ = run(true);
  assert.ok(with_.found.length > 0, "the rules found nothing to report");
  assert.ok(without.events.length > 0);
  assert.deepEqual(with_.events, without.events);
  assert.deepEqual(with_.snapshot, without.snapshot);
});
