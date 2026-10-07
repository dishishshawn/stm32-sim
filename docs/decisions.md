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
| Browser UI       | `sim ui` serves `src/` with types stripped (no bundler), the wokwi bundle, one import-map entry. Engine in the page (§15)  |
| UI tests         | `playwright-core` (Apache-2.0, dev only) and Chrome Headless Shell, from `node:test`. CI caches the browser (§15)          |

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
  `@wokwi/elements`. T30 chose neither for Lit: see §15.

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

**Fixed after T10:** exception entry kept bit 0 of the vector in the PC, as upstream
rp2040js does. Fetch masks it, so handlers ran, but the PC read odd until the
handler's first instruction. That is the state `sim` reports after a HardFault.
Entry now branches to `vector & ~1`, per ARMv6-M ExceptionTaken. The fault tests
now use realistic vectors, with bit 0 set.

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
  - `fields.<F>`: `bitOffset`, `bitWidth`, `access`, `description`, and `svdName`
    when the field's name differs from the SVD's (see "Field names" below).
  - Addresses, offsets and reset values are hex strings (`"0x40005400"`). Sizes (in
    bits), bit offsets and widths are numbers.
  - Peripherals are sorted by base address, registers by offset, and fields by bit
    offset.
- Conversion rules:
  - `derivedFrom` is resolved the way svd-rs does it: the element's own values win,
    and a register or field list is inherited whole only when the element has none.
  - `dim` arrays are expanded (`MODER%s` becomes `MODER0`…`MODER15`, which the
    field naming then turns into `MODE0`…`MODE15`).
  - The one cluster, the DMA1 channels, is flattened to `CH1_CR`, `CH1_NDTR` and so
    on.
  - stm32-rs drops a register's access when its fields differ. Such a register takes
    its fields' access when they all agree, else `read-write`, as svd2rust does. So
    DMA1 `ISR` is read-only and `IFCR` write-only.
  - Any other SVD construct makes the script throw rather than guess.
- Registers that share an offset stay as the SVD has them. Examples: TIMx
  `CCMR1_Input`/`CCMR1_Output`, `CNT`/`CNT32`, SPI `DR`/`DR8`, CRC `DR`/`DR16`/`DR8`.
  A peripheral model implements whichever view it needs.
- Peripheral and register names are stm32-rs's; field names are the CMSIS header's
  (below). Descriptions keep ST's older wording: "master mode" where RM0444 Rev 6
  says "controller mode". Every address, offset, bit position and reset value
  checked so far agrees with RM0444.

**Field names follow ST's CMSIS header (T38, 2026-10-07).** Learners write
`RCC->IOPENR |= RCC_IOPENR_GPIOBEN;`, but the SVD calls that bit `IOPBEN`, GPIO's
`MODE0` is its `MODER0`, and `AFSEL8` is its `AFREL8`. RM0444 and `stm32g031xx.h`
agree, so diagnostics and the register view use the header's names.

- `tools/svd2json.ts` also reads `vendor/cmsis-device-g0/stm32g031xx.h`. Each
  peripheral's CMSIS instance and TYPE come from the header's
  `#define GPIOB ((GPIO_TypeDef *) GPIOB_BASE)` lines, matched on base address, so
  the SVD's `LPUART`, `ADC` and `DMAMUX` find `LPUART1`, `ADC1` and `DMAMUX1`. TYPE
  is the `_TypeDef` name up to its first `_` (`DMAMUX_Channel` gives `DMAMUX`).
- A field takes `<NAME>` from the macro `<TYPE>_<REG>_<NAME>_Pos`, or
  `<INSTANCE>_<REG>_<NAME>_Pos` (`TIM1_AF1_…`), whose `_Pos` is its bit offset and
  whose `_Msk` is exactly its width. If the SVD's name is one of the matches it
  stays: the header also defines `I2C_OAR2_OA2MASK07` for `OA2MSK` and
  `RCC_PLLCFGR_PLLSRC_HSE` for `PLLSRC`. Any other tie throws.
- A renamed field keeps the SVD's name as `svdName`. A field with no match keeps the
  SVD's name and gets no `svdName`. The script prints both counts.
- Of 3456 fields, **668 are renamed**, 2175 already had the CMSIS name, and **613
  have no match**. 390 of the 613 are in the 79 registers with no bit macro under
  the SVD's register name: CMSIS names the register differently (below), or has no
  bit definitions for it (USART `RQR`, FLASH `KEYR`, PWR port E). The rest differ in
  width or position, such as EXTI `EXTICR` fields (8 bits in the SVD, 3 in the
  header) and TIM2's 32-bit `CCR1` (the header's mask is 16 bits).
- Some renames look odd, but they are what the header defines: USART `RXNE` becomes
  `RXNE_RXFNE`, and LPUART `BRR.BRR` becomes `LPUART`. The header and the SVD swap
  two pairs: SYSCFG `ITLINE3` `FLASH_ITF`/`FLASH_ECC`, and FLASH `OPTR`
  `BORF_LEV`/`BORR_LEV`. Position decides, so the JSON follows the header, and the
  descriptions, which come from the SVD, now contradict those four names. Neither
  pair has been checked against RM0444.
