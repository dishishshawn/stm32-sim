# Tasks

The index, dependency graph and waves are in `tasks/plan.md`. Tick a box only when its
verification has actually run.

Commands (once T1 exists):

- `just test`: all tests.
- `node --test path/to/x.test.ts`: one file.
- `node --test --test-name-pattern "<name>"`: one test.
- `just typecheck`.
- `just fw`: build the firmware; needs `arm-none-eabi-gcc`.

Every task also clears these:

- `just typecheck` and `just test` pass.
- Code follows `AGENTS.md`, in particular: never fix the firmware's mistake, and log
  unimplemented registers.
- Any new decision is recorded in `docs/decisions.md`.

---

## Phase 0: Setup

### T0: Install the ARM toolchain on this laptop (user action)

- [x] `arm-none-eabi-gcc --version` works: 14.2.1 (Ubuntu 15:14.2.rel1-1), checked 2026-10-07. It emits DWARF 5 by default.

**How:** run `! bash ~/install-remaining.sh` (it uses apt and needs sudo). Or unpack
the Arm GNU Toolchain tarball under `~/.local`.

**Blocked by:** nothing. **Blocks:** local runs of T3, T6 and T9, and every firmware
test. CI installs its own copy.

### T1: Repo scaffold

Create the project skeleton and CI so every later task has `just test` and
`just typecheck`.

- [x] Add:
  - `package.json`: `"type": "module"`, `engines.node >= 24`, private; dev
    dependencies `typescript` (7.0.2) and `@types/node` (24.19.1).
  - `tsconfig.json`: `strict`, `noEmit`, `allowImportingTsExtensions`,
    `erasableSyntaxOnly`, `verbatimModuleSyntax`, `module: nodenext`.
  - `.mise.toml`: `node = "24"`, `just = "1"`.
  - `justfile` recipes `test` and `typecheck`. The `fw` recipe comes with T3 and
    `sim` with T10; a recipe for code that doesn't exist yet would only fail.
  - `LICENSE`: MIT, Copyright (c) 2026 Shawn Agarwal.
  - The layout directories from `plan.md`, created only as files land.
  - `AGENTS.md`: the test, single-test and typecheck commands.
- [x] One smoke test passes under `just test`. A temporary `enum` makes
      `just typecheck` fail with TS1294, which proves `erasableSyntaxOnly` is on.
- [x] `.github/workflows/ci.yml` runs on ubuntu-24.04: checkout, mise (node and
      just), `npm ci`, `just typecheck`, `just test`. T3 adds the firmware steps.
      Green on its first run (run 37651129484, 2026-10-07): 222 tests, 1 min 4 s.

**Verify:** `just test`, `just typecheck`. CI can only be confirmed green on GitHub
after a remote exists (plan.md, Open question 2). **Blocked by:** nothing.
**Wave 0.** **Files:** the root config files and `src/smoke.test.ts`. **Size:** S.
**Needs:** the copyright name (plan.md, Open question 1).

---

## Phase 1: CPU, memory, ELF, GPIO

### T2: Copy the rp2040js CPU core behind a `Bus` interface

Copy `src/cortex-m0-core.ts` and `src/instructions.spec.ts` from rp2040js at commit
`a304c74`.

- Replace the `RP2040` dependency with a `Bus` interface: read/write of 8/16/32 bits,
  plus a break hook.
- Remove the RP2040 `cyclesIO` address ranges.
- Make the IRQ count a constructor parameter.
- Convert non-erasable syntax (parameter properties, any `enum`) to plain fields and
  `as const` objects.
- Change no instruction behavior here; that's T11.

- [x] Every upstream instruction case passes under `node:test`, run against a test
      bus backed by flat RAM.
- [x] `rg -i rp2040 src/cpu` matches only the attribution header. The header names
      the upstream repo, the commit and the MIT license, with Uri Shaked's copyright.
- [x] `just typecheck` passes.

**Verify:** `node --test 'src/cpu/**/*.test.ts'`. **Blocked by:** T1. **Wave 1**, parallel with T3,
T4 and T5. **Files:** `src/cpu/cortex-m0-core.ts`, `src/cpu/cortex-m0-core.test.ts`,
`src/cpu/bus.ts`, `src/cpu/ram-bus.ts`. **Size:** M.

### T3: Firmware build, vendored CMSIS, `blink`

- [x] Vendor these, each with its `LICENSE` and a short `VERSION` note:
  - ST cmsis-device-g0 v1.4.5: `stm32g0xx.h`, `stm32g031xx.h`, `system_stm32g0xx.h`,
    the gcc `startup_stm32g031xx.s` and `system_stm32g0xx.c` templates;
  - the Arm CMSIS-Core headers that `stm32g031xx.h` includes, at the version
    v1.4.5 expects.
- [x] Add a linker script for the G031K8 (64 KB flash at `0x08000000`, 8 KB SRAM at
      `0x20000000`) and `firmware/Makefile`. A new `fw` recipe in the `justfile` builds
      `build/<program>.elf` with `-mcpu=cortex-m0plus -mthumb -g`.
- [x] `firmware/blink/main.c` enables the GPIOA clock, sets PA0 as an output and
      toggles it in a busy-wait loop. No SysTick yet.
- [x] CI installs `gcc-arm-none-eabi` from apt and runs `just fw` before
      `just test`.

**Verify:** `just fw`; `arm-none-eabi-objdump -h build/blink.elf` shows `.text` at
`0x0800xxxx`. **Blocked by:** T1, and T0 to run locally. **Wave 1**, parallel with T2,
T4 and T5. **Files:** `vendor/cmsis-device-g0/**`, `vendor/cmsis-core/**`,
`firmware/Makefile`, `firmware/stm32g031k8.ld`, `firmware/blink/main.c`.
**Size:** M; the vendoring is mechanical.

