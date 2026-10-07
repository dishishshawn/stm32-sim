// TEMPLATE: a minimal peripheral. Copy it to src/peripherals/<name>.ts and
// follow docs/adding-a-peripheral.md. Each "TEMPLATE:" comment says what to
// change; delete those comments when you are done. The worked example is
// src/peripherals/i2c.ts.
//
// TIM14, the G031's simplest timer, cut down to its time base. A 16-bit
// counter counts CK_CNT = 16 MHz / (PSC + 1) from 0 to ARR, then wraps to 0
// with an update event, which sets SR.UIF and, with DIER.UIE, pends the TIM14
// interrupt. Enough for firmware that polls UIF to blink an LED. Behavior is
// from RM0444 Rev 6 chapter 24; § numbers below are RM0444's.
//
// The registers, their offsets and reset values (ARR resets to 0xFFFF) and
// their named bits are already in src/chips/stm32g031k8.registers.json. This
// file holds behavior only.
//
// Not simulated, logged as "unsimulated" when the firmware sets them: channel
// 1 (input capture, output compare, PWM), one-pulse mode, UDIS, URS, ARPE and
// UIFREMAP. With one set, the timer runs as if it were 0: ARR always takes
// effect at once, as with ARPE = 0.
import type { Peripheral } from "../src/peripherals/peripheral.ts"; // TEMPLATE: in src/peripherals/ this is "./peripheral.ts"

// TEMPLATE: your registers' bits, named as in RM0444 and the CMSIS header.
const CEN = 1 << 0; // TIM14_CR1 (§24.4.1)
const UIE = 1 << 0; // TIM14_DIER (§24.4.2)
const UIF = 1 << 0; // TIM14_SR (§24.4.3)
const UG = 1 << 0; // TIM14_EGR (§24.4.4)
/** RCC_APBENR2.TIM14EN (§5.4.16), the clock gate. */
const TIM14EN = 1 << 15;
/** The TIM14 interrupt is IRQ 19 (§12.3, Table 61), so exception 16 + 19. */
const TIM14_IRQ = 19;

/**
 * Fields that select behavior this file doesn't model, by register and bit.
 * Setting one is logged as an "unsimulated" event. TEMPLATE: yours.
 */
const NOT_SIMULATED: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  CR1: { UDIS: 1, URS: 2, OPM: 3, ARPE: 7, UIFREMAP: 11 },
  DIER: { CC1IE: 1 },
  EGR: { CC1G: 1 },
  CCER: { CC1E: 0 },
};

// TEMPLATE: rename the export after your peripheral, e.g. `usart2`.
export const tim14: Peripheral = {
  /** The SVD peripheral name: its key in the register JSON. */
  name: "TIM14",
  // The memory bus enforces this on every register access: with TIM14EN = 0,
  // writes are ignored and reads return 0 (§5.2.17, "not effective"). Don't
  // check it in the read and write hooks.
  gate: { register: "RCC.APBENR2", field: "TIM14EN" },
  create({ regs, regsOf, now, cpu, events }) {
    const rcc = regsOf("RCC");
    /** The active prescaler. PSC is buffered: it is copied here only at an update event (§24.3.1). */
    let prescaler = 0;
    /** CPU cycles not yet counted: the prescaler counter. */
    let pending = 0;

    const logUnsimulated = (reg: string, value: number) => {
      if (!events.active) return; // build events only while someone listens
      for (const [field, bit] of Object.entries(NOT_SIMULATED[reg])) {
        if ((value >>> bit) & 1) {
          events.emit({
            kind: "unsimulated",
            cycle: now(),
            periph: "TIM14",
            feature: `${reg}.${field}`,
          });
        }
      }
    };
    /** A write hook that stores the value, and logs what isn't simulated. */
    const store = (reg: string) => (value: number) => {
      regs[reg] = value;
      logUnsimulated(reg, value);
    };
    /** 16-bit registers: bits 31:16 are reserved, and CNT's bit 31 (UIFCPY) is read-only (§24.4.8). */
    const bits16 = (reg: string) => (value: number) => {
      regs[reg] = value & 0xffff;
    };

    /**
     * An update event (§24.3.2): the counter restarts from 0, the prescaler
     * buffer takes PSC, and UIF is set. With UIE, that pends the interrupt.
     */
    const update = () => {
      regs.CNT = 0;
      prescaler = regs.PSC;
      regs.SR |= UIF;
      if (regs.DIER & UIE) cpu.setPending(16 + TIM14_IRQ);
    };

    return {
      reset() {
        // The bus has already put every register back to its reset value.
        prescaler = 0;
        pending = 0;
      },

      // The engine calls this after every instruction, whatever the clock gate
      // says: the bus gates register accesses only. So check the gate here.
      tick(cycles) {
        if (!(regs.CR1 & CEN) || !(rcc.APBENR2 & TIM14EN)) return;
        const arr = regs.ARR;
        // §24.4.10: "The counter is blocked while the auto-reload value is null."
        if (arr === 0) return;
        pending += cycles;
        // One pass per overflow: a 1 ms sleep slice is one or two passes,
        // unless ARR is tiny.
        for (;;) {
          const divider = prescaler + 1; // CK_CNT = fCK_PSC / (PSC + 1) (§24.4.9)
          // Assumed: a counter above ARR (ARR lowered while it ran) counts on
          // to 0xFFFF and wraps to 0 with an update event. RM0444 doesn't say.
          const top = regs.CNT > arr ? 0xffff : arr;
          const toOverflow = (top - regs.CNT + 1) * divider;
          if (pending < toOverflow) {
            regs.CNT += Math.floor(pending / divider);
            pending %= divider;
            return;
          }
          pending -= toOverflow;
          update();
        }
      },

      write: {
        CR1: store("CR1"),
        DIER: store("DIER"),
        CCER: store("CCER"),
        // §24.4.3: UIF is rc_w0. Writing 0 clears it, writing 1 leaves it as
        // it is. The bytes the CPU didn't write come from SR itself, so they
        // stay as they are too.
        SR(value) {
          regs.SR = (regs.SR & value) >>> 0;
        },
        // §24.4.4: write-only. UG restarts the counter and the prescaler
        // counter and makes an update event; the prescaler ratio changes only
        // through that event. Not stored, so EGR reads 0.
        EGR(value) {
          logUnsimulated("EGR", value);
          if (value & UG) {
            pending = 0;
            update();
          }
        },
        CNT: bits16("CNT"),
        // A PSC write changes nothing until the next update event (§24.3.1),
        // so firmware that doesn't set UG runs its first period at the old
        // ratio. Faithful: never apply it early.
        PSC: bits16("PSC"),
        ARR: bits16("ARR"),
      },
      // No read hooks: every register reads back its stored value. A register
      // whose read has a side effect (I2C1's RXDR clears RXNE) gets one.
    };
  },
};
