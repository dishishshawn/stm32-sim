import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCircuit } from "./circuit.ts";
import { loadElf } from "./elf.ts";
import { catalog, Engine } from "./engine.ts";
import type { NetEvent, SimEvent } from "./events.ts";

const root = new URL("../../", import.meta.url);
const CLOCK_HZ = 16_000_000;

function blinkElf(): Uint8Array {
  const url = new URL("build/blink.elf", root);
  assert.ok(existsSync(url), "build/blink.elf is missing: run `just fw` first");
  return readFileSync(url);
}

const blinkCircuit = () =>
  parseCircuit(
    readFileSync(new URL("firmware/blink/circuit.json", root), "utf8"),
    catalog,
  );

/** A copy of `elf` with 32-bit words of its flash image replaced, by address. */
function patch(elf: Uint8Array, words: Record<number, number>): Uint8Array {
  const copy = new Uint8Array(elf);
  const flash = loadElf(copy).segments[0]; // its data is a view into `copy`
  const view = new DataView(
    flash.data.buffer,
    flash.data.byteOffset,
    flash.data.byteLength,
  );
  for (const [addr, word] of Object.entries(words))
    view.setUint32(Number(addr) - flash.addr, word, true);
  return copy;
}

/** The engine loaded with `elf` on the blink circuit, and every event from the load on. */
function load(elf: Uint8Array, engine = new Engine()) {
  const events: SimEvent[] = [];
  const off = engine.events.subscribe((e) => events.push(e));
  engine.load(elf, blinkCircuit());
  return { engine, events, off };
}

/** The line in firmware/blink/main.c that starts with `text`, as the snapshot prints it. */
function blinkLine(text: string): string {
  const file = fileURLToPath(new URL("firmware/blink/main.c", root));
  const lines = readFileSync(file, "utf8").split("\n");
  const n = lines.findIndex((l) => l.trimStart().startsWith(text)) + 1;
  assert.ok(n > 0, `no line starting ${text}`);
  return `${file}:${n}`;
}

// The toggle period, from the firmware. Each turn of delay()'s
// `for (volatile uint32_t i = 0; i < loops; i++)` is, at -Og,
// ldr/adds/str (i++) then ldr/cmp/bcc (i < loops): 2+1+2 + 2+1+2 = 10 cycles,
// as a Cortex-M0+ counts them (loads, stores and taken branches take 2) and as
// this core does. A toggle takes DELAY_LOOPS turns plus the ODR read-xor-write,
// the call and the return: 28 cycles with arm-none-eabi-gcc 14.2, so
// 2,000,028 cycles = 125.0 ms at 16 MHz.
const DELAY_LOOPS = 200_000; // firmware/blink/main.c
const CYCLES_PER_TURN = 10;

test("blink: PA0 toggles every DELAY_LOOPS × 10 cycles, plus a few for the loop", () => {
  const { engine, events } = load(blinkElf());
  const pa0 = () =>
    events.filter(
      (e): e is NetEvent => e.kind === "net" && e.endpoint === "mcu.PA0",
    );

  // In the first 100 ms, under one period: MODER makes PA0 an output at ODR's
  // 0 (floating → low), then the first toggle sets it high.
  engine.runFor(0.1);
  assert.deepEqual(
    pa0().map((e) => e.level),
    ["low", "high"],
  );

  engine.runFor(0.9);
  const toggles = pa0().slice(1);
  const period = toggles[1].cycle - toggles[0].cycle;
  toggles.forEach((t, i) => {
    assert.equal(t.level, i % 2 ? "low" : "high");
    if (i) assert.equal(t.cycle - toggles[i - 1].cycle, period);
  });
  const overhead = period - DELAY_LOOPS * CYCLES_PER_TURN;
  assert.ok(overhead > 0 && overhead < 64, `${overhead} cycles of overhead`);

  // 1 s is 16,000,000 cycles; the first toggle comes ~200 cycles after reset,
  // then one per period: 8 in all (the 8th at ~875 ms, the 9th would be at 1.0002 s).
  const { cycles, seconds } = engine.snapshot();
  assert.ok(cycles >= CLOCK_HZ && cycles < CLOCK_HZ + 4);
  assert.equal(seconds, cycles / CLOCK_HZ);
  assert.equal(toggles.length, 8);
  assert.equal(
    toggles.length,
    Math.floor((cycles - toggles[0].cycle) / period) + 1,
  );
});