### T4: Vendor the patched SVD and convert it to registers JSON

- [x] Vendor the stm32-rs `stm32g031.svd.patched`:
  - record the source URL and stm32-rs commit;
  - put back ST's Apache-2.0 notice, which the patched file drops;
  - add `vendor/svd/LICENSE`.
- [x] `tools/svd2json.ts` writes `src/chips/stm32g031k8.registers.json`:
  - per peripheral: its base address;
  - per register: offset, size, access, reset value;
  - per field: name, bit offset, width, access;
  - `derivedFrom` resolved, keys in stable order, 2-space indent.
  - Running it twice gives byte-identical output.
  - Pick the XML parser dev dependency and record it in `decisions.md`.
- [x] Tests spot-check the JSON against RM0444:
  - GPIOA base `0x50000000`, MODER reset `0xEBFFFFFF`;
  - GPIOB MODER reset `0xFFFFFFFF`;
  - RCC IOPENR at offset `0x34`;
  - I2C1 base `0x40005400`, TIMINGR at `0x10`, CR2 fields SADD/RD_WRN/NBYTES/AUTOEND.

  Record whether the SVD includes SysTick, NVIC and SCB. That answers the open item
  in `decisions.md` §4.

**Verify:** `node --test 'tools/**/*.test.ts' 'src/chips/**/*.test.ts'`. **Blocked by:** T1. **Wave 1**, parallel
with T2, T3 and T5. **Files:** `vendor/svd/*`, `tools/svd2json.ts`,
`tools/svd2json.test.ts`, `src/chips/stm32g031k8.registers.json`. **Size:** M.

### T5: Net model, `Part` interface, circuit JSON

This is the shared contract for every part. **Contract gate:** review it before T13,
T16, T18, T19 or T29 start.

- [x] `src/engine/nets.ts` resolves each net to `high`, `low`, `floating` or
      `conflict`. Drivers are:
  - strong: push-pull high/low, open-drain low;
  - weak: pull-up/pull-down, and resistor links (they carry strong levels only, with
    no weak-to-weak chaining);
  - switches: two nets joined while a switch is closed.

  `3V3` and `GND` are built-in rails. The level type is a union, not a boolean.
  Truth-table tests cover:
  - wired-AND of open-drain with a pull-up;
  - floating when nothing drives the net;
  - conflict for push-pull high against push-pull low;
  - a switch closing and opening.

- [x] `src/parts/part.ts` (the `Part` interface: pins, typed props, net callbacks,
      tick) and `src/parts/index.ts` (the registration list, empty for now). MCU pins
      are endpoints named `mcu.PA0`.
- [x] `src/engine/circuit.ts` loads and saves circuit JSON:
  - `{ chip, parts: [{ id, type, props, pos? }], wires: [["a.pin", "b.pin"], …] }`;
  - load followed by save is byte-identical;
  - an unknown part type, pin or prop is an error that names the bad field. This is
    a trust boundary: users hand-edit this file.

**Verify:** `node --test 'src/engine/**/*.test.ts' 'src/parts/**/*.test.ts'`. **Blocked by:** T1. **Wave 1**,
parallel with T2, T3 and T4. **Files:** `src/engine/nets.ts`, `src/engine/circuit.ts`,
`src/parts/part.ts`, `src/parts/index.ts`, plus tests. **Size:** M.

### T6: ELF loading and PC → file:line

- [x] Add `@gba-kit/debug-info`, pinned to an exact version. `src/engine/elf.ts` loads
      `PT_LOAD` segments by physical address (LMA) into the flash and SRAM images,
      and looks up symbols and `pcToSource`.
- [x] Tested on `build/blink.elf`:
  - `Reset_Handler` and `main` resolve;
  - a PC inside `main` maps to `firmware/blink/main.c:<line>`;
  - the `.data` initial image is in flash.
- [x] If the package fails on GCC's DWARF 5, apply the fallback in `decisions.md` §5
      and record what happened.

**Verify:** `just fw && node --test src/engine/elf.test.ts`. **Blocked by:** T3, and
T0 to run locally. **Wave 2**, parallel with T7, T11, T13, T16, T19 and T29.
**Files:** `src/engine/elf.ts`, `src/engine/elf.test.ts`, `package.json`. **Size:** S.

### T7: Memory bus, `Peripheral` interface, chip definition, event log

**Contract gate:** review before T8, T12 or T14 start.

- [x] `src/engine/memory-bus.ts` implements `Bus`:
  - flash is read-only (follow RM0444 for direct writes; record the source);
  - SRAM is 8 KB;
  - registers are dispatched by address;
  - an unmapped address throws `BusFault` (from `src/cpu/bus.ts`), which the core turns into a HardFault (T11), because ARMv6-M has no BusFault exception;
  - a register in the SVD that isn't simulated stores and returns its value
    (starting at the reset value), and every access is logged with the register's
    name;
  - byte and halfword accesses use the correct lanes;
  - clock gating is enforced here, from each peripheral's declared gate: writes are
    ignored and the event is flagged.
- [x] `src/peripherals/peripheral.ts` holds the interface: name, its registers from the
      JSON, read/write hooks, clock gate, reset. `src/chips/stm32g031k8.ts` holds
      the core type, memory map, 16 MHz, 32 IRQs, and the peripheral registration
      list.
- [x] `src/engine/events.ts` is the single event log: register access events
      `{t, pc, periph, reg, old, new, flags}` and bus events, with subscribers.
      Tests cover:
  - a write with the clock gated off changes nothing and is flagged;
  - an unsimulated register is logged by name;
  - an unmapped address throws `BusFault`;
  - byte lanes.

