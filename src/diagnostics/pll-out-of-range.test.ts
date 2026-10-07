import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { BoardView } from "../engine/engine.ts";
import type { Flag, RegEvent } from "../engine/events.ts";
import { pllOutOfRange } from "./pll-out-of-range.ts";

const PLLON = 1 << 24;
/** RCC_PLLCFGR with PLLSRC = HSI16, PLLREN, and M, N, R as divide and multiply factors. */
const pll = (m: number, n: number, r: number) =>
  ((r - 1) << 29) | (1 << 28) | (n << 8) | ((m - 1) << 4) | 2;

const board = (pllcfgr: number): BoardView => ({
  chip: stm32g031k8,
  regs: { RCC: { CR: 0x500, PLLCFGR: pllcfgr } },
  level: () => "floating",
  where: () => "",
  sameNet: () => false,
  parts: [],
});

/** RCC_CR |= PLLON, from `old`. */
const pllon = (old = 0x500, flags: Flag[] = []): RegEvent => ({
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0x40021000,
  periph: "RCC",
  reg: "CR",
  op: "write",
  old,
  value: old | PLLON,
  flags,
});

const HEAD =
  "set RCC_CR (0x40021000) bit 24 PLLON with RCC_PLLCFGR (0x4002100c) outside " +
  "the PLL's limits (DS12992 Table 43, VCORE Range 1): ";
const FIX =
  "With PLLON = 0, choose M, N and R so that HSI16 / M is 2.66 to 16 MHz, " +
  "the VCO 96 to 344 MHz and PLLRCLK 12 to 64 MHz (RM0444 §5.4.4)";

test("× 16 / 2 is 128 MHz on PLLRCLK: names the value, its limit and the fix", () => {
  assert.deepEqual(pllOutOfRange.check(pllon(), board(pll(1, 16, 2))), [
    {
      severity: "warning",
      message:
        HEAD +
        "PLLRCLK = VCO / R 2 = 128 MHz, must be 12 to 64 MHz. " +
        "The simulator runs the PLL as configured; real silicon isn't specified there. " +
        FIX,
      periph: "RCC",
      reg: "PLLCFGR",
    },
  ]);
});

test("each value out of range is listed: input, VCO", () => {
  const m = (cfg: number) =>
    pllOutOfRange.check(pllon(), board(cfg))[0].message;
  assert.ok(
    m(pll(8, 60, 4)).startsWith(
      HEAD + "input = HSI16 / M 8 = 2 MHz, must be 2.66 to 16 MHz. ",
    ),
  );
  assert.ok(
    m(pll(1, 4, 2)).startsWith(
      HEAD + "VCO = input × N 4 = 64 MHz, must be 96 to 344 MHz. ",
    ),
  );
  assert.ok(
    m(pll(1, 24, 8)).startsWith(
      HEAD + "VCO = input × N 24 = 384 MHz, must be 96 to 344 MHz. ",
    ),
  );
});

test("no input clock: says only HSI16 runs here, and that the PLL never locks", () => {
  const noClock = pll(1, 8, 2) & ~3; // PLLSRC = 00
  assert.equal(
    pllOutOfRange.check(pllon(), board(noClock))[0].message,
    HEAD +
      "input = 0 MHz (PLLSRC = 0; only HSI16 runs on this board), must be 2.66 to 16 MHz; " +
      "VCO = input × N 8 = 0 MHz, must be 96 to 344 MHz; " +
      "PLLRCLK = VCO / R 2 = 0 MHz, must be 12 to 64 MHz. " +
      "The simulator never locks a PLL with no input or N = 0 (assumed), so PLLRDY stays 0. " +
      FIX,
  );
});

test("nothing for pll-64mhz's 16 / 1 × 8 / 2, with PLLON already set, or flagged", () => {
  assert.deepEqual(pllOutOfRange.check(pllon(), board(pll(1, 8, 2))), []);
  const bad = board(pll(1, 16, 2));
  assert.deepEqual(pllOutOfRange.check(pllon(0x500 | PLLON), bad), []);
  assert.deepEqual(pllOutOfRange.check(pllon(0x500, ["clock-off"]), bad), []);
  assert.deepEqual(
    pllOutOfRange.check({ ...pllon(), value: 0x500 | (1 << 9) }, bad), // HSIKERON, not PLLON
    [],
  );
});
