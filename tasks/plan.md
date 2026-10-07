# Implementation plan: stm32-sim

## Overview

Build the simulator described in `stm32-sim-brief.md` in the brief's build order:

1. CPU, ELF and a GPIO toggle.
2. SysTick.
3. I2C and the TC74.
4. MCP23017 and the 7-segment display.
5. Button.
6. Extension recipes.
7. UI and `sim watch`.
8. Register view, diagnostics and stepping.

The stack and reuse choices are already settled in `docs/decisions.md`; this plan
doesn't reopen them. Full task cards (acceptance criteria, verification, files) are in
`tasks/todo.md`. This file is the index, the dependency graph and the parallel lanes.

**One agent:** do the tasks in ID order. That follows the brief's build order.

**Several agents:** any task whose "blocked by" tasks are all done can start. Give
each agent its own git worktree and branch, as `~/AGENT_HANDOFF.md` requires. The
shared registration lists are the only files parallel tasks are expected to both
touch: `src/parts/index.ts`, `src/diagnostics/index.ts`, and the peripheral list in
the chip definition. Those merges are one-line conflicts. When a task passes between
agents, record it in `docs/agent-handoffs/<task-id>.md`.

## Design decisions made at plan level

Each of these is implemented in the task named, which also records it in
`docs/decisions.md`.

- **Contracts first.** Four interfaces are shared by every later task:
  - `Bus` (CPU ↔ memory, T2);
  - `Net` and `Part` (T5);
  - `Peripheral` (T7);
  - the I2C target (T13).

  Each gets a review before work that depends on it fans out (see Contract gates).

- **Clock gating is enforced once, in the memory bus** (T7), using the gate each
  peripheral declares. No peripheral reimplements it. That keeps the "writes with the
  clock off do nothing" behavior consistent everywhere.
- **One event log** (T7). It records register reads and writes (with PC and time),
  I2C bus events and net changes. Diagnostics, the I2C trace, `sim inspect` and the
  UI all read it. Nothing else hooks into the engine, and diagnostics never write.
- **Nets carry a level, not a boolean** (T5): `high`, `low`, `floating`, or `conflict`
  for a short. Drivers are:
  - strong: push-pull, or open-drain pulling low;
  - weak: pull-ups/pull-downs, and resistors linking two nets;
  - switches: buttons joining two nets.

  Analog can add a voltage later without changing the parts that only read levels.

- **I2C is simulated at the transaction level** (T13), not by toggling SDA/SCL bit by
  bit. Every transaction first checks the real net levels: are the lines pulled high,
  and are the pins routed to I2C1? That reproduces every fault the brief lists at a
  fraction of the cost of bit-level simulation.
- **Time is simulated, from CPU cycles at 16 MHz.** Runs are deterministic: the same
  ELF and circuit give the same event log. "Real time" mode only throttles against
  the wall clock.
- **Tests:**
  - unit tests sit next to the file they test (`x.ts` → `x.test.ts`);
  - firmware end-to-end tests use real ELFs built by `just fw`;
  - a missing ELF fails the test with a message saying how to build it. It never
    skips the test.
- **The CLI's JSON output carries `"version": 1`.** `docs/cli.md` is the contract for
  commands, JSON shape and exit codes (T10).

Proposed layout. T1 creates it, and later tasks fill it in.

```
src/cpu/          copied rp2040js core + Bus interface
src/engine/       memory bus, nets, circuit JSON, events, I2C bus, ELF, run loop
src/chips/        chip definitions (peripheral registration list) + registers JSON
src/peripherals/  one file + test per peripheral
src/parts/        one file + test per part; index.ts = registration list
src/diagnostics/  one file + test per rule; index.ts = registration list
src/cli/          `sim`
src/ui/           browser UI
firmware/         linker script, Makefile; one directory per program (main.c + circuit.json)
vendor/           cmsis-device-g0, cmsis-core, svd, each with its LICENSE
tools/            svd2json.ts
templates/        extension templates and test templates
```

