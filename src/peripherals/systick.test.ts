import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { parseCircuit } from "../engine/circuit.ts";
import { catalog, Engine } from "../engine/engine.ts";
import { EventLog } from "../engine/events.ts";
import type { NetEvent } from "../engine/events.ts";
import { MemoryBus } from "../engine/memory-bus.ts";
import { Nets } from "../engine/nets.ts";

const [CTRL, LOAD, VAL, CALIB] = [
  0xe000e010, 0xe000e014, 0xe000e018, 0xe000e01c,
];
const [ENABLE, TICKINT, CLKSOURCE, COUNTFLAG] = [1, 2, 4, 1 << 16];
const CLOCK_HZ = 16_000_000;

/** The G031K8's bus, and every exception SysTick pends. */
function setup() {
  const pended: number[] = [];
  const bus = new MemoryBus(stm32g031k8, {
    events: new EventLog(),
    now: () => ({ cycle: 0, pc: 0 }),
    nets: new Nets(),
    cpu: {
      setPending: (n) => pended.push(n),
      clearPending() {},
      isPending: () => false,
      setPriority() {},
    },
  });
  return { bus, pended };
}

/** SysTick started the way firmware starts it: LOAD, clear VAL, then CTRL. */
function start(load: number, ctrl = ENABLE | CLKSOURCE) {
  const { bus, pended } = setup();
  bus.writeUint32(LOAD, load);
  bus.writeUint32(VAL, 0);
  bus.writeUint32(CTRL, ctrl);
  return { bus, pended };
}

test("COUNTFLAG sets when the count reaches 0, and reading CTRL clears it", () => {
  const { bus } = start(3);
  bus.tick(1); // 0 → reload 3
  assert.equal(bus.readUint32(VAL), 3);
  bus.tick(2);
  assert.equal(bus.readUint32(VAL), 1);
  assert.equal(bus.readUint32(CTRL), ENABLE | CLKSOURCE);
  bus.tick(1); // 1 → 0
  assert.equal(bus.readUint32(VAL), 0);
  assert.equal(bus.readUint32(CTRL), COUNTFLAG | ENABLE | CLKSOURCE);
  assert.equal(bus.readUint32(CTRL), ENABLE | CLKSOURCE);
  bus.writeUint32(CTRL, ENABLE | CLKSOURCE | COUNTFLAG); // read-only
  assert.equal(bus.readUint32(CTRL), ENABLE | CLKSOURCE);
});

test("a write to VAL clears it and COUNTFLAG, whatever the value", () => {
  const { bus } = start(99);
  bus.tick(150); // past 0 once, now at 50
  assert.equal(bus.readUint32(VAL), 50);
  bus.writeUint8(VAL, 0x77);
  assert.equal(bus.readUint32(VAL), 0);
  assert.equal(bus.readUint32(CTRL) & COUNTFLAG, 0);
});

test("reload: one round is LOAD + 1 clocks, however the cycles are sliced", () => {
  const a = start(99);
  const b = start(99);
  let flags = 0;
  for (let i = 0; i < 1000; i++) {
    a.bus.tick(1);
    if (a.bus.readUint32(CTRL) & COUNTFLAG) flags++;
  }
  assert.equal(flags, 10);
  for (const n of [7, 93, 250, 1, 649]) b.bus.tick(n); // 1000 in all
  assert.equal(b.bus.readUint32(VAL), a.bus.readUint32(VAL));
  assert.equal(b.bus.readUint32(CTRL) & COUNTFLAG, COUNTFLAG);
  b.bus.writeUint32(LOAD, 0xffffffff);
  assert.equal(b.bus.readUint32(LOAD), 0xffffff); // 24 bits
});

