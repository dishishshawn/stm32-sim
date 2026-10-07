# `sim`: the command line

This is the contract for scripts, CI and AI assistants. The commands, the JSON
shapes and the exit codes are a stable interface: changing one is a breaking
change, and bumps `"version"`.

Run it as `node src/cli/sim.ts …`, `just sim …` (from any directory), or `sim …`
once the package's `bin` is on your PATH.

## Commands

```
sim run <elf> [--circuit <json>] --for <duration> [inputs] [--json]
sim inspect <elf> [--circuit <json>] --at <duration> [inputs] [--json]
sim ui <elf> [--circuit <json>] [--port <n>] [--open] [--json]
sim watch <elf> [--circuit <json>] [--for <duration>] [inputs] [--json]
```

`run` and `inspect` load the ELF onto the circuit's chip, reset it, and run it for the given
**simulated** time (time comes from CPU cycles at the core clock, 16 MHz after
reset, never from the wall clock, so a run is deterministic).

- `--circuit <json>`: the circuit file. Without one, the board is the chip alone
  (`stm32g031k8`), with nothing wired.
- `--for` / `--at <duration>`: how long to run. A number and a unit: `2s`,
  `1.5s`, `100ms`, `500us`.
- `--json`: print one JSON object on stdout instead of text.

**Inputs** set a part's props (the circuit's `props`, e.g. a TC74's
`temperature` or a push-button's `pressed`). Each flag is repeatable.

- `--set <part>.<prop>=<value>`: the value from the start, in place of the
  circuit's.
- `--at <duration>:<part>.<prop>=<value>`: change it when the run reaches that
  simulated time since reset, at the first instruction boundary at or past it.
  Changes due at the same time apply in the order given.
- `--at <duration>:<part>.press`: `pressed=true` at that time and
  `pressed=false` 50 ms later.

`inspect`'s own `--at <duration>` shares the flag: a value with a `:` is a
change, one without is when to stop. So
`sim inspect fw.elf --circuit c.json --at 1s:temp.temperature=30 --at 2s` sets
30 °C at 1 s and stops at 2 s.

A value is read as the prop's declared type: a number (`30`, `-2.5`), `true` or
`false`, or a string (the rest of the argument, as is). It must also be in the
prop's range or options. An unknown part, an unknown prop or a bad value exits
2 and names what is valid:
`sim: --at: tc74 "temp" has no prop "temp" (props: variant, temperature)`.

A run ends early on a lockup or a BKPT. A HardFault does not end it: the
firmware runs its handler (ST's default handler loops forever) until the time
is up.

**`run`** prints a short summary: how the run ended, the simulated time, the PC
as `file:line`, the `mcu.*` pin levels, the core's log (HardFault and lockup
messages), and the diagnostics. In text, the pins shown are those a wire in the
circuit uses, or all of them if nothing is wired.

**Diagnostics** explain likely mistakes. They never change what the simulation
does. Each is reported once, where it first happened, with a count. In text it
is one line, `file:line: severity: message [rule]`, or `cycle N: …` when no
instruction caused it (an I2C NACK):

```
diagnostics
  firmware/clock-off/main.c:25: warning: wrote GPIOB_ODR (0x50000414) while RCC_IOPENR (0x40021034) bit 1 GPIOBEN = 0 — GPIOB's clock is off, so the write was ignored [gpio-clock-off] (3 times)
```

A message names each register as exam-style C `#define`s it, `<PERIPH>_<REG>`,
with its address, and a field by its bit or bits: `GPIOB_MODER (0x50000400)
bits 13:12 MODE6`. Compare the address with your `#define` to catch a wrong one.

These are the rules at the time of writing. `src/diagnostics/index.ts` is the
authoritative list: a new rule is one file plus one line there, so it isn't added here.