## Dependency graph

```
T1 scaffold ─┬─ T2 CPU core ──┬─ T7 bus/peripheral API ─┐
             │                └─ T11 fault fidelity     │
             ├─ T4 SVD→JSON ────────────────────────────┤
             ├─ T5 nets/parts ─┬────────────────────────┴─ T8 RCC+GPIO ─┐
             │                 ├─ T13 I2C bus ─┬─ T15 TC74             │
             │                 │               └─ T18 MCP23017         │
             │                 ├─ T16 resistor+button                  │
             │                 ├─ T19 LED+7seg                         │
             │                 └─ T29 SVG art                          │
             └─ T3 firmware ── T6 ELF+lines ───────────────────────────┴─ T9 engine+blink
                                                                              │
          ┌───────────────────────────────┬───────────────────────────────┬──┤
     T10 CLI ── T20 inputs          T12 SysTick                    T14 I2C1 (T8,T13)
          │                               │                               │
          └──────────────── T17 TC74 firmware e2e (T10,T12,T14,T15,T16) ──┘
                                          │
                    T21 thermometer, acceptance 2 (T17,T18,T19,T20)
                     ├─ T22/T23 fault tests (acceptance 3)
                     ├─ T26/T27 recipes ── T28 acceptance 4 (TMP102)
                     └─ (UI: T30 shell ── T31–T36) ── T37 README/release
```

The graph shows the main edges. The "Blocked by" column below and each card in
`tasks/todo.md` are authoritative.

**Critical path:** T1 → T2 → T7 → T8 → T9 → T10 → T17 → T21 → T26 → T28 → T37.
Speeding up anything off this path doesn't finish the project sooner, so spare agents
should take off-path work early: T4, T5, T11, T13, T15, T16, T18, T19, T29.

## Parallel waves

A wave is the earliest point a task can start. Everything in the same wave can run at
the same time, and a task can also start later than its wave.

| Wave | Tasks that can run in parallel    | Unblocked by                  |
| ---- | --------------------------------- | ----------------------------- |
| 0    | T1 · T0 (user action)             | nothing                       |
| 1    | T2, T3, T4, T5                    | T1                            |
| 2    | T6, T7, T11, T13, T16, T19, T29   | T2 / T3 / T4 / T5             |
| 3    | T8, T15, T18                      | T7, T13                       |
| 4    | T9                                | T6 + T8                       |
| 5    | T10, T12, T14                     | T9 (+T13 for T14)             |
| 6    | T17, T20, T24, T30                | T10 / T12 / T14 / T15 / T16 … |
| 7    | T21, T22, T25, T31, T33, T34, T36 | T17 / T20 / T24 / T30 …       |
| 8    | T23, T26, T27, T32, T35           | T21 / T25 / T31               |
| 9    | T28                               | T26                           |
| 10   | T37                               | T28 + all UI tasks            |

## Task index

The size labels are XS, S, M and L, from the skill's sizing table. Full cards are in
`tasks/todo.md`.

### Phase 0: Setup

| ID  | Task                                                                     | Size | Blocked by                                                                    |
| --- | ------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------- |
| T0  | Install `arm-none-eabi-gcc` on this laptop (**user action**, needs sudo) | XS   | — (blocks local runs of T3, T6, T9 and every firmware test; CI is unaffected) |
| T1  | Repo scaffold: package.json, tsconfig, mise, justfile, LICENSE, CI       | S    | —                                                                             |

### Phase 1: CPU, memory, ELF, GPIO (brief step 1)