- **Register names stay the SVD's.** Where CMSIS differs:
  - TIMx `CCMR1_Input`/`CCMR1_Output` (CMSIS `CCMR1`, also `CCMR2`, `CCMR3`) and
    `CNT16`/`CNT32` (`CNT`);
  - DMA1 `CH1_CR`, `CH1_NDTR`, `CH1_PAR`, `CH1_MAR`… (`DMA1_Channel1->CCR`,
    `CNDTR`, `CPAR`, `CMAR`);
  - DMAMUX `CCR0`… and `RGCR0`… (`DMAMUX1_Channel0->CCR`,
    `DMAMUX1_RequestGenerator0->RGCR`);
  - ADC `CHSELR0`/`CHSELR1` (`CHSELR`); SPI `DR8` and CRC `DR8`/`DR16` (`DR`);
  - struct members only, with bit macros that use the SVD's name: GPIO
    `AFRL`/`AFRH` (`AFR[0]`/`AFR[1]`, but `GPIO_AFRL_AFSEL0`), EXTI `EXTICR1`…
    (`EXTICR[0]`…), DBG `APB_FZ1` (`APBFZ1`, but `DBG_APB_FZ1_…`).

  Not renamed: most are several SVD views of one CMSIS register, which §8 keeps
  apart. Among the simulated peripherals only GPIO's `AFRL`/`AFRH` is affected: a
  diagnostic about it names `AFRL`, not `AFR[0]`.

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

**Header vs SVD disagreements (T38), checked against RM0444 Rev 6.** For FLASH_OPTR
`BORF_LEV`/`BORR_LEV`, RM0444 has BORF_LEV at bits 12:11 and BORR_LEV at 10:9. For
SYSCFG_ITLINE3, FLASH_ITF is bit 1. Both agree with the CMSIS header, so the JSON's
header-derived names are right and the SVD had them swapped. Those fields' SVD
_descriptions_ are still the swapped ones.

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
the core stays at 16 MHz. (Superseded by §14: RCC models the clock tree.)

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
- **AF ownership.** Superseded by AF endpoints (§12): an AF peripheral never drives
  `mcu.<pin>`; GPIO joins the pin to the peripheral's own endpoint with a switch.
  GPIO still re-drives a pin only when its own drive for that pin changes.
  `alternateFunction(regsOf("GPIOB"), 6)` gives a pin's AF number, or undefined
  outside AF mode.
- Not simulated: LCKR (plain storage, so locking does nothing), OSPEEDR (no digital
  effect), IOPRSTR port resets.
- Registering a peripheral marks all its registers simulated, so RCC's PLLCFGR, for
  example, is no longer flagged `unsimulated`. Revisit with a per-register flag if a
  diagnostic needs it. (§14 added one: `Peripheral.simulates`.)

## 10. Engine run loop (T9)

`src/engine/engine.ts`. `load(elfBytes, circuit)`, `runFor(seconds)`, `step()`,
`snapshot()`, and the `events` log.

- **Time is CPU cycles** (`core.cycles`) at the chip's `clockHz` (§14: at the
  HCLK of each moment). `runFor` takes
  simulated **seconds**, as the CLI's `--for 2s` does, and stops at the first
  instruction boundary at or past them (an instruction takes a few cycles), or early on
  lockup or BKPT. Nothing reads the wall clock (`runRealtime`, §11, only waits on it).
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
- **Mid-run inputs** (T20): `setPropAt(seconds, part, prop, value)` checks the
  value with `propError` and queues it by cycle. It goes to the part's `setProp`
  at the first instruction boundary at or past that cycle (after that step's
  ticks), and a WFI sleep slice ends there too, so a change lands on time even
  inside one `runFor`. Same cycle: in the order scheduled. The CLI's `--set`
  edits the circuit's props before `load` instead, so it covers props a part
  only reads in `create()` (a TC74's `variant`).
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

- `Engine.readSram(address, length)` copies SRAM bytes with no side effects, e.g. a
  firmware global at its ELF symbol. Tests use it to read `g_temp` (T17).

## 11. SysTick, SCB and real-time speed (T12)

`src/peripherals/systick.ts`, `src/peripherals/scb.ts`, `src/engine/core-cpu.ts`,
`Engine.runRealtime`.

- **Registers.** The SVD has no SysTick or SCB (T4), so each file exports its
  register-map entry, hand-written from the ARMv6-M ARM (B3.3 SysTick, B3.2 SCB) in
  the JSON's shape and with CMSIS names (`SysTick.CTRL/LOAD/VAL/CALIB`,
  `SCB.ICSR/SHPR3`). The chip definition spreads them into its `registers`, so the
  bus, the snapshot and a register view see them like SVD registers, named bits
  included. SysTick's takes the chip's CALIB value.
- **SysTick** counts in `tick(cycles)` with arithmetic, not a loop, so a 1 ms WFI
  slice costs the same as one instruction. From 0 the next clock reloads LOAD, so a
  round is LOAD + 1 clocks and LOAD = 0 holds the counter at 0. COUNTFLAG sets on
  each 1 → 0 step, clears when CTRL is read and on any VAL write, and ignores CTRL
  writes. TICKINT pends exception 15; several wraps in one tick pend it once, as
  the hardware's single pending bit would. Enabling doesn't load LOAD: the count
  starts from VAL, which is why the init sequence clears VAL first.
