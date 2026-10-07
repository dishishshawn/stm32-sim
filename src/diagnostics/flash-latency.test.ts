import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { Engine } from "../engine/engine.ts";
import type { BoardView } from "../engine/engine.ts";
import type { Flag, RegEvent, SimEvent } from "../engine/events.ts";
import { flashLatency } from "./flash-latency.ts";
import { rules } from "./index.ts";
import { diagnose } from "./rule.ts";
import type { Rule } from "./rule.ts";

/** PLLCFGR for HSI16 / 1 × 8 / 2 = 64 MHz with PLLREN, as pll-64mhz sets it. */
const PLL_64 = (1 << 29) | (1 << 28) | (8 << 8) | 2;
/** RCC_CFGR with SW and SWS = PLLRCLK. */
const ON_PLL = (2 << 3) | 2;

/** A board with the PLL locked at 64 MHz, `cfgr` and LATENCY = `ws`. */
const board = (cfgr: number, ws: number, pllcfgr = PLL_64): BoardView => ({
  chip: stm32g031k8,
  regs: {
    RCC: { CR: 0x03000500, CFGR: cfgr, PLLCFGR: pllcfgr },
    FLASH: { ACR: 0x600 | ws },
  },
  level: () => "floating",
  where: () => "",
  sameNet: () => false,
  parts: [],
});

const write = (
  periph: string,
  reg: string,
  value: number,
  flags: Flag[] = [],
): RegEvent => ({
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0,
  periph,
  reg,
  op: "write",
  old: 0,
  value,
  flags,
});

const TAIL =
  ": HCLK above 24 MHz needs LATENCY = 1, above 48 MHz LATENCY = 2 " +
  "(RM0444 §3.3.4, Table 13, VCORE Range 1). Real silicon then reads wrong " +
  "instructions from flash; the simulator doesn't model wait states, so it runs on. " +
  "Set LATENCY = 2 and wait until it reads back before raising the clock, " +
  "and lower it only after lowering the clock (RM0444 §3.3.4)";

test("SW = PLLRCLK at 64 MHz with LATENCY = 0: names both, the table and the fix", () => {
  assert.deepEqual(flashLatency.check(write("RCC", "CFGR", 2), board(0, 0)), [
    {
      severity: "warning",
      message:
        "wrote RCC_CFGR (0x40021008) selecting HCLK = 64 MHz while " +
        "FLASH_ACR (0x40022000) bits 2:0 LATENCY = 0" +
        TAIL,
      periph: "RCC",
      reg: "CFGR",
    },
  ]);
});

test("LATENCY lowered to 0 while HCLK is 64 MHz", () => {
  assert.deepEqual(
    flashLatency.check(write("FLASH", "ACR", 0x600), board(ON_PLL, 2)),
    [
      {
        severity: "warning",
        message:
          "wrote FLASH_ACR (0x40022000) bits 2:0 LATENCY = 0 while HCLK = 64 MHz" +
          TAIL,
        periph: "FLASH",
        reg: "ACR",
      },
    ],
  );
});

test("Table 13's limits: 48 MHz needs 1, 64 MHz 2", () => {
  const pll48 = (1 << 29) | (1 << 28) | (6 << 8) | 2; // 16 × 6 / 2
  const sw = write("RCC", "CFGR", 2);
  assert.equal(flashLatency.check(sw, board(0, 1, pll48)).length, 0);
  assert.match(
    flashLatency.check(sw, board(0, 0, pll48))[0].message,
    /HCLK = 48 MHz .* LATENCY = 0: .* Set LATENCY = 1 /,
  );
  assert.equal(flashLatency.check(sw, board(0, 1)).length, 1);
  assert.equal(flashLatency.check(sw, board(0, 2)).length, 0);
});

test("nothing at 16 MHz, when the clock doesn't change, on a read, or flagged", () => {
  // Back to HSISYS, then LATENCY lowered: RM0444's order for slowing down.
  assert.deepEqual(
    flashLatency.check(write("RCC", "CFGR", 0), board(ON_PLL, 2)),
    [],
  );
  assert.deepEqual(
    flashLatency.check(write("FLASH", "ACR", 0), board(0, 2)),
    [],
  );
  // Already at 64 MHz with LATENCY = 0 (reported at the switch): PPRE changes nothing.
  assert.deepEqual(
    flashLatency.check(
      write("RCC", "CFGR", ON_PLL | (4 << 12)),
      board(ON_PLL, 0),
    ),
    [],
  );
  assert.deepEqual(
    flashLatency.check({ ...write("RCC", "CFGR", 2), op: "read" }, board(0, 0)),
    [],
  );
  assert.deepEqual(
    flashLatency.check(write("RCC", "CFGR", 2, ["unsimulated"]), board(0, 0)),
    [],
  );
});

const root = new URL("../../", import.meta.url);

/** Runs build/<elf>.elf on the chip alone for `seconds` with `with_`. */
function run(elf: string, with_: readonly Rule[], seconds = 0.3) {
  const url = new URL(`build/${elf}.elf`, root);
  assert.ok(existsSync(url), `build/${elf}.elf is missing: run \`just fw\``);
  const engine = new Engine();
  const events: SimEvent[] = [];
  engine.events.subscribe((e) => events.push(e));
  engine.load(readFileSync(url), { chip: "stm32g031k8", parts: [], wires: [] });
  const found = diagnose(engine.events, engine.view(), with_);
  engine.runFor(seconds);
  return { events, snapshot: engine.snapshot(), found: found() };
}

test("faults/flash-latency: only flash-latency, once, at the SW write; the run is unchanged", () => {
  const without = run("faults/flash-latency", []);
  const with_ = run("faults/flash-latency", rules);
  assert.deepEqual(with_.events, without.events);
  assert.deepEqual(with_.snapshot, without.snapshot);
  const file = "firmware/faults/flash-latency/main.c";
  const lines = readFileSync(new URL(file, root), "utf8").split("\n");
  const n = lines.findIndex((l) => l.startsWith("  RCC_CFGR = ")) + 1;
  assert.deepEqual(
    with_.found.map((d) => [d.rule, d.count, d.at]),
    [["flash-latency", 1, `${fileURLToPath(new URL(file, root))}:${n}`]],
  );
});

test("pll-64mhz, which sets LATENCY = 2 first: no diagnostics, past its switch at about 0.5 s", () => {
  const { found, snapshot } = run("pll-64mhz", rules, 0.7);
  assert.equal((snapshot.registers.RCC.CFGR >>> 3) & 7, 2, "SWS = PLLRCLK");
  assert.deepEqual(found, []);
});
