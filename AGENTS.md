# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`CLAUDE.md` is a symlink to `AGENTS.md`, so every agent reads the same file. Edit `AGENTS.md`.

## What this is

A local, offline, MIT-licensed learning environment for STM32 microcontrollers, with a
virtual breadboard. It runs the learner's unmodified `.elf` from `arm-none-eabi-gcc`.
That firmware is register-level C with no HAL. The first target is the STM32G031K8
(NUCLEO-G031K8). Other STM32s come later.

The spec is `stm32-sim-brief.md`: read it before planning any step. Where the brief and
this file differ, this file wins. The brief's "G031K8 only" and "digital only" wording
describes MVP scope, not a permanent limit.

It is a learning tool, not an emulator built from scratch. Reuse existing open-source
pieces wherever they fit. Write our own only where nothing suitable exists.

## Commands

Node 24 and `just` come from `.mise.toml`. Run `npm install` once after cloning.

- `just test`: run every `*.test.ts` (`node --test`).
- `node --test path/to/x.test.ts`: run one file.
- `node --test 'src/cpu/**/*.test.ts'`: run one directory (`node --test src/cpu/` fails on Node 24).
- `node --test --test-name-pattern "<name>"`: run one test by name.
- `just typecheck`: run `tsc` with no output files.
- `just fw`: build every `firmware/<name>/main.c` into `build/<name>.elf` (needs `arm-none-eabi-gcc`).

`node --test` treats these as test files, so don't use them for helpers: `test-*.ts`, `*-test.ts`, `*_test.ts`, `test.ts`, and anything under a `test/` directory.

There is no build step: Node runs the `.ts` files directly. That only works for TS
syntax that can be erased, so:

- no `enum`, `namespace` or constructor parameter properties (`just typecheck`
  rejects them);
- relative imports use the `.ts` extension;
- type-only imports use `import type`.

## Extension points

Each one is a file plus one entry in a registration list. Every new part or
peripheral ships with a headless test next to it (`x.ts` → `x.test.ts`), which
`just test` runs.

- **Part:** `src/parts/<name>.ts`, registered in `src/parts/index.ts`. The interface
  is `src/parts/part.ts`; an I2C target is `I2cTarget` in `src/engine/i2c.ts`.
  Recipe: `docs/adding-a-part.md`, with the TC74 as the worked example. Templates:
  `templates/part.ts` and `templates/part.test.ts`.
- **Peripheral:** `src/peripherals/<name>.ts`, registered in the chip definition's
  `peripherals` list (`src/chips/stm32g031k8.ts`). The interface is
  `src/peripherals/peripheral.ts`. The file holds behavior only; registers and reset
  values come from `src/chips/stm32g031k8.registers.json`. Recipe:
  `docs/adding-a-peripheral.md`, with I2C1 as the worked example. Templates:
  `templates/peripheral.ts` (TIM14's time base) and `templates/peripheral.test.ts`.
- **Diagnostic rule:** `src/diagnostics/<name>.ts`, registered in
  `src/diagnostics/index.ts`. The interface is `src/diagnostics/rule.ts`. Recipe:
  `docs/adding-a-diagnostic.md`, with `timingr-while-pe` as the worked example.
  Templates: `templates/diagnostic.ts` and `templates/diagnostic.test.ts`.

The templates are not registered. Their tests mount them directly and run in
`just test`, so they can't go stale.

`docs/decisions.md` records the stack and every reuse choice, with licenses and
sources. Read it before changing anything it covers; don't reopen a decision without
new evidence. The build plan is `tasks/plan.md`, and each task's card is in
`tasks/todo.md`.

## Behavioral rules the simulator must keep

These are the product. Most "helpful" changes would break one of them.

- **Reproduce silent failures. Never fix the firmware's mistake.** With the port clock
  off, GPIO writes do nothing. A TIMINGR write while PE=1 is ignored. An I2C read
  without setting the pointer returns the register the pointer is already on. A bus
  held low reads as BUSY, and START never happens. A floating MCP23017 RESET NACKs
  every address.
- **Diagnostics explain and never alter behavior.** A diagnostic rule is a pure
  observer of register writes and bus events.
- **Log any access to an unimplemented register**, rather than silently returning 0
  or throwing.
- **Digital first.** In the MVP a net is high, low or floating, and open-drain is
  wired-AND with pull-ups. Analog (ADC inputs, potentiometers, sensors with voltage
  outputs) is later scope, because learners build analog projects too. Don't build
  analog yet, but don't put "a net is a boolean" into the interface that parts depend
  on. No cycle-exact timing.
- G031K8 (MVP target): reset values come from RM0444. The G031 is **not** an F4: clocks
  are gated through
  `RCC->IOPENR` / `APBENR1`, I2C is the "v2" IP (CR2 SADD/NBYTES/AUTOEND, ISR/ICR), and
  I2C1 is on PB6/PB7 as AF6. Core clock 16 MHz, flash `0x08000000`, SRAM
  `0x20000000` (8 KB).

## Architecture (as specified; keep it this shape)

- **One headless engine.** The CLI and the browser UI are both thin layers over the
  same engine. Nothing the UI can do should be impossible from the CLI.
- **Chip-specific facts live in a chip definition, not in the engine.** That means the
  core, the memory map, and which peripherals sit at which addresses. A second STM32
  should mean adding a new definition plus any peripherals it doesn't share with the
  G031. It should not mean editing the engine.
- **Extension points**, each one file plus one line in a single registration list:
  - _Part_: pins, behavior (GPIO levels and/or an I2C target), properties (address,
    variant) and its visual.
  - _Peripheral_: base address, registers with reset values and named bits, read/write
    side effects, and the clock gate it depends on.
  - _Diagnostic rule_: one small function.
- Acceptance check 4 requires that a new I2C part can be added from
  `docs/adding-a-part.md` without touching any core file except the registration list.
  If a part needs a core edit, the extension interface is wrong; fix the interface.
- No plugin loader or framework beyond what the MVP parts need.
- Circuits are readable, hand-editable JSON, diff-friendly (stable key order, no
  generated IDs where a name will do).
- CLI contract: `sim run firmware.elf --circuit circuit.json --for 2s` (plus inputs set
  mid-run), `sim inspect` (pins, named-bit registers, PC as file:line, I2C trace),
  `sim watch`. Every command takes `--json`. Exit codes and JSON shapes are a stable
  interface for CI and assistants, so changing them is a breaking change.

## Repo rules

- Every new part or peripheral ships with a headless test next to it. All tests must
  run in CI without a display.
- Each extension type has a template file and a test template. Update the template and
  the matching `docs/adding-a-*.md` recipe whenever the interface changes.
- Example firmware is written for this repo. Never copy it from a course assignment.
- MIT project: any reused code must have an MIT-compatible license, recorded in
  `docs/decisions.md`. Vendored ST CMSIS headers are Apache-2.0; keep their license
  file next to them.
