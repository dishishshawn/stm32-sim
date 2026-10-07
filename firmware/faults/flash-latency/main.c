/*
 * faults/flash-latency: firmware/pll-64mhz's clock setup with one mistake. It
 * brings SYSCLK to 64 MHz through the PLL but never gives the flash its wait
 * states: FLASH_ACR LATENCY stays 0, which is right only up to 24 MHz (RM0444
 * section 3.3.4, Table 13). On a real board the CPU then reads wrong
 * instructions from flash and crashes or misbehaves. The simulator doesn't
 * model wait states, so the blink runs on; the flash-latency diagnostic, at
 * the line that switches SW, is the only sign.
 *
 * The fix is pll-64mhz's step 1: FLASH_ACR = (FLASH_ACR & ~7U) | 2U, and wait
 * until it reads back, before switching the clock.
 */
#include <stdint.h>

/* RCC, base 0x40021000 (RM0444 section 5.4) */
#define RCC_CR (*(volatile uint32_t *)0x40021000U)      /* offset 0x00 */
#define RCC_CFGR (*(volatile uint32_t *)0x40021008U)    /* offset 0x08 */
#define RCC_PLLCFGR (*(volatile uint32_t *)0x4002100CU) /* offset 0x0C */
#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)  /* offset 0x34 */

/* GPIOA, base 0x50000000 (RM0444 section 7.5) */
#define GPIOA_MODER (*(volatile uint32_t *)0x50000000U) /* offset 0x00 */
#define GPIOA_ODR (*(volatile uint32_t *)0x50000014U)   /* offset 0x14 */

int main(void) {
  /* The PLL: HSI16 / 1 x 8 / 2 = 64 MHz on PLLRCLK, with PLLREN set. */
  RCC_PLLCFGR = (1U << 29) | (1U << 28) | (8U << 8) | (0U << 4) | 2U;
  RCC_CR |= 1U << 24;              /* PLLON */
  while (!(RCC_CR & (1U << 25))) { /* PLLRDY */
  }

  /* SW = PLLRCLK, with LATENCY still 0. */
  RCC_CFGR = (RCC_CFGR & ~7U) | 2U;
  while (((RCC_CFGR >> 3) & 7U) != 2U) { /* SWS */
  }

  /* Blink PA5. */
  RCC_IOPENR |= 1U;
  GPIOA_MODER = (GPIOA_MODER & ~(3U << 10)) | (1U << 10);
  for (;;) {
    GPIOA_ODR ^= 1U << 5;
    for (volatile uint32_t i = 0; i < 200000U; i++) {
    }
  }
}
