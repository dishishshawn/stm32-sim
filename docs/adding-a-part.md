# Adding a part

A part is anything on the breadboard besides the chip: a sensor, an I/O
expander, an LED, a button. This recipe adds one, step by step. The worked
example is the TC74 temperature sensor, `src/parts/tc74.ts` and its test
`src/parts/tc74.test.ts`; open them side by side with this page.

**Your change is three files:**

- a new `src/parts/<name>.ts`: the part;
- a new `src/parts/<name>.test.ts`: its test;
- `src/parts/index.ts`: one import and one list entry. **This is the only
  existing file you edit.**

If you find you need to change any other existing file (the engine, the I2C
bus, the circuit loader, the CLI, another part), stop and report it instead.
It means the part interface is missing something, and the fix belongs in the
interface, not in a workaround.

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

## 1. What a part is

A part is one object of type `Part`, from `src/parts/part.ts`. The smallest
one is the LED, `src/parts/led.ts`, in full:

```ts
// An LED. Pins match @wokwi/elements' wokwi-led: A (anode), C (cathode).
import type { Part } from "./part.ts";

export const led: Part = {
  type: "led",
  pins: ["A", "C"],
  props: {},
  create: (ctx) => ({
    // Lit only with current flowing anode to cathode; floating or conflict is unlit.
    state: () => ({
      lit: ctx.level("A") === "high" && ctx.level("C") === "low",
    }),
  }),
};
```

- `type` is the name circuit JSON uses: `"type": "led"`.
- `pins` are its pin names (step 4).
- `props` are its typed settings (step 5).
- `create(ctx)` runs once for each such part in a circuit and returns the
  instance. Keep the part's state in local variables inside `create()`.

`ctx` (a `PartContext`) is this instance's view of the circuit. Pins are named
by the part's own pin names:

| `ctx.`                    | What it does                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `id`                      | the part's id in the circuit, e.g. `"temp"`                                            |
| `props`                   | every prop, with defaults filled in                                                    |
| `level(pin)`              | the level of the pin's net: `"high"`, `"low"`, `"floating"` or `"conflict"`            |
| `drive(pin, d)`           | what this pin does to its net: `"high"`, `"low"`, `"pull-up"`, `"pull-down"`, `"hi-z"` |
| `setSwitch(a, b, closed)` | joins two of its pins while closed: a button, or pins joined inside the part           |
| `addResistor(a, b)`       | a weak link between two of its pins                                                    |

The instance (a `PartInstance`) has these members, all optional:

| Member                 | Called when                                                   | Step |
| ---------------------- | ------------------------------------------------------------- | ---- |
| `onLevel(pin, level)`  | one of its pins changed level                                 | 6a   |
| `i2c`                  | (not a call) set it if the part is an I2C target              | 6b   |
| `tick(seconds)`        | simulated time passed                                         | 7    |
| `setProp(name, value)` | a prop changed during a run: a slider moved, a button pressed | 5    |
| `state()`              | a test, `sim inspect` or the UI asks what the part shows      | 8    |

The engine does everything else: it wires pins to nets from the circuit JSON,
checks props, routes I2C transfers, and calls `tick`.

In a circuit, a pin is the endpoint `<id>.<pin>` (`temp.SDA`), the chip's pins
are `mcu.<pin>` (`mcu.PB7`), and the rails are `3V3` and `GND`. From
`firmware/tc74-read/circuit.json`:

```json
{
  "chip": "stm32g031k8",
  "parts": [
    {
      "id": "temp",
      "type": "tc74",
      "props": {
        "temperature": 22,
        "variant": "A0"
      }
    }
  ],
  "wires": [
    ["mcu.PB6", "temp.SCLK"],
    ["mcu.PB7", "temp.SDA"],
    ["temp.VDD", "3V3"],
    ["temp.GND", "GND"]
  ]
}
```

(The real file also has two pull-up resistors; I2C needs them.)

