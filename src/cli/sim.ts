#!/usr/bin/env node
// `sim`: the command line, a thin layer over the engine. docs/cli.md is the
// contract: commands, flags, JSON shapes and exit codes. Changing any of them
// is a breaking change.
import { spawn } from "node:child_process";
import { readFileSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { chips } from "../chips/index.ts";
import { rules } from "../diagnostics/index.ts";
import { mhz } from "../diagnostics/names.ts";
import { diagnose } from "../diagnostics/rule.ts";
import { parseCircuit, serializeCircuit } from "../engine/circuit.ts";
import type { Circuit } from "../engine/circuit.ts";
import { catalog, Engine, propSpec } from "../engine/engine.ts";
import type { Snapshot } from "../engine/engine.ts";
import type { I2cTraceEvent } from "../engine/events.ts";
import { i2cText } from "../engine/i2c.ts";
import type { Chip } from "../engine/memory-bus.ts";
import { propError } from "../parts/part.ts";
import type { PropSpec, PropValue } from "../parts/part.ts";
import { clocks, SYSCLK_SOURCES } from "../peripherals/rcc.ts";

const USAGE = `usage:
  sim run <elf> [--circuit <json>] --for <duration> [inputs] [--json]
  sim inspect <elf> [--circuit <json>] --at <duration> [inputs] [--json]
  sim ui <elf> [--circuit <json>] [--port <n>] [--open] [--json]
  sim watch <elf> [--circuit <json>] [--for <duration>] [inputs] [--json]
inputs, repeatable:
  --set <part>.<prop>=<value>            before the run
  --at <duration>:<part>.<prop>=<value>  at that simulated time
  --at <duration>:<part>.press           pressed, then released 50 ms later
durations: 2s, 1.5s, 100ms, 500us`;

/** Bad arguments or input: exit 2. */
class InputError extends Error {
  usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.usage = usage;
  }
}

const json = process.argv.includes("--json");
/** `sim watch --json` prints one object per line: one per run. */
const compact = process.argv[2] === "watch";
try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  fail(e);
}

/** Reports `e`: exit 2 for bad input, 3 for a simulator bug. */
function fail(e: unknown) {
  const input = e instanceof InputError;
  const message = input
    ? e.message
    : `internal error: ${(e as Error)?.stack ?? e}`;
  if (json) print({ version: 1, error: message });
  else console.error(`sim: ${message}${input && e.usage ? `\n${USAGE}` : ""}`);
  process.exitCode = input ? 2 : 3;
}

