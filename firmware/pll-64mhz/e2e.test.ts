// End to end: build/pll-64mhz.elf on src/cli/fixtures/inputs.json (a button on
// PA1). The firmware blinks PA5 twice at 16 MHz, brings SYSCLK to 64 MHz through
// the PLL at about 0.5 s, starts SysTick at 1 ms rounds, and blinks on with the
// same delay loop. Simulated time must follow the clock (docs/decisions.md §14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stm32g031k8 } from "../../src/chips/stm32g031k8.ts";
import { parseCircuit } from "../../src/engine/circuit.ts";
import { loadElf } from "../../src/engine/elf.ts";
import { catalog, Engine } from "../../src/engine/engine.ts";
import type { NetEvent, SimEvent } from "../../src/engine/events.ts";
import { parts } from "../../src/parts/index.ts";
import type { Part } from "../../src/parts/part.ts";
import { clocks } from "../../src/peripherals/rcc.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ELF = "build/pll-64mhz.elf";

function elf(): Uint8Array {
  const path = join(root, ELF);
  assert.ok(existsSync(path), `${ELF} is missing: run \`just fw\` first`);
  return readFileSync(path);
}

/** A loaded engine, every event from the load on, and a reader of `ms_ticks`. */
function load() {
  const bytes = elf();
  const engine = new Engine();
  const events: SimEvent[] = [];
  engine.events.subscribe((e) => events.push(e));
  const circuit = readFileSync(
    join(root, "src/cli/fixtures/inputs.json"),
    "utf8",
  );
  engine.load(bytes, parseCircuit(circuit, catalog));
  const at = loadElf(bytes).symbol("ms_ticks");
  assert.ok(at !== undefined, "no ms_ticks symbol");
  const msTicks = () =>
    new DataView(engine.readSram(at, 4).buffer).getUint32(0, true);
  const net = (endpoint: string) =>
    events.filter(
      (e): e is NetEvent => e.kind === "net" && e.endpoint === endpoint,
    );
  return { engine, events, msTicks, net };
}

test("every #define is at its register's address in the register map", () => {
  const source = readFileSync(join(root, "firmware/pll-64mhz/main.c"), "utf8");
  const defines = [
    ...source.matchAll(
      /^#define (\w+?)_(\w+) \(\*\(volatile uint32_t \*\)0x([0-9A-F]+)U\)/gm,
    ),
  ];
  assert.equal(defines.length, 10);
  for (const [, periph, reg, address] of defines) {
    const p = stm32g031k8.registers.peripherals[periph];
    const want =
      parseInt(p.baseAddress, 16) + parseInt(p.registers[reg].offset, 16);
    assert.equal(parseInt(address, 16), want, `${periph}_${reg}`);
  }
});

test("SYSCLK reaches 64 MHz from the PLL, and time runs at it", () => {
  const { engine } = load();
  engine.runFor(0.6);
  const s = engine.snapshot();
  assert.equal((s.registers.RCC.CFGR >>> 3) & 7, 2, "SWS = PLLRCLK");
  assert.deepEqual(clocks(s.registers.RCC), {
    sysclk: 64e6,
    hclk: 64e6,
    pclk: 64e6,
  });
  assert.equal(s.registers.FLASH.ACR & 7, 2, "LATENCY");
  // 0.6 s: about 0.5 s at 16 MHz, then 0.1 s at 64 MHz.
  assert.ok(s.seconds >= 0.6 && s.seconds < 0.6 + 1e-7, `${s.seconds} s`);
  assert.ok(s.cycles > 0.5 * 16e6 + 0.09 * 64e6, `${s.cycles} cycles`);
  engine.runFor(0.1);
  const t = engine.snapshot();
  assert.ok(
    Math.abs(t.cycles - s.cycles - 0.1 * 64e6) < 8,
    "0.1 s is 6.4M cycles",
  );
  assert.ok(Math.abs(t.seconds - s.seconds - 0.1) < 1e-7);
});

test("the blink period at 64 MHz is a quarter of the same loop's at 16 MHz", (t) => {
  const { engine, net } = load();
  engine.runFor(0.7);
  // MODER makes PA5 an output at ODR's 0 (floating → low), then the toggles:
  // four at 16 MHz, then the clock switch, then the same loop at 64 MHz.
  const toggles = net("mcu.PA5").slice(1);
  const times = toggles.map((e) => engine.secondsAt(e.cycle));
  const period = (i: number) => times[i + 1] - times[i];
  const slow = [0, 1, 2].map(period);
  const fast = [4, 5, 6].map(period);
  t.diagnostic(`periods (s): ${slow.join(", ")}; then ${fast.join(", ")}`);
  for (const p of slow)
    assert.ok(Math.abs(p - 0.125) < 0.001, `${p} s at 16 MHz`);
  for (const p of fast) {
    // The SysTick interrupt steals a few cycles per ms at 64 MHz: < 0.1 %.
    assert.ok(Math.abs(p / slow[0] - 0.25) < 0.25 * 0.001, `${p} s at 64 MHz`);
  }
});

test("SysTick at LOAD = 64000 − 1 interrupts every 1 ms of simulated time", () => {
  const { engine, msTicks } = load();
  engine.runFor(0.6);
  const before = msTicks();
  assert.ok(before > 50, `${before} ms counted by 0.6 s`);
  engine.runFor(0.25);
  assert.equal(msTicks() - before, 250);
});

test("setPropAt and real-time mode keep to simulated seconds across the switch", async () => {
  const { engine, net } = load();
  engine.setPropAt(0.6, "btn", "pressed", true); // scheduled at 16 MHz, lands at 64
  engine.runFor(0.65);
  const [press] = net("mcu.PA1").filter((e) => e.level === "low");
  const at = engine.secondsAt(press.cycle);
  assert.ok(at >= 0.6 && at < 0.6 + 1e-7, `pressed at ${at} s`);

  const s = engine.snapshot();
  const t0 = performance.now();
  await engine.runRealtime(0.05);
  const wall = performance.now() - t0;
  const t = engine.snapshot();
  assert.ok(Math.abs(t.seconds - s.seconds - 0.05) < 1e-7, `${t.seconds} s`);
  assert.ok(Math.abs(t.cycles - s.cycles - 0.05 * 64e6) < 8);
  assert.ok(wall >= 0.95 * 50, `ran ahead of real time: ${wall} ms`);
});

test("part ticks come every 1 ms of simulated time, at either clock", () => {
  let ticks = 0;
  // A test-only part type that counts its ticks. node --test runs each file in
  // its own process, so registering it here touches no other test.
  (parts as Part[]).push({
    type: "tick-counter",
    pins: [],
    props: {},
    create: () => ({ tick: () => void ticks++ }),
  });
  const engine = new Engine();
  engine.load(elf(), {
    chip: "stm32g031k8",
    parts: [{ id: "counter", type: "tick-counter", props: {} }],
    wires: [],
  });
  engine.runFor(0.6); // 0.5 s at 16 MHz, 0.1 s at 64 MHz
  assert.equal(ticks, 600);
});

test("determinism: two runs give identical events and snapshots", () => {
  const runs = [1, 2].map(() => {
    const { engine, events } = load();
    engine.runFor(0.6);
    return { events, snapshot: engine.snapshot() };
  });
  assert.ok(runs[0].events.length > 10);
  assert.deepEqual(runs[1], runs[0]);
});
