/*
 * blink: toggle pin PA0 on and off forever.
 *
 * Every GPIO program on the STM32G0 takes the same three steps:
 *   1. turn on the port's clock in RCC->IOPENR. With the clock off, the port
 *      ignores every write, silently;
 *   2. make the pin an output in GPIOx->MODER;
 *   3. drive it high or low through GPIOx->ODR.
 *
 * The register and bit names (RCC, GPIOA, RCC_IOPENR_GPIOAEN, ...) come from
 * ST's stm32g031xx.h. The reference manual, RM0444, describes each register:
 * look up RCC_IOPENR in the RCC chapter, GPIOx_MODER and GPIOx_ODR in the GPIO
 * chapter.
 */

/* How many times delay() goes round its loop between toggles. This is not a
   precise time: it depends on the code the compiler produces and on the clock.
   Built with -Og, one turn is about 10 cycles; at the 16 MHz reset clock,
   200000 turns is roughly 1/8 s, so the pin blinks about 4 times a second. */
#include <stm32g0xx.h>

#define DELAY_LOOPS 200000U
#define RCC_IOPENR ((volatile uint32_t *)0x40021034)



/* Busy-wait: burn time by counting. `volatile` makes the compiler really
   read and write i every time round, instead of deleting a loop that
   seems to do nothing. */
static void delay(uint32_t loops) {
  for (volatile uint32_t i = 0; i < loops; i++) {
  }
}

int main(void) {
  /* 1. Enable the GPIOA clock: set the GPIOAEN bit (bit 0) of RCC_IOPENR. */
  RCC_IOPENR |= (uint32_t)1;

  /* 2. Make PA0 an output. Each pin has two MODER bits: 00 input, 01 output,
        10 alternate function, 11 analog. After reset PA0 is 11 (analog), so
        clear both bits, then set 01. */
  GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODE0_Msk) | GPIO_MODER_MODE0_0;

  /* 3. Flip PA0 (bit 0 of ODR), wait, and repeat forever. */
  for (;;) {
    GPIOA->ODR ^= GPIO_ODR_OD0;
    delay(DELAY_LOOPS);
  }
}
