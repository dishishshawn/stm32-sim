/*
 * thermometer: read a TC74 and show the temperature on two 7-segment digits,
 * driven through an MCP23017 I/O expander. A button toggles °C and °F.
 *
 * Everything hangs off one I2C bus, I2C1 on PB6 (SCL) and PB7 (SDA), with a
 * 4.7 kΩ pull-up on each line:
 *   TC74A0    at 0x48: the temperature sensor (see firmware/tc74-read);
 *   MCP23017  at 0x20: 16 I/O pins, set and read over I2C (A2..A0 tied to
 *             GND give 0x20; its RESET pin is tied to 3.3 V, since a low or
 *             floating RESET holds the chip in reset and it answers nothing).
 *
 * The MCP23017's pins (Microchip DS20001952, "MCP23017"):
 *   GPA0..GPA6  tens digit, segments A..G     outputs
 *   GPA7        unused                        output, low
 *   GPB0        the button, to GND            input, internal pull-up on
 *   GPB1..GPB7  units digit, segments A..G    outputs
 * The digits are common cathode: their COM pin goes to GND and a segment
 * lights when its pin is high.
 *
 * What it does:
 *   - every 250 ms, read the TC74 and redraw;
 *   - every 20 ms, read the MCP23017's GPIOB register and look at GPB0. The
 *     pull-up holds it at 1; pressing the button pulls it to 0. Each change
 *     from 1 to 0 (a press, not a release) toggles °C/°F and redraws.
 *
 * What it shows:
 *   0..9 as " 5" (no leading zero), 10..99 as "42", anything else "--"
 *   (below 0, or above 99: 38 °C and up reads over 99 in °F).
 */
#include "stm32g0xx.h"

#define CPU_HZ 16000000U
#define MS_PER_READ 250U /* the TC74 converts 8 times a second, at best */
#define MS_PER_POLL 20U  /* the button: see "Debouncing" in main() */

#define TC74_ADDR 0x48U /* TC74A0 */
#define TC74_TEMP 0x00U /* its TEMP register */

/* MCP23017 at 0x20 (0b0100 A2 A1 A0, all three to GND). Its registers, with
   IOCON.BANK = 0 as after power-on: the A and B registers of a pair sit side
   by side (DS20001952, Table 3-5). */
#define MCP_ADDR 0x20U
#define MCP_IODIRA 0x00U /* 1 = input, 0 = output; IODIRB is next, 0x01 */
#define MCP_GPPUB 0x0DU  /* 1 = 100 kΩ pull-up on that input */
#define MCP_GPIOB 0x13U  /* reading gives the pin levels */
#define MCP_OLATA                                                              \
  0x14U /* the output latch: what output pins drive; OLATB next */

#define BUTTON 0x01U /* GPB0's bit in GPIOB */

/* The last temperature read, in °C, and the unit shown. Globals, so a
   debugger (or the simulator's tests) can find them by name. */
volatile int8_t g_temp;
volatile uint8_t g_fahrenheit;

static volatile uint32_t ms; /* milliseconds since SysTick started */

void SysTick_Handler(void) { ms++; }

/* ----- I2C1: the helpers from firmware/tc74-read, for any target -------- */

/* CR2's SADD field holds a 7-bit address in bits 7:1 (RM0444 §32.9.2). */
#define CR2_ADDR(a) (((uint32_t)(a) << 1) << I2C_CR2_SADD_Pos)
#define CR2_BYTES(n) ((uint32_t)(n) << I2C_CR2_NBYTES_Pos)

/* Waits for `flag` in I2C1->ISR and returns 0. If the target NACKs instead,
   the I2C sends a STOP by itself (§32.4.9): wait for it, clear NACKF and
   STOPF so the next transfer starts clean, and return -1. NACKF is checked
   first, so a NACK of the last byte (which still ends in STOPF) is seen. */
static int wait_for(uint32_t flag) {
  for (;;) {
    uint32_t isr = I2C1->ISR;
    if (isr & I2C_ISR_NACKF) {
      while (!(I2C1->ISR & I2C_ISR_STOPF)) {
      }
      I2C1->ICR = I2C_ICR_NACKCF | I2C_ICR_STOPCF;
      return -1;
    }
    if (isr & flag)
      return 0;
  }
}