- [ ] Follow-up (RM0444 check): a direct flash write sets FLASH_SR.PGSERR (§3); and the
      2-cycle delay after a clock-enable bit is set, during which register accesses have
      no effect (§5.2.17). Neither is modelled yet.
**Verify:** `node --test 'src/engine/**/*.test.ts' 'src/peripherals/**/*.test.ts'`. **Blocked by:** T2, T4.
**Wave 2.** **Files:** `memory-bus.ts`, `events.ts`, `peripheral.ts`,
`src/chips/stm32g031k8.ts`, plus tests. **Size:** M.

### T8: RCC and GPIOA/GPIOB

- [x] Extend the T7 `Peripheral` contract, as the T7 review agreed: `nets` and
      `regsOf(name)` (a read-only view of another peripheral's registers; I2C1 needs
      GPIOB's MODER/AFR) on `PeripheralContext`, passed through the `MemoryBus`
      options. Add the G031K8 pin list to the chip definition, for circuit validation.
- [x] `src/peripherals/rcc.ts`: IOPENR and APBENR1. These are the bits the bus reads
      for gating.
- [x] `src/peripherals/gpio.ts`: MODER, OTYPER, PUPDR, IDR, ODR, BSRR, AFRL and AFRH.
      Pins drive nets according to their mode:
  - output: push-pull or open-drain;
  - input: pull-up/down;
  - analog: hi-z;
  - AF: owned by the peripheral selected by the AF number.
- [x] Tests:
  - with IOPENR.GPIOAEN = 0, a MODER write has no effect;
  - PA0 output high makes the net high;
  - BSRR with both bits set for a pin sets it;
  - IDR follows the net, including a pull-up on a floating net;
  - open-drain output with an external weak pull-up gives wired-AND.

**Verify:** `node --test 'src/peripherals/**/*.test.ts'`. **Blocked by:** T5, T7. **Wave 3**,
parallel with T15 and T18. **Files:** `rcc.ts`, `gpio.ts`, tests, and the chip
definition list. **Size:** M.

### T9: Engine run loop and blink end-to-end test

- [x] Extend the T7 `Peripheral` contract, as the T7 review agreed: `tick?(cycles)` on
      `PeripheralInstance`; `now()` (cycles) and `cpu.setPending(exception)` on
      `PeripheralContext`. The engine wires them through the `MemoryBus` options.
- [x] `src/engine/engine.ts`:
  - `load(elf, circuit)`, then reset: SP and PC from the vector table. Build a fresh
    core on each load: upstream `reset()` doesn't clear lockup, IPSR or the mode
    (T11 finding). Copy each
    segment's `data` to its `addr` (the LMA). **Don't zero-fill `memSize` there:**
    `.data` and `.bss` can share a segment, so that would write zeros into flash
    past the image. The startup code zeroes `.bss` in RAM (T6 finding);
  - `runFor(simTime)`, `step()` and `snapshot()`, which reports pins, registers, the
    PC as file:line, and halt/fault state;
  - time comes from cycles at 16 MHz, and peripheral ticks are scheduled by time;
  - create a new `Nets` on every load: listeners can't be removed, so a reused `Nets`
    would keep calling the old bus (T8 finding).
- [x] `firmware/blink/circuit.json` (`mcu` only) and an end-to-end test: in 100 ms of
      simulated time, the PA0 net toggles the expected number of times.
- [x] Determinism: two runs give identical event logs.

**Verify:** `just fw && node --test src/engine/engine.test.ts`. **Blocked by:** T6,
T8, and T0 to run locally. **Wave 4.** **Files:** `engine.ts`, `engine.test.ts`,
`firmware/blink/circuit.json`. **Size:** M.

### T10: CLI: `sim run`, `sim inspect`, `--json`, exit codes

- [x] `src/cli/sim.ts` (plus a `sim *args` recipe in the `justfile`), built on `node:util` `parseArgs`:
  - `sim run <elf> --circuit <json> --for <dur>`;
  - `sim inspect <elf> --circuit <json> --at <dur>`, which prints pins, registers with
    named bits, the PC as file:line, the I2C trace (empty until T14), diagnostics
    (empty until T24), and unsimulated-register accesses;
  - every command takes `--json`, whose output carries `"version": 1`.
- [x] Route the core's logger (HardFault and lockup messages, which T9 still prints to
      the console) into the run result: the text output and `--json`, not stray stderr.
- [x] Exit codes:

  | Code | Meaning                  |
  | ---- | ------------------------ |
  | 0    | the run completed        |
  | 1    | firmware fault or lockup |
  | 2    | usage or invalid input   |
  | 3    | internal error           |

  `docs/cli.md` documents the commands, the JSON shapes and these codes.

- [x] The tests spawn the CLI on blink and assert the JSON shape and exit codes. A bad
      circuit gives exit 2 with a message naming the field.

**Verify:** `node --test 'src/cli/**/*.test.ts'`. **Blocked by:** T9. **Wave 5**, parallel with T12
and T14. **Files:** `src/cli/sim.ts`, `src/cli/sim.test.ts`, `docs/cli.md`,
`package.json` (`bin`). **Size:** M.

### T11: CPU fault fidelity

- [x] An undefined opcode, or UDF, enters HardFault, with the stacked PC pointing at
      the faulting instruction. Before this, it only logged a warning.
- [x] A Thumb-2-only 32-bit instruction executed on the M0+ core faults. That is what
      happens to firmware built with the wrong `-mcpu`.
- [x] A `BusFault` thrown by the bus during an instruction enters HardFault, with the stacked PC pointing at that instruction.
- [x] A fault inside HardFault locks up and halts the engine. Choose how BKPT behaves
      (ARMv6-M with no debugger attached escalates it to HardFault) and record the
      choice. BKPT halts as if a debugger were attached; recorded in `decisions.md` §2.