| ID  | Task                                                                | Size | Blocked by             |
| --- | ------------------------------------------------------------------- | ---- | ---------------------- |
| T2  | Copy the rp2040js CPU core behind a `Bus` interface; port its tests | M    | T1                     |
| T3  | Firmware build: vendored CMSIS, linker script, `blink`              | M    | T1 (T0 to run locally) |
| T4  | Vendor the patched G031 SVD and convert it to registers JSON        | M    | T1                     |
| T5  | Net model, `Part` interface, circuit JSON load/save                 | M    | T1                     |
| T6  | ELF loading and PC → file:line                                      | S    | T3                     |
| T7  | Memory bus, `Peripheral` interface, chip definition, event log      | M    | T2, T4                 |
| T8  | RCC and GPIOA/GPIOB                                                 | M    | T5, T7                 |
| T9  | Engine run loop and blink end-to-end test                           | M    | T6, T8                 |
| T10 | CLI: `sim run`, `sim inspect`, `--json`, exit codes                 | M    | T9                     |
| T11 | CPU fault fidelity: HardFault on undefined opcodes, lockup          | S    | T2                     |

**Checkpoint 1 (brief step 1).**

- `sim run firmware/blink` toggles PA0.
- `sim inspect --json` shows the pins, registers with named bits, and the PC as
  file:line.
- `just test` and `just typecheck` pass; CI is green.
- Review with Shawn.

### Phase 2: Time and I2C (brief steps 2–3)

| ID  | Task                                             | Size | Blocked by              |
| --- | ------------------------------------------------ | ---- | ----------------------- |
| T12 | SysTick and real-time/max speed control          | M    | T9                      |
| T13 | I2C bus model, target interface, bus trace       | M    | T5                      |
| T14 | I2C1 peripheral (v2 master)                      | L    | T8, T9, T13             |
| T15 | TC74 part                                        | S    | T13                     |
| T16 | Resistor and push-button parts                   | S    | T5                      |
| T17 | TC74 firmware end-to-end test with the bus trace | M    | T10, T12, T14, T15, T16 |

**Checkpoint 2 (brief steps 2–3).**

- With the slider at 22, firmware reads 22 over I2C.
- The trace shows START / 0x48 W / ACK / … / STOP.
- `sim inspect` prints the trace.

### Phase 3: Display, input, faults, diagnostics (brief steps 4–5 and acceptance 2–3)

| ID  | Task                                                                  | Size | Blocked by         |
| --- | --------------------------------------------------------------------- | ---- | ------------------ |
| T18 | MCP23017 part                                                         | M    | T13                |
| T19 | LED and 7-segment parts (common anode and common cathode)             | S    | T5                 |
| T20 | Mid-run inputs (engine API and CLI)                                   | S    | T10, T15           |
| T21 | Thermometer firmware; acceptance test 2 (22 → 71 → 22)                | M    | T17, T18, T19, T20 |
| T22 | Fault tests: wrong GPIO clock; no pull-ups                            | S    | T17                |
| T23 | Fault tests: RESET floating; segments off by one; wrong polarity      | M    | T21                |
| T24 | Diagnostics framework, plus GPIO-clock and unsimulated-register rules | M    | T10                |
| T25 | I2C diagnostic rules                                                  | M    | T14, T24           |

**Checkpoint 3 (acceptance 2 and 3).**

- The thermometer test passes.
- All five fault tests pass, each failing the way real hardware does.
- Diagnostics explain each fault without changing the run: the event log is identical
  with and without them.

### Phase 4: Extensibility (brief step 6)

| ID  | Task                                                                       | Size | Blocked by |
| --- | -------------------------------------------------------------------------- | ---- | ---------- |
| T26 | `docs/adding-a-part.md`, part template + test template, AGENTS.md extension points | M    | T21        |
| T27 | `docs/adding-a-peripheral.md`, peripheral and diagnostic templates         | M    | T21, T25   |
| T28 | Acceptance 4: a fresh agent adds a TMP102 using only the recipe            | S    | T26        |

**Checkpoint 4: headless MVP complete.**

- Acceptance checks 1–4 pass in CI with no display.
- Review with Shawn before the UI work.

### Phase 5: UI (brief steps 7–8)

