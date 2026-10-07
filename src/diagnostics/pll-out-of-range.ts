// pll-out-of-range: PLLON set with the PLL configured outside DS12992's limits
// (Table 43, VCORE Range 1): input (source / M) 2.66 to 16 MHz, VCO (× N) 96
// to 344 MHz, PLLRCLK (/ R) 12 to 64 MHz. RM0444 §5.4.4 gives the same
// cautions. The simulator runs the PLL as configured anyway (docs/decisions.md
// §14), so firmware that overclocks seems to work; one with no input clock or
// N = 0 never locks.
import { HSI16_HZ } from "../peripherals/rcc.ts";
import { fieldName, mhz, regName } from "./names.ts";
import type { Rule } from "./rule.ts";

/** RCC_CR PLLON (RM0444 §5.4.1). */
const PLLON = 1 << 24;

export const pllOutOfRange: Rule = {
  id: "pll-out-of-range",
  check(e, { chip, regs }) {
    if (
      e.kind !== "reg" ||
      e.op !== "write" ||
      e.periph !== "RCC" ||
      e.reg !== "CR" ||
      e.flags.length > 0 ||
      !(e.value & PLLON) ||
      e.old & PLLON
    ) {
      return [];
    }
    // ponytail: PLLRCLK is checked even with PLLREN = 0, so firmware using
    // only PLLPCLK (the ADC) with R out of range gets a warning it doesn't
    // need. Check R when PLLREN is set instead, if that firmware appears.
    const c = regs.RCC.PLLCFGR; // RM0444 §5.4.4
    const m = ((c >>> 4) & 7) + 1;
    const n = (c >>> 8) & 0x7f;
    const r = (c >>> 29) + 1; // 000 is reserved: the simulator divides by 1
    const hsi16 = (c & 3) === 2;
    // HSE never runs on this board (rcc.ts), and PLLSRC = 00 is no clock.
    const input = hsi16 ? HSI16_HZ / m : 0;
    const vco = input * n;
    const out = vco / r;
    const limits: [what: string, hz: number, min: number, max: number][] = [
      [
        hsi16
          ? `input = HSI16 / M ${m} = ${mhz(input)}`
          : `input = 0 MHz (PLLSRC = ${c & 3}; only HSI16 runs on this board)`,
        input,
        2.66e6,
        16e6,
      ],
      [`VCO = input × N ${n} = ${mhz(vco)}`, vco, 96e6, 344e6],
      [`PLLRCLK = VCO / R ${r} = ${mhz(out)}`, out, 12e6, 64e6],
    ];
    const bad = limits
      .filter(([, hz, min, max]) => hz < min || hz > max)
      .map(
        ([what, , min, max]) => `${what}, must be ${min / 1e6} to ${mhz(max)}`,
      );
    if (!bad.length) return [];
    return [
      {
        severity: "warning",
        message:
          `set ${fieldName(chip, "RCC", "CR", "PLLON")} with ${regName(chip, "RCC", "PLLCFGR")} ` +
          `outside the PLL's limits (DS12992 Table 43, VCORE Range 1): ${bad.join("; ")}. ` +
          (out > 0
            ? "The simulator runs the PLL as configured; real silicon isn't specified there. "
            : "The simulator never locks a PLL with no input or N = 0 (assumed), so PLLRDY stays 0. ") +
          "With PLLON = 0, choose M, N and R so that HSI16 / M is 2.66 to 16 MHz, " +
          "the VCO 96 to 344 MHz and PLLRCLK 12 to 64 MHz (RM0444 §5.4.4)",
        periph: "RCC",
        reg: "PLLCFGR",
      },
    ];
  },
};