- [ ] Follow-up, not needed for the MVP: an unaligned SRAM or flash access should HardFault
      (ARMv6-M has no unaligned access; T7 faults only unaligned register accesses).
- [ ] Follow-up, not needed for the MVP: a BX/BLX to an address with bit 0 clear
      (INVSTATE), and an SVC that can't be taken, should both enter HardFault. T11
      left them out.

**Verify:** `node --test 'src/cpu/**/*.test.ts'`. **Blocked by:** T2. **Wave 2**; runs in parallel
with the rest of Phase 1. **Files:** `src/cpu/cortex-m0-core.ts`, its test.
**Size:** S.

**Checkpoint 1:** see `plan.md`.

---

## Phase 2: Time and I2C

### T12: SysTick and speed control

- [x] SysTick at `0xE000E010`:
  - CTRL: ENABLE, TICKINT, CLKSOURCE (HCLK or HCLK/8), and COUNTFLAG, which clears
    when read;
  - LOAD (24-bit);
  - VAL: any write clears it and COUNTFLAG;
  - CALIB;
  - TICKINT pends the SysTick exception in the core.

  The NVIC and SCB still read 0 and ignore writes (T9). The SysTick exception doesn't
  need the NVIC: TICKINT plus `cpu.setPending` is enough. Add the SCB bits that needs (ICSR PENDST, SHPR3). T4 found that the SVD has no SysTick, NVIC or SCB, so hand-write them from the
  ARMv6-M architecture manual.

- [x] The engine has two speeds:
  - `max`, the default for the CLI and tests;
  - `realtime`, which throttles to the wall clock.
- [x] `firmware/blink-systick` comes in two variants, one polling COUNTFLAG and one
      using `SysTick_Handler`. In both, PA0 toggles every 500 ms ± 1 ms of simulated
      time. In realtime mode, 1 s of simulated time takes 1 s ± 10% of wall time.

- [ ] Follow-up: ICSR implements only PENDSTSET/PENDSTCLR; PENDSVSET is ignored and not
      flagged. SysTick's tick runs after every instruction even when disabled, which costs
      about 13% on blink. The real-time test now checks only that it never runs ahead of the
      wall clock, so it holds on slow CI.
**Verify:** `just fw && node --test src/peripherals/systick.test.ts`. **Blocked by:**
T9. **Wave 5.** **Files:** `systick.ts`, `scb.ts`, tests, firmware. **Size:** M.

### T13: I2C bus model, target interface, bus trace

**Contract gate:** review before T15 or T18 start.

- [x] `src/engine/i2c.ts` is a transaction-level bus on an SDA/SCL net pair:
  - `start`, `address(addr7, rw)`, `write(byte)`, `read()` and `stop`;
  - a target ACKs if it answers to the address, otherwise the bus NACKs;
  - the bus is idle only if both nets resolve high.

  Record the "transaction level, not bit level" decision in `decisions.md`.

- [x] The `Part` interface gets an optional `i2c` target hook. Its address can change
      at runtime: the MCP23017 reads it from pins, and RESET can turn it off.
- [x] Trace events (START, ADDR+R/W, ACK/NACK, DATA, STOP, each timestamped) go out
      through a callback. T9/T14 connect it to the T7 event log, so T13 doesn't depend
      on T7. Tests with two fake targets check:
  - each transaction reaches the right target;
  - NACK when no target answers;
  - not idle when there are no pull-ups;
  - the exact trace sequence.

**Verify:** `node --test src/engine/i2c.test.ts`. **Blocked by:** T5. **Wave 2.**
**Files:** `i2c.ts`, `i2c.test.ts`, `part.ts`. **Size:** M.

### T14: I2C1 peripheral (v2 master)

- [x] Registers:
  - CR1.PE;
  - CR2: SADD (7-bit), RD_WRN, NBYTES, START, STOP, AUTOEND;
  - ISR: TXE, TXIS, RXNE, NACKF, STOPF, TC, BERR, ARLO, BUSY;
  - ICR, TXDR, RXDR;
  - TIMINGR: **a write while PE=1 is ignored silently**.

  APBENR1.I2C1EN gates I2C1 through the bus. Using RELOAD or 10-bit addressing is
  logged as not simulated. The time per byte comes from TIMINGR (approximate).

- [x] Give I2C1 the engine's mounted part instances, for `I2cBus`'s `parts`: add them to
      `PeripheralContext` through the `MemoryBus` options (T9 finding).
- [x] Pin routing through AF endpoints (agreed at the T8 merge). `Nets` keeps one
      drive per endpoint, so I2C1 must not share `mcu.PB6`/`mcu.PB7` with GPIO.
  - I2C1 owns `mcu.I2C1_SCL` and `mcu.I2C1_SDA`, and its `I2cBus` sits on those.
  - GPIO joins a pin to an AF endpoint with a switch while the pin is in AF mode with
    the matching AFR value. The mapping comes from a per-chip AF table in the chip
    definition (MVP: PB6 AF6 → `I2C1_SCL`, PB7 AF6 → `I2C1_SDA`).
  - So a pin that isn't routed (wrong MODER/AFR, or the GPIO clock off so MODER never
    changed) leaves I2C1 cut off with no special case, and GPIO's PUPDR pull stays on
    the pin.
  - A bus that isn't idle sets BUSY, and START never goes out. Anything RM0444
    doesn't specify is marked "assumed".
- [x] Tests against a fake target:
  - a 1-byte write with AUTOEND gives the trace and the flag order TXIS → STOPF;
  - a 2-byte read;
  - NACK sets NACKF and sends STOP;
  - a TIMINGR write with PE=1 is ignored;
  - BUSY when the lines are held low or have no pull-ups;
  - with I2C1EN = 0, writes are ignored.

