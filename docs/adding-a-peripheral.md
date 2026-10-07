# Adding a peripheral

A peripheral is a block inside the chip that the firmware drives through its
registers: a GPIO port, the I2C controller, a timer, a UART. This recipe adds
one, step by step. The worked example is I2C1, `src/peripherals/i2c.ts` and
its test `src/peripherals/i2c.test.ts`; open them side by side with this page.

**Your change is three files:**

- a new `src/peripherals/<name>.ts`: the peripheral's behavior;
- a new `src/peripherals/<name>.test.ts`: its test;
- `src/chips/stm32g031k8.ts`: one import and one entry in its `peripherals`
  list, plus rows in its AF table if the peripheral has pins (step 8). **This
  is the only existing file you edit.**

The registers are not part of your change: they are already in
`src/chips/stm32g031k8.registers.json` (step 2).

If you find you need to change any other existing file (the memory bus, the
engine, the event types, the CLI, another peripheral), stop and report it
instead. It means the peripheral interface is missing something, and the fix
belongs in the interface, not in a workaround.

## 0. Before you start

Run every command from the repository root.

```sh
npm install   # only if node_modules/ is missing
just fw       # builds the example firmware; the end-to-end tests need it
just test     # everything passes before you change anything
```

Node 24 and `just` come from `.mise.toml` (`mise install`); `just fw` needs
`arm-none-eabi-gcc`.

Node runs the `.ts` files directly, with no build step, so:

- relative imports end in `.ts`;
- type-only imports use `import type`;
- no `enum`, `namespace`, or constructor parameter properties.

## 1. What a peripheral is

A peripheral is one object of type `Peripheral`, from
`src/peripherals/peripheral.ts`. The smallest one is FLASH,
`src/peripherals/flash.ts`, in full:

```ts
// FLASH: only FLASH_ACR is simulated, as plain storage, so LATENCY reads back what
// the firmware wrote. RM0444 §3.7.1: a new LATENCY "becomes effective when it
// returns the same value upon read", so firmware polls it (§3.3.4). Wait states
// aren't modelled: real silicon misreads flash when LATENCY is too low for HCLK
// (§3.3.4, Table 13), and a diagnostic, not the simulator, should say so (T42).
// Programming and option bytes (KEYR, SR, CR, OPTR, ...) stay plain storage,
// flagged "unsimulated". See docs/decisions.md §14.
import type { Peripheral } from "./peripheral.ts";

export const flash: Peripheral = {
  name: "FLASH",
  simulates: ["ACR"],
  create: () => ({}),
};
```

- `name` is the SVD peripheral name, its key in the register JSON: `"RCC"`,
  `"I2C1"`, `"TIM14"`.
- `gate` is the RCC enable bit its clock depends on (step 4). FLASH has none.
- `simulates` lists the registers it models, if not all of them. The others
  stay plain storage, flagged unsimulated. Leave it out to model them all.
- `create(ctx)` runs once, when the chip is built, and returns the instance.
  Keep the peripheral's own state (anything that isn't a register) in local
  variables inside `create()`.

`ctx` (a `PeripheralContext`) is what the peripheral can reach:

| `ctx.`         | What it is                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `regs`         | this peripheral's register values by name, e.g. `regs.CR1`: read and assign them directly       |
| `regsOf(name)` | another peripheral's registers, live and read-only, e.g. `regsOf("RCC").APBENR1`                |
| `now()`        | CPU cycles since reset: simulated time. A cycle lasts 1/HCLK (16 MHz after reset)               |
| `cpu`          | `setPending(exception)` raises an interrupt (step 7). Its other three methods are SCB's         |
| `nets`         | the circuit: `level`, `drive`, `setSwitch` and `listen` on endpoints such as `mcu.PB6` (step 8) |
| `parts`        | the circuit's mounted parts by id, live: I2C1's bus finds its targets here                      |
| `events`       | the event log, for events the peripheral makes itself (step 9)                                  |

`ctx.setCoreClock(hz)` is RCC's: it tells the engine that HCLK changed.

The instance (a `PeripheralInstance`) has these members, all optional:

