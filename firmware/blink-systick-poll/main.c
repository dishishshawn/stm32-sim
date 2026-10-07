/*
 * blink-systick-poll: toggle PA0 every 500 ms, timed by SysTick, by polling.
 *
 * blink's delay loop only roughly takes the time it should: it depends on the
 * code the compiler produces. SysTick is a timer inside the Cortex-M0+ core
 * that counts clock cycles, so its timing is exact:
 *   - it counts down from LOAD to 0, one step per clock;
 *   - on the step after 0 it reloads LOAD, so one round is LOAD + 1 clocks;
 *   - each time it reaches 0 it sets COUNTFLAG (bit 16 of CTRL). Reading CTRL
 *     clears COUNTFLAG again, so "COUNTFLAG is 1" means "a round has ended
 *     since I last looked".
 *
 * At the 16 MHz reset clock, LOAD = 16000 - 1 makes one round 1 ms. This
 * program counts 500 rounds, then flips PA0.
 *
 * Register addresses: base from RM0444's memory map (§2.2.2, Table 6) plus
 * the register's offset.
 *   RCC_IOPENR    RCC   0x4002 1000 + 0x34  (§5.4.13)
 *   GPIOA_MODER   GPIOA 0x5000 0000 + 0x00  (§7.5.1)
 *   GPIOA_ODR     GPIOA 0x5000 0000 + 0x14  (§7.5.6)
 * SysTick is part of the Cortex-M0+ core, not an ST peripheral, so RM0444
 * doesn't describe it: ST's programming manual PM0223 does, as does
 * ARM's ARMv6-M Architecture Reference Manual (B3.3). Its registers start at
 * 0xE000E010 on every Cortex-M:
 *   SysTick_CTRL  0xE000E010 + 0x0  (ARM calls it SYST_CSR)
 *   SysTick_LOAD  0xE000E010 + 0x4  (SYST_RVR)
 *   SysTick_VAL   0xE000E010 + 0x8  (SYST_CVR)
 */
#include <stdint.h>

#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)
#define GPIOA_MODER (*(volatile uint32_t *)0x50000000U)
#define GPIOA_ODR (*(volatile uint32_t *)0x50000014U)
#define SysTick_CTRL (*(volatile uint32_t *)0xE000E010U)
#define SysTick_LOAD (*(volatile uint32_t *)0xE000E014U)
#define SysTick_VAL (*(volatile uint32_t *)0xE000E018U)

#define RCC_IOPENR_GPIOAEN (1U << 0)

#define SysTick_CTRL_ENABLE (1U << 0)     /* start counting */
#define SysTick_CTRL_CLKSOURCE (1U << 2)  /* 1: the core clock, 0: it / 8 */
#define SysTick_CTRL_COUNTFLAG (1U << 16) /* reached 0 since the last read */

/* The core clock after reset: the internal 16 MHz oscillator, HSI16. */
#define CPU_HZ 16000000U
#define TICKS_PER_TOGGLE 500U /* 1 ms ticks */

int main(void) {
  /* PA0 as an output, as in blink: GPIOA's clock on, then MODE0 = 01. */
  RCC_IOPENR |= RCC_IOPENR_GPIOAEN;
  GPIOA_MODER = (GPIOA_MODER & ~(3U << 0)) | (1U << 0);

  /* SysTick, in the order ARM recommends:
     1. LOAD: 16000 clocks per round, so 1 ms. LOAD is one less than the
        round, because the count includes 0.
     2. VAL: any write clears the count (and COUNTFLAG), so the first round
        starts from a known point instead of a leftover value.
     3. CTRL: CLKSOURCE = 1 counts the core clock itself (0 would count it
        divided by 8), and ENABLE = 1 starts counting. TICKINT stays 0: no
        interrupt, this program polls. */
  SysTick_LOAD = CPU_HZ / 1000U - 1U;
  SysTick_VAL = 0U;
  SysTick_CTRL = SysTick_CTRL_CLKSOURCE | SysTick_CTRL_ENABLE;

  uint32_t ticks = 0;
  for (;;) {
    /* Each read of CTRL clears COUNTFLAG, so each 1 ms round is counted
       once. The loop goes round thousands of times per round, so it can't
       miss one. */
    if (SysTick_CTRL & SysTick_CTRL_COUNTFLAG) {
      ticks++;
      if (ticks == TICKS_PER_TOGGLE) {
        ticks = 0;
        GPIOA_ODR ^= (1U << 0); /* OD0 */
      }
    }
  }
}
