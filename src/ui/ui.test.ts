// The UI end to end, headless: `sim ui` serves the page as a user would start
// it, and Chromium (driven by playwright-core) runs it (docs/decisions.md §15).
// A missing browser fails every test here with the command that installs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { open, until, digits } from "./harness.ts";

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

