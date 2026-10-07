// `sim watch` as a user runs it, on a copy of an ELF in a temp dir that is
// rebuilt while it watches (docs/cli.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** build/<name>.elf, absolute. */
function elf(name: string): string {
  const path = join(root, `build/${name}.elf`);
  assert.ok(existsSync(path), `${path} is missing: run \`just fw\` first`);
  return path;
}

test(
  "watch --json: a run per rebuild within 1 s, an error for a truncated ELF, exit 0 on Ctrl-C",
  { timeout: 30_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "sim-watch-"));
    t.after(() => rmSync(dir, { recursive: true }));
    const fw = join(dir, "fw.elf");
    copyFileSync(elf("blink"), fw);
    const sim = spawn(
      process.execPath,
      ["src/cli/sim.ts", "watch", fw, "--for", "1ms", "--json"],
      { cwd: root },
    );
    t.after(() => sim.kill());
    const lines = createInterface(sim.stdout)[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value as string);
    /** Writes the ELF, then reads the line that reports it, within 1 s. */
    async function rebuild(write: () => void) {
      write();
      const start = Date.now();
      const out = await next();
      const ms = Date.now() - start;
      t.diagnostic(`reported ${ms} ms after the write`);
      assert.ok(ms < 1000, `${ms} ms`);
      return out;
    }

    const first = await next();
    assert.equal(first.version, 1);
    assert.equal(first.command, "watch");
    assert.equal(first.status, "completed");
    assert.match(first.at, /firmware\/blink\/main\.c:\d+$/);

    const poll = await rebuild(() =>
      copyFileSync(elf("blink-systick-poll"), fw),
    );
    assert.equal(poll.status, "completed");
    assert.match(poll.at, /firmware\/blink-systick-poll\/main\.c:\d+$/);

    const half = readFileSync(elf("blink")).subarray(0, 1000);
    const broken = await rebuild(() => writeFileSync(fw, half));
    assert.equal(broken.version, 1);
    assert.match(broken.error, /fw\.elf: /);

    // Still watching.
    const again = await rebuild(() => copyFileSync(elf("blink"), fw));
    assert.match(again.at, /firmware\/blink\/main\.c:\d+$/);

    sim.kill("SIGINT");
    const [code] = await once(sim, "exit");
    assert.equal(code, 0);
  },
);

test(
  "watch in text: each run under its own header",
  { timeout: 30_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "sim-watch-"));
    t.after(() => rmSync(dir, { recursive: true }));
    const fw = join(dir, "fw.elf");
    copyFileSync(elf("blink"), fw);
    const sim = spawn(
      process.execPath,
      ["src/cli/sim.ts", "watch", fw, "--for", "1ms"],
      { cwd: root },
    );
    t.after(() => sim.kill());
    let out = "";
    sim.stdout.on("data", (d) => (out += d));
    while (!/waiting for .*fw\.elf to change \(Ctrl-C to stop\)\n$/.test(out))
      await once(sim.stdout, "data");
    copyFileSync(elf("blink-systick-poll"), fw);
    while (
      !/--- run 2: .*fw\.elf at \d\d:\d\d:\d\d ---\n[^]*diagnostics/.test(out)
    )
      await once(sim.stdout, "data");
    assert.match(
      out,
      /^--- run 1: .*fw\.elf at \d\d:\d\d:\d\d ---\nstatus {2}completed\n/,
    );
    assert.match(out, /\n\n--- run 2: .*\nstatus {2}completed\n/);
    sim.kill("SIGINT");
    assert.deepEqual(await once(sim, "exit"), [0, null]);
  },
);
