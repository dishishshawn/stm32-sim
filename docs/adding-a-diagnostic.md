# Adding a diagnostic rule

A diagnostic rule explains a likely mistake in the firmware, at the line that
made it:

```
firmware/clock-off/main.c:25: warning: wrote GPIOB_ODR (0x50000414) while RCC_IOPENR (0x40021034) bit 1 GPIOBEN = 0 — GPIOB's clock is off, so the write was ignored [gpio-clock-off] (3 times)
```

A rule only watches. It never changes what the simulation does: the
simulator reproduces the firmware's mistake (the write is ignored), and the
rule says why. This recipe adds one, step by step. The worked example is
`src/diagnostics/timingr-while-pe.ts` and its test
`src/diagnostics/timingr-while-pe.test.ts`; open them side by side with this
page.

**Your change is three files:**

- a new `src/diagnostics/<rule-id>.ts`: the rule;
- a new `src/diagnostics/<rule-id>.test.ts`: its test;
- `src/diagnostics/index.ts`: one import and one list entry. **This is the
  only existing file you edit.**

If you find you need to change any other existing file (an event type, the
engine's `BoardView`, a peripheral, the CLI), stop and report it instead. A
rule that needs a peripheral to emit something new, or needs to see something
`BoardView` doesn't show, means the interface is missing something, and the
fix belongs in the interface.

## 0. Before you start

Run every command from the repository root.

```sh
npm install   # only if node_modules/ is missing
just fw       # builds the example firmware; the rule tests run it
just test     # everything passes before you change anything
```

Node 24 and `just` come from `.mise.toml` (`mise install`); `just fw` needs
`arm-none-eabi-gcc`.

Node runs the `.ts` files directly, with no build step, so:

- relative imports end in `.ts`;
- type-only imports use `import type`;
- no `enum`, `namespace`, or constructor parameter properties.

## 1. What a rule is

A rule is one object of type `Rule`, from `src/diagnostics/rule.ts`.
`timingr-while-pe`, in full:

```ts
// timingr-while-pe: a write to an I2C's TIMINGR while CR1.PE = 1. RM0444
// §32.9.5 says TIMINGR must be configured with PE = 0; the simulator ignores
// such a write, silently (docs/decisions.md §12), so the timing never changes.
import { PE } from "./i2c-pins.ts";
import { fieldName, regName } from "./names.ts";
import type { Rule } from "./rule.ts";

export const timingrWhilePe: Rule = {
  id: "timingr-while-pe",
  check(e, { chip, regs }) {
    if (
      e.kind !== "reg" ||
      e.op !== "write" ||
      !e.periph.startsWith("I2C") ||
      e.reg !== "TIMINGR" ||
      e.flags.length > 0 || // clock off or unsimulated: another rule's
      !(regs[e.periph].CR1 & PE)
    ) {
      return [];
    }
    const p = e.periph;
    return [
      {
        severity: "warning",
        message:
          `wrote ${regName(chip, p, "TIMINGR")} while ${fieldName(chip, p, "CR1", "PE")} = 1, ` +
          "so the write was ignored: " +
          "TIMINGR must be configured when the I2C is disabled, PE = 0 (RM0444 §32.9.5). " +
          "Write TIMINGR before setting PE, or clear PE first",
        periph: p,
        reg: "TIMINGR",
      },
    ];
  },
};
```

- `id` is the rule's name in kebab-case, and its file's name. `sim` prints
  it in brackets after the message, and `--json` puts it in `rule`.
- `check(event, board)` is called for **every event** of the run, and
  returns what it found: almost always `[]`, sometimes one `Finding`.

`board` (a `BoardView`, from `src/engine/engine.ts`) is read-only:

| `board.`          | What it gives                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `regs`            | stored register values by peripheral and register, live: `regs.I2C1.CR1`. Reading them has no side effects      |
| `level(endpoint)` | a net's level: `level("mcu.PB6")` is `"high"`, `"low"`, `"floating"` or `"conflict"`                            |
| `sameNet(a, b)`   | whether a wire or a closed switch joins two endpoints now, e.g. `"mcu.PB6"` and `"mcu.I2C1_SCL"`                |
| `parts`           | the circuit's parts: `id`, `type`, `pins`, `props`, and for an I2C target `i2c.sda`, `i2c.scl`, `i2c.address()` |
| `chip`            | the chip definition: its register map (bit positions), `peripherals` (each one's `gate`), `pins` and `af`       |
| `where(pc)`       | a PC as `file:line`                                                                                             |

The events (`SimEvent`, from `src/engine/events.ts`), each with its `cycle`:

| `kind`          | Emitted                                                     | Fields                                                                                  |
| --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `"reg"`         | by the memory bus, for every CPU access to a register       | `periph`, `reg`, `op` (`"read"` or `"write"`), `old`, `value`, `flags`, `address`, `pc` |
| `"net"`         | by the engine, for each endpoint whose level changed        | `endpoint`, `level`                                                                     |
| `"i2c"`         | by I2C1, one step of its bus trace                          | `periph`, `step`: START, an address with its ACK, a data byte, STOP                     |
| `"unsimulated"` | by a peripheral, when firmware selects a feature it ignores | `periph`, `feature`, e.g. `"CR2.RELOAD"`                                                |

`diagnose()`, in `rule.ts`, runs the rules and does the rest. It counts
repeats (same rule, same message), records where the first one happened (the
cycle, and for a register access the PC and its `file:line`), and catches a
rule that throws.

## 2. Pick the event

Decide which one event shows the mistake, and what state makes it one. The
existing rules:

- a write the hardware ignores in the current state: `TIMINGR` while
  `CR1.PE = 1` (`timingr-while-pe`); the template's `TXDR` while
  `ISR.TXE = 0`;
- an access the bus flagged: `clock-off` (`gpio-clock-off`), `unsimulated`
  (`unsimulated-register`);
- the moment something should happen: firmware sets `CR2.START`
  (`i2c-pins-not-af6`, `i2c-pin-push-pull`, `i2c-bus-not-idle`);
- a bus result: an address NACKed (`i2c-nack-no-device`).

What to know about events:

- **A write's event comes before the write takes effect.** In `check()`,
  `board.regs` still holds the state the firmware wrote into, `e.value` is
  what it wrote (merged with the register's other bytes) and `e.old` what was
  there. So "while PE = 1" reads `regs.I2C1.CR1`, and "sets START" reads
  `e.value`. Whether the write then took effect is the peripheral's business:
  the rule knows from that state, and from RM0444.
- **Flags.** An access with `flags` never reached a peripheral model: its
  clock was off (`clock-off`), nothing simulates the register
  (`unsimulated`), there is no register there (`reserved`), or it was a write
  to flash (`read-only`). Unless your rule is about that flag, skip it with
  `e.flags.length > 0`: another rule explains it, and the peripheral's state
  didn't change.
- **Names are the register JSON's.** `e.periph` and `e.reg` are `"I2C1"`,
  `"TXDR"`, `"AFRL"`, as `docs/adding-a-peripheral.md` step 2 describes.
  Match a family with `e.periph.startsWith("I2C")`, so I2C2 is covered once
  it is simulated.
- **Events come fast.** Firmware polling `I2C1_ISR` makes a `reg` event per
  pass. Test `e.kind` and the register first, and return `[]` at once.

## 3. Copy the templates

The templates are a minimal, working rule, `i2c-txdr-not-empty`: a write to
an I2C's TXDR while `ISR.TXE = 0`, which I2C1 ignores (RM0444 §32.9.11), so
the byte never goes out. Copy both, named after your rule's id:

```sh
cp templates/diagnostic.ts src/diagnostics/my-rule.ts
cp templates/diagnostic.test.ts src/diagnostics/my-rule.test.ts
```

Then fix the import paths, and the repository root in the test. Each is
marked `// TEMPLATE:`:

| File              | In `templates/`                                     | In `src/diagnostics/`                              |
| ----------------- | --------------------------------------------------- | -------------------------------------------------- |
| `my-rule.ts`      | `from "../src/diagnostics/names.ts"`                | `from "./names.ts"`                                |
| `my-rule.ts`      | `from "../src/diagnostics/rule.ts"`                 | `from "./rule.ts"`                                 |
| `my-rule.test.ts` | `from "../src/chips/stm32g031k8.ts"`                | `from "../chips/stm32g031k8.ts"`                   |
| `my-rule.test.ts` | `from "../src/diagnostics/rule.ts"` (2 lines)       | `from "./rule.ts"`                                 |
| `my-rule.test.ts` | `from "../src/engine/circuit.ts"`                   | `from "../engine/circuit.ts"`                      |
| `my-rule.test.ts` | `from "../src/engine/engine.ts"` (2 lines)          | `from "../engine/engine.ts"`                       |
| `my-rule.test.ts` | `from "../src/engine/events.ts"`                    | `from "../engine/events.ts"`                       |
| `my-rule.test.ts` | `import { i2cTxdrNotEmpty } from "./diagnostic.ts"` | `import { myRule } from "./my-rule.ts"`            |
| `my-rule.test.ts` | `const root = new URL("../", import.meta.url);`     | `const root = new URL("../../", import.meta.url);` |

Careful with the `root` row: from `src/diagnostics/` the repository root is
two levels up, and the test can't find `build/` without it.

Rename `i2cTxdrNotEmpty` and `"i2c-txdr-not-empty"` to your rule's, in both
files. Then work through steps 4 and 5, replacing each `TEMPLATE:` comment
with your rule's facts, and delete the comment.

## 4. Write `check()`

The template's:

```ts
  check(e, { chip, regs }) {
    // check() runs on every event, so return [] fast for the ones that aren't
    // yours. TEMPLATE: the event your rule is about.
    if (
      e.kind !== "reg" ||
      e.op !== "write" ||
      !e.periph.startsWith("I2C") ||
      e.reg !== "TXDR" ||
      e.flags.length > 0 // clock off or not simulated: another rule says so
    ) {
      return [];
    }
    // A write's event comes before the write takes effect, so `regs` is the
    // state the firmware wrote into. TXE is set while PE = 0 (§32.9.7), so
    // this is also a write with the I2C enabled.
    if (regs[e.periph].ISR & TXE) return [];
```

- First the event: its kind, op, peripheral, register and flags. Then the
  state, from `board`. Report only when both match.
- **Only read.** Never assign to `board.regs`, and never reach the simulation
  any other way: a rule is a pure observer (AGENTS.md). The types stop most of
  it (`regs` is `Readonly`, and a part's view has only `address()`, which
  parts keep free of side effects). The purity test (step 7) catches the rest.
- **Keep no state between calls.** `rules` in `index.ts` is one list, shared
  by every run and every test, so a variable in your module carries over from
  one run to the next. Repeats are counted for you. If you need history, read
  it from the registers: the state a peripheral keeps is the history the
  hardware has.
- **Reuse what's there.** `regName()` and `fieldName()`, in
  `src/diagnostics/names.ts`, name registers and fields in every message
  (step 5). `startRequested()` (a START set with PE = 1),
  `i2cLines()` (which pins can carry an I2C's SCL and SDA, and which do),
  `gpioOf()` and `PE` are in `src/diagnostics/i2c-pins.ts`;
  `alternateFunction()` is in `src/peripherals/gpio.ts`. Bit positions are
  constants citing RM0444, as the template's `TXE`, or read from
  `board.chip.registers`, as `gpio-clock-off` does for each clock gate's bit.
- **A rule that throws doesn't stop the run.** `diagnose()` reports it as a
  `rule-error` diagnostic instead (`the diagnostic rule "my-rule" failed: …
The run is unaffected, but that rule's findings may be missing`) and goes
  on. It is still a bug in your rule. For instance, `regs[e.periph]` is
  `undefined` for `"SCS"` and `"flash"`, which have no registers, so filter on
  the peripheral before you read it.

## 5. The message

The learner reads it next to their own line of code, so it names what they
wrote and says what to do:

- **The exact register and bit, as the learner `#define`s them, with the
  address.** Exam-style firmware has no ST header: it defines each register
  by address, `#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)`, and
  the address shows a wrong `#define`. Always build the name with the helpers
  in `src/diagnostics/names.ts`, never by hand:
  - `regName(chip, "GPIOB", "MODER")` gives `GPIOB_MODER (0x50000400)`;
  - `fieldName(chip, "RCC", "IOPENR", "GPIOBEN")` gives
    `RCC_IOPENR (0x40021034) bit 1 GPIOBEN`, and a field wider than a bit is
    `GPIOB_MODER (0x50000400) bits 13:12 MODE6`. Add its value after it where
    the message needs it: `… MODE6 = 3`.

  `chip` is `board.chip`. Names and addresses come from the register JSON,
  whose field names follow the CMSIS header (`docs/decisions.md` §4):
  `GPIOBEN`, not the SVD's `IOPBEN`. After the first mention, a bare name is
  fine: "TXDR can be written only when TXE = 1".

- **What happened** in the simulation: "so the write was ignored", "so
  nothing reaches the bus".
- **RM0444's section** for the rule the firmware broke: `(RM0444 §32.9.11)`.
- **The fix**: "Wait for I2C1_ISR (0x40005418) bit 1 TXIS = 1 before
  writing each byte".
- **The same text every time.** Findings with the same rule and message are
  one diagnostic with a count. Don't put the cycle, the value written, or
  anything else that changes between repeats into the message, or a mistake
  inside a loop prints a line per pass.

The template's message:

```
wrote I2C1_TXDR (0x40005428) while I2C1_ISR (0x40005418) bit 0 TXE = 0, so the write was ignored and that byte never goes out: TXDR can be written only when TXE = 1 (RM0444 §32.9.11). Wait for I2C1_ISR (0x40005418) bit 1 TXIS = 1 before writing each byte
```

The rest of the `Finding`:

- `severity`: `"warning"` for a likely mistake in the firmware, `"info"` for
  a limit of the simulator (`unsimulated-register`);
- `periph` and `reg` for a register, or `pin` (`"PB7"`) for a pin: what it is
  about. Set the ones that apply.

## 6. Register the rule

In `src/diagnostics/index.ts`, add one import and one entry:

```ts
// The diagnostic rule registration list: add one import and one entry per rule.
import { gpioClockOff } from "./gpio-clock-off.ts";
import { i2cBusNotIdle } from "./i2c-bus-not-idle.ts";
import { i2cNackNoDevice } from "./i2c-nack-no-device.ts";
import { i2cPinPushPull } from "./i2c-pin-push-pull.ts";
import { i2cPinsNotAf6 } from "./i2c-pins-not-af6.ts";
import { myRule } from "./my-rule.ts";
import type { Rule } from "./rule.ts";
import { timingrWhilePe } from "./timingr-while-pe.ts";
import { unsimulatedRegister } from "./unsimulated-register.ts";

export const rules: readonly Rule[] = [
  gpioClockOff,
  unsimulatedRegister,
  timingrWhilePe,
  i2cPinsNotAf6,
  i2cPinPushPull,
  i2cBusNotIdle,
  i2cNackNoDevice,
  myRule,
];
```

This is the only existing file you edit. It makes `sim run` and
`sim inspect` run your rule, and puts it under the purity test in
`src/diagnostics/rule.test.ts`, which runs every registered rule over four
firmware scenarios and checks that the events and the snapshot are the same
as without them. The template itself is not registered; its test runs it
directly, and so does yours.

## 7. Test it

Tests run headless with `node:test`, no display, and sit next to the rule.
The test you copied in step 3 has two kinds.

**One event at a time**, as `timingr-while-pe.test.ts` does. `board()` is a
`BoardView` with only the registers the rule reads, and `write()` makes a
`reg` event the way the bus does. Change both to what your rule reads, and
test:

- the finding, whole, with `deepEqual`: the message is what the learner
  reads, so the test pins it down word for word;
- each case that must stay silent: the other state, another register, a
  read, a flagged access (`["clock-off"]`).

**The purity check for your scenario.** `run(elf, circuit, rules)` runs
`build/<elf>.elf` on `firmware/<circuit>/circuit.json` (`null`: the chip
alone) for 0.3 s, and returns every event, the final snapshot and the
diagnostics. The test runs it without and with your rule and checks that the
events and the snapshot are identical. `rule.test.ts` does that for every
registered rule too, but its four scenarios may never reach yours, so point
this one at the firmware your rule is about:

- **Firmware that does it right**, as the template uses `tc74-read`, which
  waits for TXIS: assert there are no findings. A rule that fires on correct
  firmware is wrong.
- **Firmware that makes the mistake**, if there is one: the fault firmware
  is in `firmware/faults/<name>/` and builds to `build/faults/<name>.elf`, so
  `run("faults/gpio-clock", "faults/gpio-clock", [myRule])`. Assert the
  finding, its `count` and its `at` (`firmware/faults/<name>/main.c:<line>`),
  as `rule.test.ts`'s `faults/gpio-clock` test does.
- If no firmware makes the mistake yet, writing it (`firmware/faults/<name>/`,
  a `main.c` and a `circuit.json`) is a separate change, like firmware for a
  new part.

## 8. Run the checks

```sh
node --test src/diagnostics/my-rule.test.ts   # your test
node --test src/diagnostics/rule.test.ts      # the purity test, now with your rule
just test                                     # every test (run `just fw` once first)
just typecheck                                # tsc, no output files
git status                                    # your changes
```

All must pass. Of the files you created or changed, `git status` must list
only your two new files and `src/diagnostics/index.ts`.

## 9. Optional: see it from the CLI

`sim run` prints the diagnostics, one line each, at the line of firmware that
caused them:

```sh
just sim run build/faults/gpio-clock.elf --circuit firmware/faults/gpio-clock/circuit.json --for 300ms
```

```
diagnostics
  firmware/faults/gpio-clock/main.c:118: warning: read GPIOB_OTYPER (0x50000404) while RCC_IOPENR (0x40021034) bit 1 GPIOBEN = 0 — GPIOB's clock is off, so the read returned 0 [gpio-clock-off]
  …
  firmware/faults/gpio-clock/main.c:84: warning: I2C1_CR2 (0x40005404) bit 13 START was set, but I2C1_SCL and I2C1_SDA aren't on any pin, so nothing reaches the bus. … [i2c-pins-not-af6]
```

Your rule's lines end in `[my-rule]`, on firmware that makes the mistake.
Add `--json` for the same as JSON (`docs/cli.md`).

## Checklist

- [ ] `src/diagnostics/<rule-id>.ts`: one event, read-only, no state, a
      message naming the register and bit with `regName()`/`fieldName()`, an
      RM0444 section and the fix.
- [ ] No `TEMPLATE:` comments left, and no `i2cTxdrNotEmpty` or
      `i2c-txdr-not-empty`.
- [ ] `src/diagnostics/<rule-id>.test.ts`: the finding word for word, the
      silent cases, and the purity check on your scenario.
- [ ] `src/diagnostics/index.ts`: one import, one entry.
- [ ] `just test` and `just typecheck` pass.
- [ ] `git status` shows no other file of yours.
