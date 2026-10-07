/*
 * clock-off: a mistake on purpose, for the diagnostics to explain.
 *
 * It means to blink PB3, but turns on GPIOA's clock instead of GPIOB's. With
 * its clock off, GPIOB ignores every write, so PB3 never changes and nothing
 * says why. The simulator does the same: it never fixes the firmware's
 * mistake. `sim run` explains it with a gpio-clock-off diagnostic for each
 * access GPIOB ignored. The fix is RCC_IOPENR_GPIOBEN.
 */
#include "stm32g0xx.h"

#define DELAY_LOOPS 200000U

static void delay(uint32_t loops) {
  for (volatile uint32_t i = 0; i < loops; i++) {
  }
}

int main(void) {
  RCC->IOPENR |= RCC_IOPENR_GPIOAEN; /* the mistake: PB3 is on GPIOB */

  GPIOB->MODER = (GPIOB->MODER & ~GPIO_MODER_MODE3_Msk) | GPIO_MODER_MODE3_0;

  for (;;) {
    GPIOB->ODR ^= GPIO_ODR_OD3;
    delay(DELAY_LOOPS);
  }
}
