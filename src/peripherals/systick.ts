// SysTick, the Cortex-M0+ system timer at 0xE000E010: a 24-bit down counter that
// reloads from LOAD, sets COUNTFLAG and can pend the SysTick exception (15) each
// time it reaches 0. It is part of the core, not an ST peripheral, so the SVD
// doesn't have it (T4): its registers are hand-written below from the ARMv6-M
// Architecture Reference Manual (B3.3), with the CMSIS names firmware uses
// (SysTick->CTRL, ->LOAD, ->VAL, ->CALIB). See docs/decisions.md §11.
import type { Peripheral } from "./peripheral.ts";

const ENABLE = 1 << 0;
const TICKINT = 1 << 1;
const CLKSOURCE = 1 << 2;
const COUNTFLAG = 1 << 16;
const EXC_SYSTICK = 15;
/** CLKSOURCE = 0 counts the external reference: HCLK/8 on the STM32G0 (RM0444 §5.2, clock tree). */
const EXTERNAL_DIVIDER = 8;

const field = (bitOffset: number, bitWidth: number, description: string) => ({
  bitOffset,
  bitWidth,
  description,
});

/**
 * SysTick's entry for a chip's register map. `calib` is the chip's CALIB value.
 * Assumed: CTRL, LOAD and VAL reset to 0. The ARMv6-M ARM leaves LOAD and VAL
 * UNKNOWN and CLKSOURCE's reset IMPLEMENTATION DEFINED; PM0223 wasn't checked.
 */
export const systickRegisters = (calib: number) => ({
  baseAddress: "0xE000E010",
  registers: {
    CTRL: {
      offset: "0x0",
      size: 32,
      access: "read-write",
      resetValue: "0x00000000",
      description: "SysTick control and status register (SYST_CSR)",
      fields: {
        ENABLE: field(0, 1, "Counter enable"),
        TICKINT: field(1, 1, "Pend the SysTick exception on reaching 0"),
        CLKSOURCE: field(2, 1, "Clock source: 0 HCLK/8, 1 HCLK"),
        COUNTFLAG: field(
          16,
          1,
          "Counted to 0 since the last read of CTRL (read-only, cleared by the read)",
        ),
      },
    },
    LOAD: {
      offset: "0x4",
      size: 32,
      access: "read-write",
      resetValue: "0x00000000",
      description: "SysTick reload value register (SYST_RVR)",
      fields: { RELOAD: field(0, 24, "Loaded into VAL after it reaches 0") },
    },
    VAL: {
      offset: "0x8",
      size: 32,
      access: "read-write",
      resetValue: "0x00000000",
      description: "SysTick current value register (SYST_CVR)",
      fields: {
        CURRENT: field(0, 24, "The count. Any write clears it and COUNTFLAG"),
      },
    },
    CALIB: {
      offset: "0xC",
      size: 32,
      access: "read-only",
      resetValue: `0x${calib.toString(16).padStart(8, "0")}`,
      description: "SysTick calibration value register (SYST_CALIB)",
      fields: {
        TENMS: field(0, 24, "Calibration reload value"),
        SKEW: field(30, 1, "1: TENMS is not exact"),
        NOREF: field(31, 1, "1: no external reference clock"),
      },
    },
  },
});

export const systick: Peripheral = {
  name: "SysTick",
  create: ({ regs, cpu }) => {
    let prescaler = 0; // HCLK cycles not yet counted at HCLK/8
    return {
      reset() {
        prescaler = 0;
      },
      tick(cycles) {
        if (!(regs.CTRL & ENABLE)) return;
        let n = cycles; // SysTick clocks
        if (!(regs.CTRL & CLKSOURCE)) {
          prescaler += cycles;
          n = Math.floor(prescaler / EXTERNAL_DIVIDER);
          prescaler -= n * EXTERNAL_DIVIDER;
        }
        const load = regs.LOAD;
        const val = regs.VAL;
        // At 0 the next clock reloads, so LOAD = 0 holds the counter at 0.
        if (n === 0 || (val === 0 && load === 0)) return;
        // Clocks to the next 1 → 0 step: VAL, or from 0 a reload plus LOAD.
        const toZero = val || load + 1;
        if (n < toZero) {
          regs.VAL = toZero - n;
          return;
        }
        const after = (n - toZero) % (load + 1); // clocks since the last 1 → 0
        regs.VAL = after ? load + 1 - after : 0;
        regs.CTRL |= COUNTFLAG;
        if (regs.CTRL & TICKINT) cpu.setPending(EXC_SYSTICK);
      },
      read: {
        // Reading CTRL clears COUNTFLAG.
        CTRL: () => {
          const value = regs.CTRL;
          regs.CTRL &= ~COUNTFLAG;
          return value;
        },
      },
      write: {
        // COUNTFLAG is read-only.
        CTRL: (value) => {
          regs.CTRL =
            (regs.CTRL & COUNTFLAG) | (value & (ENABLE | TICKINT | CLKSOURCE));
        },
        LOAD: (value) => {
          regs.LOAD = value & 0xffffff;
        },
        // Any write clears the count and COUNTFLAG; the value written is ignored.
        VAL: () => {
          regs.VAL = 0;
          regs.CTRL &= ~COUNTFLAG;
        },
        CALIB: () => {},
      },
    };
  },
};
