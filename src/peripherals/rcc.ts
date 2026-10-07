// RCC: the clock tree, as far as firmware polls it and simulated time depends on
// it. Oscillators get ready some time after they are turned on, the system clock
// switches only to a ready source, and the prescalers give HCLK and PCLK. Each
// HCLK change goes to the engine (setCoreClock), which times the CPU by it.
// § numbers are RM0444 Rev 6 chapter 5's; tables are DS12992 Rev 4's.
// Clock gating needs no code here: the memory bus reads the stored IOPENR and
// APBENR1 bit each peripheral declares as its gate. See docs/decisions.md §9, §14.
import type { Peripheral, Registers } from "./peripheral.ts";

/** HSI16 (§5.2.2), the clock after reset. */
export const HSI16_HZ = 16_000_000;
/** LSI (§5.2.6). */
const LSI_HZ = 32_000;

// RCC_CR (§5.4.1)
const HSION = 1 << 8;
const HSIRDY = 1 << 10;
const HSERDY = 1 << 17;
const PLLON = 1 << 24;
const PLLRDY = 1 << 25;
// RCC_CFGR (§5.4.3): SW and SWS values, and SWS's bits
const HSISYS = 0;
const PLLRCLK = 2;
const LSI = 3;
const SWS = 7 << 3;
/** HPRE 1000 to 1111 divide SYSCLK by these (§5.4.3); 0xxx by 1. */
const AHB_DIVIDERS = [2, 4, 8, 16, 64, 128, 256, 512];
// RCC_PLLCFGR (§5.4.4)
const PLLSRC_HSI16 = 2;
const PLLREN = 1 << 28;
/** PLLSRC, PLLM, PLLN, PLLP, PLLQ, PLLR: each "can be written only when the PLL is disabled". */
const PLL_CONFIG = 0xee3e7f73;
// RCC_CSR (§5.4.24) and RCC_BDCR (§5.4.23)
const LSION = 1 << 0;
const LSIRDY = 1 << 1;
const LSEON = 1 << 0;

/** Read-only ready flags, by register. */
const READY: Readonly<Record<string, number>> = {
  CR: HSIRDY | HSERDY | PLLRDY,
  CSR: LSIRDY,
};

interface Oscillator {
  readonly reg: "CR" | "CSR";
  readonly on: number;
  readonly rdy: number;
  /** Seconds from ON to RDY: DS12992's typical start-up or lock time. */
  readonly startup: number;
}

/**
 * The oscillators that get ready. HSE never does: on the NUCLEO-G031K8 its only
 * source is the ST-LINK's MCO through SB7 into PC14, and SB7 is off by default
 * (UM2591 Table 8; assumed: an unmodified board). LSE isn't simulated.
 */
const OSCILLATORS: readonly Oscillator[] = [
  { reg: "CR", on: HSION, rdy: HSIRDY, startup: 0.8e-6 }, // Table 41 tsu(HSI16)
  { reg: "CR", on: PLLON, rdy: PLLRDY, startup: 15e-6 }, // Table 43 tLOCK: 15 typ., 40 max
  { reg: "CSR", on: LSION, rdy: LSIRDY, startup: 80e-6 }, // Table 42 tSU(LSI)
];

/**
 * PLLRCLK = (input / M) × N / R (§5.4.4), as configured, whether the PLL runs
 * or not. The input is HSI16 or nothing: HSE never runs here, and PLLSRC = 00
 * is "no clock". Assumed: PLLR = 000 (reserved) divides by 1.
 */
export function pllrclk(rcc: Readonly<Registers>): number {
  const c = rcc.PLLCFGR;
  const input = (c & 3) === PLLSRC_HSI16 ? HSI16_HZ : 0;
  const m = ((c >>> 4) & 7) + 1;
  const n = (c >>> 8) & 0x7f;
  const r = (c >>> 29) + 1;
  return ((input / m) * n) / r;
}

/** The clocks RCC's registers give now, in Hz (§5.2, Figure 10 clock tree). */
export function clocks(rcc: Readonly<Registers>): {
  sysclk: number;
  hclk: number;
  pclk: number;
} {
  const cfgr = rcc.CFGR;
  const sws = (cfgr >>> 3) & 7;
  // HSISYS = HSI16 / 2^HSIDIV (§5.4.1). SWS can't be HSE or LSE: they never get ready.
  const sysclk =
    sws === PLLRCLK
      ? pllrclk(rcc)
      : sws === LSI
        ? LSI_HZ
        : HSI16_HZ / 2 ** ((rcc.CR >>> 11) & 7);
  const hpre = (cfgr >>> 8) & 0xf;
  const hclk = sysclk / (hpre < 8 ? 1 : AHB_DIVIDERS[hpre - 8]);
  // PPRE: 0xx 1, then 100 to 111 divide HCLK by 2 to 16 (§5.4.3).
  const ppre = (cfgr >>> 12) & 7;
  const pclk = hclk / (ppre < 4 ? 1 : 2 ** (ppre - 3));
  return { sysclk, hclk, pclk };
}

