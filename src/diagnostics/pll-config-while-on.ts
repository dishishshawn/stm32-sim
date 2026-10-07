// pll-config-while-on: a write to RCC_PLLCFGR that changes the PLL's source or
// dividers while PLLON = 1. RM0444 §5.4.4: they "can be written only when the
// PLL is disabled", and PLLREN can't change while PLLRCLK is SYSCLK. The
// simulator keeps the old values of those fields, silently, and takes the rest
// of the write (rcc.ts, docs/decisions.md §14). Changing only PLLPEN, PLLQEN or
// PLLREN while the PLL runs is allowed (§5.2.4), so it isn't reported.
import { fieldName, regName } from "./names.ts";
import type { Rule } from "./rule.ts";

/** The fields RCC_PLLCFGR keeps while the PLL is on (§5.4.4). */
const LOCKED = ["PLLSRC", "PLLM", "PLLN", "PLLP", "PLLQ", "PLLR"];
/** RCC_CR PLLON (§5.4.1); SWS = PLLRCLK (§5.4.3). */
const PLLON = 1 << 24;
const PLLRCLK = 2;

export const pllConfigWhileOn: Rule = {
  id: "pll-config-while-on",
  check(e, { chip, regs }) {
    if (
      e.kind !== "reg" ||
      e.op !== "write" ||
      e.periph !== "RCC" ||
      e.reg !== "PLLCFGR" ||
      e.flags.length > 0 ||
      !(regs.RCC.CR & PLLON)
    ) {
      return [];
    }
    const { fields } = chip.registers.peripherals.RCC.registers.PLLCFGR;
    const get = (v: number, f: string) =>
      Math.floor(v / 2 ** fields[f].bitOffset) % 2 ** fields[f].bitWidth;
    const locked =
      ((regs.RCC.CFGR >>> 3) & 7) === PLLRCLK ? [...LOCKED, "PLLREN"] : LOCKED;
    const ignored = locked.filter((f) => get(e.value, f) !== get(e.old, f));
    if (!ignored.length) return [];
    return [
      {
        severity: "warning",
        message:
          `wrote ${regName(chip, "RCC", "PLLCFGR")} while ${fieldName(chip, "RCC", "CR", "PLLON")} = 1, ` +
          `so the change to ${ignored.join(", ")} was ignored and the PLL keeps its old settings: ` +
          "PLLSRC, PLLM, PLLN, PLLP, PLLQ and PLLR can be written only when the PLL is disabled, " +
          "and PLLREN not while PLLRCLK is SYSCLK (RM0444 §5.4.4). Write RCC_PLLCFGR before " +
          `setting PLLON, or clear PLLON and wait for ${fieldName(chip, "RCC", "CR", "PLLRDY")} = 0 ` +
          "first (RM0444 §5.2.4)",
        periph: "RCC",
        reg: "PLLCFGR",
      },
    ];
  },
};
