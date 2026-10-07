import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import type { BoardView } from "../engine/engine.ts";
import type { Flag, RegEvent } from "../engine/events.ts";
import { clockSwitchNotReady } from "./clock-switch-not-ready.ts";

// RCC_CR (RM0444 §5.4.1) and PLLCFGR's PLLREN (§5.4.4)
const HSI = 0x500; // HSION, HSIRDY
const PLLON = 1 << 24;
const PLLRDY = 1 << 25;
const PLLREN = 1 << 28;

/** On HSISYS (SWS = 0) with RCC_CR = `cr` and PLLCFGR = `pllcfgr`. */
const board = (cr: number, pllcfgr = PLLREN): BoardView => ({
  chip: stm32g031k8,
  regs: { RCC: { CR: cr, CFGR: 0, PLLCFGR: pllcfgr, CSR: 0, BDCR: 0 } },
  level: () => "floating",
  where: () => "",
  sameNet: () => false,
  parts: [],
});

/** RCC_CFGR = `sw`, from SW = 0. */
const sw = (value: number, flags: Flag[] = []): RegEvent => ({
  kind: "reg",
  cycle: 0,
  pc: 0,
  address: 0x40021008,
  periph: "RCC",
  reg: "CFGR",
  op: "write",
  old: 0,
  value,
  flags,
});

const WROTE = "wrote RCC_CFGR (0x40021008) bits 2:0 SW = ";
const RULE =
  "so SYSCLK stays HSISYS: RCC_CFGR (0x40021008) bits 5:3 SWS follows SW only " +
  "once the new source is ready (RM0444 §5.2.7). ";

test("SW = PLLRCLK before the PLL has locked: SWS waits, wait for PLLRDY", () => {
  assert.deepEqual(clockSwitchNotReady.check(sw(2), board(HSI | PLLON)), [
    {
      severity: "warning",
      message:
        WROTE +
        "2, PLLRCLK, while RCC_CR (0x40021000) bit 25 PLLRDY = 0, " +
        RULE +
        "Turn PLLRCLK on and wait for PLLRDY = 1 before writing SW, then wait for SWS = 2",
      periph: "RCC",
      reg: "CFGR",
    },
  ]);
});

test("SW = HSE: says it never gets ready on this board, and why", () => {
  assert.equal(
    clockSwitchNotReady.check(sw(1), board(HSI))[0].message,
    WROTE +
      "1, HSE, while RCC_CR (0x40021000) bit 17 HSERDY = 0, " +
      RULE +
      "HSE never gets ready on the NUCLEO-G031K8: its only source, the ST-LINK's MCO, " +
      "reaches PC14 through SB7, which is open (UM2591 Table 8). " +
      "Use HSI16, directly or through the PLL",
  );
});

test("a locked PLL without PLLREN isn't ready either (assumed in rcc.ts)", () => {
  assert.equal(
    clockSwitchNotReady.check(sw(2), board(HSI | PLLON | PLLRDY, 0))[0].message,
    WROTE +
      "2, PLLRCLK, while RCC_PLLCFGR (0x4002100c) bit 28 PLLREN = 0, " +
      RULE +
      "Set PLLREN = 1 before writing SW (the simulator switches only once it is set), " +
      "then wait for SWS = 2",
  );
});

test("nothing when the source is ready, already in use or already selected, or flagged", () => {
  const locked = board(HSI | PLLON | PLLRDY);
  assert.deepEqual(clockSwitchNotReady.check(sw(2), locked), []);
  assert.deepEqual(clockSwitchNotReady.check(sw(0), board(HSI | PLLON)), []);
  // SW was already 2 (reported then); this write sets HPRE.
  assert.deepEqual(
    clockSwitchNotReady.check({ ...sw(2 | (8 << 8)), old: 2 }, board(HSI)),
    [],
  );
  assert.deepEqual(
    clockSwitchNotReady.check(sw(2, ["unsimulated"]), board(HSI)),
    [],
  );
});