| Member                     | Called when                                                                    | Step |
| -------------------------- | ------------------------------------------------------------------------------ | ---- |
| `write.<REG>(value, mask)` | the CPU writes register `REG`                                                  | 5    |
| `read.<REG>()`             | the CPU reads `REG`. Returns what the CPU gets                                 | 5    |
| `tick(cycles)`             | `cycles` CPU cycles passed: after every instruction                            | 6    |
| `reset()`                  | chip reset, after the bus has put every register back to its reset value (RCC) | 1    |

The memory bus does everything else, once, for every peripheral: address
decoding, byte and halfword accesses, reset values, the clock gate, and an
event for every access. A register with no hook is plain storage: a write
stores the value, a read returns it.

## 2. Find the registers

They are already there. `src/chips/stm32g031k8.registers.json` is converted
from ST's SVD, with stm32-rs's fixes (`docs/decisions.md` §4). It has every
register of every peripheral on the chip: offset, size, access, reset value
and named bits. List the peripherals, then one peripheral's registers, with:

```sh
node -p 'Object.keys(require("./src/chips/stm32g031k8.registers.json").peripherals).join(" ")'
node -p 'Object.keys(require("./src/chips/stm32g031k8.registers.json").peripherals.I2C1.registers).join(" ")'
```

which prints `CR1 CR2 OAR1 OAR2 TIMINGR TIMEOUTR ISR ICR PECR RXDR TXDR`.
One register, as the JSON has it:

```json
"TXDR": {
  "offset": "0x28",
  "size": 32,
  "access": "read-write",
  "resetValue": "0x00000000",
  "description": "Transmit data register",
  "fields": {
    "TXDATA": {
      "bitOffset": 0,
      "bitWidth": 8,
      "access": "read-write",
      "description": "8-bit transmit data"
    }
  }
}
```

- **Your file holds behavior only.** It never declares a register, an offset,
  a reset value or a bit position for the bus. The bus, `sim inspect`'s
  register view and the diagnostics all read those from the JSON.
- **Names.** Register names are the SVD's, which are mostly the CMSIS
  header's: `I2C1->TXDR` is `TXDR`. Field names are the CMSIS header's, as in
  the learner's code: `RCC_IOPENR_GPIOBEN` is field `GPIOBEN` of `IOPENR`.
  Where the header names a register differently (decisions.md §4 lists them),
  the JSON keeps the SVD's name: GPIO's `AFR[0]` is `AFRL`.
- Your hooks are keyed by those register names. A hook for a name that isn't
  in the JSON stops the chip from loading: `I2C1 has no register TXDATA`.
- Registers that share an offset (TIMx `CCMR1_Input` and `CCMR1_Output`) are
  one value, under the first name the JSON lists. Hook that one.
- **If RM0444 and the JSON disagree, RM0444 wins.** Override the value in
  your file with a comment citing the section, as RCC's `reset()`
  (`src/peripherals/rcc.ts`) does for `CR`.
- **Core peripherals** (SysTick, NVIC, SCB) belong to the Cortex-M0+, not to
  ST, and the SVD doesn't have them. Their registers are hand-written in the
  peripheral's file, in the JSON's shape and with CMSIS names, from the ARMv6-M
  Architecture Reference Manual: `src/peripherals/systick.ts` exports
  `systickRegisters(calib)`, and the chip definition adds it to its register
  map (step 11). That is the only case where a peripheral file defines
  registers.

Then read RM0444's chapter for the peripheral. RM0444 Rev 6 is the reference;
`docs/reference/` (gitignored: ST's copyright) holds the PDF and a text copy,
`rm0444.txt`, to search, if your checkout has them. Note each of these with
its section, table or figure number. You will cite them in comments.

- Each register's reset value and access: `rw`, `r`, `w`, `rc_w0` (write 0
  to clear), `rc_w1` (write 1 to clear).
- What each bit does when written, and what sets and clears each flag.
- What happens over time (a count, a transfer) and how long it takes.
- Interrupts: which flag, which enable bit, and the IRQ number (§12.3,
  Table 61).
- Pins: which signals, on which pins, at which AF number (the datasheet,
  DS12992, Tables 13 and 14).
