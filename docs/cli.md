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
```

Both load the ELF onto the circuit's chip, reset it, and run it for the given
**simulated** time (time comes from CPU cycles at 16 MHz, never from the wall
clock, so a run is deterministic).

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
as `file:line`, the `mcu.*` pin levels, and the core's log (HardFault and lockup
messages). In text, the pins shown are those a wire in the circuit uses, or all
of them if nothing is wired.

**`inspect`** prints the same, then:

- the registers with their named bits, decoded from the chip's register map. In
  text, only the peripherals the firmware touched or that are simulated;
  `--json` gives every one;
- the I2C trace (empty until I2C1 is simulated, T14);
- diagnostics (empty until T24);
- accesses to unsimulated registers: peripheral, register, read and write counts;
- each part's `state()`.

File paths in the output are relative to the current directory.

## Exit codes

| Code | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 0    | the run completed (including a stop at a BKPT)                                           |
| 1    | firmware fault: the CPU is in its HardFault handler, or locked up                        |
| 2    | usage or invalid input: bad arguments, a missing or unreadable ELF, invalid circuit JSON |
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
  "log": ["HardFault at 0x08000154: undefined instruction 0xdeff"]
}
```

| Field     | Meaning                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `command` | `"run"` or `"inspect"`                                                                                                                   |
| `elf`     | the ELF path                                                                                                                             |
| `circuit` | the circuit path, or `null`                                                                                                              |
| `status`  | `"completed"`, `"breakpoint"`, `"hardfault"` or `"lockup"`                                                                               |
| `message` | one line for a person, e.g. the line above                                                                                               |
| `seconds` | simulated time at the end: `cycles` / 16 MHz. A run stops at the first instruction at or past `--for`                                    |
| `cycles`  | CPU cycles since reset                                                                                                                   |
| `pc`      | the PC at the end                                                                                                                        |
| `at`      | the PC as `file:line`, else `function+0xoffset`, else the address                                                                        |
| `halt`    | why the CPU stopped early: `{ "kind": "lockup" \| "breakpoint", "reason": "BKPT #7" }`, else `null`                                      |
| `fault`   | the HardFault the CPU is in: the faulting instruction (`pc`, the PC stacked on exception entry), its `at`, and the `reason`. Else `null` |
| `pins`    | every package pin's level: `"high"`, `"low"`, `"floating"` or `"conflict"`                                                               |
| `log`     | the CPU core's messages, oldest first (at most 100)                                                                                      |

### `inspect`

Everything `run` has, plus:

```json
{
  "registers": {
    "GPIOA": {
      "MODER": {
        "value": "0xebfffffd",
        "fields": { "MODER0": 1, "MODER1": 3, "...": 3, "MODER15": 3 }
      }
    }
  },
  "i2c": [],
  "diagnostics": [],
  "unsimulated": [
    { "periph": "SCS", "reg": "0xe000e010", "reads": 2, "writes": 1 }
  ],
  "parts": { "led1": { "lit": true } }
}
```

| Field         | Meaning                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registers`   | every register of every peripheral in the register map, by peripheral and register name: its stored `value`, and its `fields` (named bits, low bit first)  |
| `i2c`         | the I2C bus events from the event log, in order (filled once I2C1 is simulated, T14)                                                                       |
| `diagnostics` | diagnostic findings (filled from T24)                                                                                                                      |
| `unsimulated` | accesses to registers nothing simulates, in order of first access. `reg` is the register name, or its address where it has none (the system control space) |
| `parts`       | `state()` of each part that has one, by part id                                                                                                            |

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