function main(argv: string[], once = false): number {
  const [command, ...rest] = argv;
  const time = { run: "for", inspect: "at", ui: "", watch: "for" }[
    command ?? ""
  ];
  if (time === undefined)
    throw new InputError(
      command ? `unknown command "${command}"` : "missing command",
      true,
    );
  const options: ParseArgsConfig["options"] = {
    circuit: { type: "string" },
    json: { type: "boolean" },
    ...(command === "ui"
      ? { port: { type: "string", default: "8031" }, open: { type: "boolean" } }
      : {
          ...(time === "for" && {
            for: {
              type: "string",
              ...(command === "watch" && { default: "1s" }),
            },
          }),
          // Prop changes, and inspect's own --at <duration>: only a change has a ":".
          at: { type: "string", multiple: true },
          set: { type: "string", multiple: true },
        }),
  };
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options,
      allowPositionals: true,
    }));
  } catch (e) {
    throw new InputError((e as Error).message, true);
  }
  if (positionals.length !== 1) {
    throw new InputError(
      positionals.length ? `unexpected "${positionals[1]}"` : "missing <elf>",
      true,
    );
  }
  if (command === "watch" && !once) return watch(argv, positionals[0]);
  if (command === "ui") {
    return ui(
      positionals[0],
      values.circuit as string | undefined,
      values.port as string,
      values.open === true,
    );
  }
  const ats = (values.at ?? []) as string[];
  const changes = time === "at" ? ats.filter((a) => a.includes(":")) : ats;
  const stop =
    time === "at" ? ats.findLast((a) => !a.includes(":")) : values.for;
  const seconds = duration(stop as string | undefined, `--${time}`);
  const elfPath = positionals[0];
  const circuitPath = values.circuit as string | undefined;

  const { elf, circuit } = readInput(elfPath, circuitPath);
  for (const text of (values.set ?? []) as string[]) {
    const { id, name, value } = assignment(text, "--set", circuit);
    circuit.parts.find((p) => p.id === id)!.props[name] = value;
  }
  const scheduled = changes
    .flatMap((text): [number, string][] => {
      const colon = text.indexOf(":");
      if (colon < 0) {
        throw new InputError(
          `--at: expected <duration>:<part>.<prop>=<value>, got "${text}"`,
          true,
        );
      }
      const t = duration(text.slice(0, colon), "--at");
      const change = text.slice(colon + 1);
      const press = /^(.+)\.press$/.exec(change);
      return press
        ? [
            [t, `${press[1]}.pressed=true`],
            [t + 0.05, `${press[1]}.pressed=false`],
          ]
        : [[t, change]];
    })
    .map(([t, text]) => ({ t, ...assignment(text, "--at", circuit) }));
  const engine = new Engine();
  input(elfPath, () => engine.load(elf, circuit));
  for (const c of scheduled) engine.setPropAt(c.t, c.id, c.name, c.value);
  const diagnosed = diagnose(engine.events, engine.view(), rules);

  const inspect = command === "inspect";
  const touched = new Set<string>();
  const unsimulated = new Map<
    string,
    { periph: string; reg: string; reads: number; writes: number }
  >();
  const i2c: I2cTraceEvent[] = [];
  // Features a peripheral doesn't simulate (I2C1's RELOAD, a template's TIM16 ...),
  // by peripheral and feature, with a count.
  const notSimulated = new Map<
    string,
    { periph: string; feature: string; count: number }
  >();
  if (inspect) {
    engine.events.subscribe((e) => {
      if (e.kind === "net") return;
      if (e.kind === "i2c") return void i2c.push(e);
      if (e.kind === "unsimulated") {
        const key = `${e.periph}.${e.feature}`;
        const n = notSimulated.get(key);
        if (n) n.count++;
        else
          notSimulated.set(key, {
            periph: e.periph,
            feature: e.feature,
            count: 1,
          });
        return;
      }
      if (e.kind !== "reg") return;
      touched.add(e.periph);
      if (!e.flags.includes("unsimulated")) return;
      const reg = e.reg || hex(e.address); // the SCS has no register names
      const key = `${e.periph}.${reg}`;
      let u = unsimulated.get(key);
      if (!u)
        unsimulated.set(
          key,
          (u = { periph: e.periph, reg, reads: 0, writes: 0 }),
        );
      u[e.op === "read" ? "reads" : "writes"]++;
    });
  }

  engine.runFor(seconds);
  const s = engine.snapshot();
  const chip = chips[circuit.chip];
  const fault = s.fault && {
    ...s.fault,
    pc: hex(s.fault.pc),
    at: relAt(s.fault.at),
  };
  const at = relAt(s.at);
  const diagnostics = diagnosed().map((d) => ({
    ...d,
    pc: d.pc === null ? null : hex(d.pc),
    at: d.at === null ? null : relAt(d.at),
  }));
  const status =
    s.halt?.kind === "lockup"
      ? "lockup"
      : fault
        ? "hardfault"
        : (s.halt?.kind ?? "completed");
  const message =
    status === "lockup"
      ? `lockup: ${s.halt!.reason} (at ${at})`
      : fault
        ? `HardFault: ${fault.reason} at ${fault.at}`
        : s.halt
          ? `breakpoint: ${s.halt.reason} at ${at}`
          : "completed";

  const result = {
    version: 1,
    command,
    elf: rel(elfPath),
    circuit: circuitPath === undefined ? null : rel(circuitPath),
    status,
    message,
    seconds: s.seconds,
    cycles: s.cycles,
    pc: hex(s.pc),
    at,
    halt: s.halt,
    fault,
    pins: s.pins,
    log: s.log,
    diagnostics,
    ...(inspect && {
      clocks: {
        source: SYSCLK_SOURCES[(s.registers.RCC.CFGR >>> 3) & 7],
        ...clocks(s.registers.RCC),
      },
      registers: registers(chip, s),
      i2c,
      unsimulated: [...unsimulated.values()],
      notSimulated: [...notSimulated.values()],
      parts: s.parts,
    }),
  };
  const exit = status === "lockup" || status === "hardfault" ? 1 : 0;
  if (json) {
    print(result);
    return exit;
  }

  // Text: the wired mcu pins (all of them if nothing is wired), and the
  // registers of the peripherals the firmware touched or that are simulated.
  const wired = new Set(
    circuit.wires
      .flat()
      .flatMap((e) => (e.startsWith("mcu.") ? [e.slice(4)] : [])),
  );
  const pins = Object.entries(s.pins).filter(
    ([p]) => !wired.size || wired.has(p),
  );
  const out = [
    `status  ${message}`,
    `time    ${s.seconds.toFixed(6)} s (${s.cycles} cycles)`,
    `pc      ${at} (${hex(s.pc)})`,
    ...chunk(
      pins.map(([p, l]) => `${p}=${l}`),
      6,
    ).map((line, i) => `${i ? "       " : "pins   "} ${line.join(" ")}`),
    ...s.log.map((m) => `log     ${m}`),
    `diagnostics${diagnostics.length ? "" : "  (none)"}`,
    ...diagnostics.map(
      (d) =>
        `  ${d.at ?? `cycle ${d.cycle}`}: ${d.severity}: ${d.message} [${d.rule}]` +
        (d.count > 1 ? ` (${d.count} times)` : ""),
    ),
  ];
  if (inspect) {
    const c = result.clocks!;
    out.push(
      `clocks  SYSCLK ${mhz(c.sysclk)} from ${c.source}, HCLK ${mhz(c.hclk)}, PCLK ${mhz(c.pclk)}`,
    );
    const shown = new Set([...touched, ...chip.peripherals.map((p) => p.name)]);
    out.push("registers");
    for (const [periph, regs] of Object.entries(result.registers!)) {
      if (!shown.has(periph)) continue;
      out.push(`  ${periph}`);
      for (const [reg, { value, fields }] of Object.entries(regs)) {
        const bits = Object.entries(fields).map(([f, v]) => `${f}=${v}`);
        out.push(`    ${reg.padEnd(10)} ${value}  ${bits.join(" ")}`);
      }
    }
    out.push(
      `i2c${i2c.length ? "" : "          (none)"}`,
      ...i2c.map(
        (e) => `  ${engine.secondsAt(e.cycle).toFixed(6)} s  ${i2cText(e.step)}`,
      ),
      `unsimulated${unsimulated.size || notSimulated.size ? "" : "  (none)"}`,
      ...[...unsimulated.values()].map(
        (u) => `  ${u.periph}.${u.reg}  ${u.reads} reads, ${u.writes} writes`,
      ),
      ...[...notSimulated.values()].map(
        (n) => `  ${n.periph} ${n.feature} isn't simulated (${n.count}×)`,
      ),
      `parts${Object.keys(s.parts).length ? "" : "        (none)"}`,
      ...Object.entries(s.parts).map(
        ([id, st]) => `  ${id}  ${JSON.stringify(st)}`,
      ),
    );
  }
  console.log(out.join("\n"));
  return exit;
}

