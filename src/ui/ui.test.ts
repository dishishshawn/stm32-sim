// The UI end to end, headless: `sim ui` serves the page as a user would start
// it, and Chromium (driven by playwright-core) runs it (docs/decisions.md §15).
// A missing browser fails every test here with the command that installs it.
import { after, before, test } from "node:test";
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

const root = fileURLToPath(new URL("../../", import.meta.url));

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
async function open(t: TestContext, elf: string, circuit: string) {
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
async function until<T>(read: () => Promise<T>, want: T, what: string) {
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
async function digits(page: Page): Promise<string> {
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

test("thermometer: shows 22; a press on the button (Space) shows 71; the slider at 30 shows 86", async (t) => {
  const { page, problems } = await open(
    t,
    "thermometer",
    "firmware/thermometer/circuit.json",
  );
  await until(() => digits(page), "22", "the digits at 22 °C");
  // Held for 200 ms: the firmware looks at the button every 20 ms.
  await page.locator('[data-part="btn"] button').focus();
  await page.keyboard.down("Space");
  await sleep(200);
  await page.keyboard.up("Space");
  await until(() => digits(page), "71", "the digits after one press (°F)");
  await page.locator('[data-part="temp"] input').fill("30");
  await until(() => digits(page), "86", "the digits at 30 °C, in °F");
  assert.equal(await page.textContent("#run"), "running");
  assert.deepEqual(problems, []);
});

test("blink with an LED on PA0: the LED and the board's PA0 pin turn on and off", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sim-ui-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const circuit = join(dir, "circuit.json");
  writeFileSync(
    circuit,
    JSON.stringify({
      chip: "stm32g031k8",
      parts: [{ id: "led", type: "led", props: {} }],
      wires: [
        ["mcu.PA0", "led.A"],
        ["led.C", "GND"],
      ],
    }),
  );
  const { page, problems } = await open(t, "blink", circuit);
  const lit = () =>
    page.evaluate(
      () =>
        document.querySelector<HTMLElement & { value: boolean }>("wokwi-led")!
          .value,
    );
  const pa0 = () => page.getAttribute('.pin[data-pin="PA0"]', "data-level");
  await until(lit, true, "the LED on");
  await until(lit, false, "the LED off");
  await until(pa0, "high", "PA0 on the board high");
  await until(pa0, "low", "PA0 on the board low");
  assert.deepEqual(problems, []);
});
