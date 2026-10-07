/*
 * blink-systick-irq: toggle PA0 every 500 ms, counting SysTick interrupts.
 *
 * Same timer as blink-systick-poll: SysTick counts 16000 core clocks, 1 ms at
 * 16 MHz, then starts again. This time CTRL's TICKINT bit is set, so each time
 * the count reaches 0 the core stops what it is doing, runs SysTick_Handler,
 * and comes back. The handler only counts milliseconds; main() reads the count
 * and decides when to toggle.
 *
 * The SysTick exception needs no NVIC setup: it is a core exception, enabled
 * by TICKINT alone. Its priority is in SCB->SHP[1] (SHPR3); the reset value,
 * 0, is the highest, and fine here.
 */
#include "stm32g0xx.h"

#define CPU_HZ 16000000U
#define MS_PER_TOGGLE 500U

/* Milliseconds since SysTick started. `volatile` because the handler changes
   it behind main()'s back: without it the compiler may read it once and keep
   the value in a register forever, and main() would never see it move. */
static volatile uint32_t ms;

/* The name matters: the vector table in startup_stm32g031xx.s points the
   SysTick exception at a function called SysTick_Handler. Misspell it and
   the default handler, an endless loop, runs instead. */
void SysTick_Handler(void) { ms++; }

int main(void) {
  /* PA0 as an output, as in blink. */
  RCC->IOPENR |= RCC_IOPENR_GPIOAEN;
  GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODE0_Msk) | GPIO_MODER_MODE0_0;

  /* 1 ms rounds from the core clock, as in blink-systick-poll, plus TICKINT:
     interrupt at the end of every round. */
  SysTick->LOAD = CPU_HZ / 1000U - 1U;
  SysTick->VAL = 0U;
  SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_TICKINT_Msk |
                  SysTick_CTRL_ENABLE_Msk;

  uint32_t last = 0;
  for (;;) {
    /* `ms - last` is right even when ms wraps past 0xFFFFFFFF (after 49
       days), because unsigned subtraction wraps too. */
    if (ms - last >= MS_PER_TOGGLE) {
      last += MS_PER_TOGGLE;
      GPIOA->ODR ^= GPIO_ODR_OD0;
    }
  }
}
