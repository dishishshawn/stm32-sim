// flash-latency: HCLK above what FLASH_ACR.LATENCY allows (RM0444 §3.3.4,
// Table 13). Real silicon misreads flash then; the simulator doesn't model wait
// states (docs/decisions.md §14), so this diagnostic is the only sign. Checked
// when firmware changes the clock it selects (an RCC_CFGR write: SW, HPRE) and
// when it writes FLASH_ACR. Nothing else can raise HCLK above 24 MHz: HSISYS
// is at most 16 MHz, and PLLCFGR can't change while PLLRCLK is SYSCLK.
import { clocks } from "../peripherals/rcc.ts";
import { fieldName, mhz, regName } from "./names.ts";
import type { Rule } from "./rule.ts";

/**
 * Table 13, VCORE Range 1: the highest HCLK with 0 and with 1 wait states;
 * up to 64 MHz needs 2.
 * ponytail: assumes Range 1, PWR_CR1.VOS's reset value. Range 2 allows only
 * 8 and 16 MHz; read VOS if firmware ever selects it.
 */
const MAX_HZ = [24e6, 48e6];
/** RCC_CFGR SWS (RM0444 §5.4.3). */
const SWS = 7 << 3;

export const flashLatency: Rule = {
  id: "flash-latency",
  check(e, { chip, regs }) {
    if (e.kind !== "reg" || e.op !== "write" || e.flags.length > 0) return [];
    const cfgr = e.periph === "RCC" && e.reg === "CFGR";
    if (!cfgr && !(e.periph === "FLASH" && e.reg === "ACR")) return [];
    const now = clocks(regs.RCC).hclk;
    const latency = fieldName(chip, "FLASH", "ACR", "LATENCY");
    let hclk: number, ws: number, what: string;
    if (cfgr) {
      // The HCLK that SW and HPRE select. A source that isn't ready yet is
      // switched to once it is (§5.2.7), so the switch counts from here.
      hclk = clocks({
        ...regs.RCC,
        CFGR: (e.value & ~SWS) | ((e.value & 7) << 3),
      }).hclk;
      if (hclk === now) return [];
      ws = regs.FLASH.ACR & 7;
      what = `wrote ${regName(chip, "RCC", "CFGR")} selecting HCLK = ${mhz(hclk)} while ${latency} = ${ws}`;
    } else {
      hclk = now;
      ws = e.value & 7;
      what = `wrote ${latency} = ${ws} while HCLK = ${mhz(hclk)}`;
    }
    const need = MAX_HZ.filter((max) => hclk > max).length;
    if (ws >= need) return [];
    return [
      {
        severity: "warning",
        message:
          `${what}: HCLK above 24 MHz needs LATENCY = 1, above 48 MHz LATENCY = 2 ` +
          "(RM0444 §3.3.4, Table 13, VCORE Range 1). Real silicon then reads wrong " +
          "instructions from flash; the simulator doesn't model wait states, so it runs on. " +
          `Set LATENCY = ${need} and wait until it reads back before raising the clock, ` +
          "and lower it only after lowering the clock (RM0444 §3.3.4)",
        periph: e.periph,
        reg: e.reg,
      },
    ];
  },
};
