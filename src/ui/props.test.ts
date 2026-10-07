// The Part panel (T43): select a part, and its props are a form; a change
// restarts the simulation and Save writes it. Each test writes its own
// circuit to a temp file, so Save never touches the repo's.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { note, open, save, setProp, until, wire, write } from "./harness.ts";

/** Whether the I2C trace has a row ending in `text`. */
const traced = (page: Page, text: string) =>
  page.$$eval(
    ".i2c-trace li",
    (lis, text) => lis.some((li) => li.textContent!.endsWith(text)),
    text,
  );

test("a TC74 from the palette, set to A0 in the Part panel, answers tc74-read at 0x48; an out-of-range temperature is refused; Save and reload keep A0", async (t) => {
  // tc74-read's pull-ups, without its TC74.
  const file = write(t, {
    chip: "stm32g031k8",
    parts: [
      { id: "r_scl", type: "resistor", props: { ohms: 4700 } },
      { id: "r_sda", type: "resistor", props: { ohms: 4700 } },
    ],
    wires: [
      ["r_scl.1", "mcu.PB6"],
      ["r_scl.2", "3V3"],
      ["r_sda.1", "mcu.PB7"],
      ["r_sda.2", "3V3"],
    ],
  });
  const { page, problems } = await open(t, "tc74-read", file);
  assert.ok(await page.isVisible("text=Click a part to see its props."));
  await page.getByRole("button", { name: "tc74", exact: true }).click();
  await page.waitForSelector('[data-part="tc74_1"]');
  await wire(page, "mcu.PB6", "tc74_1.SCLK");
  await wire(page, "mcu.PB7", "tc74_1.SDA");
  await wire(page, "tc74_1.VDD", "3V3");
  await wire(page, "tc74_1.GND", "GND");

  // Clicked, its props are a form: the variant a select, the temperature a
  // number with the prop's range.
  await page.locator('[data-part="tc74_1"] figcaption').click();
  const form = page.getByRole("group", { name: "tc74_1 (tc74)" });
  const variant = form.getByLabel("variant");
  const temperature = form.getByLabel("temperature");
  assert.equal(await variant.inputValue(), "A5");
  assert.deepEqual(
    await temperature.evaluate((e: HTMLInputElement) => [
      e.min,
      e.max,
      e.value,
    ]),
    ["-65", "150", "25"],
  );
  // A5 is 0x4D: nothing answers the firmware's 0x48.
  await until(() => traced(page, "ADDR 0x48 W  NACK"), true, "a NACK at 0x48");
  await setProp(page, "tc74_1", "variant", "A0");
  await until(() => traced(page, "ADDR 0x48 W  ACK"), true, "an ACK at 0x48");

  // Out of range: refused, with the reason shown, and nothing restarts.
  await temperature.fill("200");
  await temperature.press("Enter");
  assert.equal(
    await page.textContent("#part-error"),
    "temperature: expected -65 to 150, got 200",
  );
  assert.ok(await page.isVisible("#part-error"));
  assert.equal(await temperature.getAttribute("aria-invalid"), "true");
  assert.equal(
    await note(page),
    "set tc74_1.variant to A0: simulation restarted",
  );

  // Saved with only what differs from the defaults; a reload reads it back.
  const saved = await save(page, file);
  assert.deepEqual(saved.parts[2].props, { variant: "A0" });
  await page.reload();
  await page.waitForSelector('[data-part="tc74_1"]');
  await page.locator('[data-part="tc74_1"]').focus();
  assert.equal(await variant.inputValue(), "A0");
  assert.equal(await temperature.inputValue(), "25");
  await until(
    () => traced(page, "ADDR 0x48 W  ACK"),
    true,
    "an ACK after the reload",
  );
  assert.deepEqual(problems, []);
});

test("a 7-segment display from the palette, switched from common cathode to common anode (its common to 3V3), lights the other segments", async (t) => {
  const file = write(t, { chip: "stm32g031k8", parts: [], wires: [] });
  const { page, problems } = await open(t, "blink", file);
  await page.getByRole("button", { name: "7segment" }).click();
  await page.waitForSelector('[data-part="segment1"]');
  await setProp(page, "segment1", "common", "cathode");
  // Each segment on a rail, in the shape of a 2: A B D E G high, C F DP low.
  const high = ["A", "B", "D", "E", "G"];
  for (const s of ["A", "B", "C", "D", "E", "F", "G", "DP"])
    await wire(page, `segment1.${s}`, high.includes(s) ? "3V3" : "GND");
  await wire(page, "segment1.COM.1", "GND");
  const values = () =>
    page.$eval('[data-part="segment1"] wokwi-7segment', (e) =>
      (e as HTMLElement & { values: number[] }).values.join(""),
    );
  await until(values, "11011010", "the cathode display's lit segments");

  // Common anode with its common still on GND: nothing is lit. With its
  // common on 3V3, the segments driven low are.
  await setProp(page, "segment1", "common", "anode");
  await until(values, "00000000", "an anode display with its common low");
  await page.locator('.wire[data-wire="8"]').focus();
  await page.keyboard.press("Delete");
  await until(
    () => note(page),
    "removed the wire segment1.COM.1 to GND: simulation restarted",
    "the header after Delete",
  );
  await wire(page, "segment1.COM.1", "3V3");
  await until(values, "00100101", "the anode display's lit segments");
  // anode is the default, so the file says nothing.
  assert.deepEqual((await save(page, file)).parts[0].props, {});
  assert.deepEqual(problems, []);
});