test("determinism: two runs give identical events and snapshots, the second after a reload", () => {
  const elf = blinkElf();
  const engine = new Engine();
  const runs = [1, 2].map(() => {
    const { events, off } = load(elf, engine);
    engine.runFor(0.5);
    off();
    return { events, snapshot: engine.snapshot() };
  });
  assert.ok(runs[0].events.length > 10);
  assert.deepEqual(runs[1], runs[0]);
});

test("snapshot: the PC as main.c file:line, pins, registers, no halt", () => {
  const { engine } = load(blinkElf());
  engine.runFor(0.3);
  const s = engine.snapshot();
  assert.equal(s.at, blinkLine("for (volatile uint32_t i = 0;"));
  assert.equal(s.halt, null);
  assert.equal(s.pins.PA0, "high"); // 0.3 s is between the 3rd toggle (high) and the 4th
  assert.equal(s.pins.PA1, "floating");
  assert.equal(Object.keys(s.pins).length, 30);
  assert.equal(s.registers.RCC.IOPENR & 1, 1);
  assert.equal(s.registers.GPIOA.MODER & 3, 1);
  assert.equal(s.registers.GPIOA.ODR & 1, 1);
  assert.deepEqual(s.parts, {});
});

test("a BKPT stops the run on the BKPT, and running on stops there again", () => {
  const elf = blinkElf();
  const main = loadElf(elf).symbol("main")!;
  const { engine } = load(patch(elf, { [main]: 0xbe07be07 })); // BKPT #7
  engine.runFor(1);
  const s = engine.snapshot();
  assert.deepEqual(s.halt, { kind: "breakpoint", reason: "BKPT #7" });
  assert.equal(s.pc, main);
  assert.equal(s.at, blinkLine("int main(void) {"));
  engine.runFor(1);
  assert.equal(engine.snapshot().pc, main);
  assert.ok(engine.snapshot().cycles < 1000);
});

test("a lockup halts the run at once and is reported", () => {
  // Reset and HardFault vectors at unmapped memory: fetching the reset handler
  // faults, and fetching the HardFault handler faults again, inside HardFault.
  const elf = patch(blinkElf(), {
    0x0800_0004: 0x3000_0001,
    0x0800_000c: 0x3000_0001,
  });
  const { engine } = load(elf);
  engine.runFor(1);
  const s = engine.snapshot();
  assert.deepEqual(s.halt, {
    kind: "lockup",
    reason: "fault inside HardFault at 0x30000000: bus fault at 0x30000000",
  });
  assert.equal(s.at, "0x30000000");
  assert.ok(s.cycles < 100);
  engine.step(); // stays locked up
  assert.equal(engine.snapshot().cycles, s.cycles);
});

test("WFI with nothing to wake it: time passes, and the run ends on time", () => {
  const elf = blinkElf();
  const main = loadElf(elf).symbol("main")!;
  const { engine } = load(patch(elf, { [main]: 0xbf30bf30 })); // WFI; WFI
  engine.runFor(1);
  const s = engine.snapshot();
  assert.equal(s.cycles, CLOCK_HZ);
  assert.equal(s.pc, main + 2);
  assert.equal(s.halt, null);
});

test("parts tick in simulated time, and the snapshot carries their state()", () => {
  const engine = new Engine();
  const circuit = parseCircuit(
    JSON.stringify({
      chip: "stm32g031k8",
      parts: [{ id: "temp", type: "tc74", props: {} }],
      wires: [],
    }),
    catalog,
  );
  engine.load(blinkElf(), circuit);
  engine.runFor(0.12);
  assert.equal(engine.snapshot().parts.temp.dataReady, false);
  engine.runFor(0.01); // past the TC74's first conversion, 125 ms after power-up
  assert.deepEqual(engine.snapshot().parts, {
    temp: { temperature: 25, shutdown: false, dataReady: true },
  });
});