- The clock enable bit in RCC (§5.4).
- What the manual says "must" be done, and what happens if it isn't. Often
  it doesn't say; those become "Assumed:" (step 10).

## 3. Copy the templates

The templates are a minimal, working peripheral: TIM14 cut down to its time
base. A 16-bit counter counts 16 MHz / (PSC + 1) from 0 to ARR, then wraps
with an update event that sets `SR.UIF` and, with `DIER.UIE`, pends the TIM14
interrupt. PSC is buffered until an update event, `EGR.UG` makes one, and
`UIF` clears when written 0. Copy both, named after your peripheral in lower
case (`tim14.ts`, `usart2.ts`):

```sh
cp templates/peripheral.ts src/peripherals/myperiph.ts
cp templates/peripheral.test.ts src/peripherals/myperiph.test.ts
```

Then fix the import paths. Each is marked `// TEMPLATE:`:

| File               | In `templates/`                            | In `src/peripherals/`                      |
| ------------------ | ------------------------------------------ | ------------------------------------------ |
| `myperiph.ts`      | `from "../src/peripherals/peripheral.ts"`  | `from "./peripheral.ts"`                   |
| `myperiph.test.ts` | `from "../src/chips/stm32g031k8.ts"`       | `from "../chips/stm32g031k8.ts"`           |
| `myperiph.test.ts` | `from "../src/engine/events.ts"` (2 lines) | `from "../engine/events.ts"`               |
| `myperiph.test.ts` | `from "../src/engine/memory-bus.ts"`       | `from "../engine/memory-bus.ts"`           |
| `myperiph.test.ts` | `from "../src/engine/nets.ts"`             | `from "../engine/nets.ts"`                 |
| `myperiph.test.ts` | `import { tim14 } from "./peripheral.ts"`  | `import { myperiph } from "./myperiph.ts"` |

Careful with the last row: in `templates/`, `./peripheral.ts` is the template
peripheral; in `src/peripherals/`, `./peripheral.ts` is the `Peripheral`
interface.

Rename `tim14` and `TIM14` to your peripheral everywhere, in both files
(`TIM14EN` becomes `USART2EN`, say). `name` must be the peripheral's key in
the register JSON (step 2). Then work through steps 4 to 10, replacing each
`TEMPLATE:` comment with your peripheral's facts (its gate bit, its IRQ
number, the test's addresses), and delete the comment.

## 4. The clock gate

Most STM32 peripherals have an enable bit in RCC, and do nothing until the
firmware sets it: with the clock off, "the read and write accesses to its
registers are not effective" (RM0444 §5.2.17). I2C1's:

```ts
  gate: { register: "RCC.APBENR1", field: "I2C1EN" },
```

- `register` is `"<PERIPHERAL>.<REGISTER>"` and `field` the field name, both
  as the JSON has them. If either is missing, the chip doesn't load:
  `clock gate RCC.APBENR1.I2C1EN is not in the register map`. The bits are in
  RM0444 §5.4: `IOPENR` for the GPIO ports, `AHBENR`, `APBENR1` and `APBENR2`
  for the rest.
- **The bus enforces it. Don't check it in your hooks.** While the bit is 0,
  every write is ignored and every read returns 0 without calling your read
  hook, flagged `clock-off`. The `gpio-clock-off` diagnostic explains that
  for any gated peripheral, not only GPIO.
- **`tick()` is gated too.** With the enable bit at 0 the bus doesn't call
  `tick()`: a peripheral without its clock is frozen (RM0444 §5.2.17). Check
  only your own enable bits at the top of `tick()`, e.g. `if (!(regs.CR1 & CEN))
  return;`. I2C1 also checks its RCC bit itself, which is harmless.