**Visuals:** there is no browser UI yet, so a part needs no visual and there is
no step for it. Leave `src/ui/art/` alone. When the UI arrives, this recipe
gets a step: a part will either use an `@wokwi/elements` element or get
plain-SVG art in `src/ui/art/`.

## 2. Read the datasheet first

Note each of these, with its section, table or figure number. You will cite
them in comments.

- The pin table: names and order.
- The I2C address, and what selects it: a part variant (TC74A0 to A7) or
  address pins (MCP23017 A0 to A2).
- The register map: addresses, widths, power-on values, read-only bits.
- The pointer: is the first byte written after START the register address?
  Does it move on after each byte (auto-increment)?
- Timing: conversion time or rate, power-on delay.
- What the part does with a bad request: NACK, ignore, something else. Often
  the datasheet doesn't say; those become "Assumed:" (step 9).

## 3. Copy the templates

The templates are a minimal, working I2C part: LX01, a made-up light sensor
with an ID register, a read/write CONFIG register, a 16-bit DATA register set
from a `lux` slider, a register pointer, and an address chosen by an `ADDR`
pin. Copy both, named after your part number in lower case (`tc74.ts`,
`mcp23017.ts`):

```sh
cp templates/part.ts src/parts/mypart.ts
cp templates/part.test.ts src/parts/mypart.test.ts
```

Then fix the import paths. Each is marked `// TEMPLATE:`:

| File             | In `templates/`                         | In `src/parts/`                        |
| ---------------- | --------------------------------------- | -------------------------------------- |
| `mypart.ts`      | `from "../src/parts/part.ts"`           | `from "./part.ts"`                     |
| `mypart.test.ts` | `from "../src/engine/i2c.ts"`           | `from "../engine/i2c.ts"`              |
| `mypart.test.ts` | `from "../src/engine/nets.ts"`          | `from "../engine/nets.ts"`             |
| `mypart.test.ts` | `from "../src/parts/part.ts"` (2 lines) | `from "./part.ts"`                     |
| `mypart.test.ts` | `import { lx01 } from "./part.ts"`      | `import { mypart } from "./mypart.ts"` |

Careful with the last row: in `templates/`, `./part.ts` is the template part;
in `src/parts/`, `./part.ts` is the `Part` interface.

Rename `lx01`, `"lx01"` and `LX01` to your part everywhere, in both files. Then work
through steps 4 to 9, replacing each `TEMPLATE:` comment with your part's
facts, and delete the comment.

## 4. Pins

- Use the datasheet's names, in the order of its pin table. The TC74 is
  `["NC", "SDA", "GND", "SCLK", "VDD"]`, the TO-220 pins 1 to 5. Its clock pin
  is `SCLK`, not `SCL`: keep the datasheet's spelling.
- If `@wokwi/elements` has an element for the part (LED, push-button,
  resistor, 7-segment display), use the element's pin names instead, so the
  UI can attach wires to them: the LED is `["A", "C"]`, the push-button
  `["1.l", "1.r", "2.l", "2.r"]`.
- Names must be unique within the part. Where the datasheet repeats one, add
  a suffix: `GND.1` and `GND.2`, joined inside the part with
  `ctx.setSwitch("GND.1", "GND.2", true)` in `create()`. Unconnected pins can
  be named by number, as the MCP23017's `NC11` and `NC14`.
- Declare the power pins (`VDD`, `GND`) so they can be wired, even though
  power is not simulated: `create()` is the power-on reset.
- A part may only use its declared pins. `ctx.drive("NOPE", …)` throws
  `tc74 "temp" has no pin "NOPE"`.

## 5. Props

A prop is something set from outside the chip: which variant it is (the
address), a slider (a temperature), a button. The registers the firmware
writes are not props; they are local state inside `create()`.

The TC74's props:

```ts
  props: {
    // TC74A0-A7 answer 1001 000b-1001 111b; A5 is the default address (§3.1.2, §5.1).
    variant: { type: "string", default: "A5", options: VARIANTS },
    // The slider. -65 to +150 °C is the storage range (§1.1).
    temperature: { type: "number", default: 25, min: -65, max: 150 },
  },
```

