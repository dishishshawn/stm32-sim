/*
 * blink: toggle pin PA0 on and off forever.
 *
 * Every GPIO program on the STM32G0 takes the same three steps:
 *   1. turn on the port's clock in RCC_IOPENR. With the clock off, the port
 *      ignores every write, silently;
 *   2. make the pin an output in GPIOx_MODER;
 *   3. drive it high or low through GPIOx_ODR.
 *
 * No ST header: each register is defined by its address, as in an exam. The
 * address is the peripheral's base address, from the memory map (RM0444
 * §2.2.2, Table 6), plus the register's offset, from the register's own
 * section:
 *   RCC_IOPENR    RCC   0x4002 1000 + 0x34  (§5.4.13)
 *   GPIOA_MODER   GPIOA 0x5000 0000 + 0x00  (§7.5.1)
 *   GPIOA_ODR     GPIOA 0x5000 0000 + 0x14  (§7.5.6)
 * `volatile` makes the compiler really read or write the register every time
 * the code says so, instead of keeping a copy in a CPU register.
 */
#include <stdint.h>

#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)
#define GPIOA_MODER (*(volatile uint32_t *)0x50000000U)
#define GPIOA_ODR (*(volatile uint32_t *)0x50000014U)

#define RCC_IOPENR_GPIOAEN (1U << 0)

/* How many times delay() goes round its loop between toggles. This is not a
   precise time: it depends on the code the compiler produces and on the clock.
   Built with -Og, one turn is about 10 cycles; at the 16 MHz reset clock,
   200000 turns is roughly 1/8 s, so the pin blinks about 4 times a second. */
#define DELAY_LOOPS 200000U

/* Busy-wait: burn time by counting. `volatile` makes the compiler really
   read and write i every time round, instead of deleting a loop that
   seems to do nothing. */
static void delay(uint32_t loops) {
  for (volatile uint32_t i = 0; i < loops; i++) {
  }
}

int main(void) {
  /* 1. Enable the GPIOA clock: set the GPIOAEN bit (bit 0) of RCC_IOPENR. */
  RCC_IOPENR |= RCC_IOPENR_GPIOAEN;

  /* 2. Make PA0 an output. Each pin has two MODER bits, pin n at bits
        2n+1:2n: 00 input, 01 output, 10 alternate function, 11 analog.
        After reset PA0 is 11 (analog), so clear both bits, then set 01. */
  GPIOA_MODER = (GPIOA_MODER & ~(3U << 0)) | (1U << 0); /* MODE0 = 01 */

  /* 3. Flip PA0 (bit 0 of ODR), wait, and repeat forever. */
  for (;;) {
    GPIOA_ODR ^= (1U << 0); /* OD0 */
    delay(DELAY_LOOPS);
  }
}
