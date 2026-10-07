import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { BoardView } from "../engine/engine.ts";
import type { Flag, RegEvent } from "../engine/events.ts";
import { pllConfigWhileOn } from "./pll-config-while-on.ts";

const PLLON = 1 << 24;
const PLLREN = 1 << 28;
/** HSI16 / 1 × 8 / 2 = 64 MHz, with PLLREN. */
const PLL_64 = (1 << 29) | PLLREN | (8 << 8) | 2;

/** RCC_CR = `cr`, SYSCLK = `sws`. */
const board = (cr: number, sws = 0): BoardView => ({
  chip: stm32g031k8,
  regs: { RCC: { CR: cr, CFGR: (sws << 3) | sws, PLLCFGR: PLL_64 } },
  level: () => "floating",
  where: () => "",
  sameNet: () => false,
  parts: [],
});

/** RCC_PLLCFGR = `value`, over pll-64mhz's configuration. */
const write = (value: number, flags: Flag[] = []): RegEvent => ({
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0x4002100c,
  periph: "RCC",
  reg: "PLLCFGR",
  op: "write",
  old: PLL_64,
  value,
  flags,
});

const message = (fields: string) =>
  "wrote RCC_PLLCFGR (0x4002100c) while RCC_CR (0x40021000) bit 24 PLLON = 1, " +
  `so the change to ${fields} was ignored and the PLL keeps its old settings: ` +
  "PLLSRC, PLLM, PLLN, PLLP, PLLQ and PLLR can be written only when the PLL is disabled, " +
  "and PLLREN not while PLLRCLK is SYSCLK (RM0444 §5.4.4). Write RCC_PLLCFGR before " +
  "setting PLLON, or clear PLLON and wait for RCC_CR (0x40021000) bit 25 PLLRDY = 0 " +
  "first (RM0444 §5.2.4)";

test("N and R changed while PLLON = 1: names what was ignored, and the fix", () => {
  const n16r4 = (3 << 29) | PLLREN | (16 << 8) | 2;
  assert.deepEqual(pllConfigWhileOn.check(write(n16r4), board(PLLON)), [
    {
      severity: "warning",
      message: message("PLLN, PLLR"),
      periph: "RCC",
      reg: "PLLCFGR",
    },
  ]);
});

test("clearing PLLREN while PLLRCLK is SYSCLK is ignored too", () => {
  assert.equal(
    pllConfigWhileOn.check(write(PLL_64 & ~PLLREN), board(PLLON, 2))[0].message,
    message("PLLREN"),
  );
});

test("nothing with the PLL off, for the output enables alone, or flagged", () => {
  const n16 = (PLL_64 & ~(0x7f << 8)) | (16 << 8);
  assert.deepEqual(pllConfigWhileOn.check(write(n16), board(0x500)), []);
  // PLLPEN, PLLQEN and PLLREN may change while the PLL runs (RM0444 §5.2.4).
  assert.deepEqual(
    pllConfigWhileOn.check(write(PLL_64 | (1 << 16)), board(PLLON)),
    [],
  );
  assert.deepEqual(
    pllConfigWhileOn.check(write(PLL_64 & ~PLLREN), board(PLLON)),
    [],
  );
  assert.deepEqual(
    pllConfigWhileOn.check(write(n16, ["unsimulated"]), board(PLLON)),
    [],
  );
});