export const rcc: Peripheral = {
  name: "RCC",
  create({ regs, setCoreClock, events, now }) {
    let hclk = HSI16_HZ;
    /** Seconds left until each starting oscillator is ready. */
    const starting = new Map<Oscillator, number>();

    /** Whether a SW value's source is ready to switch to (§5.2.7). */
    const ready = (sw: number): boolean =>
      sw === HSISYS
        ? (regs.CR & HSIRDY) !== 0
        : sw === PLLRCLK
          ? // Assumed: without PLLREN there is no PLLRCLK to switch to.
            (regs.CR & PLLRDY) !== 0 && (regs.PLLCFGR & PLLREN) !== 0
          : sw === LSI
            ? (regs.CSR & LSIRDY) !== 0
            : false; // HSE and LSE never get ready; 101 to 111 are reserved

    /**
     * §5.2.7: "A switch from one clock source to another occurs only if the
     * target clock source is ready"; one selected before it is ready happens
     * when it gets ready. SWS shows the source in use. Then HCLK follows.
     */
    const update = () => {
      const sw = regs.CFGR & 7;
      if (sw !== (regs.CFGR & SWS) >>> 3 && ready(sw))
        regs.CFGR = ((regs.CFGR & ~SWS) | (sw << 3)) >>> 0;
      const hz = clocks(regs).hclk;
      if (hz !== hclk) setCoreClock((hclk = hz));
    };

    /**
     * The ON bits of `reg` the hardware keeps set: "When a clock source is used
     * directly or through the PLL as a system clock, it is not possible to stop
     * it" (§5.2.7; HSION and PLLON, §5.4.1).
     */
    const inUse = (reg: "CR" | "CSR"): number => {
      const sws = (regs.CFGR & SWS) >>> 3;
      if (reg === "CSR") return sws === LSI ? LSION : 0;
      const viaPll =
        sws === PLLRCLK && (regs.PLLCFGR & 3) === PLLSRC_HSI16 ? HSION : 0;
      return (
        (sws === HSISYS ? HSION : 0) | (sws === PLLRCLK ? PLLON : 0) | viaPll
      );
    };

    /** A write to CR or CSR: oscillators start or stop. */
    const control = (reg: "CR" | "CSR") => (value: number) => {
      const old = regs[reg];
      const v = ((value & ~READY[reg]) | (old & READY[reg]) | inUse(reg)) >>> 0;
      regs[reg] = v;
      for (const o of OSCILLATORS) {
        if (o.reg !== reg) continue;
        if (!(v & o.on)) {
          // Assumed: RDY clears at once (RM0444: 6 HSI16 cycles for HSIRDY).
          regs[reg] = (regs[reg] & ~o.rdy) >>> 0;
          starting.delete(o);
        } else if (!(old & o.on)) {
          // Assumed: a PLL with no input clock (or N = 0) never locks.
          if (o.on !== PLLON || pllrclk(regs) > 0) starting.set(o, o.startup);
        }
      }
      update();
    };

    return {
      reset() {
        // §5.4.1: CR resets to 0x0000_0500, HSION and HSIRDY. The SVD says 0x63.
        regs.CR = HSION | HSIRDY;
        starting.clear();
        hclk = HSI16_HZ;
        setCoreClock(hclk);
      },
      // ponytail: called after every instruction, even with nothing starting:
      // blink runs ~15% slower. Let tick() report idle until the next register
      // write if speed matters.
      tick(cycles) {
        if (!starting.size) return;
        const seconds = cycles / hclk;
        for (const [o, left] of starting) {
          if (left > seconds) starting.set(o, left - seconds);
          else {
            starting.delete(o);
            regs[o.reg] = (regs[o.reg] | o.rdy) >>> 0;
          }
        }
        update();
      },
      write: {
        CR: control("CR"),
        CSR: control("CSR"),
        CFGR(value) {
          // SWS is read-only (§5.4.3).
          regs.CFGR = ((value & ~SWS) | (regs.CFGR & SWS)) >>> 0;
          update();
        },
        PLLCFGR(value) {
          // §5.4.4: the dividers and the source can't change while the PLL
          // is on, and PLLREN can't while PLLRCLK is the system clock.
          let keep = regs.CR & PLLON ? PLL_CONFIG : 0;
          if ((regs.CFGR & SWS) >>> 3 === PLLRCLK) keep |= PLLREN;
          regs.PLLCFGR = ((value & ~keep) | (regs.PLLCFGR & keep)) >>> 0;
          update(); // PLLREN may complete a switch waiting for it
        },
        // LSE isn't simulated: LSERDY never sets. Neither is the RTC domain's
        // write protection (PWR_CR1.DBP, §5.4.23).
        BDCR(value) {
          regs.BDCR = value;
          if (value & LSEON && events.active) {
            events.emit({
              kind: "unsimulated",
              cycle: now(),
              periph: "RCC",
              feature: "BDCR.LSEON",
            });
          }
        },
      },
    };
  },
};
