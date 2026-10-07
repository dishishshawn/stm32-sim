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
#include <stdint.h>

/* Registers, the same ones as tc74-read's, each defined by its address: the
   peripheral's base address from RM0444's memory map (§2.2.2, Table 6), plus
   the register's offset from its own section.
     RCC    0x4002 1000  IOPENR  + 0x34 (§5.4.13), APBENR1 + 0x3C (§5.4.15)
     GPIOB  0x5000 0400  MODER   + 0x00 (§7.5.1),  OTYPER  + 0x04 (§7.5.2),
                         AFRL    + 0x20 (§7.5.9)
     I2C1   0x4000 5400  CR1     + 0x00 (§32.9.1), CR2     + 0x04 (§32.9.2),
                         TIMINGR + 0x10 (§32.9.5), ISR     + 0x18 (§32.9.7),
                         ICR     + 0x1C (§32.9.8), RXDR    + 0x24 (§32.9.10),
                         TXDR    + 0x28 (§32.9.11)
   SysTick is in the Cortex-M0+ core, not in RM0444: see blink-systick-poll. */
#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)
#define RCC_APBENR1 (*(volatile uint32_t *)0x4002103CU)
#define GPIOB_MODER (*(volatile uint32_t *)0x50000400U)
#define GPIOB_OTYPER (*(volatile uint32_t *)0x50000404U)
#define GPIOB_AFRL (*(volatile uint32_t *)0x50000420U)
#define I2C1_CR1 (*(volatile uint32_t *)0x40005400U)
#define I2C1_CR2 (*(volatile uint32_t *)0x40005404U)
#define I2C1_TIMINGR (*(volatile uint32_t *)0x40005410U)
#define I2C1_ISR (*(volatile uint32_t *)0x40005418U)
#define I2C1_ICR (*(volatile uint32_t *)0x4000541CU)
#define I2C1_RXDR (*(volatile uint32_t *)0x40005424U)
#define I2C1_TXDR (*(volatile uint32_t *)0x40005428U)
#define SysTick_CTRL (*(volatile uint32_t *)0xE000E010U)
#define SysTick_LOAD (*(volatile uint32_t *)0xE000E014U)
#define SysTick_VAL (*(volatile uint32_t *)0xE000E018U)

/* The bits used, from each register's section in RM0444. */
#define RCC_IOPENR_GPIOBEN (1U << 1)
#define RCC_APBENR1_I2C1EN (1U << 21)
#define I2C_CR1_PE (1U << 0)       /* peripheral enable */
#define I2C_CR2_RD_WRN (1U << 10)  /* 1: read, 0: write */
#define I2C_CR2_START (1U << 13)   /* send START (or a repeated START) */
#define I2C_CR2_AUTOEND (1U << 25) /* send STOP after NBYTES by itself */
#define I2C_ISR_TXIS (1U << 1)
#define I2C_ISR_RXNE (1U << 2)
#define I2C_ISR_NACKF (1U << 4)
#define I2C_ISR_STOPF (1U << 5)
#define I2C_ISR_TC (1U << 6)
#define I2C_ICR_NACKCF (1U << 4)
#define I2C_ICR_STOPCF (1U << 5)
#define SysTick_CTRL_ENABLE (1U << 0)
#define SysTick_CTRL_TICKINT (1U << 1)
#define SysTick_CTRL_CLKSOURCE (1U << 2)

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

/* CR2's address field, SADD (bits 9:0), holds a 7-bit address in bits 7:1,
   so the address goes in shifted up by one; NBYTES is bits 23:16 (RM0444
   §32.9.2). */
#define CR2_ADDR(a) ((uint32_t)(a) << 1)
#define CR2_BYTES(n) ((uint32_t)(n) << 16)

/* Waits for `flag` in I2C1_ISR and returns 0. If the target NACKs instead,
   the I2C sends a STOP by itself (§32.4.9): wait for it, clear NACKF and
   STOPF so the next transfer starts clean, and return -1. NACKF is checked
   first, so a NACK of the last byte (which still ends in STOPF) is seen. */
static int wait_for(uint32_t flag) {
  for (;;) {
    uint32_t isr = I2C1_ISR;
    if (isr & I2C_ISR_NACKF) {
      while (!(I2C1_ISR & I2C_ISR_STOPF)) {
      }
      I2C1_ICR = I2C_ICR_NACKCF | I2C_ICR_STOPCF;
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
  I2C1_CR2 = CR2_ADDR(addr) | CR2_BYTES(n) | I2C_CR2_AUTOEND | I2C_CR2_START;
  for (uint32_t i = 0; i < n; i++) {
    if (wait_for(I2C_ISR_TXIS))
      return -1;
    I2C1_TXDR = data[i];
  }
  if (wait_for(I2C_ISR_STOPF))
    return -1;
  I2C1_ICR = I2C_ICR_STOPCF;
  return 0;
}

/* Reads register `reg` of the target at `addr`: write the register address,
   then a repeated START and read one byte, as tc74_read in tc74-read does.
     S addr+W A reg A  Sr addr+R A <value> NA P
   Returns 0, or -1 on a NACK. */
static int i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *value) {
  I2C1_CR2 = CR2_ADDR(addr) | CR2_BYTES(1) | I2C_CR2_START; /* AUTOEND = 0 */
  if (wait_for(I2C_ISR_TXIS))
    return -1;
  I2C1_TXDR = reg;
  if (wait_for(I2C_ISR_TC))
    return -1;
  I2C1_CR2 = CR2_ADDR(addr) | I2C_CR2_RD_WRN | CR2_BYTES(1) | I2C_CR2_AUTOEND |
             I2C_CR2_START;
  if (wait_for(I2C_ISR_RXNE))
    return -1;
  *value = (uint8_t)I2C1_RXDR; /* reading RXDR clears RXNE */
  if (wait_for(I2C_ISR_STOPF))
    return -1;
  I2C1_ICR = I2C_ICR_STOPCF;
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
  RCC_IOPENR |= RCC_IOPENR_GPIOBEN;
  RCC_APBENR1 |= RCC_APBENR1_I2C1EN;
  (void)RCC_APBENR1;
  GPIOB_OTYPER |= (1U << 6) | (1U << 7); /* OT6 = OT7 = 1 */
  GPIOB_AFRL = (GPIOB_AFRL & ~((0xFU << 24) | (0xFU << 28))) | // clear
               (6U << 24) | (6U << 28);                        // set
  GPIOB_MODER = (GPIOB_MODER & ~((3U << 12) | (3U << 14))) |   // clear
                (2U << 12) | (2U << 14);                       // set
  I2C1_TIMINGR = (0x3U << 28) | // PRESC,  bits 31:28
                 (0x4U << 20) | // SCLDEL, bits 23:20
                 (0x2U << 16) | // SDADEL, bits 19:16
                 (0x0FU << 8) | // SCLH,   bits 15:8
                 (0x13U << 0);  // SCLL,   bits 7:0
  I2C1_CR1 |= I2C_CR1_PE;

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
  SysTick_LOAD = CPU_HZ / 1000U - 1U;
  SysTick_VAL = 0U;
  SysTick_CTRL =
      SysTick_CTRL_CLKSOURCE | SysTick_CTRL_TICKINT | SysTick_CTRL_ENABLE;

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