- **STM32G0 facts, from RM0444 Rev 6:** CLKSOURCE = 0 counts HCLK/8 (§5.2, clock
  tree); CALIB is 1000 (§12.2: "set to 1000, which gives a reference time base of
  1 ms with the SysTick clock set to 1 MHz"). **Assumed:** NOREF and SKEW read 0
  (RM0444 gives only the value; PM0223 wasn't checked), and CTRL, LOAD and VAL
  reset to 0 (the ARMv6-M ARM leaves LOAD and VAL UNKNOWN and CLKSOURCE's reset
  IMPLEMENTATION DEFINED). The HCLK/8 residue carries across ticks, so CLKSOURCE = 0
  is exactly 8× slower.
- **SCB:** only ICSR's PENDSTSET/PENDSTCLR and SHPR3 (PRI_14 and PRI_15, top two
  bits each). PENDSTSET reads 1 while SysTick is pending; set wins if both bits
  are written (UNPREDICTABLE on hardware). Every other SCB address, and ICSR's other
  bits, still read 0 and ignore writes; the other addresses are still logged as
  `SCS`/`unsimulated`. ICSR itself is now a simulated register, so a PENDSVSET
  write is ignored without the `unsimulated` flag (§9's per-register flag would fix
  it).
- **Contract addition:** `Cpu` gained `clearPending`, `isPending` and
  `setPriority(exception, priority)`, next to `setPending`. `coreCpu()` in
  `src/engine/core-cpu.ts` implements all four on the core, as upstream's
  `ppb.ts` did (priority goes into the core's `SHPR3`, for 14 and 15 only). Test
  stubs of `Cpu` need all four.
- **Speed: `max` is `runFor(seconds)`, unchanged and synchronous; `realtime` is
  `await runRealtime(seconds)`.** It runs 10 ms slices of simulated time through
  `runFor` and, after each, `setTimeout`s until the wall clock (`performance.now()`,
  measured from the call) has caught up. Both are globals in Node and browsers, so
  the engine still imports neither. The simulation is identical in both speeds:
  the wall clock only decides when to wait. If the simulation is slower than real
  time it never waits and doesn't yield to the event loop. It stops early on a
  lockup or BKPT, as `runFor` does. No pause or cancel yet; the UI can add an
  `AbortSignal` when it needs one. Measured: 0.5 s simulated took 500.1 ms.
- **Cost:** SysTick ticks after every instruction even when disabled. Blink went
  from 3.65 to 3.16 simulated seconds per wall second (this laptop, same run);
  the SysTick firmware runs at about 2.2.

## 12. I2C1 and alternate-function routing (T14)

`src/peripherals/i2c.ts`, the AF table in `src/chips/stm32g031k8.ts`, AF routing in
`src/peripherals/gpio.ts`. Behavior is from RM0444 Rev 6 chapter 32, cited by section
in the code.

**Contract additions.**

- `PeripheralContext.parts` (the mounted parts, read live) and
  `PeripheralContext.events` (the event log). `MemoryBusOptions.parts` is optional
  (default none); the engine passes its parts map before mounting into it.
- `gpio(name, gate, pins, af)` takes the chip's `AfTable`: per pin, AF number →
  signal, e.g. `{ PB6: { 6: "I2C1_SCL" } }`.
- Two event kinds: `i2c` (`{cycle, periph, step}`, `step` being the `I2cBus` trace
  event) and `unsimulated` (`{cycle, periph, feature}`, e.g. `"CR2.RELOAD"`).

**AF endpoints.** A peripheral signal is its own endpoint, `mcu.I2C1_SCL`. GPIO
closes a switch between `mcu.PB6` and it while PB6 is in AF mode with AFR = 6, and
opens it otherwise. A pin that isn't routed (wrong MODER or AFR, or the port clock
off so MODER never changed) leaves I2C1's lines floating with no special case, and
the PUPDR pull stays on the pin. The G031K8's table has every I2C1 pin on the
package, all AF6 (DS12992 Rev 4, Tables 13 and 14): PA9/PA10 (the Nucleo's D5/D4,
labelled I2C1 in UM2591 Table 9), PB6/PB7 and PB8/PB9. Two pins routed to one
signal are simply joined.

**The controller.** One state machine, ticked every instruction while PE = 1 and
I2C1EN = 1, so flags appear over simulated time:

- An SCL period is `(SCLH + 1 + SCLL + 1) × (PRESC + 1)` cycles plus 4 for the sync
  delays (§32.4.9; Table 173 note 2 gives 4 as their minimum), plus DNF per edge.
  START with the address counts as 10 periods, a byte 9, a STOP 1. **Assumed:**
  I2CCLK is the 16 MHz core clock (§14: I2C1SEL's clock now); the analog filter
  delay and SDADEL/SCLDEL are not counted. 100 kHz from Table 173 comes out at 9.25 µs per period instead of ~10.
- Flag rules from RM0444: TXIS after the address ACK and again as soon as a byte is
  copied to the shift register if another is due (Figure 303); SCL held while TXDR
  is empty or RXDR unread (§32.4.7); the last read byte NACKed (§32.4.9); a NACK sets
  NACKF and sends STOP whatever AUTOEND says (§32.4.9); TC with AUTOEND = 0, cleared
  by setting START (repeated START) or STOP; START cleared once the address is sent;
  STOP clears STOP, NACK and PECBYTE; PE = 0 resets the state, CR2
  START/STOP/NACK/PECBYTE and the ISR flags, and sets TXE (§32.4.6); TXDR takes a
  write only while TXE = 1 (§32.9.11); writing ISR.TXE = 1 flushes; ICR clears the
  flags at the same bit positions, and ADDRCF also clears START; ICR reads 0.
- **Assumed:**
  - **BUSY** is "a START was seen" in RM0444 (§32.9.7). Here it is also set while
    either line isn't high (floating, held low, pins not routed), and a pending
    START waits for both lines high. That is AGENTS.md's "a bus held low reads as
    BUSY, and START never happens": RM0444 only warns that a low incident at START
    may deadlock the peripheral (§32.4.9).
  - **TIMINGR** with PE = 1: RM0444 says it "must be configured" with PE = 0
    (§32.9.5) but not what such a write does. Ignored silently, per AGENTS.md.
  - While PE = 0, CR2's START/STOP/NACK/PECBYTE can't be set, and TXDR writes are
    ignored (TXE is held set).
  - Clearing PE mid-transfer puts no STOP on the bus; the target sees the next START.
  - Gating I2C1EN off mid-transfer freezes it.
- **Not simulated**, logged as an `unsimulated` event when the firmware sets the
  field: interrupts (CR1 TXIE…ERRIE, so no I2C IRQ), DMA, target mode (OA1EN, OA2EN,
  GCEN, SBC, NOSTRETCH, WUPEN, CR2.NACK), SMBus (SMBHEN, SMBDEN, ALERTEN, PECEN,
  PECBYTE, TIMEOUTR), 10-bit addressing (ADD10) and RELOAD. With RELOAD or ADD10 set,
  the transfer runs as if they were 0. BERR and ARLO are never set: the bus model has
  no misplaced START/STOP and no arbitration (§7).

## 13. Diagnostics (T24, T25)

- A `Rule` gets each event plus a read-only `BoardView`: register values, net levels,
  `sameNet`, and a projection of each part (id, type, pins, props, and for an I2C
  target its `sda`/`scl`/`address()`). It never gets the bus or `setProp`, so it can't
  change the run. The purity test runs five firmware scenarios with and without every
  rule and compares the event logs and snapshots.
- So a part's `address()` **must have no side effects**: diagnostics call it.
- A rule that throws becomes a `rule-error` diagnostic; the run continues unchanged.
- Repeats are grouped by rule and message, with a count.
- I2C pin rules fire when firmware sets START, not when it sets PE, because firmware
  may legally route the pins after enabling PE. The cost: firmware that polls BUSY
  before ever setting START gets no pin diagnostic.
- `Chip` carries its AF table (`af`), which GPIO already used, so rules can name
  I2C1's candidate pins.
- Registers in messages are named `<PERIPH>_<REG> (0xADDRESS)`, fields `… bit N NAME`
  (T41, `src/diagnostics/names.ts`). That's how exam-style firmware `#define`s them, so
  a learner can check their own address against the message. Field names are the CMSIS
  names (§4).
- **Clock rules (T42).** There is no clock-change event, so `flash-latency` checks
  the HCLK an RCC_CFGR write _selects_ (SW and HPRE, with SWS taken as SW) against
  FLASH_ACR.LATENCY, and LATENCY when ACR is written. That blames the SW line, which
  RM0444 §3.3.4's sequence says must come after LATENCY, even when the switch waits
  for the PLL lock. Missed: SW = PLL written before the PLL is configured. Both
  `flash-latency` and `pll-out-of-range` assume VCORE Range 1 (PWR_CR1.VOS's reset
  value). `pll-out-of-range` checks at PLLON against DS12992 Table 43 (input 2.66–16,
  VCO 96–344, PLLRCLK 12–64 MHz), PLLRCLK even with PLLREN = 0.
  `pll-config-while-on` reports only a change to a field the write can't make
  (§14), not a PLLCFGR write that sets an output enable, which RM0444 §5.2.4 allows.

## 14. Clock tree, and time that follows the clock (T39)

`src/peripherals/rcc.ts`, `src/peripherals/flash.ts`, the clock timeline in
`src/engine/engine.ts`. Sources: RM0444 Rev 6 chapters 3 and 5, DS12992 Rev 4
Tables 41–43, UM2591 Rev 2 Table 8, cited in the code. This supersedes §9's "HSE
and the PLL aren't simulated ... the core stays at 16 MHz", §10's "cycles at the
chip's `clockHz`" and §12's "I2CCLK is the 16 MHz core clock".

**RCC.**

- **Start-up.** ON → RDY after DS12992's typical time: HSI16 0.8 µs (Table 41),
  PLL lock 15 µs (Table 43, tLOCK: 15 typical, 40 max), LSI 80 µs (Table 42).
  It is counted in seconds at the HCLK of each tick. ON = 0 clears RDY at once
  (**assumed**; RM0444 gives 6 HSI16 cycles for HSIRDY).
- **HSE never gets ready.** On the NUCLEO-G031K8 its only source is the ST-LINK's
  MCO through SB7 into PC14, and SB7 is off by default (UM2591 Table 8).
  **Assumed:** an unmodified board. HSEON and HSEBYP are stored.
- **LSE isn't simulated**: LSERDY never sets, and setting LSEON logs an
  `unsimulated` event (`BDCR.LSEON`). The board does have the 32.768 kHz crystal
  (SB8 and SB9 on), but its 2 s start-up and the RTC domain's write protection
  (PWR_CR1.DBP) would need modelling first.
- **PLL.** PLLRCLK = (input / M) × N / R (§5.4.4). The input is HSI16, or nothing
  for PLLSRC = 00 or HSE. **Assumed:** a PLL with no input clock, or N = 0, never
  locks; PLLR = 000 (reserved) divides by 1. The datasheet limits (input 2.66–16
  MHz, VCO 96–344 MHz, PLLRCLK ≤ 64 MHz) aren't enforced: that's T42's
  diagnostic. While PLLON = 1, writes to PLLSRC, M, N, P, Q and R are ignored,
  and so is PLLREN while PLLRCLK is SYSCLK (§5.4.4: "can be written only when the
  PLL is disabled"), silently, per AGENTS.md.
- **SW → SWS** (§5.2.7): "A switch from one clock source to another occurs only
  if the target clock source is ready", and "if a clock source which is not yet
  ready is selected, the switch occurs when the clock source becomes ready". So
  SW = PLL before PLLRDY leaves SWS on HSISYS until the lock, then switches. A
  source that never gets ready (HSE, LSE, a PLL that is off, reserved values)
  leaves SWS where it is. **Assumed:** the switch takes no extra cycles, and the
  PLL counts as ready only with PLLREN set.
- The source in use can't be stopped (§5.2.7, §5.4.1): HSION (directly or under
  the PLL), PLLON, PLLREN and LSION stay set while it is SYSCLK.
- HSIDIV → HSISYS, HPRE (1, 2, 4, 8, 16, 64, 128, 256, 512) → HCLK, PPRE → PCLK.
  `clocks(regs)` in rcc.ts works out SYSCLK, HCLK and PCLK from the registers
  alone; I2C1 uses it, and T42 can.
- Not simulated: RCC interrupts (CIER/CIFR), CSS, MCO, the reset flags, HSI16
  trimming. HSI48 isn't on the G031.

**Time.**

- **Contract addition:** `PeripheralContext.setCoreClock(hz)`, through
  `MemoryBusOptions.setCoreClock` (default: ignored). RCC calls it when HCLK
  changes.
- The engine keeps a **clock timeline**: `(cycle, seconds, hz)` points, the first
  being the chip's `clockHz` at cycle 0. `Engine.secondsAt(cycle)` converts any
  cycle. The snapshot's `seconds` and the CLI's I2C trace times use it.
  `Chip.clockHz` is only the reset clock now.
- Deadlines stay in cycles, so the per-instruction compares are unchanged:
  `runFor`'s end, the next part tick, and `setPropAt` changes. A clock change
  moves them to keep their simulated time: part ticks and changes are worked out
  again from their seconds, and the run's end is scaled by new hz / old hz.
  `runRealtime` works out its end's cycle again for every 10 ms slice. At 16 MHz
  with no change, this is the old arithmetic exactly: every earlier test and
  cycle count is unchanged.
- Part ticks fall on the cycle nearest each 1 ms, rounded per tick, so they
  don't drift at clocks that aren't a whole number of kHz.
- A clock change inside a WFI slice lands at the slice's end, up to 1 ms late,
  as a wake-up does (§10).
- **SysTick** needed no change: it counts core cycles, which are HCLK
  (CLKSOURCE = 1), or HCLK/8.
- **I2C1** counts in I2CCLK cycles, turned into core cycles (× HCLK / I2CCLK,
  rounded) when each step starts. I2CCLK is CCIPR.I2C1SEL's: PCLK (reset
  default), SYSCLK or HSI16; **assumed:** 11 (reserved) as PCLK. With PCLK =
  HCLK this is the old timing exactly.
- **Cost:** RCC ticks after every instruction, because a switch waiting for the
  PLL must happen at the lock even if the firmware doesn't poll. Blink measured
  about 15% slower (25 against 29 M cycles per wall second, pinned to one core,
  noisy). If that matters: let `tick()` report idle until the peripheral's next
  register write.

**FLASH.** Registered with `simulates: ["ACR"]`, a new optional `Peripheral`
field: the registers a peripheral models. The others stay plain storage flagged
`unsimulated`, so FLASH_KEYR or FLASH_CR still say so. The default is all, as
before (§9). ACR is plain storage: LATENCY reads back, which firmware polls
(§3.3.4). Wait states have no effect; real silicon misreads flash with too few
of them at a high HCLK (§3.3.4, Table 13), and T42 diagnoses that instead. No
clock gate: RCC_AHBENR.FLASHEN resets to 1 (§5.4.14), but the SVD's AHBENR reset
value is 0, so a gate would ignore every ACR write.

**Example:** `firmware/pll-64mhz/` in exam style. PA5 blinks twice at 16 MHz,
then the firmware sets LATENCY = 2, the PLL (HSI16 / 1 × 8 / 2), PLLON, waits
for PLLRDY, switches SW and waits for SWS, starts SysTick at LOAD = 64000 − 1,
and blinks with the same loop. Its test checks the period ratio (4), 1 ms
SysTick interrupts, part ticks, `setPropAt` and real-time mode across the
switch, and that every `#define` matches the register JSON.

## 15. Browser UI shell and `sim ui` (T30)

`src/ui/server.ts` (Node), `src/ui/index.html` and `src/ui/main.ts` (browser),
`src/ui/ui.test.ts`. Measured 2026-10-07 on this laptop (8 cores), Node 24.20.0,
Chrome Headless Shell 153.

**Serving.** `sim ui` checks its input as `run` does (exit 2), then serves with
`node:http` on `127.0.0.1` only, default port 8031 (`--port 0` picks a free
one). Routes: `/` the page; `/elf` and `/circuit`, read from disk on every
request, so a reload picks up a rebuilt ELF; `/src/**.ts` and `/src/**.json`;
`/debug-info/*.js`; `/wokwi-elements.js`. Anything else is 404, and a path that
resolves outside its directory too.

- A request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` gets
  403, so a site that rebinds its DNS name to 127.0.0.1 can't read the files.
- Every response has `Content-Security-Policy: default-src 'self'
'unsafe-inline'`: the page can't fetch anything from another origin, which
  makes "offline" something the browser enforces. `unsafe-inline` is for the
  import map and the page's `<style>`. And `Cache-Control: no-store`.

**TS in the browser: no bundler.** Option (a) of the T30 card.

- The server strips types on request with Node's `module.stripTypeScriptTypes`
  and serves the result as JavaScript. Imports keep their `.ts` extension; the
  browser doesn't care about extensions, only the MIME type. Strip mode
  replaces types with spaces, so line and column numbers match the source and
  no source map is needed.
- It exists in Node 24 and warns once per process (`ExperimentalWarning:
stripTypeScriptTypes is an experimental feature`). `server.ts` calls it once
  at import with `process.emitWarning` stubbed, so Node records the warning as
  given and `sim ui` prints nothing.
- Cost: 36 files of engine, parts and UI strip in 36 ms on the first pass
  (20 ms after). The page loads in about 180 ms with 60 requests.
- The registers JSON loads as a JSON module (`import … with { type: "json" }`),
  natively.
- Import map: one entry, `@gba-kit/debug-info` → `/debug-info/index.js`. Its
  `dist/` is ESM with `.js` extensions and no Node imports.
- `@wokwi/elements` 1.9.2 is loaded as its IIFE bundle
  (`dist/wokwi-elements.bundle.js`, 554 KB, Lit included) in a classic
  `<script>`. Its ESM build can't load without a bundler: it imports
  extensionless paths (`./utils/keys`). The bundle defines every element, and
  our code doesn't import Lit: the page is plain DOM.
- Licenses: `@wokwi/elements` MIT; Lit 3 (`lit`, `lit-html`, `lit-element`,
  `@lit/reactive-element`, `@lit-labs/ssr-dom-shim`) BSD-3-Clause; its
  `@types/react` and `csstype` dependencies MIT.
- **Rejected: esbuild (b).** It works, but it is a native binary and a
  runtime dependency of `sim ui`, for what 4 lines of stripping already do.
  Revisit if the UI needs a feature that isn't erasable TS, or a library whose
  ESM build needs a bundler.
- A later task that wants Lit for its own components adds `lit`, `lit/`,
  `lit-html`, `lit-html/`, `lit-element/`, `@lit/reactive-element` and
  `@lit/reactive-element/` to the import map: Lit's own ESM has extensions. It
  would be a second copy of Lit next to the bundle's, which is harmless.

**The engine runs in the page**, driven by `requestAnimationFrame` in
`frame()` in `main.ts`.

- Each frame runs the wall time since the last one, in 1 ms `runFor` slices,
  until done or until it has spent 12 ms. Then it takes one `snapshot()` and
  updates the elements. At most 100 ms per frame, so a hidden tab (no frames)
  pauses the simulation instead of building a backlog.
- `runRealtime` isn't used: when the firmware is slower than real time it never
  yields, which would freeze the page, and it can't be paused.
- Measured, thermometer firmware: 1.26 simulated s per wall s in Chromium at
  full speed (0.92 in Node 24); 0.96 in the page with the 12 ms budget. Frames
  stay at 16.7 ms (median and p95 16.7–16.8 ms, max 16.8 ms over 120 frames),
  so the UI doesn't stutter. `snapshot()` costs 0.1 ms.
- So the page uses most of the main thread while running, and the
  thermometer runs close to the budget's limit. Move the engine to a Web
  Worker when a panel needs more main-thread time per frame, or firmware
  needs more than about 0.7× of full speed. The engine has no DOM imports, so
  only `main.ts` changes: `load`, `runFor`, `snapshot` and `setPropAt` become
  messages. Panels that read `engine.view()` or `engine.events` directly
  (T34–T36) would need their data posted too, which is why the page is the
  simpler start.
- Inputs: `setPropAt(seconds of the last frame, …)`, which applies at once.
  The push-button sets `pressed` on `button-press` and `button-release` (the
  element's own `<button>`, so Space works). A part with a numeric
  `temperature` prop (TC74, also TMP102 and MCP9808) gets a range input with
  the prop's min and max.
- The header shows the run state, worded as `sim run`'s message (`running`,
  `HardFault: … at …`, `lockup: …`, `breakpoint: …`), and the simulated time.
  The loop stops on a halt.

**Drawing.**

- Coordinates: CSS px at 96 per inch, the unit of `@wokwi/elements` `pinInfo`
  (0.1 in = 9.6 px). T29's art is in 0.01 in units, drawn at
  `PX_PER_UNIT = 0.96` (`src/ui/art/index.ts`). A part's circuit `pos` is its
  top-left corner in these px. The canvas is shown at `zoom: 1.5`; a pointer
  position (T31) divides by it.
- The board is at (0, 0). A part without `pos` goes in a grid below it: 4
  columns of 160 × 110 px cells, part i in cell i. No packing, no measuring.
  So a part moved out of its cell (T31) leaves a gap, and the rest stay put,
  in the page and after Save and reload.
- Each part is a `<figure data-part="<id>">` with its id as `<figcaption>`.
  Wokwi elements for `led`, `7segment`, `pushbutton` and `resistor`; T29's SVG
  for `tc74` and `mcp23017`; a labelled box for a part with neither (TMP102,
  MCP9808).
- Live: an LED's `value` from `state().lit`, a 7-segment's `values` from
  `state().values` (set only when it changes).
- **Nucleo endpoints.** Each Nucleo header pin now has its `endpoint`
  (`src/ui/art/nucleo-g031k8.ts`): `mcu.<pin>` for an MCU pin, `3V3` or `GND`
  for a rail, none for 5V, VIN, NRST and AREF, which the simulation doesn't
  have. The page draws a dot on each MCU pin, coloured by its net level from
  the snapshot (high, low, conflict; floating shows the bare pad), with the
  level in its `<title>`: `<circle class="pin" data-pin="PA0">`.
- A pin's position is its figure's `pos` plus the element's `pinInfo`, or
  the art's `pins` × `PX_PER_UNIT` (T32, below).
- Accessibility: semantic header and figures, the run state in a
  `role="status"` region (the time is outside it, so it isn't announced every
  frame), the button and slider are native controls, `:focus-visible` gets a
  2 px outline, and colours are CSS variables for light and dark
  (`prefers-color-scheme`).

**Editing (T31).** In `main.ts`, which owns the drawing.

- The palette has one button per registered part type. Click adds the part
  in the first cell no part overlaps; dragging the button onto the canvas
  (native drag and drop) adds it there. The id is the type plus a number,
  starting with a letter, with `_` after a type ending in a digit: `led1`,
  `segment1`, `tc74_1`. Props are `{}`, so the defaults apply, as in a
  hand-written file.
- A part moves by pointer drag (deltas divided by the canvas zoom) or the
  arrow keys on the focused figure, snapped to the 0.1 in grid (9.6 px,
  rounded to 0.1 px so the file says `28.8`). Only a moved or added part gets
  a `pos`. Delete or Backspace asks in a `<dialog>` and removes the part and
  every wire with one of its endpoints.
- Adding or removing restarts the simulation: `engine.load()` on the edited
  circuit (the same object, so panels' `ui.circuit` stays current) with the
  ELF re-fetched, then a redraw. The header says so. Moving doesn't: `pos`
  isn't simulated. Since T32, a move that plugs pins into a breadboard or
  pulls them out does (below).
- Save `PUT`s `serializeCircuit()` to `/circuit`. The server writes only
  `serializeCircuit(parseCircuit(body))`, only to the `--circuit` file (409
  without one), and only for a request whose `Origin` is its own (403
  otherwise). Another site's page can't `PUT` here anyway: that needs a CORS
  preflight the server never grants. A body `parseCircuit` rejects gets 400
  and no write. Saving an unchanged canonical file is byte-identical.

**Wires and the breadboard (T32).** In `main.ts`, plus the `breadboard`
part.

- **Pins.** Every pin gets a `<button class="pin-target">` on its part,
  titled `led1 pin A` (`board pin PB6 (D1)` on the Nucleo), with its endpoint
  in `data-endpoint`. Buttons, so Tab reaches them and Enter clicks them; a
  breadboard's 400 holes are 400 tab stops, which is workable but slow. Board
  pins are its header positions with an `endpoint`. GND is on two, and a wire
  to GND is drawn to the first. A part with neither an element nor art (TMP102,
  MCP9808) gets its pins in a row along the top of its box, 0.1 in apart.
- **Pin positions are computed, not measured.** Figures now align their
  content to the top-left (they centred it), so the element's top-left is the
  part's `pos`, and a pin is `pos` plus its `pinInfo` (or art pin ×
  `PX_PER_UNIT`). No `getBoundingClientRect`, so no waiting for Lit's first
  render. The wokwi `pinInfo` comes from a throwaway element per type.
- **Making a wire:** click a pin, then another: the wire is appended to
  `circuit.wires` as `[first, second]` and the simulation restarts through
  T31's `change()`. A dashed rubber band follows the pointer, or the pin
  the keyboard is on. Escape, or the first pin again, cancels. A pair already
  wired (either way round) isn't added twice. Wires are only ever appended or
  removed, never reordered, so a hand-written file's order survives.
- **Drawing:** one SVG over the canvas, one `<g class="wire">` per wire: a
  1.5 px line coloured by its net's level (`engine.view().level()` each
  frame; `--high`, `--low`, `--conflict` from the board's pins; floating is
  muted and dashed), over a 6 px transparent line to click. A click focuses
  it (`tabindex`), which is the selection; Delete or Backspace removes it, no
  confirmation (a wire is cheap to redraw). A wire to an MCU pin on no header
  isn't drawn.
- **Stacking:** breadboards, the board, wires, parts, then the board's pins
  (`z-index`, under `isolation: isolate`). Wires go under parts so a part
  crossed by wires can still be dragged; the board's pins go over wires so
  they stay clickable. Wires don't take the pointer while one is being drawn,
  so a hole under a wire's end can be its second pin.
- **The breadboard is a part**, `src/parts/breadboard.ts`: pins are the
  art's 400 hole names, and `create()` closes `setSwitch(first, hole)` across
  each of `art/breadboard.ts`'s 64 groups. So a strip's holes are one net by
  the engine's own nets, with no core change, and a breadboard circuit runs
  the same from the CLI. Cost (thermometer, Node 24, this laptop): `load()`
  13 → 49 ms on the first load (3 → 39 ms after), and 2 simulated s take
  2.48–2.52 s instead of 2.15–2.35 s: about 10 % slower, because every net
  change re-resolves 400 more endpoints (`nets.ts`'s `ponytail:`).
- **Plugging a part in: snap, chosen over explicit pin-to-hole wires.** A
  learner drags an LED onto the breadboard, as on a real one. Explicit wires
  would cost no code, but the part's own pin button covers the hole under it,
  so its "plug" could only go to a neighbouring hole: a jumper, not a plug.
  - A **plug** is an ordinary wire `[part pin, hole]` whose two ends are within
    GRID / 3 (3.2 px) of each other. Nothing marks it: the file stays plain
    `wires`, hand-editable, and the CLI runs it. Drawn, it has no length.
  - **Seating:** a part dropped by pointer (drag end, or from the palette)
    moves so its pin nearest a hole (within 0.75 grid, which reaches one from
    anywhere over the holes) sits exactly on it. The 3.2 px tolerance covers
    wokwi parts that aren't on the 0.1 in pitch: the LED's legs are 10 px
    apart, the resistor's 58.8 px, the DIP art's rows 0.32 in.
  - After each move, `rewire(before)` compares plugs before and after:
    plugs that came apart are taken out, new ones appended. Only if that
    changed the wires does the move restart the simulation, saying e.g.
    `moved led1 (0 in, 2 out)`. A wire drawn from a pin to a far hole isn't a
    plug, so it stays and stretches.
  - Arrow keys: a part with plugs steps exactly 0.1 in (staying hole to
    hole); otherwise it snaps to the grid as in T31, and isn't seated, since
    the grid and the holes are half a pitch apart in places. So a keyboard
    user plugs a part in with wires to holes.
  - Moving a breadboard doesn't carry its parts: they stay, and come
    unplugged. Moving it back plugs them in again.
- **Tests:** `src/ui/wire.test.ts`. The thermometer rebuilt in the page
  from an empty circuit: all seven parts from the palette, their props set in
  the Part panel (T43, below), and all 34 wires clicked in. It shows 22, then
  71 after a press, and Save writes the thermometer's props and the 34 wires
  in the order drawn. Then Escape, the
  keyboard, wire ends at the pins' centres following an arrow-key move, and
  click-then-Delete on a wire, with blink. Then a breadboard from the
  palette, an LED dropped on it and plugged into a9/a10, PA0 through strip
  e10 and the − rail to GND: it blinks; dragged off, the two plugs go.
  About 20 s for the three (the rebuild 16 s: 47 restarts).

**Props (T43).** `src/ui/props.ts`, a "Part" panel, first in the sidebar.

- Selecting a part (focusing it or anything on it; a click focuses it)
  shows its id and type as a `<fieldset>`'s legend and one labelled native
  control per prop, from its `PropSpec`: a `<select>` for `options`, a number
  input with the spec's `min` and `max` (`step="any"`), a checkbox for a
  boolean, a text input for a free string.
- A control's `change` (Enter or leaving a number field) checks the value
  with `propError()`. A bad one is refused: the reason shows under the form
  in a `role="alert"` paragraph, the field gets `aria-invalid`, and nothing
  restarts. A good one goes through `change()`: the simulation restarts and
  Save writes it. A value equal to the default is deleted from `props`, so
  the file holds only what differs, as a hand-written one does. The part
  object is replaced, not mutated, so `change()`'s undo works.
- The TC74 slider and the push-button stay live controls (`setPropAt`, not
  saved). The form shows the circuit's value, so after the slider moves the
  two differ until the next restart.
- Two hooks on `Ui` for it: `onSelect(fn)` (main.ts calls it from the
  canvas's `focusin`, and with `undefined` when the part is removed) and
  `change(edit)`, main.ts's own.
- **Tests:** `src/ui/props.test.ts`. A TC74 from the palette, wired to
  tc74-read's pull-ups: at A5 the trace shows `ADDR 0x48 W  NACK`, set to A0
  `ADDR 0x48 W  ACK`; 200 °C is refused with its message; Save writes
  `{ "variant": "A0" }` and a reload shows A0. A 7-segment from the palette,
  set to cathode, each segment on a rail and its common on GND, lights
  `11011010`; set to anode it is dark, and with its common moved to 3V3 it
  lights `00100101`. A common-anode display's common goes to the high rail,
  so the prop alone can't invert the lit segments. About 9 s for the two.

**Headless UI tests: `playwright-core` driven from `node:test`.**

- `playwright-core` 1.63.0 (Apache-2.0, a dev dependency only, 14 MB, no
  dependencies, no install script) with Chrome Headless Shell 153
  (`chromium_headless_shell-1243`): a 120 MB download, 261 MB unpacked in
  `~/.cache/ms-playwright`, installed in 6.7 s here by
  `npx playwright-core install --only-shell chromium`. Locally, add
  `--no-remove` if other Playwright versions share that cache: by default the
  install deletes browsers no installation references.
- `src/ui/ui.test.ts` starts `sim ui --port 0` as a user would, opens the page,
  and fails on any page error, console error or request to another origin.
  Thermometer: the digits show 22; Space held on the button for 200 ms gives
  71; the slider at 30 gives 86. Blink with an LED on PA0 (a circuit written by
  the test; `firmware/blink/circuit.json` stays bare, other tests use it): the
  LED and the board's PA0 dot go on and off. Both take about 2 s.
- A missing browser fails both tests with the install command. They never
  skip. Playwright's own banner names `npx playwright install`, which installs
  another package's browsers, so only its first line is kept.
- CI caches `~/.cache/ms-playwright` with `actions/cache@v6`, keyed on
  `package-lock.json`, then runs the install (a no-op on a cache hit).
- **Rejected:** Puppeteer (also Apache-2.0, but it downloads Chrome from an
  install script); the system Chrome through
  `channel: "chrome"` (CI images have it, a learner's machine may not, and
  its version drifts).

**Panels (added before T31–T36).** A panel is one file in `src/ui/`, registered in
`src/ui/panels.ts`. It gets a `Ui` (`src/ui/ui.ts`): the engine, the circuit, a
`run.paused` flag the frame loop respects, `onSnapshot(fn)`, `panel(title)` for its own
section in the right-hand sidebar, the header `toolbar` for run controls, and (T43)
`onSelect(fn)` and `change(edit)`. That way
panels can be built in parallel without editing `main.ts`. Only placing parts and
wires (T31, T32) change `main.ts`'s rendering.

**Run controls and the Source panel (T36).** `src/ui/controls.ts`, a panel.

- Pause/Resume set `run.paused`; Step calls `engine.step()` and shows the new
  snapshot at once. Both are disabled on a halt: running or stepping a BKPT
  stops on it again (§2, §10). `#paused` in the URL pauses before the first
  frame, at the reset vector. No "step a line": the only PC is in
  `snapshot()` (0.1 ms), too slow to call per instruction through blink's
  1.2 M-instruction delay loop.
- **Max speed** runs in the panel's `onSnapshot` callback, after `main.ts`'s
  real-time share, until 12 ms after the frame's start
  (`document.timeline.currentTime`, which is the rAF timestamp). A `run.max`
  flag in `main.ts`'s loop (`t < due || loop.max`) would replace it. Blink
  gains little (the engine runs it at about 1.5× real time at best); the test
  uses `firmware/wfi-fixture`, which sleeps, so the speeds differ on any
  machine.
- **`/source?file=<path>`** is a safety boundary. It serves a file only if
  the path is absolute and equals one of `Elf.sources()`: every file
  `pcToSource` can give (the line table's files, joined with their unit's
  `comp_dir`), read from the ELF on each request. Anything else is 404 (a
  relative path, `..`, any other file). A named file missing from disk (the C
  library's) gets an empty 200, not a 404 the browser would log on every step
  into it.

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

- **Packaging:** how a learner gets the one-command start (`npx`, a published package
  with a `tsc` emit, or a single binary).
- **Second chip:** the v7-M core choice in §2, and whether its SVD needs patches the
  way the G031's does.