A prop is one of three kinds (`PropSpec`):

- `{ type: "boolean", default }`;
- `{ type: "number", default, min?, max? }`;
- `{ type: "string", default, options? }`; with `options` it is an enum.

The circuit JSON's `props`, and the CLI's `--set temp.temperature=30` and
`--at 1s:temp.temperature=30`, are checked against these before your part
sees them. `create()` reads them from `ctx.props`, typed as
`number | string | boolean`, so cast:

```ts
const address = 0x48 + VARIANTS.indexOf(ctx.props.variant as string);
let temperature = ctx.props.temperature as number;
```

A change during a run arrives in `setProp(name, value)`, already checked:

```ts
      setProp(name, value) {
        if (name === "temperature") temperature = value as number;
      },
```

A prop that `setProp` ignores keeps its value from `create()`, as the TC74's
`variant` does: you can't swap the chip on a running board.

## 6. Behavior

A part reacts to its pins (6a), to I2C transfers (6b), or both: the MCP23017
is an I2C target that also drives sixteen GPIO pins.

### 6a. On pins: `drive`, `level`, `onLevel`

Read a level when you need it with `ctx.level(pin)`, as the LED's `state()`
does. To react the moment a level changes, use `onLevel`. A part whose `OUT`
pin is `IN` inverted (from `src/parts/part.test.ts`):

```ts
  create(ctx) {
    return {
      onLevel(pin, level) {
        if (pin === "IN") ctx.drive("OUT", level === "high" ? "low" : "high");
      },
    };
  },
```

- How a pin drives its net: a push-pull output is `"high"` or `"low"`; an
  open-drain output is `"low"` or `"hi-z"`; an input is `"hi-z"` (the
  default); an internal pull-up is `"pull-up"`.
- `onLevel` is not called for levels already present when `create()` runs.
  If the initial level matters, read it with `ctx.level()` in `create()`.
- Treat `"floating"` and `"conflict"` as "no defined level". What the part
  does with one is usually an "Assumed:" (step 9).
- A part that only connects pins uses `ctx.setSwitch`. The push-button, in
  full (`src/parts/pushbutton.ts`):

```ts
// A push-button: side 1 (1.l, 1.r) joins side 2 (2.l, 2.r) while pressed.
import type { Part } from "./part.ts";

export const pushbutton: Part = {
  type: "pushbutton",
  pins: ["1.l", "1.r", "2.l", "2.r"],
  props: { pressed: { type: "boolean", default: false } },
  create(ctx) {
    ctx.setSwitch("1.l", "1.r", true);
    ctx.setSwitch("2.l", "2.r", true);
    ctx.setSwitch("1.l", "2.l", ctx.props.pressed === true);
    return {
      setProp(name, value) {
        if (name === "pressed") ctx.setSwitch("1.l", "2.l", value === true);
      },
    };
  },
};
```

- A drive made inside `onLevel` settles in a further round. Parts that keep
  re-driving each other forever stop the run with "nets did not settle after
  100 rounds".

### 6b. On I2C: the `i2c` target

Set `i2c` on the instance to an `I2cTarget` (`src/engine/i2c.ts`). The bus is
simulated one step at a time (START, address, byte, STOP), not bit by bit.
The TC74's target:

