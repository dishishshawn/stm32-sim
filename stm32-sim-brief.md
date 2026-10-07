# Project: local, extensible STM32 + breadboard simulator for learning bare-metal C

## Goal

A simulator that runs entirely on the learner's machine (offline, one command to start,
no account) where they wire parts on a virtual breadboard and run the real firmware
they would flash to a board: the unmodified `.elf` from `arm-none-eabi-gcc`, written at
the register level (`RCC->IOPENR`, `I2C1->CR2`, ...) with no HAL.

Two things set it apart from hosted simulators like Wokwi:

1. **Local and open.** MIT-licensed; runs offline; reloads automatically when the
   learner rebuilds their firmware.
2. **Built to be extended by learners and their AI coding assistants.** Adding a new
   part (sensor, IO expander, display) or a new peripheral (timer, UART) should be one
   file following a documented recipe, with a test next to it. The whole simulator can be
   driven from the command line, so an assistant can verify what it built.

## Principles

1. **Faithful, including silent failures.** Real hardware ignores many mistakes without
   any error. Reproduce that: GPIO writes with the port clock off do nothing, writing
   I2C TIMINGR while PE=1 has no effect, a read without setting the register pointer
   returns whatever register the pointer is on. Never "fix" the user's mistake.
2. **Then explain.** A diagnostics panel flags likely mistakes ("wrote GPIOB->MODER
   while RCC IOPENR.GPIOBEN = 0"). Explain; never change behavior.
3. **Make the invisible visible.** A live register view (named bits) and an I2C bus
   trace (START, address + R/W, ACK/NACK, data, STOP) matter more than graphics.
4. **Digital, not analog.** Each wire is high, low or floating; open-drain lines are
   wired-AND with pull-ups. No SPICE.
5. **Extension points are the product.** Keep the core small; every part and peripheral
   goes through the same plain interface. No plugin loader or framework beyond what
   the parts below need.

## Research first

Write the findings to `docs/decisions.md` before writing code.

- CPU core: the STM32G031 is a Cortex-M0+ (ARMv6-M Thumb). Evaluate reusing an existing
  open-source ARMv6-M core, e.g. wokwi/rp2040js (TypeScript), Unicorn, Renode or QEMU,
  against writing one (ARMv6-M is a small instruction set). Check each license is
  compatible with MIT.
- Component visuals: evaluate @wokwi/elements (web components for LEDs, 7-segment
  displays, buttons) for reuse. Check the license.
- Pick one stack that runs locally with a single command, record why, and move on.

## Extension design

- **Part** = one file: its pins, its behavior (GPIO levels and/or an I2C target
  responding to address, read and write), its properties (address, variant) and its
  visual. Registered in one list.
- **Peripheral** = one file: base address, registers with reset values and named bits,
  read/write side effects, a clock-gate dependency. Registered in one list.
- **Diagnostic rule** = one small function over register writes and bus events.
- `docs/adding-a-part.md` and `docs/adding-a-peripheral.md`: step-by-step recipes using
  the TC74 and I2C1 as worked examples.
- `AGENTS.md` (also linked as `CLAUDE.md`): how to build, run, test; where the extension
  points are; the rule that every new part or peripheral ships with a headless test.
- A template file and a test template for each extension type.

## Command-line mode (drives everything without the UI)

- `sim run firmware.elf --circuit circuit.json --for 2s`, plus commands to set inputs
  (press button, set temperature) mid-run
- `sim inspect`: pins, peripheral registers (named bits), PC as file:line, I2C trace;
  `--json` on everything
- `sim watch firmware.elf`: reload when the ELF changes; the UI runs on top of the same
  engine
- Exit codes and JSON output stable enough for scripts, CI and AI assistants

## MVP scope: STM32G031K8 (NUCLEO-G031K8)

Peripherals (reset values from RM0444; log any access to an unimplemented register):

- Flash 0x08000000 and SRAM 0x20000000 (8 KB); vector table, reset handler; load ELF
  and its symbols
- RCC: IOPENR, APBENR1 (gate clocks: no clock means the peripheral ignores writes)
- GPIOA/GPIOB: MODER, OTYPER, PUPDR, IDR, ODR, BSRR, AFR[0..1]; the pin level
  comes from the breadboard net
- I2C1 master mode (I2C "v2"): CR1 (PE), CR2 (SADD, RD_WRN, NBYTES, START, STOP,
  AUTOEND), ISR (TXE, TXIS, RXNE, NACKF, STOPF, TC, BERR, ARLO, BUSY), ICR, TXDR, RXDR,
  TIMINGR; alternate function AF6 on PB6/PB7; a bus held low means BUSY and no START
- SysTick (LOAD, VAL, CTRL, COUNTFLAG) driven by a 16 MHz core clock; speed control
  (real time / max)

Parts:

- TC74 temperature sensor: address by variant (A0 to A7 = 0x48 to 0x4F); register
  0x00 = temperature (signed 8-bit), 0x01 = config (SHDN bit 7, DATA_RDY bit 6);
  temperature set from a slider
- MCP23017: address 0x20 to 0x27 from A2-A0; full register map (BANK=0): IODIR, IPOL,
  GPPU (100k pull-ups), GPIO, OLAT, IOCON; register pointer auto-increments; RESET
  active-low (floating or low means it NACKs everything)
- 7-segment digit, common-anode and common-cathode
- Push button, LED, pull-up resistor, wires, GND and 3V3 rails

Out of scope for MVP: interrupts/EXTI (the first extension to add, using the recipe),
timers, UART, ADC, analog behavior, cycle-exact timing, other chips.

## UI

Breadboard with drag-and-drop parts and wires; circuits saved as readable JSON
(diff-friendly, hand-editable); register view; I2C trace; diagnostics; pause / resume /
step with the current source line.

## Acceptance

1. Every test runs headless in CI.
2. An example firmware written for this repo (not taken from any course assignment):
   reads the TC74, shows the temperature on two 7-segment digits through an MCP23017, and
   a button on GPB0 toggles °C/°F. Test: slider at 22 shows "22"; after one press it
   shows 71 (22 °C = 71.6 °F, truncated); a second press shows 22 again.
3. Fault tests, each failing the same way real hardware does:
   - GPIOA clock enabled when the pins are on GPIOB: I2C never starts
   - No pull-ups on SDA/SCL: firmware hangs waiting on TXIS, with BUSY set
   - MCP23017 RESET left floating: every address NACKs
   - Segments wired one pin off: the digits come out scrambled
   - Common-anode display driven with common-cathode patterns: wrong segments light
4. Extensibility check: following only `docs/adding-a-part.md`, add a new I2C part (for
   example a TMP102 temperature sensor) with its test, without touching core files
   other than the one registration list.

## Build order

Each step ends in a passing headless test.

1. CPU, memory, ELF loading, `sim run` / `sim inspect`; firmware toggles a GPIO pin
2. SysTick delays
3. I2C1 and the TC74, with the bus trace
4. MCP23017 and the 7-segment display
5. Button and pull-ups
6. Extension recipes, templates, AGENTS.md; do acceptance check 4
7. Breadboard UI on top of the same engine; `sim watch`
8. Register view, diagnostics, stepping

## Repo

MIT license, README with a GIF and a "your first part in 10 minutes" section, CI
running the headless tests. Vendored ST CMSIS headers are Apache-2.0: keep their
license file next to them.
