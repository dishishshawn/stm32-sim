// T36's run controls and Source panel, headless, through `sim ui` (./harness.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright-core";
import { open, root, until } from "./harness.ts";

const BLINK = join(root, "firmware/blink/main.c");
const blink = readFileSync(BLINK, "utf8").split("\n");

/** The Source panel's "Paused at <file>:<line>, PC 0x…" (or "at _init+0x2, …"), parsed. */
async function where(page: Page) {
  const text = (await page.textContent(".source-at"))!;
  const m = /^(\w+) at (.*?)(?::(\d+))?, PC (0x[0-9a-f]{8})$/.exec(text);
  assert.ok(m, text);
  return { state: m[1], file: m[2], line: Number(m[3] ?? 0), pc: m[4] };
}

const highlighted = (page: Page) =>
  page.textContent(".source li[aria-current]");
const time = async (page: Page) => Number(await page.textContent("#time"));

test("blink: Pause stops time; Step moves the PC, highlighting main.c's line; Resume runs on", async (t) => {
  const { page, problems } = await open(
    t,
    "blink",
    "firmware/blink/circuit.json",
  );
  const pause = page.getByRole("button", { name: "Pause" });
  const step = page.getByRole("button", { name: "Step" });
  assert.equal(await step.isDisabled(), true);
  await pause.click();
  const resume = page.getByRole("button", { name: "Resume" });
  let at = await where(page);
  assert.equal(at.state, "Paused");
  assert.equal(at.file, BLINK);
  await until(() => highlighted(page), blink[at.line - 1], "the line shown");
  const paused = await time(page);
  await sleep(300);
  assert.equal(await time(page), paused, "no time passes while paused");

  for (let i = 0; i < 5; i++) {
    await step.click();
    const next = await where(page);
    assert.notEqual(next.pc, at.pc, `step ${i + 1} moves the PC`);
    assert.equal(next.file, BLINK);
    await until(() => highlighted(page), blink[next.line - 1], "the line");
    at = next;
  }

  await resume.click();
  assert.equal(await step.isDisabled(), true);
  await until(
    async () => (await time(page)) > paused + 0.5,
    true,
    "time runs on",
  );
  assert.equal((await where(page)).state, "Running");
  assert.deepEqual(problems, []);
});

test("blink from reset (#paused): stepping walks the startup code into main.c, line by line", async (t) => {
  const { page, problems } = await open(
    t,
    "blink",
    "firmware/blink/circuit.json",
  );
  await page.goto(`${page.url()}#paused`);
  await page.reload();
  const startup = join(root, "vendor/cmsis-device-g0/startup_stm32g031xx.s");
  await until(
    async () => (await where(page)).file,
    startup,
    "the reset vector",
  );
  const at = await where(page);
  assert.equal(at.state, "Paused");
  const text = readFileSync(startup, "utf8").split("\n")[at.line - 1];
  await until(() => highlighted(page), text, "Reset_Handler's first line");

  // About 90 instructions to main(); then main's first lines, in order.
  await page.getByRole("button", { name: "Step" }).focus();
  const lines: number[] = [];
  for (let i = 0; i < 200 && lines.length < 3; i++) {
    await page.keyboard.press("Enter");
    const { file, line } = await where(page);
    if (file === BLINK && line !== lines.at(-1)) lines.push(line);
  }
  const line = (code: string) => blink.findIndex((l) => l.includes(code)) + 1;
  assert.deepEqual(lines, [
    line("int main(void) {"),
    line("RCC_IOPENR |="),
    line("GPIOA_MODER ="),
  ]);
  await until(() => highlighted(page), blink[lines[2] - 1], "the line shown");
  assert.deepEqual(problems, []);
});

test("the source route serves the ELF's own source files and nothing else", async (t) => {
  const { page } = await open(t, "blink", "firmware/blink/circuit.json");
  const get = (query: string) => fetch(new URL(`/source${query}`, page.url()));
  const file = (path: string) => `?file=${encodeURIComponent(path)}`;

  const ok = await get(file(BLINK));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), blink.join("\n"));
  for (const query of [
    file("/etc/passwd"),
    file("../package.json"),
    file(join(root, "package.json")),
    file(`${root}firmware/blink/../../package.json`),
    file("firmware/blink/main.c"),
    file(""),
    "",
  ]) {
    const r = await get(query);
    assert.equal(r.status, 404, query);
    assert.equal(await r.text(), "not found", query);
  }
});

test("speed: max runs far faster than real time; real time keeps pace again", async (t) => {
  // Firmware that sleeps: the engine can run it far faster than real time, so
  // the two speeds differ however loaded the machine is.
  const { page, problems } = await open(
    t,
    "wfi-fixture",
    "firmware/blink/circuit.json",
  );
  // Simulated seconds per wall second, over 1 s.
  const rate = () =>
    page.evaluate(async () => {
      const now = () => [
        Number(document.getElementById("time")!.textContent),
        performance.now(),
      ];
      const [s0, w0] = now();
      await new Promise((r) => setTimeout(r, 1000));
      const [s1, w1] = now();
      return (s1 - s0) / ((w1 - w0) / 1000);
    });
  const speed = page.getByLabel("Speed");
  assert.equal(await speed.inputValue(), "realtime");
  const real = await rate();
  assert.ok(real > 0.5 && real < 1.1, `real time: ${real}`);
  await speed.selectOption("max");
  const max = await rate();
  assert.ok(max > 3, `max: ${max}`);
  await speed.selectOption("realtime");
  const again = await rate();
  assert.ok(again < 1.1, `real time again: ${again}`);
  assert.deepEqual(problems, []);
});
