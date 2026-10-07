/*
 * clock-off: a mistake on purpose, for the diagnostics to explain.
 *
 * It means to blink PB3, but turns on GPIOA's clock instead of GPIOB's. With
 * its clock off, GPIOB ignores every write, so PB3 never changes and nothing
 * says why. The simulator does the same: it never fixes the firmware's
 * mistake. `sim run` explains it with a gpio-clock-off diagnostic for each
 * access GPIOB ignored. The fix is RCC_IOPENR_GPIOBEN, bit 1.
 *
 * Register addresses: RM0444's memory map (§2.2.2, Table 6) plus the
 * register's offset.
 *   RCC_IOPENR    RCC   0x4002 1000 + 0x34  (§5.4.13)
 *   GPIOB_MODER   GPIOB 0x5000 0400 + 0x00  (§7.5.1)
 *   GPIOB_ODR     GPIOB 0x5000 0400 + 0x14  (§7.5.6)
 */
#include <stdint.h>

#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)
#define GPIOB_MODER (*(volatile uint32_t *)0x50000400U)
#define GPIOB_ODR (*(volatile uint32_t *)0x50000414U)

#define RCC_IOPENR_GPIOAEN (1U << 0)
#define RCC_IOPENR_GPIOBEN (1U << 1) /* the fix: PB3 needs this one */

#define DELAY_LOOPS 200000U

static void delay(uint32_t loops) {
  for (volatile uint32_t i = 0; i < loops; i++) {
  }
}

int main(void) {
  RCC_IOPENR |= RCC_IOPENR_GPIOAEN; /* the mistake: PB3 is on GPIOB */

  GPIOB_MODER = (GPIOB_MODER & ~(3U << 6)) | (1U << 6); /* MODE3 = 01 */

  for (;;) {
    GPIOB_ODR ^= (1U << 3); /* OD3 */
    delay(DELAY_LOOPS);
  }
}
