# Decisions

Research done 2026-10-07, before any code, as `stm32-sim-brief.md` requires. Each
decision says what was chosen, why, and what was rejected. Facts were read from the
projects' own files and docs. Where something is inferred rather than read, it says
so. Revisit a decision only with new evidence, and update this file when you do.

## Summary

| Area             | Decision                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Stack            | TypeScript on Node ≥ 24. No build step in development. `node --test` for tests. The engine runs in Node and the browser.   |
| CPU core (M0+)   | Copy `CortexM0Core` from wokwi/rp2040js (MIT) and put it behind our own bus interface                                      |
| CPU core (later) | Decide when a second chip is added. Candidates: c1570/rp2350js `CortexM33Core` (MIT, TS) or labwired-core (MIT, Rust/wasm) |
| Part visuals     | `@wokwi/elements` (MIT) for every part it has; our own SVG for the breadboard, wires, Nucleo board and IC packages         |
| Register data    | Patched SVD from stm32-rs, converted once to checked-in JSON: names, addresses, reset values, bitfields                    |
| ELF + PC→line    | `@gba-kit/debug-info` (MIT, no dependencies, DWARF 2–5). Checked in T6 on a GCC 14 DWARF 5 ELF: works                      |
| Test firmware    | Built from source with `arm-none-eabi-gcc`. CI installs it. ELFs are not committed                                         |

## 1. Stack: TypeScript on Node ≥ 24

**Decision.** TypeScript (ESM), with Node 24 pinned in `.mise.toml`.

- The engine, CLI and tests run as `.ts` directly through Node's type stripping, with
  no build step.
- Tests use the built-in `node:test`, and type checks use `tsc --noEmit`.
- The CLI parses arguments with `node:util` `parseArgs`.
- The engine imports nothing from Node or the DOM. Only the CLI layer touches the
  file system, file watching and exit codes. That way the same engine runs under the
  CLI and inside the browser UI.

**Why.**

- Both pieces worth reusing are TypeScript or web: the rp2040js CPU core and
  `@wokwi/elements`.
- One language covers the engine, CLI, UI and learner extensions. A learner's AI
  assistant can add a part without a second toolchain.
- Verified on Node 24.20.0, the version installed here:
  - `node file.test.ts` runs a test file;
  - `node --test` finds `*.test.ts` with no config;
  - `--test-name-pattern=<name>` runs a single test.
- So there is no test framework or bundler to install for the engine.

**Constraints that follow.**

- Erasable TypeScript syntax only: no `enum`, `namespace` or constructor parameter
  properties. Imports use the `.ts` extension. Set `erasableSyntaxOnly` in
  `tsconfig.json` so `tsc` enforces this.
- Node refuses to strip types under `node_modules`. Verified: it throws
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. So the npm package, if we publish
  one, needs a `tsc` emit step. Running from a clone does not.
- The browser UI will need a bundler or an import map to resolve Lit and
  `@wokwi/elements`. That choice is deferred to build step 7.

**Rejected.**

- Bun: it would work, but students are more likely to already have Node, and Node
  covers everything we need.
- C# (Renode) and Rust (LabWired): see §2. Either would split the project into two
  languages, and only the TS side runs natively in the browser.

## 2. CPU core

### Now (Cortex-M0+, ARMv6-M): copy rp2040js `CortexM0Core`

