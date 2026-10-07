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
 * SysTick, its CTRL/LOAD/VAL registers and the SysTick_CTRL_..._Msk bit names
 * come from ARM's core_cm0plus.h, included by stm32g0xx.h. ST's programming
 * manual PM0223 describes them (they are not in RM0444, which covers ST's
 * peripherals, not the core).
 */
#include "stm32g0xx.h"

/* The core clock after reset: the internal 16 MHz oscillator, HSI16. */
#define CPU_HZ 16000000U
#define TICKS_PER_TOGGLE 500U /* 1 ms ticks */

int main(void) {
  /* PA0 as an output, as in blink: GPIOA's clock on, then MODER0 = 01. */
  RCC->IOPENR |= RCC_IOPENR_GPIOAEN;
  GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODE0_Msk) | GPIO_MODER_MODE0_0;

  /* SysTick, in the order ARM recommends:
     1. LOAD: 16000 clocks per round, so 1 ms. LOAD is one less than the
        round, because the count includes 0.
     2. VAL: any write clears the count (and COUNTFLAG), so the first round
        starts from a known point instead of a leftover value.
     3. CTRL: CLKSOURCE = 1 counts the core clock itself (0 would count it
        divided by 8), and ENABLE = 1 starts counting. TICKINT stays 0: no
        interrupt, this program polls. */
  SysTick->LOAD = CPU_HZ / 1000U - 1U;
  SysTick->VAL = 0U;
  SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_ENABLE_Msk;

  uint32_t ticks = 0;
  for (;;) {
    /* Each read of CTRL clears COUNTFLAG, so each 1 ms round is counted
       once. The loop goes round thousands of times per round, so it can't
       miss one. */
    if (SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) {
      ticks++;
      if (ticks == TICKS_PER_TOGGLE) {
        ticks = 0;
        GPIOA->ODR ^= GPIO_ODR_OD0;
      }
    }
  }
}
