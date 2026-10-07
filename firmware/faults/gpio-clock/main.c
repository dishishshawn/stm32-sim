/*
 * faults/gpio-clock: tc74-read with one mistake on purpose (acceptance 3).
 *
 * Step 1 turns on GPIOA's clock instead of GPIOB's. With its clock off, GPIOB
 * ignores every write (RM0444 §5.2.17), so PB6/PB7 stay in analog mode (the
 * MODER reset value), I2C1 is never connected to them, and nothing ever
 * appears on the bus. The wait loops have no timeout, so the firmware sits in
 * wait_for() forever and nothing says why. The fix is RCC_IOPENR_GPIOBEN.
 * Everything below is tc74-read's, apart from that one line.
 */

/*
 * tc74-read: read a TC74 temperature sensor over I2C1, four times a second.
 *
 * The TC74 (Microchip DS21462) is an I2C target. A TC74A0 answers address
 * 0x48 (the A0..A7 parts are 0x48..0x4F). Its register 0x00, TEMP, holds the
 * temperature in whole degrees Celsius as a signed byte. Reading it takes two
 * transfers, joined by a repeated START:
 *   1. write one byte, 0x00, which points the TC74 at TEMP;
 *   2. read one byte: TEMP.
 * On the bus:   S 0x48+W A 0x00 A  Sr 0x48+R A <temp> NA P
 * (S START, Sr repeated START, A ACK, NA NACK, P STOP.)
 *
 * The STM32G0's I2C does the bit-level work itself. The firmware writes the
 * address, the byte count and the direction to CR2 in one go, sets START, and
 * from then on only watches flags in ISR:
 *   TXIS   write the next byte to TXDR
 *   TC     all NBYTES done: send a repeated START or a STOP
 *   RXNE   a byte has arrived in RXDR
 *   NACKF  the target didn't answer; the I2C sends a STOP by itself
 *   STOPF  the STOP has gone out
 * The reference manual, RM0444, covers the I2C in chapter 32. §32.4.9 draws
 * each transfer as a flowchart: Figure 301 for writing, Figure 304 for reading.
 *
 * Wiring (circuit.json): PB6 is SCL, to the TC74's SCLK; PB7 is SDA, to its
 * SDA; each line has a 4.7 kΩ pull-up to 3.3 V. I2C lines are open drain:
 * every device only ever pulls a line low or lets go of it, and the resistor
 * pulls it back high. Without the pull-ups the bus never looks free, and the
 * I2C never sends START.
 */
#include "stm32g0xx.h"

#define CPU_HZ 16000000U
#define MS_PER_READ 250U

#define TC74_ADDR 0x48U /* TC74A0. The usual part, TC74A5, is 0x4D. */
#define TC74_TEMP 0x00U /* the TEMP register's command code */

/* The last temperature read, in °C. Global and volatile so a debugger (or
   the simulator's tests) can find it by name and always sees the latest. */
volatile int8_t g_temp;

/* Milliseconds since SysTick started, as in blink-systick-irq. */
static volatile uint32_t ms;

void SysTick_Handler(void) { ms++; }

/* CR2's address field, SADD, holds a 7-bit address in bits 7:1 (§32.9.2). */
#define CR2_TC74 ((TC74_ADDR << 1) << I2C_CR2_SADD_Pos)
#define CR2_ONE_BYTE (1U << I2C_CR2_NBYTES_Pos)

/* Waits for `flag` in I2C1->ISR and returns 0. If the target NACKs instead,
   the I2C sends a STOP by itself (§32.4.9): wait for it, clear NACKF and
   STOPF so the next transfer starts clean, and return -1. */
static int wait_for(uint32_t flag) {
  for (;;) {
    uint32_t isr = I2C1->ISR;
    if (isr & flag)
      return 0;
    if (isr & I2C_ISR_NACKF) {
      while (!(I2C1->ISR & I2C_ISR_STOPF)) {
      }
      I2C1->ICR = I2C_ICR_NACKCF | I2C_ICR_STOPCF;
      return -1;
    }
  }
}

