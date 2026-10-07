// End to end, acceptance test 2 of the brief: build/thermometer.elf on
// firmware/thermometer/circuit.json. The TC74A0's slider is at 22 °C; the
// firmware reads it every 250 ms and shows it on the "tens" and "units"
// digits through the MCP23017; the button "btn" toggles °C/°F.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCircuit } from "../../src/engine/circuit.ts";
import { catalog, Engine } from "../../src/engine/engine.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ELF = "build/thermometer.elf";
const CIRCUIT = "firmware/thermometer/circuit.json";

function elf(): Uint8Array {
  const path = join(root, ELF);
  assert.ok(existsSync(path), `${ELF} is missing: run \`just fw\` first`);
  return readFileSync(path);
}

/** The usual 7-segment font, by lit segments: bit 0 is A ... bit 6 G, bit 7 DP. */
const FONT: Record<number, string> = {
  0x00: " ",
  0x40: "-",
  0x3f: "0",
  0x06: "1",
  0x5b: "2",
  0x4f: "3",
  0x66: "4",
  0x6d: "5",
  0x7d: "6",
  0x07: "7",
  0x7f: "8",
  0x6f: "9",
};

/** A digit's character, from its state().values (A–G, DP); "?" and the bits if no character matches. */
function char(state: Readonly<Record<string, unknown>>): string {
  const bits = (state.values as number[]).reduce((b, v, i) => b | (v << i), 0);
  return FONT[bits] ?? `?${bits.toString(16)}`;
}

/** What the two digits show. */
const shown = (parts: Record<string, Readonly<Record<string, unknown>>>) =>
  char(parts.tens) + char(parts.units);

/** The firmware on the circuit, reset, with the slider at `celsius`. */
function boot(celsius = 22): Engine {
  const circuit = parseCircuit(
    readFileSync(join(root, CIRCUIT), "utf8"),
    catalog,
  );
  circuit.parts.find((p) => p.id === "temp")!.props.temperature = celsius;
  const engine = new Engine();
  engine.load(elf(), circuit);
  return engine;
}

/** A press at `seconds` since reset, released 50 ms later, as the CLI's `--at <t>:btn.press`. */
function press(engine: Engine, seconds: number) {
  engine.setPropAt(seconds, "btn", "pressed", true);
  engine.setPropAt(seconds + 0.05, "btn", "pressed", false);
}

/** Runs until simulated time `seconds` since reset; returns what the digits show then. */
function at(engine: Engine, seconds: number): string {
  engine.runFor(seconds - engine.snapshot().seconds);
  return shown(engine.snapshot().parts);
}

test("22 °C shows 22; a press shows 71 (71.6 °F, truncated); a second press shows 22", () => {
  const engine = boot();
  assert.equal(at(engine, 0.2), "  ", "dark before the first read at 250 ms");
  assert.equal(at(engine, 1), "22");
  press(engine, 1);
  assert.equal(at(engine, 1.1), "71");
  assert.equal(at(engine, 2), "71", "the release doesn't toggle");
  press(engine, 2);
  assert.equal(at(engine, 2.1), "22");
  assert.equal(at(engine, 3), "22");
});

test("°F truncates the whole C*9/5+32; outside 0..99 shows --", () => {
  const engine = boot(-1);
  assert.equal(at(engine, 0.5), "--", "-1 °C");
  press(engine, 0.5);
  assert.equal(at(engine, 0.6), "30", "-1 °C = 30.2 °F");
  engine.setPropAt(0.6, "temp", "temperature", 40);
  assert.equal(at(engine, 1.2), "--", "40 °C = 104 °F");
  press(engine, 1.2);
  assert.equal(at(engine, 1.3), "40");
  engine.setPropAt(1.3, "temp", "temperature", 7);
  assert.equal(at(engine, 1.9), " 7", "no leading zero");
});

test("sim inspect --at 1s:btn.press --at 1.5s shows 71", () => {
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
      "1s:btn.press",
      "--at",
      "1.5s",
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "completed");
  assert.deepEqual(out.diagnostics, []);
  assert.equal(shown(out.parts), "71");
});