/* Writes `n` bytes to the target at `addr` in one transfer:
     S addr+W A data[0] A data[1] A ... P
   With AUTOEND = 1 the I2C sends STOP by itself after the last byte.
   Returns 0, or -1 on a NACK. */
static int i2c_write(uint8_t addr, const uint8_t *data, uint32_t n) {
  I2C1->CR2 = CR2_ADDR(addr) | CR2_BYTES(n) | I2C_CR2_AUTOEND | I2C_CR2_START;
  for (uint32_t i = 0; i < n; i++) {
    if (wait_for(I2C_ISR_TXIS))
      return -1;
    I2C1->TXDR = data[i];
  }
  if (wait_for(I2C_ISR_STOPF))
    return -1;
  I2C1->ICR = I2C_ICR_STOPCF;
  return 0;
}

/* Reads register `reg` of the target at `addr`: write the register address,
   then a repeated START and read one byte, as tc74_read in tc74-read does.
     S addr+W A reg A  Sr addr+R A <value> NA P
   Returns 0, or -1 on a NACK. */
static int i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *value) {
  I2C1->CR2 = CR2_ADDR(addr) | CR2_BYTES(1) | I2C_CR2_START; /* AUTOEND = 0 */
  if (wait_for(I2C_ISR_TXIS))
    return -1;
  I2C1->TXDR = reg;
  if (wait_for(I2C_ISR_TC))
    return -1;
  I2C1->CR2 = CR2_ADDR(addr) | I2C_CR2_RD_WRN | CR2_BYTES(1) | I2C_CR2_AUTOEND |
              I2C_CR2_START;
  if (wait_for(I2C_ISR_RXNE))
    return -1;
  *value = (uint8_t)I2C1->RXDR; /* reading RXDR clears RXNE */
  if (wait_for(I2C_ISR_STOPF))
    return -1;
  I2C1->ICR = I2C_ICR_STOPCF;
  return 0;
}

/* ----- The display ------------------------------------------------------ */

/* Which segments make each digit, one bit per segment: bit 0 is A, bit 1 B,
   ... bit 6 G. The segments, as on every 7-segment datasheet:
        A
      F   B
        G
      E   C
        D
   With common-cathode digits a 1 bit (pin high) lights the segment. */
static const uint8_t DIGITS[10] = {
    0x3F, /* 0: A B C D E F   */
    0x06, /* 1:   B C         */
    0x5B, /* 2: A B   D E   G */
    0x4F, /* 3: A B C D     G */
    0x66, /* 4:   B C     F G */
    0x6D, /* 5: A   C D   F G */
    0x7D, /* 6: A   C D E F G */
    0x07, /* 7: A B C         */
    0x7F, /* 8: all seven     */
    0x6F, /* 9: A B C D   F G */
};
#define DASH 0x40U /* G alone: "-" */
#define BLANK 0x00U

/* Shows `value` on the two digits, in one I2C transfer. The MCP23017 moves
   its register pointer on by one after each byte (sequential mode, IOCON.SEQOP
   = 0, the power-on setting; §3.2.1), so after the register address OLATA
   the first data byte lands in OLATA and the second in OLATB. The units
   digit is on GPB1..GPB7, so its pattern is shifted up one bit; bit 0 is
   GPB0, the button, an input, which the latch doesn't affect. */
static void show(int value) {
  uint8_t tens = DASH, units = DASH;
  if (value >= 0 && value <= 99) {
    tens = value >= 10 ? DIGITS[value / 10] : BLANK;
    units = DIGITS[value % 10];
  }
  const uint8_t msg[] = {MCP_OLATA, tens, (uint8_t)(units << 1)};
  i2c_write(MCP_ADDR, msg, sizeof msg); /* a NACK: the next redraw retries */
}

/* °F = °C × 9/5 + 32, truncated toward zero, which is what C's integer
   division does. Written as (9C + 160) / 5 so the whole result is truncated
   once: C*9/5 + 32 would truncate C*9/5 first and get -1 °C (30.2 °F) as 31.
   22 °C: (198 + 160) / 5 = 358 / 5 = 71 (71.6). */