test("LOAD = 0 stops the counter at its next 0", () => {
  const idle = start(0);
  idle.bus.tick(1000);
  assert.equal(idle.bus.readUint32(VAL), 0);
  assert.equal(idle.bus.readUint32(CTRL) & COUNTFLAG, 0);

  const { bus } = start(99);
  bus.tick(51); // at 49
  bus.writeUint32(LOAD, 0);
  bus.tick(1000);
  assert.equal(bus.readUint32(VAL), 0);
  assert.equal(bus.readUint32(CTRL) & COUNTFLAG, COUNTFLAG); // it did reach 0 once
  bus.tick(1000);
  assert.equal(bus.readUint32(CTRL) & COUNTFLAG, 0);
});

test("CLKSOURCE = 0 counts HCLK/8: 8× slower", () => {
  const { bus } = start(99, ENABLE);
  bus.tick(8 * 100 - 1);
  assert.equal(bus.readUint32(CTRL) & COUNTFLAG, 0);
  bus.tick(1);
  assert.equal(bus.readUint32(CTRL) & COUNTFLAG, COUNTFLAG);
});

test("TICKINT pends the SysTick exception (15) at each 0; without it nothing pends", () => {
  const on = start(99, ENABLE | CLKSOURCE | TICKINT);
  on.bus.tick(100);
  on.bus.tick(100);
  assert.deepEqual(on.pended, [15, 15]);
  const off = start(99);
  off.bus.tick(1000);
  assert.deepEqual(off.pended, []);
});

test("disabled, it doesn't count; CALIB reads RM0444's 1000 and ignores writes", () => {
  const { bus } = start(99, CLKSOURCE);
  bus.tick(1000);
  assert.equal(bus.readUint32(VAL), 0);
  assert.equal(bus.readUint32(CALIB), 1000);
  bus.writeUint32(CALIB, 0);
  assert.equal(bus.readUint32(CALIB), 1000);
});

// End to end: both firmware variants on the blink circuit (mcu only).

const root = new URL("../../", import.meta.url);

function elf(name: string): Uint8Array {
  const url = new URL(`build/${name}.elf`, root);
  assert.ok(
    existsSync(url),
    `build/${name}.elf is missing: run \`just fw\` first`,
  );
  return readFileSync(url);
}

/** An engine running `name`, and the cycle of every PA0 change. */
function run(name: string) {
  const engine = new Engine();
  const pa0: NetEvent[] = [];
  engine.events.subscribe((e) => {
    if (e.kind === "net" && e.endpoint === "mcu.PA0") pa0.push(e);
  });
  const circuit = readFileSync(
    new URL("firmware/blink/circuit.json", root),
    "utf8",
  );
  engine.load(elf(name), parseCircuit(circuit, catalog));
  return { engine, pa0 };
}

for (const name of ["blink-systick-poll", "blink-systick-irq"]) {
  test(`${name}: PA0 toggles every 500 ms ± 1 ms of simulated time`, (t) => {
    const { engine, pa0 } = run(name);
    engine.runFor(2.1);
    // MODER makes PA0 an output at ODR's 0 (floating → low), then the toggles.
    assert.equal(pa0[0].level, "low");
    const toggles = pa0.slice(1);
    assert.deepEqual(
      toggles.map((e) => e.level),
      ["high", "low", "high", "low"],
    );
    // From reset (cycle 0), then from toggle to toggle.
    const periods = toggles.map(
      (e, i) => e.cycle - (i ? toggles[i - 1].cycle : 0),
    );
    t.diagnostic(`periods in cycles: ${periods.join(", ")}`);
    for (const p of periods)
      assert.ok(Math.abs(p - CLOCK_HZ / 2) <= CLOCK_HZ / 1000, `${p} cycles`);
  });
}

test("realtime: 0.5 s of simulated time takes 0.5 s ± 10% of wall time", async (t) => {
  const { engine } = run("blink-systick-irq");
  const t0 = performance.now();
  await engine.runRealtime(0.5);
  const wall = performance.now() - t0;
  t.diagnostic(`0.5 s simulated took ${wall.toFixed(1)} ms`);
  assert.ok(Math.abs(wall - 500) <= 50, `${wall} ms`);
  const { cycles } = engine.snapshot();
  assert.ok(cycles >= CLOCK_HZ / 2 && cycles < CLOCK_HZ / 2 + 4);
});
