// RCC. Clock gating needs no code here: the memory bus reads the stored IOPENR and
// APBENR1 bit each peripheral declares as its gate. This file only keeps RCC_CR
// true to a chip running from HSI16, so firmware waiting for HSIRDY doesn't hang.
// Every other RCC register is plain storage. See docs/decisions.md §9.
import type { Peripheral } from "./peripheral.ts";

const HSION = 1 << 8;
const HSIRDY = 1 << 10;
const HSERDY = 1 << 17;
const PLLRDY = 1 << 25;

export const rcc: Peripheral = {
  name: "RCC",
  create: ({ regs }) => ({
    // Assumed (RM0444 §5.4.1, not checked): CR resets to 0x0000_0500, HSION and
    // HSIRDY. The SVD says 0x63, which has HSI16 off and not ready although the
    // core runs on it.
    reset() {
      regs.CR = HSION | HSIRDY;
    },
    write: {
      // The ready flags are read-only. HSI16 is the system clock, so the hardware
      // keeps it on and ready. HSE and the PLL aren't simulated: they never get
      // ready, so firmware that waits for them waits forever.
      CR: (value) => {
        regs.CR = ((value & ~(HSERDY | PLLRDY)) | HSION | HSIRDY) >>> 0;
      },
    },
  }),
};
