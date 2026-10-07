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
 * by TICKINT alone. Its priority is in the core's SHPR3 register; the reset
 * value, 0, is the highest, and fine here.
 *
 * Register addresses, as in blink-systick-poll: RM0444's memory map (§2.2.2,
 * Table 6) plus the register's offset; SysTick from PM0223.
 *   RCC_IOPENR    RCC   0x4002 1000 + 0x34  (§5.4.13)
 *   GPIOA_MODER   GPIOA 0x5000 0000 + 0x00  (§7.5.1)
 *   GPIOA_ODR     GPIOA 0x5000 0000 + 0x14  (§7.5.6)
 *   SysTick_CTRL  0xE000E010 + 0x0, _LOAD + 0x4, _VAL + 0x8
 */
#include <stdint.h>

#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)
#define GPIOA_MODER (*(volatile uint32_t *)0x50000000U)
#define GPIOA_ODR (*(volatile uint32_t *)0x50000014U)
#define SysTick_CTRL (*(volatile uint32_t *)0xE000E010U)
#define SysTick_LOAD (*(volatile uint32_t *)0xE000E014U)
#define SysTick_VAL (*(volatile uint32_t *)0xE000E018U)

#define RCC_IOPENR_GPIOAEN (1U << 0)

#define SysTick_CTRL_ENABLE (1U << 0)    /* start counting */
#define SysTick_CTRL_TICKINT (1U << 1)   /* interrupt each time it reaches 0 */
#define SysTick_CTRL_CLKSOURCE (1U << 2) /* 1: the core clock, 0: it / 8 */

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
  RCC_IOPENR |= RCC_IOPENR_GPIOAEN;
  GPIOA_MODER = (GPIOA_MODER & ~(3U << 0)) | (1U << 0); /* MODE0 = 01 */

  /* 1 ms rounds from the core clock, as in blink-systick-poll, plus TICKINT:
     interrupt at the end of every round. */
  SysTick_LOAD = CPU_HZ / 1000U - 1U;
  SysTick_VAL = 0U;
  SysTick_CTRL =
      SysTick_CTRL_CLKSOURCE | SysTick_CTRL_TICKINT | SysTick_CTRL_ENABLE;

  uint32_t last = 0;
  for (;;) {
    /* `ms - last` is right even when ms wraps past 0xFFFFFFFF (after 49
       days), because unsigned subtraction wraps too. */
    if (ms - last >= MS_PER_TOGGLE) {
      last += MS_PER_TOGGLE;
      GPIOA_ODR ^= (1U << 0); /* OD0 */
    }
  }
}
