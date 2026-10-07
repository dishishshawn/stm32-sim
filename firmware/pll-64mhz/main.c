/*
 * pll-64mhz: run the core at 64 MHz from the PLL, and blink PA5.
 *
 * After reset the STM32G031 runs from HSI16, its internal 16 MHz oscillator.
 * The PLL multiplies a clock: here HSI16 / 1 x 8 / 2 = 64 MHz, the fastest
 * this chip may run (RM0444 section 5.2.7). Getting there takes four steps,
 * in this order:
 *   1. give the flash 2 wait states. At 64 MHz it is too slow to answer in
 *      one clock (RM0444 section 3.3.4, Table 13); without them the CPU reads
 *      wrong instructions;
 *   2. configure the PLL while it is off: input, M, N and R;
 *   3. turn it on, and wait until it is locked (PLLRDY);
 *   4. switch the system clock to it, and wait until the switch has happened
 *      (SWS).
 *
 * To see the difference, PA5 first blinks twice at 16 MHz, then forever at
 * 64 MHz, with the same delay loop. The loop takes the same number of clock
 * cycles at any speed, and each cycle is 4 times shorter, so it blinks 4
 * times as fast. SysTick counts the same faster clock: 64000 cycles are 1 ms.
 *
 * No ST header: each register is defined by its address, as in the exam.
 * The address is the peripheral's base (RM0444 section 2.2.2, Table 6) plus
 * the register's offset (in the register's own section). `volatile` makes the
 * compiler really read and write the register every time.
 */
#include <stdint.h>

/* FLASH, base 0x40022000 (RM0444 section 3.7) */
#define FLASH_ACR (*(volatile uint32_t *)0x40022000U) /* offset 0x00 */

/* RCC, base 0x40021000 (RM0444 section 5.4) */
#define RCC_CR (*(volatile uint32_t *)0x40021000U)      /* offset 0x00 */
#define RCC_CFGR (*(volatile uint32_t *)0x40021008U)    /* offset 0x08 */
#define RCC_PLLCFGR (*(volatile uint32_t *)0x4002100CU) /* offset 0x0C */
#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)  /* offset 0x34 */

/* GPIOA, base 0x50000000 (RM0444 section 7.5) */
#define GPIOA_MODER (*(volatile uint32_t *)0x50000000U) /* offset 0x00 */
#define GPIOA_ODR (*(volatile uint32_t *)0x50000014U)   /* offset 0x14 */

/* SysTick is inside the Cortex-M0+ core, not an ST peripheral, so it is in
   ST's programming manual PM0223, not RM0444. Base 0xE000E010. */
#define SysTick_CTRL (*(volatile uint32_t *)0xE000E010U) /* offset 0x0 */
#define SysTick_LOAD (*(volatile uint32_t *)0xE000E014U) /* offset 0x4 */
#define SysTick_VAL (*(volatile uint32_t *)0xE000E018U)  /* offset 0x8 */

/* Turns of delay()'s loop per toggle: about 10 cycles each, so 2,000,000
   cycles, which is 125 ms at 16 MHz and 31.25 ms at 64 MHz. */
#define DELAY_LOOPS 200000U

/* Milliseconds since SysTick started, counted by SysTick_Handler. `volatile`
   because the handler changes it behind main()'s back. */
volatile uint32_t ms_ticks;

/* The vector table in the startup file points the SysTick exception at a
   function with exactly this name. */
void SysTick_Handler(void) { ms_ticks++; }

/* Busy-wait by counting. How long it takes depends on the clock. */
static void delay(uint32_t loops) {
  for (volatile uint32_t i = 0; i < loops; i++) {
  }
}

static void clock_to_64mhz(void) {
  /* 1. FLASH_ACR bits 2:0 are LATENCY, the number of wait states: 2 for
        up to 64 MHz. The new value counts once it reads back, so wait for it.
   */
  FLASH_ACR = (FLASH_ACR & ~7U) | 2U;
  while ((FLASH_ACR & 7U) != 2U) {
  }

  /* 2. The PLL, while it is off (these fields can't change while it runs):
          PLLSRC bits 1:0   = 10:  input HSI16, 16 MHz
          PLLM   bits 6:4   = 000: divide by 1, 16 MHz (must be 2.66 to 16)
          PLLN   bits 14:8  = 8:   multiply by 8, 128 MHz (must be 96 to 344)
          PLLR   bits 31:29 = 001: divide by 2, 64 MHz out on PLLRCLK
          PLLREN bit 28     = 1:   turn the PLLRCLK output on */
  RCC_PLLCFGR = (1U << 29) | (1U << 28) | (8U << 8) | (0U << 4) | 2U;

  /* 3. PLLON (RCC_CR bit 24) starts the PLL. It takes a few microseconds to
        lock onto its new frequency; PLLRDY (bit 25) says when it has. */
  RCC_CR |= 1U << 24;
  while (!(RCC_CR & (1U << 25))) {
  }

  /* 4. SW (RCC_CFGR bits 2:0) = 010 selects PLLRCLK as the system clock.
        SWS (bits 5:3) shows the clock in use: wait until it says 010 too. */
  RCC_CFGR = (RCC_CFGR & ~7U) | 2U;
  while (((RCC_CFGR >> 3) & 7U) != 2U) {
  }
}

int main(void) {
  /* PA5 as an output: turn on GPIOA's clock (RCC_IOPENR bit 0), then set
     PA5's two MODER bits (11:10) to 01, output. */
  RCC_IOPENR |= 1U;
  GPIOA_MODER = (GPIOA_MODER & ~(3U << 10)) | (1U << 10);

  /* Two blinks at the reset clock, 16 MHz, to compare. */
  for (int i = 0; i < 4; i++) {
    GPIOA_ODR ^= 1U << 5;
    delay(DELAY_LOOPS);
  }

  clock_to_64mhz();

  /* SysTick counts down from LOAD to 0, then reloads: LOAD + 1 core clocks
     per round. 64000 clocks at 64 MHz are 1 ms. Clear VAL so the first round
     starts from LOAD, then CTRL: CLKSOURCE (bit 2) = core clock, TICKINT
     (bit 1) = interrupt at each 0, ENABLE (bit 0) = start. */
  SysTick_LOAD = 64000U - 1U;
  SysTick_VAL = 0U;
  SysTick_CTRL = (1U << 2) | (1U << 1) | 1U;

  /* The same blink, now at 64 MHz. */
  for (;;) {
    GPIOA_ODR ^= 1U << 5;
    delay(DELAY_LOOPS);
  }
}