- [ ] Follow-up: I2C1 interrupts aren't raised (no NVIC model yet). BERR and ARLO are never
      set (no arbitration in the bus model). RELOAD and ADD10 are logged as unsimulated and
      run as if 0. The AF table also maps PB8/PB9 and PA9/PA10 to I2C1 (DS12992 Tables 13–14).
**Verify:** `node --test src/peripherals/i2c.test.ts`. **Blocked by:** T8, T9, T13.
**Wave 5.** **Files:** `i2c.ts`, `i2c.test.ts`, the chip list. **Size:** L. If it
runs long, split the read path into a follow-up task.

### T15: TC74 part

- [x] Variants A0–A7 give addresses 0x48–0x4F. Registers:
  - 0x00 TEMP: signed 8-bit, clamped to the datasheet range;
  - 0x01 CONFIG: SHDN (bit 7) and DATA_RDY (bit 6), timed per the datasheet.

  Writing a byte sets the pointer, and a read returns the register the pointer is on.
  The `temperature` prop is settable.

- [x] Add it to `src/parts/index.ts`. Tests through the I2C target interface:
  - a read without setting the pointer returns TEMP, the power-up pointer;
  - −5 °C reads as `0xFB`;
  - the address follows the variant;
  - SHDN behaves per the datasheet.

**Verify:** `node --test src/parts/tc74.test.ts`. **Blocked by:** T13. **Wave 3.**
**Files:** `tc74.ts`, `tc74.test.ts`, `index.ts`. **Size:** S.

### T16: Resistor and push-button parts

- [x] `resistor.ts` is a weak link between two pins. Between a net and `3V3` it acts
      as a pull-up.
- [x] `pushbutton.ts` is a switch that joins its pins while `pressed` is set.
- [x] Tests:
  - a pull-up holds an undriven net high, and an open-drain low still wins;
  - a button to GND pulls a pulled-up net low and releases it.

**Verify:** `node --test 'src/parts/**/*.test.ts'`. **Blocked by:** T5. **Wave 2.** **Files:**
`resistor.ts`, `pushbutton.ts`, tests, `index.ts`. **Size:** S.

### T17: TC74 firmware end-to-end test with the bus trace

- [x] `firmware/tc74-read/`:
  - set PB6/PB7 to AF6, open-drain;
  - set TIMINGR for 100 kHz at 16 MHz;
  - read TEMP into a global `g_temp` every 250 ms.

  `circuit.json` has the TC74 (variant A0, address 0x48), 4.7 kΩ pull-ups to 3V3,
  and wires.

- [x] End-to-end with the slider at 22: `g_temp` (read by its symbol) equals 22, and
      the trace is START, 0x48 W, ACK, 0x00, ACK, … STOP.
- [x] `sim inspect --json` includes that trace.

**Verify:** `just fw && node --test 'firmware/tc74-read/**/*.test.ts'`. **Blocked by:** T10, T12,
T14, T15, T16. **Wave 6.** **Files:** `firmware/tc74-read/{main.c,circuit.json,e2e.test.ts}`.
**Size:** M.

**Checkpoint 2:** see `plan.md`.

---

## Phase 3: Display, input, faults, diagnostics

### T18: MCP23017 part

- [x] Address 0x20 | A2..A0, read from the pin levels at transaction time. RESET low
      or floating NACKs every address, and its release restores the power-on
      register state.
- [x] The full BANK=0 register map (0x00–0x15): IODIR (reset 0xFF), IPOL, GPINTEN,
      DEFVAL, INTCON, IOCON (two addresses), GPPU, INTF, INTCAP, GPIO, OLAT.
  - GPPU applies a weak 100 kΩ pull-up.
  - A GPIO read applies IPOL; a write goes to OLAT.
  - The pointer auto-increments unless IOCON.SEQOP=1.
  - BANK=1 and INTA/INTB are logged as not simulated.
- [x] Tests:
  - the address follows the A pins;
  - floating RESET NACKs;
  - a sequential IODIRA/IODIRB write auto-increments;
  - GPPU makes an unconnected input read 1;
  - OLAT drives the GPA nets.

- [ ] Follow-up, not needed for the MVP: on rev D parts (DS20001952D) GPA7 and GPB7 are
      output-only, but here they still work as inputs. INTA/INTB stay hi-z, while a
      real part drives them high when idle. Both are marked in `mcp23017.ts`.
      **Verify:** `node --test src/parts/mcp23017.test.ts`. **Blocked by:** T13. **Wave 3.**
      **Files:** `mcp23017.ts`, its test, `index.ts`. **Size:** M.

### T19: LED and 7-segment parts

- [x] Add an optional `state?(): Readonly<Record<string, unknown>>` to `PartInstance` in `src/parts/part.ts`: what the part shows, for tests, `sim inspect` and the UI. This was the one gap the T5 contract review found.
- [x] An LED is lit when its anode net is high and its cathode net is low.
- [x] The 7-segment display has two variants, common-anode and common-cathode. It has
      pins A–G, DP and COM, and exposes `values[8]` in `@wokwi/elements` order
      (A–G, DP).
- [x] Tests:
  - CA lights a segment when COM is high and the segment pin is low;
  - CC is the reverse;
  - a floating pin stays unlit.

**Verify:** `node --test 'src/parts/**/*.test.ts'`. **Blocked by:** T5. **Wave 2.** **Files:**
`led.ts`, `seven-segment.ts`, tests, `index.ts`. **Size:** S.

### T20: Mid-run inputs

- [x] The engine can schedule a part prop change at a simulated time.
- [x] The CLI takes `--at <time> <part>.<prop>=<value>`, repeatable, plus
      `--set <part>.<prop>=<value>` for the initial value. Values are checked
      against the part's declared prop types.