/** Blink with a TC74, and a button that pulls PA1 to GND while pressed. */
const inputsCircuit = () =>
  parseCircuit(
    JSON.stringify({
      chip: "stm32g031k8",
      parts: [
        { id: "temp", type: "tc74", props: {} },
        { id: "btn", type: "pushbutton", props: {} },
      ],
      wires: [
        ["btn.1.l", "mcu.PA1"],
        ["btn.2.l", "GND"],
      ],
    }),
    catalog,
  );

test("setPropAt: a change lands at its simulated time, mid-run, and the same schedule gives the same events", () => {
  const elf = blinkElf();
  const engine = new Engine();
  const runs = [1, 2].map(() => {
    const events: SimEvent[] = [];
    const off = engine.events.subscribe((e) => events.push(e));
    engine.load(elf, inputsCircuit());
    engine.setPropAt(1, "temp", "temperature", 30);
    engine.setPropAt(1, "btn", "pressed", true);
    engine.setPropAt(1.25, "btn", "pressed", false);
    engine.runFor(0.999);
    assert.equal(engine.snapshot().parts.temp.temperature, 25);
    engine.runFor(0.5); // one call across all three changes
    off();
    assert.equal(engine.snapshot().parts.temp.temperature, 30);
    return { events, snapshot: engine.snapshot() };
  });
  const pa1 = runs[0].events.filter(
    (e): e is NetEvent => e.kind === "net" && e.endpoint === "mcu.PA1",
  );
  // At the first instruction boundary at or past each time (an instruction is a few cycles).
  assert.deepEqual(
    pa1.map((e) => e.level),
    ["low", "floating"],
  );
  assert.ok(pa1[0].cycle >= CLOCK_HZ && pa1[0].cycle < CLOCK_HZ + 8);
  assert.ok(
    pa1[1].cycle >= 1.25 * CLOCK_HZ && pa1[1].cycle < 1.25 * CLOCK_HZ + 8,
  );
  assert.deepEqual(runs[1], runs[0]);
});

test("setPropAt: while the core sleeps (WFI), a change lands on its exact cycle", () => {
  const elf = blinkElf();
  const main = loadElf(elf).symbol("main")!;
  const engine = new Engine();
  const events: SimEvent[] = [];
  engine.events.subscribe((e) => events.push(e));
  engine.load(patch(elf, { [main]: 0xbf30bf30 }), inputsCircuit()); // WFI; WFI
  engine.setPropAt(0.0105, "btn", "pressed", true); // between two 1 ms part ticks
  engine.runFor(0.02);
  const press = events.find(
    (e): e is NetEvent => e.kind === "net" && e.endpoint === "mcu.PA1",
  );
  assert.equal(press?.cycle, 0.0105 * CLOCK_HZ);
});

test("setPropAt: an unknown part or prop, or a bad value, throws naming what is valid", () => {
  const engine = new Engine();
  engine.load(blinkElf(), inputsCircuit());
  assert.throws(
    () => engine.setPropAt(1, "nope", "temperature", 30),
    /^Error: unknown part "nope" \(parts: temp, btn\)$/,
  );
  assert.throws(
    () => engine.setPropAt(1, "temp", "temp", 30),
    /^Error: tc74 "temp" has no prop "temp" \(props: variant, temperature\)$/,
  );
  assert.throws(
    () => engine.setPropAt(1, "temp", "temperature", 200),
    /^Error: temp\.temperature: expected -65 to 150, got 200$/,
  );
});

test("step() executes one instruction", () => {
  const elf = blinkElf();
  const { engine } = load(elf);
  const reset = loadElf(elf).symbol("Reset_Handler")!;
  assert.equal(engine.snapshot().pc, reset);
  assert.equal(engine.snapshot().cycles, 0);
  engine.step(); // ldr r0, =_estack
  assert.equal(engine.snapshot().pc, reset + 2);
  assert.equal(engine.snapshot().cycles, 2);
});
