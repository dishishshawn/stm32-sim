// Shared by the UI tests: one headless Chromium per test file (each file runs
// in its own process under `node --test`), and helpers to start `sim ui`, wait
// for a value and read the 7-segment digits. A missing browser fails every UI
// test with the command that installs it (docs/decisions.md §15).
import { after, before } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

export const root = fileURLToPath(new URL("../../", import.meta.url));

let browser: Browser;
before(async () => {
  try {
    browser = await chromium.launch();
  } catch (e) {
    // Only the first line: Playwright's banner names `npx playwright install`,
    // which installs the browsers of a different package.
    throw new Error(
      "the UI tests need Chromium: run `npx playwright-core install --only-shell chromium`\n" +
        (e as Error).message.split("\n")[0],
    );
  }
});
after(() => browser?.close());

/**
 * `sim ui` on build/<elf>.elf and `circuit`, open in a new page. `problems`
 * collects page errors, console errors and any request to another origin.
 */
export async function open(t: TestContext, elf: string, circuit: string) {
  const path = `build/${elf}.elf`;
  assert.ok(
    existsSync(join(root, path)),
    `${path} is missing: run \`just fw\` first`,
  );
  const sim = spawn(
    process.execPath,
    ["src/cli/sim.ts", "ui", path, "--circuit", circuit, "--port", "0"],
    { cwd: root },
  );
  t.after(() => sim.kill());
  let stderr = "";
  sim.stderr.on("data", (d) => (stderr += d));
  const line = await Promise.race([
    once(createInterface(sim.stdout), "line").then(([l]) => l as string),
    once(sim, "exit").then(() => assert.fail(`sim ui exited: ${stderr}`)),
  ]);
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(line)?.[0];
  assert.ok(url, line);

  const page = await browser.newPage();
  t.after(() => page.close());
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("request", (r) => {
    if (!r.url().startsWith(url)) problems.push(`request to ${r.url()}`);
  });
  await page.goto(url);
  // The page has fetched the firmware and drawn the circuit.
  await page.waitForFunction(
    () => document.getElementById("run")!.textContent !== "loading",
  );
  assert.equal(await page.textContent("#run"), "running");
  return { page, problems };
}

/** Polls `read` until it gives `want`, for up to 10 s of wall time; fails with the last value. */
export async function until<T>(read: () => Promise<T>, want: T, what: string) {
  let got: T | undefined;
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(50)) {
    got = await read();
    if (got === want) return;
  }
  assert.equal(got, want, what);
}

/** The usual 7-segment font, by lit segments: bit 0 is A ... bit 6 G. */
const FONT: Record<number, string> = {
  0x00: " ",
  0x3f: "0",
  0x06: "1",
  0x5b: "2",
  0x4f: "3",
  0x66: "4",
  0x6d: "5",
  0x7d: "6",
  0x07: "7",
  0x7f: "8",
  0x6f: "9",
};

/** What the "tens" and "units" digits show, from their elements' `values`. */
export async function digits(page: Page): Promise<string> {
  const values = await page.evaluate(() =>
    ["tens", "units"].map(
      (id) =>
        document.querySelector<HTMLElement & { values: number[] }>(
          `[data-part="${id}"] wokwi-7segment`,
        )!.values,
    ),
  );
  return values
    .map((v) => FONT[v.reduce((bits, on, i) => bits | (on << i), 0)] ?? "?")
    .join("");
}