- [x] Tests:
  - a TC74 temperature changed at 1 s is visible in `inspect` at 2 s;
  - an unknown prop gives exit 2 with a list of the valid props.

- [ ] Follow-up: parts don't say which props can change at run time, so
      `--at 1s:temp.variant=A3` passes the checks and the TC74 silently ignores it. Mark
      runtime props in `PropSpec` and reject the rest with exit 2.
**Verify:** `node --test 'src/cli/**/*.test.ts'`. **Blocked by:** T10, T15. **Wave 6.** **Files:**
`engine.ts`, `sim.ts`, tests, `docs/cli.md`. **Size:** S.

### T21: Thermometer firmware; acceptance test 2

- [x] `firmware/thermometer/` is written for this repo:
  - it reads the TC74;
  - MCP23017 port A drives the tens digit (A–G) and GPB1–GPB7 drive the units digit;
  - a button on GPB0 (with GPPU on) toggles °C/°F on each press edge;
  - °F is computed as `C*9/5+32`, truncated.

  The `circuit.json` uses common-cathode digits.

- [x] Decode the digits from the 7-segment `values`. At 22 the display shows "22";
      after one press it shows "71"; after a second press it shows "22".

**Verify:** `just fw && node --test 'firmware/thermometer/**/*.test.ts'`. **Blocked by:** T17, T18,
T19, T20. **Wave 7.** **Files:** `firmware/thermometer/{main.c,circuit.json,e2e.test.ts}`.
**Size:** M.

### T22: Fault tests: wrong GPIO clock, no pull-ups

Each test asserts the failure real hardware shows, not a simulator error.

- [x] The firmware enables the GPIOA clock, but the I2C pins are on GPIOB. The trace
      stays empty and the PC sits in the wait loop (file:line).
- [x] The pull-up resistors are removed from the circuit. ISR.BUSY is set, and the
      firmware hangs waiting on TXIS.

- Note (T22): RM0444 doesn't say what an unrouted I2C input reads. The simulator treats it as
  floating, so BUSY is set and START never goes out. Real silicon might instead NACK
  internally and retry. The bus is empty either way, and the test doesn't assert BUSY
  for this fault. Check on a real board.

**Verify:** `node --test 'firmware/faults/**/*.test.ts'`. **Blocked by:** T17. **Wave 7.** The two
cases can be split between agents. **Files:** `firmware/faults/{gpio-clock,no-pullups}/…`.
**Size:** S.

### T23: Fault tests: RESET floating, segments off by one, wrong polarity

- [x] With the MCP23017 RESET left unconnected, every address NACKs in the trace.
- [x] With the segment wires shifted by one pin, the digits show the exact scrambled
      pattern; assert the specific wrong segments.
- [x] With a common-anode display driven by the common-cathode patterns, the inverted
      segments light.

**Verify:** `node --test 'firmware/faults/**/*.test.ts'`. **Blocked by:** T21. **Wave 8.**
**Files:** `firmware/faults/{reset-floating,segments-shifted,wrong-polarity}/…`.
**Size:** M.

### T24: Diagnostics framework, plus GPIO-clock and unsimulated-register rules

- [x] Add `src/diagnostics/rule.ts` and the registration list `index.ts`. A rule is a
      function over events plus read-only state that returns diagnostics. Rules
      never write.
- [x] Rules:
  - `gpio-clock-off`, which reports e.g. "wrote GPIOB->MODER while RCC
    IOPENR.GPIOBEN = 0";
  - `unsimulated-register`.

  `sim run` and `sim inspect` print diagnostics in both text and JSON.

- [x] A test proves diagnostics are pure observers: the event log is identical with
      and without them.

**Verify:** `node --test 'src/diagnostics/**/*.test.ts'`. **Blocked by:** T10. **Wave 6.**
**Files:** `rule.ts`, `index.ts`, two rule files, tests. **Size:** M.

### T25: I2C diagnostic rules

- [x] Rules:
  - `timingr-while-pe`;
  - `i2c-pins-not-af6`;
  - `i2c-bus-not-idle`, which names the likely cause: no pull-ups, or a line held low;
  - `i2c-nack-no-device`, which reports e.g. "no device at 0x49; the TC74 on this bus
    is at 0x48 (variant A0)".

  Each rule has its own test.

- [x] A rule that throws must not stop or change the run. Catch it and report a
      `rule-error` diagnostic instead (T24 finding).
- [x] `i2c-pin-push-pull`: an I2C pin is in AF mode but OTYPER is push-pull. RM0444 requires
      open-drain. The simulator's transaction-level bus doesn't show the fight on the ACK
      bit, so the diagnostic is the only signal (T17 finding).
- [x] Readable I2C trace in `sim inspect`'s text output: one line per step, with time,
      START, ADDR 0x48 W/R, ACK/NACK, DATA 0x16, STOP. Not raw JSON (T17 finding; the brief
      asks for this). Leave the `--json` shape alone.

**Verify:** `node --test 'src/diagnostics/**/*.test.ts'`. **Blocked by:** T14, T24, T38. **Wave 7.**
**Files:** four rule files and their tests. **Size:** M.

### T38: Register and field names follow the CMSIS header

Learners write `RCC->IOPENR |= RCC_IOPENR_GPIOBEN;`. The SVD names that bit `IOPBEN`, and
GPIO's `MODE0` is `MODER0` there. Diagnostics and the register view must use the names in
the learner's code: RM0444 and ST's `stm32g031xx.h` agree on them.

- [x] `tools/svd2json.ts` takes each field's name from `vendor/cmsis-device-g0/stm32g031xx.h`,
      matching `<TYPE>_<REG>_<NAME>_Pos` on register and bit position (TYPE is the CMSIS
      peripheral type: GPIO for GPIOA/B, I2C for I2C1, ...). The SVD name is kept as
      `svdName` where it differs, and the number of renamed fields is reported. The output
      stays deterministic.