/**
 * `sim ui`: checks the input as `run` does (exit 2 if bad), then serves the UI
 * until stopped. The page reads the ELF and circuit files on each load.
 */
function ui(
  elfPath: string,
  circuitPath: string | undefined,
  portText: string,
  open: boolean,
): number {
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) {
    throw new InputError(
      `--port: expected 0 to 65535, got "${portText}"`,
      true,
    );
  }
  const { elf, circuit } = readInput(elfPath, circuitPath);
  input(elfPath, () => new Engine().load(elf, circuit));
  // Imported here, not above: loading it costs `run` and `inspect` 60 ms.
  import("../ui/server.ts")
    .then(({ serveUi }) =>
      serveUi(port, {
        elf: () => readFileSync(elfPath),
        circuit: () =>
          circuitPath
            ? readFileSync(circuitPath, "utf8")
            : serializeCircuit(circuit),
        // The page's Save writes this file and no other (T31).
        save: circuitPath
          ? (text) => writeFileSync(circuitPath, text)
          : undefined,
        onElfChange: (fn) => watchStable(elfPath, fn), // T33
      }),
    )
    .then(
      (url) => {
        if (json) print({ version: 1, command: "ui", url });
        else console.log(`sim ui: serving ${url} (Ctrl-C to stop)`);
        if (open) {
          const opener = { darwin: "open", win32: "explorer" }[
            process.platform as string
          ];
          spawn(opener ?? "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
      },
      (e: NodeJS.ErrnoException) =>
        fail(
          e.code === "EADDRINUSE"
            ? new InputError(
                `--port: ${port} is in use (--port 0 picks a free one)`,
              )
            : e,
        ),
    );
  return 0;
}

// ---- T33: sim watch ----

/**
 * `sim watch`: runs as `run` does, then again each time the ELF is rebuilt,
 * until Ctrl-C (exit 0). Bad input on the first run exits 2, as `run` does.
 * After that, an error (a broken ELF) is printed and it keeps watching.
 */
function watch(argv: string[], elfPath: string): number {
  let n = 0;
  const once = () => {
    const time = new Date().toTimeString().slice(0, 8);
    if (!json)
      console.log(
        `${n ? "\n" : ""}--- run ${++n}: ${rel(elfPath)} at ${time} ---`,
      );
    main(argv, true);
  };
  process.once("SIGINT", () => process.exit(0));
  // Watching first, so a rebuild during the first run counts too.
  watchStable(elfPath, () => {
    try {
      once();
    } catch (e) {
      fail(e);
    }
  });
  try {
    once();
  } catch (e) {
    unwatchFile(elfPath); // so it exits, with run's exit code
    throw e;
  }
  if (!json)
    console.log(
      `sim watch: waiting for ${rel(elfPath)} to change (Ctrl-C to stop)`,
    );
  return 0;
}

/**
 * Calls `changed` each time the file at `path` changes, once its size and
 * mtime have stayed the same for 100 ms: a linker may write it in steps.
 * Polls the path, so it also follows a file that is replaced (ld unlinks its
 * output first). A deleted file is ignored until it is back.
 */
function watchStable(path: string, changed: () => void): void {
  let timer: NodeJS.Timeout | undefined;
  watchFile(path, { interval: 50 }, (seen) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Changed again since: watchFile calls back again, and that waits anew.
      const now = statSync(path, { throwIfNoEntry: false });
      if (now?.mtimeMs === seen.mtimeMs && now.size === seen.size) changed();
    }, 100);
  });
}