/* Reads TC74 register `reg` into *value. Returns 0, or -1 on a NACK. */
static int tc74_read(uint8_t reg, int8_t *value) {
  /* 1. Write the pointer: one byte, and AUTOEND = 0, so once it is sent the
        I2C sets TC and holds the bus for a repeated START instead of
        sending STOP. */
  I2C1->CR2 = CR2_TC74 | CR2_ONE_BYTE | I2C_CR2_START;
  if (wait_for(I2C_ISR_TXIS))
    return -1;
  I2C1->TXDR = reg;
  if (wait_for(I2C_ISR_TC))
    return -1;

  /* 2. Read one byte. Setting START again, now with RD_WRN = 1, sends the
        repeated START. AUTOEND = 1: after the byte the I2C NACKs it (telling
        the TC74 "no more") and sends STOP by itself. */
  I2C1->CR2 = CR2_TC74 | I2C_CR2_RD_WRN | CR2_ONE_BYTE | I2C_CR2_AUTOEND |
              I2C_CR2_START;
  if (wait_for(I2C_ISR_RXNE))
    return -1;
  *value = (int8_t)I2C1->RXDR; /* reading RXDR clears RXNE */
  wait_for(I2C_ISR_STOPF);
  I2C1->ICR = I2C_ICR_STOPCF;
  return 0;
}

int main(void) {
  /* 1. Clocks for GPIOB (RCC_IOPENR, RM0444 §5.4.13) and I2C1
        (RCC_APBENR1, §5.4.15). A clock starts 2 cycles after its enable bit
        is set (§5.2.17); reading the register back covers that. */
  RCC->IOPENR |= RCC_IOPENR_GPIOAEN; /* the mistake: PB6/PB7 are on GPIOB */
  RCC->APBENR1 |= RCC_APBENR1_I2C1EN;
  (void)RCC->APBENR1;

  /* 2. Hand PB6 and PB7 to I2C1: alternate function 6 (DS12992, the
        STM32G031 datasheet, Table 14), open drain (OTYPER = 1) so the pin
        only pulls low or lets go. The AF number and output type go in first,
        then MODER = 10 (alternate function), so the pins never drive the bus
        as anything else on the way. PUPDR stays 00, no internal pull-ups:
        the circuit has its own 4.7 kΩ ones. Registers: RM0444 §7.5. */
  GPIOB->OTYPER |= GPIO_OTYPER_OT6 | GPIO_OTYPER_OT7;
  GPIOB->AFR[0] =
      (GPIOB->AFR[0] & ~(GPIO_AFRL_AFSEL6_Msk | GPIO_AFRL_AFSEL7_Msk)) |
      (6U << GPIO_AFRL_AFSEL6_Pos) | (6U << GPIO_AFRL_AFSEL7_Pos);
  GPIOB->MODER =
      (GPIOB->MODER & ~(GPIO_MODER_MODE6_Msk | GPIO_MODER_MODE7_Msk)) |
      GPIO_MODER_MODE6_1 | GPIO_MODER_MODE7_1;

  /* 3. 100 kHz, from RM0444 Table 173 (I2CCLK = 16 MHz; after reset I2C1
        runs from PCLK, which is 16 MHz). PRESC = 3 makes the I2C's time unit
        4 clocks, 250 ns; SCL is low for SCLL + 1 = 20 units (5 µs) and high
        for SCLH + 1 = 16 (4 µs). SDADEL and SCLDEL set the data hold and
        setup times. TIMINGR only takes a write while PE = 0 (§32.9.5): it is
        0 after reset, so set the timing before enabling. */
  I2C1->TIMINGR =
      (0x3U << I2C_TIMINGR_PRESC_Pos) | (0x4U << I2C_TIMINGR_SCLDEL_Pos) |
      (0x2U << I2C_TIMINGR_SDADEL_Pos) | (0x0FU << I2C_TIMINGR_SCLH_Pos) |
      (0x13U << I2C_TIMINGR_SCLL_Pos);

  /* 4. Enable the I2C. */
  I2C1->CR1 |= I2C_CR1_PE;

  /* 5. A 1 ms SysTick interrupt, as in blink-systick-irq. */
  SysTick->LOAD = CPU_HZ / 1000U - 1U;
  SysTick->VAL = 0U;
  SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_TICKINT_Msk |
                  SysTick_CTRL_ENABLE_Msk;

  /* Read TEMP every 250 ms. The first read is 250 ms after reset: the TC74
     can take that long after power-on to finish its first conversion, and
     TEMP reads 0 until then (DS21462, DC characteristics, note 2). On a NACK
     g_temp keeps its last value and the next period tries again. */
  uint32_t last = 0;
  for (;;) {
    if (ms - last >= MS_PER_READ) {
      last += MS_PER_READ;
      int8_t t;
      if (tc74_read(TC74_TEMP, &t) == 0)
        g_temp = t;
    }
  }
}