- A peripheral with no enable bit (RCC itself, the core's SysTick) leaves
  `gate` out.
- Not modelled: the 2-cycle delay after the enable bit is set (§5.2.17).

## 5. Read and write hooks

A hook replaces the default access for one register. Hooks are keyed by
register name, in `write` and `read` on the instance:

- `write.REG(value, mask)`: `value` is the whole 32-bit register as the write
  leaves it, the bytes the CPU wrote merged into the other bytes of
  `regs.REG`. `mask` marks the bits the CPU wrote: `0xffffffff` for a word,
  `0x0000ff00` for a byte at offset 1. Most hooks need only `value`.
- **A write hook stores what it keeps.** The default, `regs.REG = value`,
  doesn't run once there's a hook. A register that is also plain storage
  stores it itself, as I2C1's `OAR1` does.
- `read.REG()` returns what the CPU reads; the bus picks out the bytes of a
  byte or halfword read. Only the CPU calls it. The snapshot, `sim inspect`
  and the diagnostics read `regs` directly, so a read's side effect never
  happens because someone looked, and a value computed only in a read hook
  never shows in `sim inspect`. Keep what the register holds in `regs`.

The patterns, from I2C1 (§ numbers are RM0444's) and its neighbours:

**A read-only register or bit.** Hook the write and keep the read-only part.
I2C1's read-only registers ignore writes:

```ts
        PECR() {}, // read-only
        RXDR() {}, // read-only
```

SysTick's `CTRL` keeps its read-only `COUNTFLAG` (`src/peripherals/systick.ts`):

```ts
        // COUNTFLAG is read-only.
        CTRL: (value) => {
          regs.CTRL =
            (regs.CTRL & COUNTFLAG) | (value & (ENABLE | TICKINT | CLKSOURCE));
        },
```

**A write-only register** reads 0. Hook the read, or never store the value
(the template's `EGR`):

```ts
        ICR: () => 0, // write-only
```

**Write 1 to clear** (`rc_w1`). Each bit written 1 in I2C_ICR clears the ISR
flag at the same position (§32.9.8):

```ts
        ICR(value) {
          clear(value & ICR_FLAGS);
          // §32.9.8: ADDRCF also clears CR2.START.
          if (value & ADDRCF) regs.CR2 = (regs.CR2 & ~START) >>> 0;
        },
```

Careful where the flags sit in the register being written, as in EXTI_RPR1:
`value` carries the stored flags in the bytes the CPU didn't write, so clear
only `value & mask`, or a byte write clears the other bytes' flags too.

**Write 0 to clear** (`rc_w0`). The template's `SR`: the bytes the CPU didn't
write are the flags themselves, so they stay.

```ts
        SR(value) {
          regs.SR = (regs.SR & value) >>> 0;
        },
```

**A read with a side effect.** Reading I2C_RXDR clears RXNE (§32.9.7):

```ts
        RXDR() {
          clear(RXNE);
          return regs.RXDR;
        },
```

**A write that is ignored in some states.** TXDATA "can be written only when
TXE = 1" (§32.9.11):

```ts
        TXDR(value) {
          if (!(regs.CR1 & PE) || !(regs.ISR & TXE)) return;
          regs.TXDR = value & 0xff;
          clear(TXE | TXIS);
        },
```

**Keep values unsigned.** JavaScript's `~`, `&`, `|` and `<<` give signed
32-bit results, so a register with bit 31 set would go negative. End such an
expression with `>>> 0`, as I2C1 does: `regs.ISR = (regs.ISR | flags) >>> 0`.

## 6. Time: `tick(cycles)`

Anything that happens over time happens in `tick`: a counter counting, a byte
going out on the wire, a flag that sets later. The engine calls it after every
instruction, with that instruction's cycles (one to a few), in registration
order; while the core sleeps in WFI, with up to 1 ms of cycles at once.
Time is CPU cycles at the core clock, HCLK (16 MHz after reset; RCC can change
it), so a run gives the same result every time, and `ctx.now()` is the cycle
count since reset. A peripheral on its own kernel clock (I2C1's I2CCLK) turns
its clock cycles into core cycles with `clocks()` from `rcc.ts`. Never read the
wall clock (`Date.now()`, `performance.now()`, `setTimeout`).

- Turn cycles into your peripheral's clock with arithmetic, and keep the
  remainder, so the result doesn't depend on how the cycles are sliced. The
  template's prescaler:

```ts
if (pending < toOverflow) {
  regs.CNT += Math.floor(pending / divider);
  pending %= divider;
  return;
}
```

SysTick does the same for its HCLK/8 clock. Don't loop once per cycle:
`tick` runs after every instruction.

- Or, as I2C1 does, note when the current step ends and finish it in the
  first `tick` at or past that cycle:

```ts
const onWire = (s: State, cycles: number) => {
  state = s;
  due = at + cycles;
};
```

- Approximate where the firmware can't tell. I2C1 counts a byte as 9 SCL
  periods from TIMINGR's formula (§32.4.9), not edge by edge. There is no
  cycle-exact timing; say "Assumed:" for the approximation.
- A peripheral with nothing to do over time leaves `tick` out. It then costs
  nothing.

## 7. Interrupts: `cpu.setPending`

Pend the peripheral's interrupt with `cpu.setPending(16 + n)`, where `n` is
its IRQ number: its position in RM0444 §12.3, Table 61, or `<NAME>_IRQn` in
`stm32g031xx.h`. The template's TIM14 is IRQ 19:

```ts
if (regs.DIER & UIE) cpu.setPending(16 + TIM14_IRQ);
```

Exceptions 2 (NMI), 14 (PendSV) and 15 (SysTick) are pended by their own
number: SysTick pends 15 when it counts to 0 with TICKINT set.

**The NVIC isn't modelled yet.** Its registers read 0 and ignore writes, so
`NVIC_EnableIRQ` does nothing and the core never takes a pended IRQ (16 and
up): the firmware's handler never runs. Pend it anyway, so it works once the
NVIC exists, and test that you do. Firmware that polls the flag works today.
I2C1 doesn't pend yet: it logs its interrupt enable bits as not simulated
(step 9).

## 8. Pins: AF endpoints

A peripheral never touches a pin's endpoint (`mcu.PB6`): that belongs to
GPIO. Each of the peripheral's signals is an endpoint of its own,
`mcu.<SIGNAL>`; I2C1's are `mcu.I2C1_SCL` and `mcu.I2C1_SDA`. GPIO joins a
pin to a signal with a switch while the pin is in alternate-function mode
(MODER = 2) with the AF number the chip's AF table gives, and opens it
otherwise (decisions.md §12).

- **Drive and read your signal's endpoint** through `ctx.nets`:
  `nets.drive(endpoint, "high")`, `nets.level(endpoint)`, and
  `nets.listen((endpoint, level) => …)` to hear a change. I2C1 hands its two
  endpoints to an `I2cBus` (`src/engine/i2c.ts`), which finds the parts wired
  to them:

```ts
const bus = new I2cBus({
  nets,
  sda: "mcu.I2C1_SDA",
  scl: "mcu.I2C1_SCL",
  parts,
  now: () => at,
  trace(step) {
    if (events.active)
      events.emit({ kind: "i2c", cycle: step.t, periph: "I2C1", step });
  },
});
```

- **Add the signal's pins to the chip's AF table**, `af` in
  `src/chips/stm32g031k8.ts`, the same file as the registration list (step 11).
  AF numbers come from the datasheet, DS12992 Tables 13 (port A) and 14
  (port B). Each pin maps AF numbers to signals, so one pin can list several.
  I2C1's rows:

```ts
const af: AfTable = {
  PA9: { 6: "I2C1_SCL" },
  PA10: { 6: "I2C1_SDA" },
  PB6: { 6: "I2C1_SCL" },
  PB7: { 6: "I2C1_SDA" },
  PB8: { 6: "I2C1_SCL" },
  PB9: { 6: "I2C1_SDA" },
};
```

- That is all the routing. A pin the firmware didn't route (wrong MODER,
  wrong AF number, its port's clock off) leaves your signal unconnected, with
  no special case in your file. I2C1 then sees its lines floating, reads BUSY,
  and START never goes out, as on the real chip.
- The template has no pins: TIM14's channel 1 output isn't simulated.

## 9. Events

The bus already logs every register access as a `reg` event: the cycle and
PC, the register, the old and new value, and flags (`clock-off`,
`unsimulated`, `reserved`). Diagnostics, `sim inspect` and the UI build on
them, and you write no code for them. A peripheral emits two kinds itself,
through `ctx.events`:

- **`unsimulated`**: the firmware selected a feature your file doesn't
  model. Registering a peripheral marks all its registers simulated
  (decisions.md §9), so without this event a learner who sets I2C1's
  `CR2.RELOAD` would see nothing at all. Emit one for each such field the
  firmware sets, and run as if it were 0. From I2C1's `logUnsimulated`:

```ts
events.emit({
  kind: "unsimulated",
  cycle: now(),
  periph: "I2C1",
  feature,
});
```

`feature` is `"<REGISTER>.<FIELD>"`, e.g. `"CR2.RELOAD"`. The template keeps
its fields in a `NOT_SIMULATED` table, as I2C1 does. `sim inspect` prints these
events in its `i2c` section, whichever peripheral sent them:
`TIM14 CR1.OPM isn't simulated`.

- **`i2c`**: one step of I2C1's bus trace, from its `I2cBus` (the `trace`
  above).
- **Build an event only while `events.active`.** Blink writes ODR millions of
  times, often with nobody listening:

```ts
if (!events.active) return;
```

- A new kind of event (a UART's bytes, say) means adding it to `SimEvent` in
  `src/engine/events.ts` and showing it in the CLI. That is an interface
  change, not part of this recipe: stop and report it.

## 10. Faithful, including silent failures

This simulator is for learning register-level C, so a peripheral must fail
the way the real chip fails.

- **Never fix the firmware's mistake.** A write the hardware ignores is
  ignored: I2C1 drops a TIMINGR write while PE = 1, and a TXDR write while
  TXE = 0. A flag the firmware forgot to clear stays set. A PSC write without
  UG waits for the next update event. A peripheral whose clock, pins or pull-ups
  the firmware forgot does nothing.
- **Don't throw, warn or log because the firmware did something odd.** The
  real chip doesn't. A throw from a peripheral stops the run as an internal
  error (exit code 3). Explaining mistakes is the job of diagnostic rules
  (`docs/adding-a-diagnostic.md`), which only observe; peripherals only
  behave.
- **Cite RM0444** for each behavior: a section, table or figure number in a
  comment, e.g. `// §32.9.7: reading RXDR clears RXNE.`
- **Write "Assumed:"** before every choice RM0444 doesn't settle, and say
  what you chose. I2C1 has several (decisions.md §12): a line that isn't high
  reads BUSY; a TIMINGR write with PE = 1 is ignored; clearing PE in the middle
  of a transfer puts no STOP on the bus. The template has one: a counter
  above ARR counts on to 0xFFFF.
- Anything the peripheral has that you don't simulate, name in the file's
  header comment, and log as `unsimulated` (step 9) when the firmware selects
  it.

## 11. Register the peripheral

In `src/chips/stm32g031k8.ts`, add one import and one entry at the end of the
`peripherals` list:

```ts
import { myperiph } from "../peripherals/myperiph.ts";
```

```ts
  // The peripheral registration list: one import and one entry per peripheral.
  // Every SVD register without one is plain storage, logged as "unsimulated".
  peripherals: [
    rcc,
    gpio("GPIOA", { register: "RCC.IOPENR", field: "GPIOAEN" }, pins, af),
    gpio("GPIOB", { register: "RCC.IOPENR", field: "GPIOBEN" }, pins, af),
    systick,
    scb,
    i2c1,
    myperiph,
  ],
```

- Peripherals tick in this order. Put yours last unless it must tick before
  one already there.
- Pins: add the rows to `af` in the same file (step 8).
- A core peripheral with hand-written registers also goes into the register
  map, as SysTick's does:

```ts
  registers: {
    peripherals: {
      ...registers.peripherals,
      // Core registers the SVD doesn't have (T4), hand-written from the ARMv6-M ARM.
      // RM0444 §12.2: "The SysTick calibration value is set to 1000".
      SysTick: systickRegisters(1000),
      SCB: scbRegisters,
    },
  },
```

This is the only existing file you edit. It puts the peripheral on the chip:
its registers lose the `unsimulated` flag, `sim inspect` lists them, and the
gate and hook names are checked when the chip loads. A `name` that isn't in
the register map, or a peripheral registered twice, stops the chip from
loading. The template itself is not registered; its test adds it to a copy of
the chip, and so does yours.

## 12. Test it

Tests run headless with `node:test`, no display, and sit next to the
peripheral. The test you copied in step 3 already has the harness:

- `setup()` builds the G031K8's memory bus with your peripheral in its list,
  its clock on (`setup(false)`: off), a fake `cpu` that records each
  exception you pend in `pended`, and every event in `events`;
- `w(offset, value)` and `r(offset)` access your registers as the CPU does,
  through the bus, so the gate, lanes and hooks all apply;
- `bus.tick(cycles)` is the passing of time;
- `bus.regs.TIM14` is the stored values, read without side effects.

Change the addresses to yours, and the tests to RM0444. Test at least:

- the reset values that matter;
- each hook: read-only bits unchanged, write-only registers reading 0, each
  flag set and cleared the way RM0444 says (by a write of 0, of 1, by a read);
- behavior over time: just before and just after each event, in one big
  `tick` as well as small ones;
- each interrupt: pended when it should be, and not with its enable bit 0;
- the clock gate: writes ignored with the bit at 0, and `tick` stopped;
- each silent failure, e.g. "a PSC write takes effect only at the next update
  event";
- each `unsimulated` event.

Name each test with a sentence about the behavior. A peripheral with pins
needs a circuit: `board()` in `i2c.test.ts` wires the pins to a target with
pull-ups and routes them the way firmware does, through GPIOB's registers:

```ts
for (const pin of [scl, sda]) {
  const port = pin[1] === "A" ? GPIOA : GPIOB;
  const n = Number(pin.slice(2));
  rmw(port + MODER, 3 << (2 * n), 2 << (2 * n)); // AF
  rmw(port + OTYPER, 1 << n, 1 << n); // open-drain
  const shift = (n % 8) * 4;
  rmw(port + (n < 8 ? AFRL : AFRH), 0xf << shift, (o.af ?? 6) << shift);
}
```

Then test the wiring mistakes too: I2C1's test has the wrong AF number, no
pull-ups, a line held low, and the port's clock off.

## 13. Run the checks

```sh
node --test src/peripherals/myperiph.test.ts   # your test
just test                                      # every test (run `just fw` once first)
just typecheck                                 # tsc, no output files
git status                                     # your changes
```

All must pass. Of the files you created or changed, `git status` must list
only your two new files and `src/chips/stm32g031k8.ts`.

## 14. Optional: try it under firmware

`sim inspect` shows the registers of every registered peripheral with their
named bits, so any firmware shows yours on the chip, at its reset values:

```sh
just sim inspect build/blink.elf --circuit firmware/blink/circuit.json --at 10ms
```

Under `registers`, your peripheral is listed among the others, in the
register map's order. For I2C1, the
TC74 firmware exercises it:

```sh
just sim inspect build/tc74-read.elf --circuit firmware/tc74-read/circuit.json --at 300ms
```

prints I2C1's registers with their bits, such as
`TIMINGR    0x30420f13  SCLL=19 SCLH=15 SDADEL=2 SCLDEL=4 PRESC=3`, and the
bus trace under `i2c`. Add `--json` for the same as JSON.

Firmware written for your peripheral (`firmware/<name>/main.c`, its
`circuit.json` and an end-to-end test, like `firmware/tc74-read/`) is a
separate change, not part of adding the peripheral.

## Checklist

- [ ] `src/peripherals/<name>.ts`: the SVD's `name`, its `gate`, behavior
      only (no registers, unless it's a core peripheral), an RM0444 citation
      or "Assumed:" for each choice, unsimulated features logged.
- [ ] No `TEMPLATE:` comments left, and no `tim14` or `TIM14` unless it is
      TIM14.
- [ ] `src/peripherals/<name>.test.ts`: reset values, hooks, time,
      interrupts, the clock gate, silent failures, unsimulated events.
- [ ] `src/chips/stm32g031k8.ts`: one import, one entry, and AF rows for any
      pins.
- [ ] `just test` and `just typecheck` pass.
- [ ] `git status` shows no other file of yours.