// ---- end T33 ----

/** The ELF's bytes and the parsed circuit, else the chip alone. Anything thrown reading them is the input's fault: exit 2. */
function readInput(elfPath: string, circuitPath: string | undefined) {
  const elf = input(elfPath, () => readFileSync(elfPath));
  const circuit: Circuit = circuitPath
    ? input(circuitPath, () =>
        parseCircuit(readFileSync(circuitPath, "utf8"), catalog),
      )
    : { chip: Object.keys(chips)[0], parts: [], wires: [] };
  return { elf, circuit };
}

/** "2s", "1.5s", "100ms", "500us" in seconds. */
function duration(text: string | undefined, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|ms|us)$/.exec(text ?? "");
  if (!m) {
    throw new InputError(
      text === undefined
        ? `missing ${flag} <duration>`
        : `${flag}: invalid duration "${text}" (use 2s, 1.5s, 100ms or 500us)`,
      true,
    );
  }
  return Number(m[1]) * { s: 1, ms: 1e-3, us: 1e-6 }[m[2] as "s"];
}

/** "<part>.<prop>=<value>", the value parsed as the prop's declared type and checked. */
function assignment(text: string, flag: string, circuit: Circuit) {
  const m = /^([^.=]+)\.([^=]+)=(.*)$/s.exec(text);
  if (!m) {
    throw new InputError(
      `${flag}: expected <part>.<prop>=<value>, got "${text}"`,
      true,
    );
  }
  const [, id, name, raw] = m;
  let spec: PropSpec;
  try {
    spec = propSpec(circuit, id, name);
  } catch (e) {
    throw new InputError(`${flag}: ${(e as Error).message}`);
  }
  // Text that isn't the declared type stays a string, for propError to name.
  const n = Number(raw);
  const value =
    spec.type === "number"
      ? raw.trim() && Number.isFinite(n)
        ? n
        : raw
      : spec.type === "boolean"
        ? raw === "true" || (raw === "false" ? false : raw)
        : raw;
  const error = propError(spec, value);
  if (error) throw new InputError(`${flag}: ${id}.${name}: ${error}`);
  return { id, name, value: value as PropValue };
}

/** Runs `f`; anything it throws is invalid input, labelled with `path`. */
function input<T>(path: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    // "ENOENT: no such file or directory, open 'x.elf'" names the path twice.
    const message = (e as Error).message.replace(/, \w+ '.*'$/, "");
    throw new InputError(`${rel(path)}: ${message}`);
  }
}

/** Every register's value, and its named fields decoded, by peripheral. */
function registers(chip: Chip, s: Snapshot) {
  const map = chip.registers.peripherals;
  return Object.fromEntries(
    Object.entries(s.registers).map(([periph, regs]) => [
      periph,
      Object.fromEntries(
        Object.entries(regs).map(([reg, value]) => [
          reg,
          {
            value: hex(value),
            fields: Object.fromEntries(
              Object.entries(map[periph].registers[reg].fields)
                .sort(([, a], [, b]) => a.bitOffset - b.bitOffset)
                .map(([f, { bitOffset, bitWidth }]) => [
                  f,
                  Math.floor(value / 2 ** bitOffset) % 2 ** bitWidth,
                ]),
            ),
          },
        ]),
      ),
    ]),
  );
}

/** A path relative to the current directory. */
function rel(path: string): string {
  return relative(process.cwd(), resolve(path)) || ".";
}

/** An "absolute/file:line" made relative; "function+0x10" and addresses as they are. */
function relAt(at: string): string {
  const m = /^(.+):(\d+)$/.exec(at);
  return m && isAbsolute(m[1]) ? `${rel(m[1])}:${m[2]}` : at;
}

function hex(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, compact ? undefined : 2));
}
