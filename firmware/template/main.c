/*
 * template: a starting point in exam style. Copy this folder to
 * firmware/<name>/ and `just fw` builds it into build/<name>.elf.
 *
 * No ST header: define each register you use by its address. To find an
 * address in RM0444:
 *   1. the peripheral's base address is in the memory map, §2.2.2, Table 6
 *      ("peripheral register boundary addresses"): RCC is at 0x4002 1000,
 *      GPIOA at 0x5000 0000, GPIOB at 0x5000 0400;
 *   2. the register's offset is at the top of its own section, under
 *      "Address offset": RCC_IOPENR (§5.4.13) is 0x34, GPIOx_MODER (§7.5.1)
 *      0x00, GPIOx_ODR (§7.5.6) 0x14;
 *   3. address = base + offset: RCC_IOPENR is 0x4002 1000 + 0x34, 0x40021034.
 * The same section's bit table gives each bit's position.
 *
 * The vector table and the reset handler come from ST's startup file,
 * vendor/cmsis-device-g0/startup_stm32g031xx.s, which firmware/Makefile links
 * into every program. The reset handler sets up RAM, calls SystemInit, then
 * main(). So this file only needs main(), plus any interrupt handler you add,
 * named as in the startup file's vector table (SysTick_Handler, ...).
 */
#include <stdint.h>

#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)
#define GPIOA_MODER (*(volatile uint32_t *)0x50000000U)
#define GPIOA_ODR (*(volatile uint32_t *)0x50000014U)

int main(void) {
  /* 1. Turn on GPIOA's clock: GPIOAEN, bit 0 of RCC_IOPENR. */
  RCC_IOPENR |= (1U << 0);

  /* 2. PA5 as an output: MODE5, bits 11:10 of GPIOA_MODER, = 01. Pin n's
        two MODER bits are 2n+1:2n. */
  GPIOA_MODER = (GPIOA_MODER & ~(3U << 10)) | (1U << 10);

  /* 3. PA5 high: OD5, bit 5 of GPIOA_ODR. */
  GPIOA_ODR |= (1U << 5);

  for (;;) {
    /* Your code here. */
  }
}
