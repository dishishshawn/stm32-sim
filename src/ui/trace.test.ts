// The I2C trace and diagnostics panels (src/ui/trace.ts, diagnostics.ts),
// headless, checked against what `sim inspect` prints for the same firmware.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Page } from "playwright-core";
import { open, root, until } from "./harness.ts";

/** `sim inspect`'s I2C trace lines ("0.250110 s  ADDR 0x48 W  ACK") at `at`. */
function cliTrace(elf: string, circuit: string, at: string): string[] {
  const out = execFileSync(
    process.execPath,
    [
      "src/cli/sim.ts",
      "inspect",
      `build/${elf}.elf`,
      "--circuit",
      circuit,
      "--at",
      at,
    ],
    { cwd: root, encoding: "utf8" },
  );
  return [...out.matchAll(/^ {2}(\d+\.\d{6} s {2}.+)$/gm)].map((m) => m[1]);
}

/** The trace's transactions, each a list of rows; a NACK row starts with "!". */
const groups = (page: Page) =>
  page.$$eval(".i2c-trace ol", (ols) =>
    ols.map((ol) =>
      [...ol.children].map(
        (li) => (li.className === "nack" ? "!" : "") + li.textContent,
      ),
    ),
  );

const diagnostics = (page: Page) =>
  page.$$eval(".diagnostics li", (lis) => lis.map((li) => li.textContent!));

test("thermometer: the trace shows the TC74's read, as sim inspect does, bounded; no diagnostics", async (t) => {
  const circuit = "firmware/thermometer/circuit.json";
  const { page, problems } = await open(t, "thermometer", circuit);
  // About 400 steps a second: 500 are kept, so this takes 1.3 simulated s,
  // which a loaded machine (the whole suite at once) may take 10 s or more for.
  await page.waitForSelector("text=Earlier steps dropped", { timeout: 60_000 });
  const shown = await groups(page);
  const rows = shown.flat();
  assert.ok(rows.length <= 500, `${rows.length} rows`);
  assert.ok(rows.some((r) => r.endsWith("  ADDR 0x48 W  ACK")));
  assert.ok(rows.some((r) => r.endsWith("  STOP")));
  assert.ok(
    rows.some((r) => /^!.* DATA 0x16 R {2}NACK$/.test(r)),
    "a highlighted NACK",
  );
  // Each transaction from START to STOP; the last one may still be going.
  for (const g of shown.slice(0, -1)) {
    assert.match(g[0], / START$/);
    assert.match(g.at(-1)!, / STOP$/);
  }
  // The same steps at the same times as the CLI, which runs without the panels.
  const plain = rows.map((r) => r.replace(/^!/, ""));
  const last = parseFloat(plain.at(-1)!);
  const cli = cliTrace("thermometer", circuit, `${(last + 0.05).toFixed(3)}s`);
  const i = cli.indexOf(plain[0]);
  assert.ok(i >= 0, plain[0]);
  assert.deepEqual(cli.slice(i, i + plain.length), plain);

  assert.ok(await page.isVisible("text=No problems found"));
  assert.deepEqual(await diagnostics(page), []);
  const cleared = await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Clear")!
      .click();
    return document.querySelectorAll(".i2c-trace li").length;
  });
  assert.equal(cleared, 0);
  assert.deepEqual(problems, []);
});

test("tc74-read without pull-ups: i2c-bus-not-idle, as the CLI words it, and no trace", async (t) => {
  const circuit = "firmware/faults/no-pullups/circuit.json";
  const { page, problems } = await open(t, "tc74-read", circuit);
  await until(
    async () => (await diagnostics(page)).length,
    1,
    "one diagnostic",
  );
  const [d] = await diagnostics(page);
  // The CLI's line, but with the file name only, and the register it names after.
  const cli = execFileSync(
    process.execPath,
    [
      "src/cli/sim.ts",
      "run",
      "build/tc74-read.elf",
      "--circuit",
      circuit,
      "--for",
      "1s",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const line =
    /^ {2}firmware\/tc74-read\/(main\.c:\d+: warning: .* \[i2c-bus-not-idle\])$/m.exec(
      cli,
    );
  assert.ok(line, cli);
  assert.equal(d, `${line[1]}I2C1_CR2`);
  assert.equal(await page.isVisible("text=No problems found"), false);
  // START never goes out, so there's nothing to trace, and a click highlights
  // the diagnostic itself.
  assert.deepEqual(await groups(page), []);
  await page.click(".diagnostics button");
  assert.equal(
    await page.getAttribute(".diagnostics li", "class"),
    "warning diag-target",
  );
  assert.deepEqual(problems, []);
});

test("a NACK diagnostic links to its trace step", async (t) => {
  // The MCP23017's RESET floats, so address 0x20 gets NACK from the start.
  const { page, problems } = await open(
    t,
    "thermometer",
    "firmware/faults/reset-floating/circuit.json",
  );
  await until(
    async () => (await diagnostics(page)).length > 0,
    true,
    "a diagnostic",
  );
  await until(async () => (await groups(page)).length > 0, true, "a trace");
  await page.click(".diagnostics button");
  assert.equal(
    await page.textContent(".i2c-trace .diag-target"),
    "0.000110 s  ADDR 0x20 W  NACK",
  );
  assert.deepEqual(problems, []);
});