| ID  | Task                                                                                         | Size | Blocked by         |
| --- | -------------------------------------------------------------------------------------------- | ---- | ------------------ |
| T29 | SVG art: breadboard, NUCLEO-G031K8, DIP-28, TO-220-5                                         | M    | T5                 |
| T30 | UI shell: `sim ui`, local server, engine in the page, parts rendered; headless UI test setup | L    | T10, T16, T19, T29 |
| T31 | Place and move parts; save circuit JSON (round trip)                                         | M    | T30                |
| T32 | Wires and breadboard row connectivity                                                        | M    | T31                |
| T33 | `sim watch`: reload on ELF change, headless and in the UI                                    | M    | T30                |
| T34 | Register view with named bits                                                                | M    | T4, T30            |
| T35 | I2C trace panel and diagnostics panel                                                        | M    | T25, T30           |
| T36 | Pause, resume and step with the current source line; speed toggle                            | M    | T6, T12, T30       |

**Checkpoint 5.**

- The thermometer circuit can be built from scratch in the UI, saved, reloaded and run.
- `sim watch` picks up a rebuild.
- Stepping shows the source line.

### Phase 6: Release

| ID  | Task                                                                                   | Size | Blocked by   |
| --- | -------------------------------------------------------------------------------------- | ---- | ------------ |
| T37 | README with GIF and "your first part in 10 minutes"; packaging for a one-command start | M    | T28, T32–T36 |

**Checkpoint 6: complete.**

- Every acceptance item in the brief is met and verified in CI.
- The README quickstart works from a fresh clone.

## Contract gates

These are reviews before parallel work fans out over a shared interface. Each takes
one review pass, by Shawn or by Fable per the handoff guide, against the brief's
principles.

- **After T5:** the `Net` and `Part` API, before T13, T16, T18, T19 and T29 start.
  Check that it isn't boolean-only, and that switches and weak links are supported.
  **Passed 2026-10-07.** Levels are a string union; switches, resistor links and rails are
  supported. One gap: parts have no way to expose what they show (LED lit, 7-segment
  `values`). It is an optional, non-breaking addition, assigned to T19.
- **After T7:** the `Peripheral` API and clock gating, before T8, T12 and T14.
- **After T13:** the I2C target interface, before T15 and T18.

## Risks and mitigations

| Risk                                                                                 | Impact       | Mitigation                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The CPU port changes instruction behavior                                            | High         | T2 is behavior-preserving, and every upstream test must pass before any change. Fidelity fixes come separately (T11), each with its own test. |
| `@gba-kit/debug-info` fails on GCC's DWARF 5                                         | Med          | T6 is in wave 2, so it fails fast. Fallback per `decisions.md` §5: vendor and fix it, or write a `.debug_line` reader.                        |
| Behavior RM0444 doesn't specify (reads with the clock off, I2C with pins not routed) | Med          | Each such choice is marked "assumed" in code and in `decisions.md`, and checked on a real board when one is available (Open question 3).      |
| The net model is too simple (boolean) or too clever (analog creep)                   | Med          | Contract gate after T5. Levels are an extensible union, and analog stays out of the MVP.                                                      |
| No toolchain on this laptop                                                          | High (local) | T0 is a user action. CI installs `gcc-arm-none-eabi` from apt either way.                                                                     |
| Parallel agents overwrite each other                                                 | Med          | One worktree per agent. Registration lists are the only shared files.                                                                         |
| UI tests can't run headless in CI                                                    | Med          | T30 picks the headless browser approach first and records it before any UI feature work.                                                      |
| Copied code diverges from upstream fixes                                             | Low          | Record the upstream commit (rp2040js `a304c74`) in the file header; diff against upstream when bumping.                                       |

## Open questions

1. **LICENSE copyright line (T1):** whose name should it carry, and with which year?
2. **GitHub remote (T1):** should the repo be created on GitHub, under which account,
   and public or private? `gh` isn't authenticated yet. CI can't be verified green
   until a remote exists.
3. **Hardware cross-check:** is a NUCLEO-G031K8 available? With probe-rs, the rp2040js
   test driver can run the CPU tests against the real chip. It can also settle the
   "assumed" behaviors in the Risks table.
