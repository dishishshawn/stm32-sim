// Spawns the CLI as a user would, from the repo root, and checks what
// docs/cli.md promises: exit codes, the JSON shape, and paths relative to cwd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SIM = fileURLToPath(new URL("sim.ts", import.meta.url));

function sim(...args: string[]) {
  const r = spawnSync(process.execPath, [SIM, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** build/<name>.elf, relative to the repo root. */
function elf(name: string): string {
  const path = `build/${name}.elf`;
  assert.ok(
    existsSync(join(root, path)),
    `${path} is missing: run \`just fw\` first`,
  );
  return path;
}

/** "firmware/<name>/main.c:<n>" for the line containing `text`. */
function line(name: string, text: string): string {
  const file = `firmware/${name}/main.c`;
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const n = lines.findIndex((l) => l.includes(text)) + 1;
  assert.ok(n > 0, `no line containing ${text}`);
  return `${file}:${n}`;
}

const BLINK = ["--circuit", "firmware/blink/circuit.json"];

test("run on blink completes: exit 0", () => {
  const r = sim("run", elf("blink"), ...BLINK, "--for", "300ms");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^status {2}completed$/m);
  assert.match(r.stdout, /PA0=(low|high)/);
});

test("inspect --json on blink: version, pins, PC as file:line, named bits", () => {
  const r = sim("inspect", elf("blink"), ...BLINK, "--at", "0.2s", "--json");
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.version, 1);
  assert.equal(out.status, "completed");
  assert.ok(["low", "high"].includes(out.pins.PA0));
  assert.match(out.at, /^firmware\/blink\/main\.c:\d+$/);
  // MODER0 = 01: PA0 is an output.
  assert.equal(out.registers.GPIOA.MODER.fields.MODER0, 1);
  assert.equal(out.registers.RCC.IOPENR.fields.IOPAEN, 1);
  assert.deepEqual(out.i2c, []);
  assert.deepEqual(out.diagnostics, []);
  assert.deepEqual(out.unsimulated, []);
});

test("run and inspect report diagnostics, in text and --json", () => {
  const at = line("clock-off", "GPIOB->ODR ^=");
  const r = sim("run", elf("clock-off"), "--for", "300ms");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(
    r.stdout.includes(
      `\n  ${at}: warning: wrote GPIOB->ODR while RCC->IOPENR.IOPBEN (bit 1) = 0`,
    ),
    r.stdout,
  );
  assert.match(r.stdout, /\[gpio-clock-off\] \(3 times\)$/m);

  for (const command of ["run", "inspect"]) {
    const time = command === "run" ? "--for" : "--at";
    const j = sim(command, elf("clock-off"), time, "300ms", "--json");
    const d = JSON.parse(j.stdout).diagnostics.find((d: { message: string }) =>
      d.message.startsWith("wrote GPIOB->ODR"),
    );
    assert.equal(d.rule, "gpio-clock-off");
    assert.equal(d.severity, "warning");
    assert.equal(d.periph, "GPIOB");
    assert.equal(d.reg, "ODR");
    assert.equal(d.count, 3);
    assert.equal(d.at, at);
    assert.match(d.pc, /^0x0800[0-9a-f]{4}$/);
  }
});

test("a bad circuit exits 2, naming the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-"));
  const circuit = join(dir, "circuit.json");
  writeFileSync(
    circuit,
    JSON.stringify({
      chip: "stm32g031k8",
      parts: [{ id: "x", type: "nope", props: {} }],
      wires: [],
    }),
  );
  const r = sim("run", elf("blink"), "--circuit", circuit, "--for", "1ms");
  rmSync(dir, { recursive: true });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /parts\[0\]\.type: unknown part type "nope"/);
});

test("a missing ELF exits 2", () => {
  const r = sim("run", "build/missing.elf", "--for", "1ms");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /build\/missing\.elf/);

  const j = sim("run", "build/missing.elf", "--for", "1ms", "--json");
  assert.equal(j.code, 2);
  assert.equal(JSON.parse(j.stdout).version, 1);
  assert.match(JSON.parse(j.stdout).error, /build\/missing\.elf/);
});

test("a HardFault exits 1 and names the faulting line, without stderr", () => {
  const at = line("hardfault", "__builtin_trap");
  const r = sim("run", elf("hardfault"), "--for", "10ms");
  assert.equal(r.code, 1);
  assert.match(
    r.stdout,
    new RegExp(`^status {2}HardFault: undefined instruction .* at ${at}$`, "m"),
  );
  assert.equal(r.stderr, ""); // the core's log is in the output instead

  const j = JSON.parse(
    sim("run", elf("hardfault"), "--for", "10ms", "--json").stdout,
  );
  assert.equal(j.status, "hardfault");
  assert.equal(j.fault.at, at);
  assert.match(j.log[0], /^HardFault at 0x/);
});

// A TC74, and a button that pulls PA1 to GND while pressed.
const INPUTS = ["--circuit", "src/cli/fixtures/inputs.json"];

test("--set before the run, --at mid-run: a TC74 temperature set at 1 s shows at 2 s", () => {
  const inspect = (at: string) => {
    const r = sim(
      "inspect",
      elf("blink"),
      ...INPUTS,
      "--set",
      "temp.temperature=20",
      "--at",
      "1s:temp.temperature=30",
      "--at",
      at,
      "--json",
    );
    assert.equal(r.code, 0, r.stdout);
    return JSON.parse(r.stdout).parts.temp;
  };
  assert.equal(inspect("0.5s").temperature, 20);
  assert.deepEqual(inspect("2s"), {
    temperature: 30,
    shutdown: false,
    dataReady: true,
  });
});

test("--at <t>:btn.press presses the button at t and releases it 50 ms later", () => {
  const pa1 = (at: string) =>
    JSON.parse(
      sim(
        "inspect",
        elf("blink"),
        ...INPUTS,
        "--at",
        "10ms:btn.press",
        "--at",
        at,
        "--json",
      ).stdout,
    ).pins.PA1;
  assert.equal(pa1("5ms"), "floating");
  assert.equal(pa1("30ms"), "low");
  assert.equal(pa1("70ms"), "floating");
});

test("an unknown part or prop, or a bad value, exits 2 and names what is valid", () => {
  const run = (...args: string[]) =>
    sim("run", elf("blink"), ...INPUTS, "--for", "1ms", ...args);
  let r = run("--at", "1s:temp.temp=30");
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /^sim: --at: tc74 "temp" has no prop "temp" \(props: variant, temperature\)$/m,
  );
  r = run("--set", "nope.temperature=30", "--json");
  assert.equal(r.code, 2);
  assert.equal(
    JSON.parse(r.stdout).error,
    '--set: unknown part "nope" (parts: temp, btn)',
  );
  r = run("--set", "temp.temperature=hot");
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /--set: temp\.temperature: expected a number, got "hot"/,
  );
  r = run("--at", "1s:btn.pressed=yes");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /expected true or false, got "yes"/);
  r = run("--at", "2s");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--at: expected <duration>:<part>\.<prop>=<value>/);
});

test("a bad duration exits 2", () => {
  const r = sim("run", elf("blink"), "--for", "2 seconds");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--for: invalid duration/);
});
