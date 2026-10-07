// clock-switch-not-ready: RCC_CFGR.SW set to a clock that isn't ready. RM0444
// §5.2.7: the switch happens only once it is, and SWS shows when; until then
// SYSCLK stays where it was, as rcc.ts does (docs/decisions.md §14). HSE never
// gets ready on the NUCLEO-G031K8, so a switch to it never happens.
import { SYSCLK_SOURCES } from "../peripherals/rcc.ts";
import { fieldName } from "./names.ts";
import type { Rule } from "./rule.ts";

/** Each SW value's ready flag (RM0444 §5.4.1, §5.4.24, §5.4.23). 101 to 111 are reserved. */
const READY: readonly [reg: string, field: string][] = [
  ["CR", "HSIRDY"],
  ["CR", "HSERDY"],
  ["CR", "PLLRDY"],
  ["CSR", "LSIRDY"],
  ["BDCR", "LSERDY"],
];
const PLLRCLK = 2;

export const clockSwitchNotReady: Rule = {
  id: "clock-switch-not-ready",
  check(e, { chip, regs }) {
    if (
      e.kind !== "reg" ||
      e.op !== "write" ||
      e.periph !== "RCC" ||
      e.reg !== "CFGR" ||
      e.flags.length > 0
    ) {
      return [];
    }
    const rcc = regs.RCC;
    const sw = e.value & 7;
    const sws = (rcc.CFGR >>> 3) & 7;
    // Already there, already asked for (reported then), or reserved.
    if (sw === sws || sw === (e.old & 7) || sw >= READY.length) return [];
    const map = chip.registers.peripherals.RCC.registers;
    const bit = (reg: string, f: string) =>
      (rcc[reg] >>> map[reg].fields[f].bitOffset) & 1;
    // Assumed (rcc.ts): a locked PLL is ready only with PLLREN set too.
    const [reg, flag] =
      sw === PLLRCLK && bit("CR", "PLLRDY") ? ["PLLCFGR", "PLLREN"] : READY[sw];
    if (bit(reg, flag)) return [];
    const name = SYSCLK_SOURCES[sw];
    const fix =
      name === "HSE"
        ? "HSE never gets ready on the NUCLEO-G031K8: its only source, the ST-LINK's MCO, " +
          "reaches PC14 through SB7, which is open (UM2591 Table 8). " +
          "Use HSI16, directly or through the PLL"
        : flag === "PLLREN"
          ? "Set PLLREN = 1 before writing SW (the simulator switches only once it is set), " +
            `then wait for SWS = ${sw}`
          : `Turn ${name} on and wait for ${flag} = 1 before writing SW, then wait for SWS = ${sw}`;
    return [
      {
        severity: "warning",
        message:
          `wrote ${fieldName(chip, "RCC", "CFGR", "SW")} = ${sw}, ${name}, while ` +
          `${fieldName(chip, "RCC", reg, flag)} = 0, so SYSCLK stays ${SYSCLK_SOURCES[sws]}: ` +
          `${fieldName(chip, "RCC", "CFGR", "SWS")} follows SW only once the new source ` +
          `is ready (RM0444 §5.2.7). ${fix}`,
        periph: "RCC",
        reg: "CFGR",
      },
    ];
  },
};