static void redraw(void) {
  int c = g_temp;
  show(g_fahrenheit ? (c * 9 + 160) / 5 : c);
}

/* ----- main ------------------------------------------------------------- */

int main(void) {
  /* 1. I2C1 on PB6/PB7 at 100 kHz, exactly as in tc74-read (see its steps
        1 to 4 for each value): clocks, pins to AF6 open drain, timing, PE. */
  RCC->IOPENR |= RCC_IOPENR_GPIOBEN;
  RCC->APBENR1 |= RCC_APBENR1_I2C1EN;
  (void)RCC->APBENR1;
  GPIOB->OTYPER |= GPIO_OTYPER_OT6 | GPIO_OTYPER_OT7;
  GPIOB->AFR[0] =
      (GPIOB->AFR[0] & ~(GPIO_AFRL_AFSEL6_Msk | GPIO_AFRL_AFSEL7_Msk)) |
      (6U << GPIO_AFRL_AFSEL6_Pos) | (6U << GPIO_AFRL_AFSEL7_Pos);
  GPIOB->MODER =
      (GPIOB->MODER & ~(GPIO_MODER_MODE6_Msk | GPIO_MODER_MODE7_Msk)) |
      GPIO_MODER_MODE6_1 | GPIO_MODER_MODE7_1;
  I2C1->TIMINGR =
      (0x3U << I2C_TIMINGR_PRESC_Pos) | (0x4U << I2C_TIMINGR_SCLDEL_Pos) |
      (0x2U << I2C_TIMINGR_SDADEL_Pos) | (0x0FU << I2C_TIMINGR_SCLH_Pos) |
      (0x13U << I2C_TIMINGR_SCLL_Pos);
  I2C1->CR1 |= I2C_CR1_PE;

  /* 2. The MCP23017. After power-on every pin is an input (IODIR = 0xFF)
        and every latch is 0, so the digits are dark until the first redraw.
        IODIRA = 0x00: port A all outputs. IODIRB = 0x01: GPB0 an input, the
        rest outputs. Both in one write, IODIRB following IODIRA. Then GPPUB
        = 0x01: GPB0's pull-up, so the button reads 1 until pressed. */
  const uint8_t iodir[] = {MCP_IODIRA, 0x00, BUTTON};
  const uint8_t gppu[] = {MCP_GPPUB, BUTTON};
  i2c_write(MCP_ADDR, iodir, sizeof iodir);
  i2c_write(MCP_ADDR, gppu, sizeof gppu);

  /* 3. A 1 ms SysTick interrupt, as in blink-systick-irq. */
  SysTick->LOAD = CPU_HZ / 1000U - 1U;
  SysTick->VAL = 0U;
  SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_TICKINT_Msk |
                  SysTick_CTRL_ENABLE_Msk;

  /* Debouncing. A button's contacts bounce for a few ms when pressed or
     released, reading 0 1 0 1 0... before they settle. Looking only every
     20 ms, longer than the bounce, at most one look lands in it, and it
     reads either the old or the new level: so one press gives one 1 -> 0
     change, never several. */
  uint32_t last_read = 0, last_poll = 0;
  uint8_t was_down = 0, have_temp = 0;
  for (;;) {
    if (ms - last_poll >= MS_PER_POLL) {
      last_poll += MS_PER_POLL;
      uint8_t gpiob;
      if (i2c_read_reg(MCP_ADDR, MCP_GPIOB, &gpiob) == 0) {
        uint8_t down = !(gpiob & BUTTON); /* pressed pulls GPB0 to 0 */
        if (down && !was_down) {
          g_fahrenheit = !g_fahrenheit;
          if (have_temp)
            redraw();
        }
        was_down = down;
      }
    }
    /* The first read is at 250 ms: until the TC74's first conversion is
       done, TEMP reads 0 (see tc74-read). On a NACK, try again next time. */
    if (ms - last_read >= MS_PER_READ) {
      last_read += MS_PER_READ;
      uint8_t t;
      if (i2c_read_reg(TC74_ADDR, TC74_TEMP, &t) == 0) {
        g_temp = (int8_t)t; /* TEMP is a signed byte */
        have_temp = 1;
        redraw();
      }
    }
  }
}