```ts
      i2c: {
        sda: "SDA",
        scl: "SCLK",
        address: () => address,
        start() {
          pointerNext = true;
        },
        // The command byte sets the pointer; a data byte goes to that register
        // (Figure 3-1). Assumed: applied at once, though Figure 1-1 marks STOP as
        // "Data Executed by Slave".
        write(byte) {
          if (pointerNext) {
            pointer = byte;
            pointerNext = false;
          } else if (pointer === 0x01) {
            // Only SHDN is writable (Table 4-2). Entering standby clears
            // DATA_RDY (Table 4-2 note 1); leaving it starts a new conversion,
            // and DATA_RDY returns after it (Figure 4-1).
            const shdn = (byte & 0x80) !== 0;
            if (shdn && !shutdown) ready = false;
            if (!shdn && shutdown) sinceConversion = 0;
            shutdown = shdn;
          }
          // Assumed: a data byte to TEMP (read-only, Table 4-5) or to an
          // undefined command code is ACKed and ignored.
          return "ack";
        },
        // No auto-increment: every byte is the register the pointer is on
        // (Receive Byte, Figure 3-1). Assumed: undefined command codes read 0.
        read: () => (pointer === 0x00 ? temp : pointer === 0x01 ? config() : 0),
      },
```

What the bus calls, in order:

| On the bus                 | Called on your part                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| START, or a repeated START | `start()`, on every target on the bus, addressed or not                                     |
| the address, with R/W      | `address()`, on every target. Those that return it are selected and the bus ACKs; else NACK |
| a byte from the controller | `write(byte)`, on each selected target. Return `"ack"` or `"nack"`                          |
| a byte to the controller   | `read()`, on each selected target. Return the byte                                          |
| STOP                       | `stop()`, on every target                                                                   |

- `sda` and `scl` name your part's pins. The part is on the bus only if both
  are wired to the controller's lines; that is why the test wires them.