| Rule                   | Severity  | Reports                                                                                                               |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `gpio-clock-off`       | `warning` | an access to a peripheral whose RCC clock enable bit is 0 (any clock-gated one, not only GPIO)                        |
| `unsimulated-register` | `info`    | an access to a register the simulator doesn't model yet                                                               |
| `timingr-while-pe`     | `warning` | a write to I2C1_TIMINGR while I2C1_CR1 bit 0 PE = 1, which was ignored                                                |
| `i2c-pins-not-af6`     | `warning` | START set while SCL or SDA isn't routed to any pin (no pin in AF mode with AF6), naming what the pins are instead     |
| `i2c-pin-push-pull`    | `warning` | START set while a pin routed to I2C1 is push-pull (OTYPER bit 0) instead of open drain                                |
| `i2c-bus-not-idle`     | `warning` | START set while SCL or SDA isn't high, so START never goes out: floating (no pull-ups), low (held low) or in conflict |
| `i2c-nack-no-device`   | `warning` | an address NACKed, naming the I2C parts on the bus and their addresses, or why one answers none (e.g. held in reset)  |
| `rule-error`           | `info`    | a diagnostic rule threw: a simulator bug. The run is unaffected; the message names the rule                           |

**`inspect`** prints the same, then:

- the clocks at the end of the run, from RCC's registers: the SYSCLK source
  (what SWS shows: `HSISYS`, `PLLRCLK`, `LSI`), SYSCLK, HCLK (the core and
  SysTick) and PCLK (APB peripherals such as I2C1):

  ```
  clocks  SYSCLK 64 MHz from PLLRCLK, HCLK 64 MHz, PCLK 64 MHz
  ```

- the registers with their named bits, decoded from the chip's register map. In
  text, only the peripherals the firmware touched or that are simulated;
  `--json` gives every one;
- the I2C trace. In text, one line per step with its simulated time: `START`
  (a repeated START too), the address or data byte with R or W and the ACK or
  NACK (on a read, the data byte's ACK is the controller's), and `STOP`. A
  feature of I2C1 that the firmware selected but the simulator doesn't model
  shows as `I2C1 CR2.RELOAD isn't simulated`:

  ```
  i2c
    0.250018 s  START
    0.250110 s  ADDR 0x48 W  ACK
    0.250194 s  DATA 0x00 W  ACK
    0.250196 s  START
    0.250288 s  ADDR 0x48 R  ACK
    0.250372 s  DATA 0x16 R  NACK
    0.250381 s  STOP
  ```

- accesses to unsimulated registers: peripheral, register, read and write counts,
  and features a peripheral doesn't simulate;
- each part's `state()`.

File paths in the output are relative to the current directory.

**`ui`** checks the ELF and circuit as `run` does (exit 2 if either is bad),
then serves the browser UI on `127.0.0.1` until stopped with Ctrl-C:

```
$ just sim ui build/thermometer.elf --circuit firmware/thermometer/circuit.json
sim ui: serving http://127.0.0.1:8031/ (Ctrl-C to stop)
```

- The page runs the firmware in real time and shows the circuit: LEDs and
  7-segment digits live, push-buttons pressed while held (mouse or Space), a
  slider for a temperature sensor, the board's MCU pins coloured by level, and
  the run state and simulated time.