- [x] Tests: RCC IOPENR bit 1 is `GPIOBEN`; GPIOA MODER bits 1:0 are `MODE0`; I2C1 CR2 SADD
      is unchanged.
- [x] Code and tests that use SVD field names are updated: the clock gates (`IOPAEN` →
      `GPIOAEN`, ...), GPIO, I2C1, SysTick and the diagnostics. `gpio-clock-off` now reads
      `RCC->IOPENR.GPIOBEN`.

**Verify:** `just test`. **Blocked by:** T4. Runs now, before T25 and the recipes (T26, T27),
which show these names. **Size:** M.

**Checkpoint 3:** see `plan.md`.

---

## Phase 4: Extensibility

### T26: Part recipe, part templates, AGENTS.md commands

- [x] `docs/adding-a-part.md`: a step-by-step recipe with the TC74 as the worked
      example, ending with the test.
- [x] `templates/part.ts` and `templates/part.test.ts`: a minimal working part.
      `just test` runs its test so the template can't go stale.
- [x] In `AGENTS.md`, replace the "Current state" section with where the extension
      points, recipes and templates are.

**Verify:** `just test`. A read-through confirms that the recipe mentions only
`src/parts/index.ts` as an existing file to edit. **Blocked by:** T21. **Wave 8**,
parallel with T23 and T27. **Size:** M.

### T27: Peripheral and diagnostic recipes and templates

- [x] `docs/adding-a-peripheral.md`, with I2C1 as the worked example: the registers
      come from the SVD JSON, and the file holds behavior only.
- [x] Templates, each with a test template that runs in `just test`:
  - `templates/peripheral.ts` and its test;
  - `templates/diagnostic.ts` and its test.

**Verify:** `just test`. **Blocked by:** T21, T25. **Wave 8.** **Size:** M.

### T28: Acceptance 4: a TMP102 added from the recipe alone

- [x] A **fresh agent** gets only `docs/adding-a-part.md` and the task "add a TMP102".
      Its diff touches only the new part file, its test and `src/parts/index.ts`.
- [x] Wherever the agent got stuck, fix the recipe, not the agent's code. Then rerun
      with another fresh agent until the run is clean. Record the iterations in
      `docs/agent-handoffs/T28.md`.

- Result: iteration 1 (TMP102) and iteration 2 (MCP9808) both touched only the
  three allowed files. Iteration 1's 8 recipe gaps were fixed; iteration 2 had 6
  minor gaps, also fixed, with no third run. See `docs/agent-handoffs/T28.md`.

**Verify:** `git diff --stat` on the agent's branch, and `just test`. **Blocked by:**
T26. **Wave 9.** **Size:** S.

**Checkpoint 4 (headless MVP):** see `plan.md`.

---

## Phase 4b: Exam style and the clock tree (added 2026-10-07)

Shawn's course exams forbid ST's headers: firmware defines each register it uses by
address, e.g. `#define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)`. Course code
also brings SYSCLK up to 64 MHz through the PLL. Before this phase the simulator hung
on `while (!(RCC_CR & (1U << 25)))`, because the PLL never locked.

### T39: Clock tree, and simulated time that follows the clock speed

- [x] RCC models what firmware polls:
  - HSION → HSIRDY;
  - PLLON → PLLRDY after the lock time (DS12992 tLOCK: 15 µs typical, 40 max),
    with PLLRCLK = (source / PLLM) × PLLN / PLLR, output only while PLLREN is set;
  - CFGR.SW → SWS, switching only once the chosen source is ready (on hardware a
    switch to a source that isn't ready doesn't happen);
  - HPRE/PPRE → HCLK/PCLK.

  HSE on the NUCLEO-G031K8 comes only from the ST-LINK MCO through SB7 into PC14
  (UM2591); follow UM2591 and mark it "assumed". Cite RM0444 chapter 5 for each rule.
- [x] The engine's time comes from the **current** clock: simulated seconds accumulate
  as cycles ÷ HCLK at each moment. `runFor`, part ticks (every 1 ms), `setPropAt`,
  real-time mode, snapshot `seconds` and the CLI all use it.
  - SysTick counts HCLK (or HCLK/8).
  - I2C1 times bytes from its kernel clock (PCLK by default; RM0444 CCIPR).
- [x] A FLASH peripheral stores ACR so LATENCY reads back (firmware polls it); it is
  no longer "unsimulated".
- [x] `firmware/pll-64mhz/` in exam style (no ST header): it brings SYSCLK to 64 MHz
  and blinks. Its test shows the blink period matches 64 MHz and a SysTick at
  LOAD = 64000 − 1 gives 1 ms. A switch to a source that isn't ready leaves SWS
  unchanged.

**Verify:** `just test`. **Blocked by:** nothing. **Size:** L.

### T40: Examples in exam style, and a template

- [ ] blink, blink-systick-poll/irq, tc74-read, thermometer, clock-off and the fault
  firmwares define each register they use by address (verified against the register
  JSON), with no `#include "stm32g0xx.h"`; `#include <stdint.h>` stays. Behavior is
  unchanged: every existing test passes as it is.
- [x] `firmware/template/main.c`: a starter in exam style with comments on how to
  find an address (RM0444 memory map plus register offset). It builds and runs.
- [x] `AGENTS.md` and the recipes say examples use exam style.

**Verify:** `just fw && just test`. **Blocked by:** nothing. **Size:** M.

### T41: Diagnostics name registers your way, with addresses

- [x] One shared helper formats a register as `GPIOB_MODER (0x50000400)` and a field
  as `RCC_IOPENR (0x40021034) bit 1 GPIOBEN`, matching exam-style `#define` names.
  Every rule uses it, so a learner can check their `#define` against the message.