**Decision.** Copy `src/cortex-m0-core.ts` (1,325 lines) and `src/instructions.spec.ts`
(1,549 lines, about 126 cases) from [wokwi/rp2040js](https://github.com/wokwi/rp2040js)
at commit `a304c74` (v1.4.0, 2026-09-25). License: MIT.

- Keep the MIT notice and record where the files came from.
- Replace the `RP2040` constructor argument with a small bus interface: 8/16/32-bit
  read/write and a break hook.
- Port the tests from vitest to `node:test`.

**Why.**

- It's MIT, TypeScript, actively released, and covers all of ARMv6-M.
- Exception entry and return, stacking, PRIMASK, MSP/PSP/CONTROL, SVC and priority
  arbitration all live inside the core (`cortex-m0-core.ts` :250, :290, :478, :1245).
  The NVIC and SysTick _registers_ live outside it, in `peripherals/ppb.ts`. That
  split matches our peripheral model.
- Its test driver can run the same instruction tests on real hardware over GDB
  (`test-utils/create-test-driver.ts`, `TEST_GDB_SERVER`). That would let us check the
  core against a real NUCLEO-G031K8 through probe-rs.

**Why copy instead of depending on the package.** The package doesn't export the core:

- verified, the `exports` field is only `.` and `./gdb-tcp-server`;
- `CortexM0Core` is not in `dist/esm/index.d.ts`;
- the constructor is `constructor(readonly rp2040: RP2040)` (`:97`);
- every memory access goes through `this.rp2040.read*/write*` (`:193-215`).

There is no precedent for reusing it on a non-RP2040 chip. Cost: we own the copy and
apply upstream fixes by hand.

**Changes our copy needs, to follow the "faithful" principle.**

- An unimplemented or undefined opcode only logs a warning (`:1317`). On hardware it
  raises a HardFault. The HardFault path is a TODO upstream (`rp2040.ts:196`).
  Done in T11, below.
- `cyclesIO` hard-codes the RP2040 SIO/APB address ranges (`:577-586`). Remove it;
  cycle-exact timing is out of scope.
- `MAX_HARDWARE_IRQ = 25` (`irq.ts:30`) is an RP2040 number. Make it a chip parameter.
  The G031 has 32 IRQ lines and 2 NVIC priority bits.

**How T2 did it** (`src/cpu/`). Choices the T2 card left open:

- `Bus` is only the six reads/writes and `onBreak`, named as the core already called
  them on the RP2040 class.
- The core's `logger` (warn/info: unimplemented opcode or SYSm, SEV, YIELD) is a
  public field on the core, not part of `Bus`. It defaults to `console`, which exists
  in Node and the browser and isn't an import. The engine replaces it when the event
  log exists (T7).
- `new CortexM0Core(bus, irqCount = 32)`. Upstream cleared a pending IRQ above
  `MAX_HARDWARE_IRQ` on entry (the RP2040's software IRQs). That is kept as
  `irq >= irqCount`, so it does nothing at 32.
- `cyclesIO` returns 1 for every address. No upstream test checks cycle counts, so no
  test changed.
- `TestBus` is flat RAM at `0x20000000`, `0x42000` bytes (every address the upstream
  tests touch). An access outside it throws `RangeError`. It has no SCB, so the test
  driver turns the SVC test's write to `VTOR` (`0xE000ED08`) into `core.VTOR = …`.
- The copies are reformatted to this repo's prettier style. To diff against upstream,
  run prettier over the upstream file first; the diff is then only the changes above.
- Not ported: upstream's GDB test driver (`TEST_GDB_SERVER`), which runs the same
  cases on real hardware. Worth adding once a NUCLEO-G031K8 and probe-rs are set up.

**How T11 did faults** (`cortex-m0-core.ts`, ARMv6-M ARM B1.5):

- Any opcode the decoder doesn't match is undefined on ARMv6-M and enters HardFault
  (exception 3). That covers UDF (both encodings) and v7-M instructions such as
  `cbz`, `it` or 32-bit `ldr.w`/`add.w` from firmware built with the wrong `-mcpu`.
  The stacked return address is the faulting instruction, and the core logs one
  `HardFault at 0x…: …` line through `logger.warn`.
- A `BusFault` thrown by the bus during a fetch, load or store aborts the instruction
  and enters HardFault the same way. Any other exception still escapes the core, so a
  simulator bug stays loud.
- Lockup: a fault while executing at priority -1 or above (inside HardFault or NMI),
  or a `BusFault` anywhere in exception entry (stacking or vector read). The core sets
  `lockedUp = true` and `lockupReason`, logs it, and `executeInstruction()` then
  returns 0 and does nothing; the engine stops on `lockedUp`. Simplification: on
  hardware a stacking fault for an ordinary exception first escalates to HardFault,
  but that stacks onto the same bad SP and locks up anyway.
- On lockup the PC stays at the faulting instruction so it maps to file:line. Real
  hardware reads PC as `0xFFFFFFFE` there.
- **BKPT halts, like an attached debugger.** It calls `bus.onBreak(imm8)` and sets
  `breakRewind = 2`, as upstream did. Without a debugger, ARMv6-M escalates BKPT to
  HardFault, but the simulator plays the debugger (`sim inspect`, stepping), and a
  learner who writes `__BKPT()` wants to stop there. UDF is not a break: it HardFaults.

### Later (Cortex-M3/M4/M7): decide when the second chip is added

The CPU sits behind the same bus interface, so a v7-M core can be swapped in per chip
definition. Candidates as of today:

- **c1570/rp2350js `CortexM33Core`.** MIT, TypeScript, about 8.5k lines with tests,
  pushed 2026-09-10. ARMv8-M Mainline with an FPU.
  - Plain ARMv7-M code runs on it.
  - DSP SIMD support is partial: grep found no `SADD8` or `QADD`. M4 firmware that uses
    those would fault.
  - It is coupled to its chip class the same way, so it needs the same decoupling.
- **labwired-core.** MIT, Rust, with a wasm-bindgen crate.
  - Covers M0+, M3, M4, M7 and M33, including DSP and VFPv4-SP.
  - The CPU steps against a bus trait: `Cpu::step(bus: &mut dyn Bus)`.
  - The wasm crate exposes a whole simulator, not a bare core.
  - It is a large dependency that moves fast: v0.25.0, about 635k lines of Rust, one
    maintainer.

### Rejected as the foundation

| Option                                                                          | License               | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Unicorn](https://github.com/unicorn-engine/unicorn) 2.1.4                      | GPL-2.0               | Bundling it makes the distributed whole GPL. It is CPU only: `armv7m_nvic_set_pending` is an empty stub and there is no SysTick. The only JS port (unicorn.js) is also GPL and about 20 MB.                                                                                                                                                                                                                                                                                                                                                                  |
| [QEMU](https://www.qemu.org/docs/master/system/arm/stm32.html) / xPack QEMU Arm | GPL-2.0               | No G0 machine. The upstream STM32 machines have no GPIO or I2C models, and RCC is "only reset and enable registers". Each peripheral is in-tree C and needs a QEMU rebuild.                                                                                                                                                                                                                                                                                                                                                                                  |
| [Renode](https://github.com/renode/renode) 1.17.0                               | MIT; tlib is LGPL-2.1 | License-compatible, and a single `.cs` peripheral can be loaded at runtime. But `stm32g0.repl` is generic (128 KB / 48 KB), its RCC is a Python stub, `STM32_GPIOPort` never checks RCC, and TIMINGR fields are placeholders. We would have to rewrite exactly the models whose fidelity matters most, in C#. It's a 60–100 MB .NET download and doesn't run in the browser. **Useful as a cross-check.**                                                                                                                                                    |
| [LabWired Core](https://github.com/w1ne/labwired-core) 0.25.0                   | MIT                   | The closest existing project: ELF in, modelled chip and board, I2C/GPIO traces, CI exit codes, YAML chip manifests, a G071 config. But its peripherals are Rust inside the core crate, so adding one means editing the core and rebuilding with Rust. That fails acceptance check 4 and the "one file" recipe. Its own G071 config says the G0 peripherals "are register models reused from the L0/L4 families and are not G0-tuned". It aims at firmware CI, not at reproducing and explaining learner mistakes. **Reference, and a candidate M3/M4 core.** |
| icicle-emu                                                                      | MIT/Apache-2.0        | Built for fuzzing. No NVIC, SysTick or Cortex-M exception model. Depends on cranelift-jit, so no wasm (inferred).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| thumbulator (and npm `thumbulator.ts`)                                          | MIT                   | No Thumb-2; unmaintained since 2021/2022.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| zmu                                                                             | Apache-2.0            | Fixed 64 KB flash / 128 KB SRAM map. No wasm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| armagnac                                                                        | MIT/Apache-2.0        | Its README says "ArmV6-M has not been tested", and exception priorities are not enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| emul, stm32f4-emu                                                               | Apache-2.0, MIT       | Both weeks old, single-chip apps rather than libraries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Wokwi's STM32 simulation                                                        | closed                | Not in any public wokwi repo. It needs a Wokwi license or a CLI token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 3. Part visuals: `@wokwi/elements`

**Decision.** Use [`@wokwi/elements`](https://github.com/wokwi/wokwi-elements) 1.9.2
(MIT, Lit 3, repo pushed 2026-10-01) for every part it has:

- LED (`value`);
- 7-segment (`values[]`, 8 entries per digit: A–G and DP);
- pushbutton (`pressed`, plus `button-press`/`button-release` events);
- resistor;
- later, the potentiometer and NTC sensor for analog work.

Every element exposes `pinInfo: {name, x, y, signals}`. Pins joined inside the part
share a prefix (`GND.1`, `GND.2`). That is enough to attach breadboard wires.

**What it does not cover, and we draw ourselves as plain SVG:**

- the breadboard and wires;
- the NUCLEO-G031K8 board;
- a DIP IC body (MCP23017, 28 pins);
- the TC74 (TO-220-5).

[wokwi-boards](https://github.com/wokwi/wokwi-boards) has a Nucleo-32 board
(`st-nucleo-l031k6`) with pin coordinates, but the repo has **no license file**. Treat
it as all rights reserved and don't copy it.

**Consequences.**

- The elements only display state. Their README says they "only provide the
  presentation… not the functional simulation". All behavior lives in our parts.
- The 7-segment element has no anode/cathode property. Our part computes which
  segments are lit from the net levels and the variant, then hands the element its
  `values`. That is also the code the "common-anode driven with common-cathode
  patterns" fault test exercises.
- Pin signal types already include `analog`, which fits the analog extension later.

**Our art (T29), in `src/ui/art/`.** Each piece is `{ svg, width, height, pins }`.

- One SVG unit is 0.01 in, so the 0.1 in pitch is 10 units. To match wokwi pinInfo
  (CSS px, 0.1 in = 9.6 px), scale by 0.96.
- A part's `pins` keys are its pin names from the datasheet: TC74 `SDA`, `SCLK`,
  `VDD`, `GND`; MCP23017 `GPA0`…, `SCK`, `SDA`, `A0`…, `RESET`. NC pins are drawn
  but have no key. `partArt` maps part type to art.
- NUCLEO-G031K8 pins are keyed by header position (`CN3.1`…`CN4.15`), each with
  its `signal` (`PB6`, `GND`, `3V3`, …) from UM2591 Rev 1 Table 9.
- Breadboard holes are `a1`…`j30` plus rails `tp`/`tn`/`bp`/`bn` 1–25. `groups`
  lists the holes joined inside the board.

## 4. Register data: SVD, converted to checked-in JSON

**Decision.** Take every register name, address, reset value and named bitfield from
the [stm32-rs](https://github.com/stm32-rs/stm32-rs) patched SVD for the STM32G031.

- It is ST's v1.6 SVD with stm32-rs's corrections.
- ST's original carries `SPDX-License-Identifier: Apache-2.0`; the stm32-rs patches
  are MIT/Apache-2.0.
- Vendor it with ST's Apache-2.0 license text. The patched file drops ST's license
  comment, so the attribution has to be restored next to it.
- A one-off script converts it to JSON per chip, and the JSON is checked in. Nothing
  parses XML at runtime.

Peripheral files contain only behavior and side effects. If RM0444 and the SVD
disagree, RM0444 wins, and the peripheral file overrides the value with a comment
citing the RM section.

**Why.**

- A second STM32 then gets its register map, register view and named bits from data
  instead of hand-typing.
- It also makes "log access to an unimplemented register" precise. The log can name
  the register ("read of `I2C1->OAR2`, not simulated"). And it can tell that case
  apart from an address where no register exists at all.

**Known errors in ST's G031 SVD v1.6, all fixed by stm32-rs:**

- `nvicPrioBits` is 4; the CMSIS header says 2.
- A phantom DMA2, and DMA1 declared with 7 channels instead of 5.
- FLASH `WRP1AR`/`WRP1BR` have the wrong access type and reset value.
- A leftover `SYSCFG_ITLINE` peripheral.
- Misspelt names (`MISERR`, `IDWG_SW`).
- Fields split into pieces (`BRR_0_3`/`BRR_4_15`).
- `TIM3 derivedFrom="TIM2"`, which inherits a 32-bit layout.

This is why we use the patched file, not the raw one. The stm32-rs field
documentation for this chip is 2964 of 3456 fields.

**Also vendored, for the example firmware:**

- ST [cmsis-device-g0](https://github.com/STMicroelectronics/cmsis-device-g0) v1.4.5
  (`stm32g031xx.h`, Apache-2.0);
- the Arm CMSIS-Core headers it includes (`core_cm0plus.h`, Apache-2.0);
- each with its license file next to it.

Done in T3; `vendor/*/VERSION` records the tag, commit and files.

- CMSIS-Core is CMSIS_5 tag **5.6.0** (CMSIS-Core(M) 5.3.0). The device repo's README
  defers to the STM32CubeG0 release notes, and STM32CubeG0 v1.6.3 pairs "STM32G0xx
  CMSIS V1.4.5" with "CMSIS V5.6.0_cm0".
- Only the headers GCC reaches are vendored: `core_cm0plus.h`, `cmsis_version.h`,
  `cmsis_compiler.h`, `cmsis_gcc.h`, and `mpu_armv7.h` (the G031 sets
  `__MPU_PRESENT 1`). The Arm/IAR compiler headers are left out.
- The files sit flat in each directory, unmodified. Upstream's `LICENSE.md` /
  `LICENSE.txt` is renamed `LICENSE`.

The device header has bit masks but **no reset values**, so it can't replace the SVD.

**Vendored and converted (T4, 2026-10-07).**

- `vendor/svd/stm32g031.svd.patched` was built from stm32-rs commit `a70ec04`
  (2026-09-16). ST's notice is restored right after the XML declaration.
  `vendor/svd/VERSION` records the source, commit and hash, and `vendor/svd/LICENSE`
  is the Apache-2.0 text.
- `node tools/svd2json.ts` writes `src/chips/stm32g031k8.registers.json`: 35
  peripherals, 484 registers and 3456 fields, the same field count stm32-rs reports.
  `tools/svd2json.test.ts` fails if the committed file differs from a fresh
  conversion by a single byte. It also spot-checks values against RM0444 Rev 6.
- Shape, keyed by name at each level:
  - `peripherals.<P>`: `baseAddress`, `registers`;
  - `registers.<R>`: `offset`, `size`, `access`, `resetValue`, `description`,
    `fields`;
  - `fields.<F>`: `bitOffset`, `bitWidth`, `access`, `description`.
  - Addresses, offsets and reset values are hex strings (`"0x40005400"`). Sizes (in
    bits), bit offsets and widths are numbers.
  - Peripherals are sorted by base address, registers by offset, and fields by bit
    offset.
- Conversion rules:
  - `derivedFrom` is resolved the way svd-rs does it: the element's own values win,
    and a register or field list is inherited whole only when the element has none.
  - `dim` arrays are expanded (`MODER%s` becomes `MODER0`…`MODER15`).
  - The one cluster, the DMA1 channels, is flattened to `CH1_CR`, `CH1_NDTR` and so
    on.
  - stm32-rs drops a register's access when its fields differ. Such a register takes
    its fields' access when they all agree, else `read-write`, as svd2rust does. So
    DMA1 `ISR` is read-only and `IFCR` write-only.
  - Any other SVD construct makes the script throw rather than guess.
- Registers that share an offset stay as the SVD has them. Examples: TIMx
  `CCMR1_Input`/`CCMR1_Output`, `CNT`/`CNT32`, SPI `DR`/`DR8`, CRC `DR`/`DR16`/`DR8`.
  A peripheral model implements whichever view it needs.
- Names are stm32-rs's, and some differ from RM0444. GPIO `MODER0` is RM0444's
  `MODE0`, and `AFREL8` is its `AFSEL8`. Descriptions keep ST's older wording: "master
  mode" where RM0444 Rev 6 says "controller mode". Every address, offset, bit
  position and reset value checked so far agrees with RM0444.

**XML parser: `@xmldom/xmldom` 0.9.12**, pinned exact as a dev dependency and used
only by `tools/`. It is MIT, has no dependencies, and was last published 2026-08-23.
Its standard DOM suits the lookups `derivedFrom` needs. Rejected:

- `fast-xml-parser` 5.11 (MIT): it now pulls in six dependencies;
- `saxes` (ISC): no release since 2022;
- `sax` 1.6 (BlueOak-1.0.0): streaming, so more code for the same result.

**SysTick, NVIC and SCB are not in the SVD** (checked 2026-10-07, T4).

- Neither the patched SVD nor ST's original v1.6 has a peripheral at `0xE000_xxxx`,
  or anything named SysTick, STK, NVIC or SCB.
- The only core information is the `<cpu>` block: `CM0` r0p1, `nvicPrioBits` 2 (4 in
  ST's original), and `vendorSystickConfig` false, meaning the standard Arm SysTick.
- So these registers are hand-written from the ARMv6-M Architecture Reference Manual,
  starting with SysTick at build step 2.

## 5. ELF loading and PC → file:line

**Decision.** Use [`@gba-kit/debug-info`](https://www.npmjs.com/package/@gba-kit/debug-info)
0.8.0 (MIT, no dependencies, pinned exact) for symbols and the `.debug_line` lookup:
ELF32, DWARF 2–5, `pcToSource` and `symbolToAddress`.

It was built for the Game Boy Advance, whose toolchain also produces ARM ELF32, so
it should fit (inferred). It's pre-1.0 with little use. **Build step 1 must check it
against a real `arm-none-eabi-gcc` ELF.** If it fails, vendor it (MIT allows that)
and fix it, or write a `.debug_line` reader. Loading `PT_LOAD` segments into flash and
RAM is a few dozen lines; write it ourselves if the package doesn't expose segments.

**Why DWARF 5 matters.** GCC 11 and later emit DWARF 5 by default. The npm `addr2line`
package has no DWARF-5 header parsing (inferred from `lib/dwarf.js`). The popular ELF
packages (`elfy`, `elf-tools`, `elfinfo`) don't parse DWARF at all.

**Rejected: calling binutils** (`arm-none-eabi-addr2line`, or
`objdump --dwarf=decodedline`).

- It works only from Node, never in the browser.
- The objdump text depends on locale and width, and truncates file names to 35
  characters without `-w`.
- Its format has never been documented as stable.

**Checked in T6 (2026-10-07): the package works, so no fallback.** Tested on
`build/blink.elf` from `arm-none-eabi-gcc` 14.2.1. Its `.debug_info` is DWARF 5. The
C units' line tables are version 3 and the startup `.s` unit's is version 5; the
package reads both. `Reset_Handler` and `main` resolve, and every PC in `main` maps
to the right line of `blink/main.c`. Two gaps, both filled in `src/engine/elf.ts`:

- It doesn't expose program headers or `e_entry`, so `elf.ts` reads them itself
  (about 20 lines).
- `pcToSource` returns the file name relative to the compile directory, as DWARF
  records it (`blink/main.c`, since `make` runs in `firmware/`). `elf.ts` joins it
  with the unit's `DW_AT_comp_dir`, so it returns an absolute path, as `addr2line`
  does. The CLI and UI can make it relative to the current directory.

## 6. Firmware toolchain for tests

**Decision.**

- Example and test firmware is built from source with `arm-none-eabi-gcc`, the same
  toolchain learners use.
- CI installs it (`gcc-arm-none-eabi` from apt on Ubuntu).
- Built ELFs are not committed.
- CPU instruction tests use hand-assembled opcodes, as the rp2040js tests do, so they
  run without the toolchain. Only the firmware-level tests need it.

**Build settings (T3).** `firmware/Makefile` builds each `firmware/<name>/main.c`
into `build/<name>.elf`, linked with ST's gcc startup and `system_stm32g0xx.c`
templates and our own `firmware/stm32g031k8.ld`.

- `-Og`: optimised, but still easy to follow line by line, which stepping and
  PC → file:line need. `-g` gives DWARF 5 with GCC 14.
- `--specs=nano.specs` only. ST's startup calls `__libc_init_array`, so newlib is
  needed, but blink makes no system calls. `nosys.specs` would only add "not
  implemented" linker warnings. A program that uses `printf` or `malloc` adds it.
- CI names `libnewlib-arm-none-eabi` explicitly: `gcc-arm-none-eabi` only
  Recommends it, and `nano.specs` comes from it.

**On the development laptop:** 14.2.1, installed in T0 by `~/install-remaining.sh`
(apt, needs sudo).

## 7. I2C at the transaction level, with line levels from the nets

**Decision (T13).** `src/engine/i2c.ts` simulates I2C one step at a time (START,
address, byte, STOP), not by toggling SDA and SCL bit by bit. The nets are still
the truth for the lines: the controller starts only if `isIdle()` sees both lines
resolve high, and a target is on the bus only if its SDA and SCL pins are on the
bus's nets (`Nets.sameNet`).

**Why.** Every I2C fault the brief lists shows at this level: no pull-ups (the lines
float, so never idle), a line held low, pins not routed to I2C1, a wrong address,
and RESET floating (the target answers no address). Bit-level simulation would cost
dozens of net resolutions per byte and show a learner nothing more.

**Assumed** (wired open-drain behavior, not from a datasheet):

- Targets that share an address all take every write, and the bus ACKs if any of
  them ACKs. A read returns the AND of their bytes.
- With no target selected (after a NACK), a read returns `0xFF`: nothing pulls SDA
  low.
- START and STOP reach every target on the bus, addressed or not.

**Not simulated:** the bus never drives the nets during a transaction, so a line
pulled low mid-transaction goes unseen. There is no arbitration loss (ARLO) and no
clock stretching. I2C bit-banged on GPIO pins reaches no target. Revisit with bit-level
simulation if a part or a lesson needs one of these.

## 8. Memory bus, peripherals and events (T7)

`src/engine/memory-bus.ts`, `src/peripherals/peripheral.ts`, `src/engine/events.ts`.
RM0444 itself couldn't be fetched while this was written (st.com refuses scripted
downloads), so every RM0444 point below is marked **assumed** until someone checks it
against the PDF.

- **Flash** is read-only to plain stores. A write is ignored and logged as `flash`,
  flagged `read-only`, with no fault. RM0444's FLASH_SR.PGSERR reads "set by hardware
  when a write access to the Flash memory is performed by the code while PG or FSTPG
  have not been set" (quoted from a web search result, not the PDF). That text names a
  flag, not a bus error. Setting PGSERR is left to a FLASH model. **Assumed:** no fault.
- **Flash is also mapped at `0x00000000`** (boot from main flash), because the core
  reads the vector table at VTOR = 0. **Assumed:** default boot configuration.
  System memory, OTP and option bytes (`0x1FFFxxxx`) aren't mapped: they fault.
- **Peripheral blocks are 1 KB-aligned**, found from each SVD peripheral's base. All
  484 registers fall inside their peripheral's block. SYSCFG and VREFBUF share
  `0x40010000`. **Assumed:** RM0444's boundary table wasn't checked. An address in a
  block with no register is `reserved`: it reads 0 and ignores writes (**assumed**).
  An address outside every block throws `BusFault`.
- **System control space** `0xE000E000–0xE000EFFF`: logged as `SCS`, flagged
  `unsimulated`, reads 0, ignores writes. Lookup order is SVD registers, then SCS,
  then reserved. So T12 adds SysTick by putting its hand-written registers into the
  chip's register map and registering a peripheral, with no bus change.
- **Unsimulated SVD registers** keep a value, starting at the reset value. Access
  type isn't enforced: a write to a read-only register is stored too. Registers that
  share an offset (TIMx `CCMR1_Input`/`CCMR1_Output`, SPI `DR`/`DR8`, CRC
  `DR`/`DR16`/`DR8`, ADC `CHSELR0`/`CHSELR1`) are one value, under the first name
  listed, with that name's reset value.
- **Byte lanes.** Peripheral registers are 32-bit words. A byte or halfword read
  returns its lanes. A write merges its lanes into the stored value, and a write hook
  gets that merged value plus the mask of the bits written. An unaligned register
  access throws `BusFault` (ARMv6-M faults unaligned accesses). Flash and SRAM don't
  check alignment yet; that belongs to T11.
- **Clock gating** is checked from the gate register's _stored_ value, so it works
  before an RCC model exists. With the bit at 0, writes are ignored, and reads
  return 0 without calling the read hook. Both are flagged `clock-off`. **Assumed:**
  reads return 0, because RM0444 wasn't available to check.
- **Events** go to subscribers and aren't stored. The bus builds an event only while
  someone subscribes. It calls `now()` for the cycle and PC only then. A write's event
  is emitted before the write takes effect, so events the write causes follow it.
  Flash and SRAM accesses aren't events, except ignored flash writes. The card's
  `{t, …, new}` became `{cycle, …, op, value}`, plus `address`, so reserved and SCS
  accesses, which have no register name, can still be located.

## 9. RCC and GPIO (T8)

`src/peripherals/rcc.ts`, `src/peripherals/gpio.ts`. RM0444 wasn't available
(`docs/reference/` doesn't exist yet), so RM0444 points are **assumed** as in §8.

**Contract additions** (agreed at the T7 gate):

- `PeripheralContext.nets: Nets`, and `regsOf(name): Readonly<Registers>`, the live
  registers of another peripheral. An unknown name throws.
- `MemoryBusOptions.nets: Nets` (required), handed to every peripheral.
- `Chip.pins: readonly string[]`: the package's I/O pins, so circuit JSON can check
  `mcu.<pin>`. For the G031K8 they are PA0–PA15, PB0–PB9, PC6, PC14, PC15 and PF2, from
  embassy-rs/stm32-data-generated `data/chips/STM32G031K8.json` (MIT/Apache-2.0); the
  LQFP32 and UFQFPN32 pinouts are the same. Package pins 22 and 23 are PA11 and PA12;
  the SYSCFG remap to PA9 and PA10 isn't simulated. PF2 is also NRST. PC and PF pins
  can be wired, but nothing drives them until GPIOC/GPIOF exist.

**RCC.** Gating already worked from the stored IOPENR/APBENR1 values (§8), so the
only behavior is in `RCC_CR`. The SVD's reset value, `0x63`, has HSION and HSIRDY at
0, so `while (!(RCC->CR & RCC_CR_HSIRDY));` would hang although the core runs from
HSI16. **Assumed** (RM0444 §5.4.1): CR resets to `0x0000_0500`. HSION and HSIRDY then
stay 1, since HSI16 is the system clock. HSERDY and PLLRDY stay 0: HSE and the PLL
aren't simulated, so firmware waiting for them stops there, visibly, instead of
running at a clock the simulator doesn't model. HSIDIV and CFGR are plain storage;
the core stays at 16 MHz.

**GPIO.** One `gpio(name, gate, pins)` for every port. Only pins on the package are
driven (`mcu.PB12` stays unconnected).

| MODER       | Drive on `mcu.<pin>`                                                     |
| ----------- | ------------------------------------------------------------------------ |
| output (01) | push-pull: `high`/`low` from ODR. Open-drain: `low`, or the pull for a 1 |
| input (00)  | the PUPDR pull: `pull-up`, `pull-down`, or `hi-z`                        |
| AF (10)     | the PUPDR pull. The peripheral that owns the pin drives it itself        |
| analog (11) | `hi-z`, with the pulls disconnected                                      |

- **IDR** is stored, and kept current by a nets listener and on every config write,
  so the register view and `regsOf` see the same value as the CPU. A pin reads 1
  only when its net is `high`. **Assumed:** `floating` and `conflict` read 0. Real
  hardware is unpredictable there; 0 is deterministic, and a diagnostic should flag a
  floating input rather than the model guessing. An analog-mode pin reads 0 (its
  Schmitt trigger is off; standard STM32 behavior, **assumed** for RM0444).
- **PUPDR 11** (reserved) pulls neither way (**assumed**).
- **BSRR**: set wins when a pin's set and reset bits are both written. BSRR and BRR
  act on ODR and read 0. IDR ignores writes.
- **AF ownership.** Nets hold one drive per endpoint, and an AF peripheral (I2C1 in
  T14) drives the same `mcu.<pin>` through `ctx.nets`. So GPIO re-drives a pin only
  when its own drive for that pin changes; writes for other pins leave it alone.
  `alternateFunction(regsOf("GPIOB"), 6)` gives a pin's AF number, or undefined
  outside AF mode. An AF peripheral that releases a line should put back the PUPDR
  pull, because its drive replaced GPIO's.
- Not simulated: LCKR (plain storage, so locking does nothing), OSPEEDR (no digital
  effect), IOPRSTR port resets.
- Registering a peripheral marks all its registers simulated, so RCC's PLLCFGR, for
  example, is no longer flagged `unsimulated`. Revisit with a per-register flag if a
  diagnostic needs it.

## 10. Engine run loop (T9)

`src/engine/engine.ts`. `load(elfBytes, circuit)`, `runFor(seconds)`, `step()`,
`snapshot()`, and the `events` log.

- **Time is CPU cycles** (`core.cycles`) at the chip's `clockHz`. `runFor` takes
  simulated **seconds**, as the CLI's `--for 2s` does, and stops at the first
  instruction boundary at or past them (an instruction takes a few cycles), or early on
  lockup or BKPT. Nothing reads the wall clock.
- **Contract additions** (agreed at the T7 gate): `PeripheralInstance.tick?(cycles)`,
  `PeripheralContext.now()` (cycles) and `PeripheralContext.cpu.setPending(exception)`
  (2 NMI, 14 PendSV, 15 SysTick, 16 + n for IRQ n), through
  `MemoryBusOptions.cpu`. `setPending` does what upstream rp2040js's NVIC and ICSR
  do: `core.setInterrupt(n, true)`, or the core's `pendingNMI`/`pendingPendSV`/
  `pendingSystick` plus `interruptsUpdated`.
- **Peripheral ticks run after every instruction**, with that instruction's cycles,
  in registration order, and only for peripherals that define `tick`. That is exact
  and costs nothing until a peripheral ticks. **Part ticks run every 1 ms** of
  simulated time, on fixed cycle boundaries (16,000 cycles), with
  `tick(0.001)`.
- **WFI/WFE:** while the core waits and nothing is pending, time jumps to the next
  1 ms part-tick boundary or the end of the run, whichever is first, and peripherals
  get that slice in one `tick`. A pending exception wakes the core at the next slice,
  so a wake-up can be up to 1 ms late. The MVP firmware doesn't sleep; if WFI firmware
  needs better, peripherals can report their next deadline.
- **BKPT** (§2) stops the run with the PC rewound onto the BKPT, so the snapshot
  shows its line. Running or stepping again executes it again, as a debugger does
  until the PC is moved.
- **Net changes are events** (`kind: "net"`, with the cycle, endpoint and level), so
  tests and the UI see pins change without polling.
- **The snapshot** has the PC as `file:line` (else `function+0xoffset`, else the
  address), each package pin's level, every register's _stored_ value (so taking it
  has no read side effects), `cycles` and `seconds`, `halt` (`lockup` or `breakpoint`
  with its reason, else null), and `state()` of each part that has one.
- `src/chips/index.ts` is the chip registration list, which `load` looks
  `circuit.chip` up in; `catalog` (in `engine.ts`) is the parts and chips list for
  `parseCircuit`.
- **The core's `logger`** (HardFault and lockup messages) goes into the snapshot's
  `log` (the first 100 since load), not the console (T10). The snapshot's `fault`
  is the HardFault the CPU is in (IPSR = 3): the PC stacked on entry (SP+24, from
  the stack EXC_RETURN names) as `file:line`, and the core's reason. `sim` reports
  it and exits 1 (`docs/cli.md`).
- Speed: blink runs at about 4.2 simulated seconds per wall-clock second (Node 24,
  this laptop).

## Checked against RM0444 Rev 6 (2026-10-07)

The reference manuals are now local, in `docs/reference/` (gitignored: ST's
copyright). These are the "assumed" points from §8 and §9 that RM0444 settles.

- **Clock off** (§5.2.17): "the read and write accesses to its registers are not
  effective." Writes are ignored, **confirmed**. Reads returning 0 is our reading of
  "not effective" and stays assumed.
- **Clock enable delay** (§5.2.17): the clock starts 2 cycles after the enable bit is
  set, and an access in that window has no effect. **Not modelled**; a follow-up on T7.
- **Direct flash write** (§3, FLASH_SR bit 7 PGSERR): a write without PG/FSTPG sets
  PGSERR. There is no bus fault, **confirmed**. Setting PGSERR is a follow-up on T7.
- **Peripheral blocks** (memory-map table): 1 KB each for GPIOA, GPIOB, RCC and I2C1,
  **confirmed**.
- **RCC_CR** (§5.4.1): power-on reset value `0x0000 0500`, **confirmed**. The SVD's
  `0x63` is wrong; `rcc.ts` overrides it.

## Open, deferred to the build step that needs them

- **Step 7, UI:** the bundler or import map for Lit and `@wokwi/elements`, and
  whether the engine runs in the page, in a Web Worker, or in Node behind a socket.
  It's possible either way because the engine has no Node or DOM imports.
- **Packaging:** how a learner gets the one-command start (`npx`, a published package
  with a `tsc` emit, or a single binary).
- **Second chip:** the v7-M core choice in §2, and whether its SVD needs patches the
  way the G031's does.