- Run controls in the header: **Pause**/**Resume**; **Step**, while paused,
  runs one instruction; **Speed** is "real time" (the default) or "max", as
  fast as the page can run the firmware without stuttering. A BKPT or a
  lockup stops the run and disables them: running on would stop on the same
  BKPT again.
- The **Source** panel shows where the PC is (`file:line` and the PC), with
  the file's text and that line highlighted. It follows every step, and about
  4 times a second while running. The server reads only the source files the
  ELF's debug info names; one it names that isn't on this machine (the C
  library's) shows no text.
- Add `#paused` to the URL (`http://127.0.0.1:8031/#paused`) to start paused
  at the reset vector, before the first instruction.
- It reads the ELF and circuit files on each page load. It also watches the
  ELF as `watch` does: when you rebuild, the open page loads the new firmware
  within a second, keeping its circuit and resetting the MCU (parts start
  again from the circuit's props; a slider shows its old value until moved),
  and the header
  says `firmware reloaded at HH:MM:SS` for a few seconds. If the new ELF
  doesn't load, it says `firmware reload failed: …` and the old firmware keeps
  running. A page whose firmware has halted (BKPT, lockup) reloads whole.
- `--port <n>`: the port, default 8031; `0` picks a free one. A port in use
  exits 2.
- `--open`: also open the URL in the default browser.
- It is local and offline: it listens on 127.0.0.1 only, and the page loads
  nothing from anywhere else.
- Parts are added from the palette (click, or drag onto the canvas), moved
  by dragging or with the arrow keys, and removed with Delete. Adding or
  removing one restarts the simulation. "Save circuit" writes the circuit to
  the `--circuit` file, in its canonical form (`serializeCircuit`: fixed key
  order, one wire per line), with `pos` only for parts that were placed;
  an unchanged file stays byte-identical. Without `--circuit`
  there is nowhere to save.

**`watch`** runs as `run` does (`--for` defaults to `1s`), prints the result,
then runs again each time the ELF changes, until Ctrl-C:

```
$ just sim watch build/blink.elf --for 500ms
--- run 1: build/blink.elf at 14:02:11 ---
status  completed
…
sim watch: waiting for build/blink.elf to change (Ctrl-C to stop)

--- run 2: build/blink.elf at 14:02:40 ---
status  completed
…
```

- A change counts once the file has kept its size and modification time for
  100 ms, since a linker may write it in steps. It polls the path every 50 ms,
  so a linker that replaces the file is followed too. A deleted ELF is ignored
  until it is back.
- Each run reads the ELF and the circuit again.
- Bad input on the first run (arguments, ELF, circuit) exits 2, as `run` does.
  After that an error, e.g. a truncated ELF, is printed (on stderr, or as a
  JSON error line) and it keeps watching.
- Ctrl-C exits 0. A run's status is in its output, not the exit code.
- With `--json`, each run prints one JSON object on one line: `run`'s object
  with `"command": "watch"`.

## Exit codes

| Code | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 0    | the run completed (including a stop at a BKPT)                                           |
| 1    | firmware fault: the CPU is in its HardFault handler, or locked up                        |
| 2    | usage or invalid input: bad arguments, a missing or unreadable ELF, invalid circuit JSON |
| 2    | `ui`: the port is in use                                                                 |
| 0    | `watch`: stopped with Ctrl-C                                                             |
| 3    | internal error: a bug in the simulator                                                   |

**BKPT** stops the run at the BKPT instruction, as a debugger would, with
`"status": "breakpoint"` and exit code **0**: a BKPT is something the firmware
asked for, not a fault. A script that needs the full duration checks `status`.

## JSON

Every object has `"version": 1`. Numbers that are addresses or register values
are hex strings (`"0x08000154"`); bit-field values are numbers.

### `run`

```json
{
  "version": 1,
  "command": "run",
  "elf": "build/hardfault.elf",
  "circuit": null,
  "status": "hardfault",
  "message": "HardFault: undefined instruction 0xdeff at firmware/hardfault/main.c:8",
  "seconds": 0.0010000625,
  "cycles": 16001,
  "pc": "0x080001a9",
  "at": "vendor/cmsis-device-g0/startup_stm32g031xx.s:118",
  "halt": null,
  "fault": {
    "pc": "0x08000154",
    "at": "firmware/hardfault/main.c:8",
    "reason": "undefined instruction 0xdeff"
  },
  "pins": { "PA0": "floating", "PA13": "high", "PA14": "low", "...": "..." },
  "log": ["HardFault at 0x08000154: undefined instruction 0xdeff"],
  "diagnostics": []
}
```

| Field         | Meaning                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | `"run"`, `"inspect"` or `"watch"`                                                                                                        |
| `elf`         | the ELF path                                                                                                                             |
| `circuit`     | the circuit path, or `null`                                                                                                              |
| `status`      | `"completed"`, `"breakpoint"`, `"hardfault"` or `"lockup"`                                                                               |
| `message`     | one line for a person, e.g. the line above                                                                                               |
| `seconds`     | simulated time at the end, each cycle at the core clock of its moment. A run stops at the first instruction at or past `--for`           |
| `cycles`      | CPU cycles since reset                                                                                                                   |
| `pc`          | the PC at the end                                                                                                                        |
| `at`          | the PC as `file:line`, else `function+0xoffset`, else the address                                                                        |
| `halt`        | why the CPU stopped early: `{ "kind": "lockup" \| "breakpoint", "reason": "BKPT #7" }`, else `null`                                      |
| `fault`       | the HardFault the CPU is in: the faulting instruction (`pc`, the PC stacked on exception entry), its `at`, and the `reason`. Else `null` |
| `pins`        | every package pin's level: `"high"`, `"low"`, `"floating"` or `"conflict"`                                                               |
| `log`         | the CPU core's messages, oldest first (at most 100)                                                                                      |
| `diagnostics` | likely mistakes, in order of first occurrence (below)                                                                                    |

Each diagnostic:

```json
{
  "rule": "gpio-clock-off",
  "severity": "warning",
  "message": "wrote GPIOB_ODR (0x50000414) while RCC_IOPENR (0x40021034) bit 1 GPIOBEN = 0 — GPIOB's clock is off, so the write was ignored",
  "periph": "GPIOB",
  "reg": "ODR",
  "count": 3,
  "cycle": 190,
  "pc": "0x0800018e",
  "at": "firmware/clock-off/main.c:25"
}
```

| Field                  | Meaning                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `rule`                 | the rule's id                                                                                                                  |
| `severity`             | `"warning"`: likely a mistake in the firmware. `"info"`: a limit of the simulator                                              |
| `message`              | one line for a person                                                                                                          |
| `periph`, `reg`, `pin` | what it is about, each only where it applies: a register (`reg` is its address where it has no name), or a pin                 |
| `count`                | how many times it happened. The other fields describe the first time                                                           |
| `cycle`                | the CPU cycle                                                                                                                  |
| `pc`, `at`             | the instruction that made the access, and its `file:line` as the top-level `at` gives it. `null` when no instruction caused it |

### `inspect`

Everything `run` has, plus:

```json
{
  "clocks": {
    "source": "PLLRCLK",
    "sysclk": 64000000,
    "hclk": 64000000,
    "pclk": 64000000
  },
  "registers": {
    "GPIOA": {
      "MODER": {
        "value": "0xebfffffd",
        "fields": { "MODE0": 1, "MODE1": 3, "...": 3, "MODE15": 3 }
      }
    }
  },
  "i2c": [
    {
      "kind": "i2c",
      "cycle": 4001764,
      "periph": "I2C1",
      "step": {
        "t": 4001764,
        "kind": "addr",
        "addr": 72,
        "read": false,
        "ack": "ack"
      }
    }
  ],
  "unsimulated": [
    { "periph": "SCS", "reg": "0xe000e010", "reads": 2, "writes": 1 }
  ],
  "parts": { "led1": { "lit": true } }
}
```

| Field          | Meaning                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clocks`       | the clocks at the end of the run, in Hz: `source` (the SYSCLK source SWS shows: `"HSISYS"`, `"PLLRCLK"` or `"LSI"`), `sysclk`, `hclk` and `pclk` (added by T42; version stays 1)            |
| `registers`    | every register of every peripheral in the register map, by peripheral and register name: its stored `value`, and its `fields` (named bits, low bit first)                                   |
| `i2c`          | I2C1's bus trace, in order (`step.kind` is `start`, `addr`, `data` or `stop`)                                                                                                               |
| `notSimulated` | features a peripheral doesn't simulate (e.g. I2C1 RELOAD), once each: `{periph, feature, count}` (added in place of the earlier `kind: "unsimulated"` entries under `i2c`; version stays 1) |
| `unsimulated`  | accesses to registers nothing simulates, in order of first access. `reg` is the register name, or its address where it has none (the system control space)                                  |
| `parts`        | `state()` of each part that has one, by part id                                                                                                                                             |

### `ui`

Once it is serving, one object:

```json
{ "version": 1, "command": "ui", "url": "http://127.0.0.1:8031/" }
```

### Errors

With `--json`, an error (exit 2 or 3) prints instead:

```json
{
  "version": 1,
  "error": "build/missing.elf: ENOENT: no such file or directory"
}
```

Without `--json`, errors go to stderr as `sim: <message>`. A bad circuit names
the file and the field: `sim: circuit.json: parts[0].type: unknown part type "nope"`.