- `address()` returns the 7-bit address (`0x48`, not `0x90`). It is asked at
  every address phase, so it can follow a prop (the TC74's variant) or pins.
  Return `undefined` to answer no address at all, e.g. in reset. The
  MCP23017 reads its address pins every time:

```ts
// 0b0100 A2 A1 A0 (§3.3.1, Figure 3-4), read from the pins every time.
// Assumed: a floating or conflicting A pin (Table 2-1: "must be externally
// biased") matches no address.
const address = () =>
  inReset() || A.some((p) => !["high", "low"].includes(ctx.level(p)))
    ? undefined
    : 0x20 | port(A);
```

- Some parts select their address by tying a pin to SDA or SCL as well as to
  GND or VDD. A part can't tell which net a pin is on, and an idle SDA reads
  high just like VDD, so model that choice as a string prop with the
  datasheet's options instead (`options: ["GND", "VDD", "SDA", "SCL"]`).
- The bus doesn't tell your part whether the address phase was a read or a
  write, nor whether the controller ACKed the byte it just read. You learn
  the direction from which of `write()` and `read()` is called next.
- The register pointer is your part's job. On most devices the first byte
  written after a START is the pointer: set a flag in `start()` and clear it
  in `write()`, as above. Don't reset the pointer itself in `start()` or
  `stop()` unless the datasheet says so: a read that skips setting it must
  get whatever register the pointer is already on.
- Auto-increment follows the datasheet. The TC74 has none: every byte read is
  the same register. The MCP23017 and the template move the pointer on after
  each byte.
- A register wider than a byte goes out one byte per `read()` call. Count the
  bytes since the START. In your copy of the template, replace `start()` and `read()` with
  this, where `readRegister()` now returns 16 bits:

```ts
        start() {
          pointerNext = true;
          byteIndex = 0;
        },
        // MSB first, then LSB, from the same register. Assumed: a third
        // byte starts the register again.
        read() {
          const value = readRegister(pointer);
          const byte = byteIndex % 2 === 0 ? value >> 8 : value & 0xff;
          byteIndex++;
          return byte;
        },
```

with `let byteIndex = 0;` next to `pointerNext`. Writes are the same idea:
count the bytes, keep the MSB until the LSB arrives, and move the pointer
only if the datasheet says it moves.

- Return `"nack"` from `write()` only where the datasheet says the part NACKs
  a byte. The bus already NACKs on a wrong address for you.

## 7. Timing: `tick(seconds)`

Anything the datasheet times (a conversion, a power-on delay) happens in
`tick`. During a run the engine calls it every 1 ms of simulated time, with
`seconds = 0.001`. Simulated time comes from CPU cycles at 16 MHz, so a run
gives the same result every time. Never read the wall clock (`Date.now()`,
`performance.now()`, `setTimeout`).

The TC74 converts eight times a second, and a slider move shows in TEMP only
after the next conversion:

```ts
/**
 * Nominal conversion rate, 8 samples/s (§1.0 DC Characteristics, CR typ).
 * The minimum is 4 SPS, and Note 2 allows up to 250 ms from POR to DATA_RDY.
 */
const T_CONV = 1 / 8;
```

```ts
      // Standby halts the A/D and freezes TEMP (§3.1.1). Otherwise a
      // conversion completes every T_CONV, setting DATA_RDY and TEMP (Table 4-5 note 1).
      tick(seconds) {
        if (shutdown) return;
        sinceConversion += seconds;
        if (sinceConversion < T_CONV) return;
        sinceConversion %= T_CONV;
        ready = true;
        temp = toRegister(temperature);
      },
```

Add up `seconds`, compare with the datasheet's time, keep the remainder. A
test calls `tick` itself, with any amount: `t.tick?.(0.2)`.

## 8. `state()`

`state()` returns what the part shows, as plain JSON values: numbers,
strings, booleans, arrays, plain objects. Tests compare it with `deepEqual`;
`sim inspect` prints it under `parts`, and `--json` puts it at
`parts.<id>`. Include what a learner would look at while debugging: the
slider value, the mode, the address it answers. The TC74's:

```ts
      state: () => ({ temperature, shutdown, dataReady: ready }),
```

## 9. Faithful, including silent failures

This simulator is for learning register-level C, so a part must fail the way
the real chip fails.

- **Never fix the firmware's mistake.** A read that forgot to set the pointer
  gets the register the pointer is on. A write to a read-only register is
  ignored if the datasheet says so. A wrong address NACKs. A pin the datasheet
  says "must be biased" does not quietly read as low when it floats.
- **Don't throw, warn or log because the firmware did something odd.** The
  real chip doesn't. A throw from a part stops the run as an internal error
  (exit code 3). Explaining mistakes is the job of diagnostic rules
  (`src/diagnostics/`), which only observe; parts only behave.
- **Cite the datasheet** for each behavior: a section, table or figure number
  in a comment, e.g. `// Table 4-4: rounds down`.
- **Write "Assumed:"** before every choice the datasheet doesn't settle, and
  say what you chose. The TC74 has several: a data byte to read-only TEMP is
  ACKed and ignored; undefined command codes read 0; below -65 °C reads -65.
  That is how a reviewer, or someone with the real chip on a bench, finds the
  guesses.
- Anything the part has that you don't simulate (an alert output, a mode),
  name in the file's header comment. If firmware can switch it on, list it in
  `state()` when it does, as the MCP23017's `notSimulated`.

## 10. Register the part

In `src/parts/index.ts`, add one import and one entry:

```ts
// The part registration list: add one import and one entry per part.
import { led } from "./led.ts";
import { mcp23017 } from "./mcp23017.ts";
import { mypart } from "./mypart.ts";
import type { Part } from "./part.ts";
import { pushbutton } from "./pushbutton.ts";
import { resistor } from "./resistor.ts";
import { sevenSegment } from "./seven-segment.ts";
import { tc74 } from "./tc74.ts";

export const parts: readonly Part[] = [
  resistor,
  pushbutton,
  led,
  sevenSegment,
  tc74,
  mcp23017,
  mypart,
];
```

This is the only existing file you edit. It makes the part's `type` usable in
circuit JSON and on the CLI, and puts it under the registry test in
`src/parts/part.test.ts`: types and pin names unique, every prop's default
valid. The template itself is not registered; its test mounts it directly,
and so does yours.

## 11. Test it

Tests run headless with `node:test`, no display, and sit next to the part.
The test you copied in step 3 already has the harness: SDA and SCL wired to
`mcu.PB7` and `mcu.PB6` with pull-ups to `3V3`, the part mounted with
`mountPart`, an `I2cBus` in place of the chip's I2C1, and helpers:

- `write(pointer, ...data)`: START, address + W, the bytes, STOP; returns
  each byte's ACK;
- `read(n)`: START, address + R, `n` bytes, STOP, without setting the
  pointer;
- `readRegs(reg, n)`: sets the pointer, then a repeated START and `n` bytes.

Change the wiring to your pins, `ADDRESS` to your default address, and the
tests to your datasheet. Test at least:

- the address: the right one ACKs, others NACK, for each variant or
  address-pin setting, and what answers nothing;
- the power-on values, including where the pointer starts: a `read` before
  any pointer write;
- each register: read, write, read-only bits unchanged;
- the pointer: where it is after each transfer;
- the slider-to-register conversion, row by row from the datasheet's own
  example table (`tc74.test.ts` checks Table 4-4);
- timing: just before and just after the conversion time;
- `state()`.

Name each test with a sentence about the behavior, e.g. "a read without
setting the pointer returns TEMP, the power-up pointer". For a part with no
I2C, test with `Nets` alone, as `src/parts/led.test.ts` does:

```ts
test("an LED is lit only when its anode is high and its cathode low", () => {
  const nets = new Nets([
    ["mcu.PA5", "d1.A"],
    ["d1.C", "GND"],
  ]);
  const d1 = mountPart(nets, led, "d1");
  assert.equal(d1.state?.().lit, false, "anode floating");
  nets.drive("mcu.PA5", "high");
  assert.equal(d1.state?.().lit, true);
```

`mountPart` doesn't check props: give it valid ones.

## 12. Run the checks

```sh
node --test src/parts/mypart.test.ts   # your test
node --test src/parts/part.test.ts     # the registry test
just test                              # every test (run `just fw` once first)
just typecheck                         # tsc, no output files
git status                             # your changes
```

All must pass. Of the files you created or changed, `git status` must list
only your two new files and `src/parts/index.ts`.

## 13. Optional: try it under firmware

You don't need new firmware to see your part on the bus. `build/tc74-read.elf`
(built by `just fw`) reads one byte of register 0x00 from address 0x48 every
250 ms, from 250 ms on. Put your part in a copy of its circuit, in `build/`,
which git ignores:

```sh
cp firmware/tc74-read/circuit.json build/try.json
```

In `build/try.json`, replace the `tc74` entry with your part (its own `id`,
`type` and `props`) and rename the wires' endpoints to your part's pins:
SDA to `mcu.PB7`, the clock pin to `mcu.PB6`, its power pins to `3V3` and
`GND`, and any address pins as needed. Keep the two resistors. Then:

```sh
just sim inspect build/tc74-read.elf --circuit build/try.json --at 1s
```

Near the end of the output, `i2c` is the bus trace, and last, `parts` is
each part's `state()`. If your
part answers 0x48, the trace shows its byte from register 0x00; if not, it
shows `"ack":"nack"` on every address, which checks `address()` too. A bad
part type, prop or pin name exits 2 and names what is valid. Add `--json` for
the same as JSON, and `--set <id>.<prop>=<value>` to change a prop.

Firmware written for your part (`firmware/<name>/main.c`, its
`circuit.json` and an end-to-end test, like `firmware/tc74-read/`) is a
separate change, not part of adding the part.

## Checklist

- [ ] `src/parts/<name>.ts`: datasheet pin names, typed props, behavior with
      a datasheet citation or "Assumed:" for each choice, `state()`.
- [ ] No `TEMPLATE:` comments left, and no `lx01` or `LX01`.
- [ ] `src/parts/<name>.test.ts`: address, power-on values, pointer,
      registers, conversion, timing, `state()`.
- [ ] `src/parts/index.ts`: one import, one entry.
- [ ] `just test` and `just typecheck` pass.
- [ ] `git status` shows no other file of yours.
