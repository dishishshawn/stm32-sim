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

test("a bad duration exits 2", () => {
  const r = sim("run", elf("blink"), "--for", "2 seconds");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--for: invalid duration/);
});