- [x] Tests and `docs/cli.md` examples are updated.

**Verify:** `just test`. **Blocked by:** nothing. **Size:** S.

### T42: Clock diagnostics, and clocks in `inspect`

- [x] Rules:
  - `flash-latency`: SYSCLK over 24 MHz with FLASH_ACR.LATENCY too low (RM0444 §3);
  - `pll-out-of-range`: VCO or PLLR output outside the datasheet limits (VCO is 96–344 MHz per DS12992 Table 43 and RM0444 §5.4.4, not the 64 this card first said);
  - `clock-switch-not-ready`: SW set to a source that isn't ready, so SWS doesn't
    follow;
  - `pll-config-while-on`: PLLCFGR written while PLLON = 1 (RM0444 says configure it
    with the PLL off).

  Each names registers the T41 way and suggests the fix.
- [x] `sim inspect` prints `clocks` (SYSCLK source, SYSCLK, HCLK, PCLK); `--json`
  adds them (an additive field).

**Verify:** `just test`. **Blocked by:** T39, T41. **Size:** M.

## Phase 5: UI

### T29: SVG art

- [x] Plain SVG, each with pin coordinates using the pin names from T5:
  - a breadboard with rails;
  - the NUCLEO-G031K8 board, with pinout from UM2591; do not use the unlicensed
    wokwi-boards art;
  - a generic DIP-28 for the MCP23017;
  - a TO-220-5 for the TC74.
- [x] A test checks that every pin a part declares has a coordinate in its art.

**Verify:** `node --test 'src/ui/art/**/*.test.ts'`. **Blocked by:** T5. **Wave 2**; can run
alongside all of Phases 1–4. **Size:** M.

### T30: UI shell and `sim ui`

- [ ] `sim ui <elf> --circuit <json>` serves a local page with `node:http`. Decide
      and record in `decisions.md`:
  - the bundler or import map for Lit and `@wokwi/elements`;
  - whether the engine runs in the page or in a worker.
- [ ] T29 notes: art units are 0.01 in (0.1 in pitch = 10 units), so scale by 0.96 to match
      `@wokwi/elements` pin coordinates. Nucleo art pins carry a `signal` (`PB6`, `GND`, …)
      that still has to be mapped to endpoints (`mcu.PB6`, rails).
- [ ] The page renders the circuit with `@wokwi/elements` and the T29 art, and the
      LED and 7-segment display update live while running.
- [ ] Choose a headless browser test setup and add it to CI. A smoke test loads the
      blink circuit and sees the LED toggle.

**Verify:** the UI smoke test passes headless. **Blocked by:** T10, T16, T19, T29.
**Wave 6.** **Size:** L.

### T31: Place and move parts; save the circuit JSON

- [ ] Drag parts from a palette and move them; positions go into `pos`.
- [ ] Saving writes JSON in the same stable format as T5. Loading and then saving an
      unchanged circuit is byte-identical.

**Verify:** a UI test plus the round-trip test. **Blocked by:** T30. **Wave 7.**
**Size:** M.

### T32: Wires and breadboard connectivity

- [ ] Draw wires pin to pin; they're saved as `wires`.
- [ ] Each breadboard row is internally one net, and the rails are nets. A part
      plugged into a row joins that net.
- [ ] A UI test rebuilds the thermometer circuit, and the run matches T21.

**Verify:** a UI test. **Blocked by:** T31. **Wave 8.** **Size:** M.

### T33: `sim watch`

- [ ] `sim watch <elf> --circuit <json>` re-runs when the ELF changes; headless, it
      prints each run's result.
- [ ] In the UI, the page reloads the firmware, keeping the circuit and resetting the
      MCU.
- [ ] A test touches the ELF and sees a reload within 1 s.

**Verify:** `node --test src/cli/watch.test.ts`. **Blocked by:** T30. **Wave 7.**
**Size:** M.

### T34: Register view

- [ ] Per peripheral, show live register values with the named bits taken from the
      registers JSON. Changed bits are highlighted, and unsimulated registers are
      marked as such.

**Verify:** a UI test. **Blocked by:** T4, T30. **Wave 7.** **Size:** M.

### T35: I2C trace panel and diagnostics panel

- [ ] The trace panel lists START, ADDR+R/W, ACK/NACK, DATA and STOP, timestamped.
- [ ] The diagnostics panel shows the same diagnostics as the CLI, each linked to its
      register or bus event.

**Verify:** a UI test with the no-pull-ups fault circuit. **Blocked by:** T25, T30.
**Wave 8.** **Size:** M.

### T36: Pause, resume and step, with the source line

- [ ] Pause, resume and single-step instructions.
- [ ] Show the current file:line and the surrounding source, which the server reads
      from disk.
- [ ] Toggle between realtime and max speed.

**Verify:** a UI test that steps blink and sees the line change. **Blocked by:** T6,
T12, T30. **Wave 7.** **Size:** M.

**Checkpoint 5:** see `plan.md`.

---

## Phase 6: Release

### T37: README and packaging

- [ ] The README has:
  - what the project is;
  - a quickstart: one command from a fresh clone;
  - a GIF of the thermometer;
  - "Your first part in 10 minutes", which follows `docs/adding-a-part.md`;
  - license notes for the vendored code.
- [ ] Decide how learners start it: from a clone, through `npx`, or through a
      published package with a `tsc` emit. Record the decision, and test it from a
      fresh clone in CI.

**Verify:** a CI job runs the quickstart from a clean checkout. **Blocked by:** T28,
T32, T33, T34, T35, T36. **Wave 10.** **Size:** M.

**Checkpoint 6 (complete):** see `plan.md`.
