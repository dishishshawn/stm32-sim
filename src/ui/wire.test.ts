// Wiring in the browser (T32): click a pin, then another; Escape cancels;
// click a wire and Delete removes it; a breadboard joins its strips and
// rails, and a part dropped on it is plugged in. Each test writes its own
// circuit to a temp file, so Save never touches the repo's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { setTimeout as sleep } from "node:timers/promises";
import {
  digits,
  ends,
  note,
  open,
  pin,
  root,
  save,
  setProp,
  until,
  wire,
  write,
} from "./harness.ts";

const lit = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector<HTMLElement & { value: boolean }>("wokwi-led")!
        .value,
  );

test("the thermometer rebuilt in the page, by placing parts, setting their props and wiring every pin, runs as T21's: 22, then 71 after a press", async (t) => {
  // From an empty circuit: every part from the palette, its props (TC74 A0
  // at 22 °C, common-cathode displays, 4.7 kΩ) set in the Part panel, then
  // every wire clicked in.
  const thermometer: {
    parts: { id: string; type: string; props: Record<string, unknown> }[];
    wires: string[][];
  } = JSON.parse(
    readFileSync(join(root, "firmware/thermometer/circuit.json"), "utf8"),
  );
  const file = write(t, { chip: "stm32g031k8", parts: [], wires: [] });
  const { page, problems } = await open(t, "thermometer", file);
  const ids: Record<string, string> = {
    temp: "tc74_1",
    io: "mcp23017_1",
    tens: "segment1",
    units: "segment2",
    btn: "pushbutton1",
    r_scl: "resistor1",
    r_sda: "resistor2",
  };
  for (const { type } of thermometer.parts)
    await page.getByRole("button", { name: type, exact: true }).click();
  for (const id of Object.values(ids))
    await page.waitForSelector(`[data-part="${id}"]`);
  for (const { id, props } of thermometer.parts)
    for (const [name, value] of Object.entries(props))
      await setProp(page, ids[id], name, String(value));
  const rename = (e: string) => e.replace(/^[^.]+/, (id) => ids[id] ?? id);
  const wires = thermometer.wires.map((w) => w.map(rename));
  assert.equal(wires.length, 34);
  for (const [a, b] of wires) await wire(page, a, b);

  const shown = () => digits(page, [ids.tens, ids.units]);
  await until(shown, "22", "the digits at 22 °C");
  // Held for 200 ms: the firmware looks at the button every 20 ms.
  await page
    .locator('[data-part="pushbutton1"] wokwi-pushbutton button')
    .focus();
  await page.keyboard.down("Space");
  await sleep(200);
  await page.keyboard.up("Space");
  await until(shown, "71", "the digits after one press (°F)");

  // Each wire is drawn, coloured by its net: the rails' are low and high.
  const level = (i: number) =>
    page.getAttribute(`.wire[data-wire="${i}"]`, "data-level");
  assert.equal(await level(3), "low"); // temp.GND to GND
  assert.equal(await level(2), "high"); // temp.VDD to 3V3

  // Saved with the thermometer's props, and its wires as pairs in the order
  // drawn: the file's own order.
  const saved: typeof thermometer = await save(page, file);
  assert.deepEqual(
    Object.fromEntries(saved.parts.map((p) => [p.id, p.props])),
    Object.fromEntries(thermometer.parts.map((p) => [ids[p.id], p.props])),
  );
  assert.deepEqual(saved.wires, wires);
  assert.equal(await page.textContent("#run"), "running");
  assert.deepEqual(problems, []);
});

test("wiring: Escape cancels, the keyboard wires too, a wire follows its part, and a clicked wire goes on Delete", async (t) => {
  const file = write(t, {
    chip: "stm32g031k8",
    parts: [{ id: "led", type: "led", props: {}, pos: { x: 288, y: 115.2 } }],
    wires: [],
  });
  const { page, problems } = await open(t, "blink", file);

  // A click starts a wire, with a rubber band to the pointer; Escape ends it.
  await pin(page, "mcu.PA0").click();
  assert.equal(
    await note(page),
    "wiring from mcu.PA0: pick the other pin, or Escape",
  );
  const band = () =>
    page.$eval(".band", (l: SVGPathElement) => ({
      shown: getComputedStyle(l).visibility === "visible",
      x2: Math.round(l.getPointAtLength(l.getTotalLength()).x * 10) / 10,
    }));
  const box = (await page.locator("#circuit").boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 150);
  // 300 screen px is 200 CSS px at zoom 1.5.
  assert.deepEqual(await band(), { shown: true, x2: 200 });
  await page.keyboard.press("Escape");
  assert.equal(await note(page), "wiring cancelled");
  assert.equal((await band()).shown, false);

  // From the keyboard: Enter on a pin, Tab or focus to another, Enter.
  await pin(page, "mcu.PA0").focus();
  await page.keyboard.press("Enter");
  await pin(page, "led.A").focus();
  await page.keyboard.press("Enter");
  await until(
    () => note(page),
    "wired mcu.PA0 to led.A: simulation restarted",
    "the header after wiring from the keyboard",
  );
  await wire(page, "led.C", "GND");
  await pin(page, "GND").click();
  await pin(page, "led.C").click();
  assert.equal(await note(page), "GND and led.C are already wired");

  // The LED blinks, and its wire to PA0 shows the level.
  await until(() => lit(page), true, "the LED on");
  await until(() => lit(page), false, "the LED off");
  const level = (i: number) =>
    page.getAttribute(`.wire[data-wire="${i}"]`, "data-level");
  await until(() => level(0), "high", "the PA0 wire high");
  await until(() => level(0), "low", "the PA0 wire low");
  assert.equal(await level(1), "low");

  // A wire's ends are its pins' centres, and follow a moved part.
  const before = await ends(page, 0);
  assert.deepEqual(before.line, before.pins);
  await page.locator('[data-part="led"]').focus();
  await page.keyboard.press("ArrowRight");
  const after = await ends(page, 0);
  assert.deepEqual(after.line, after.pins);
  assert.equal(after.line[2], before.line[2] + 9.6);

  // A wire sags, so the straight line between its pins is off it, and a click
  // there finds no wire. A click on it selects it (it takes the focus); Delete
  // removes it.
  const at = await page.evaluate(() => {
    const canvas = document.getElementById("circuit")!;
    const z = Number(getComputedStyle(canvas).zoom);
    const c = canvas.getBoundingClientRect();
    const screen = (x: number, y: number) => [c.x + x * z, c.y + y * z];
    const l = document.querySelector<SVGPathElement>(
      '.wire[data-wire="0"] .line',
    )!;
    const n = l.getTotalLength();
    const [a, b, mid] = [0, n, n / 2].map((d) => l.getPointAtLength(d));
    const chord = screen((a.x + b.x) / 2, (a.y + b.y) / 2);
    return {
      chord: !document.elementFromPoint(chord[0], chord[1])?.closest(".wire"),
      on: screen(mid.x, mid.y),
    };
  });
  assert.ok(at.chord, "a wire under the straight line between its pins");
  await page.mouse.click(at.on[0], at.on[1]);
  assert.equal(
    await page.evaluate(
      () => (document.activeElement as HTMLElement).dataset.wire,
    ),
    "0",
  );
  await page.keyboard.press("Delete");
  await until(
    () => note(page),
    "removed the wire mcu.PA0 to led.A: simulation restarted",
    "the header after Delete",
  );
  const saved = await save(page, file);
  assert.deepEqual(saved.wires, [["led.C", "GND"]]);
  assert.deepEqual(problems, []);
});

test("a breadboard: an LED dropped on it is plugged into two strips, wired through a strip and a rail it blinks, and dragged off it is unplugged", async (t) => {
  const file = write(t, { chip: "stm32g031k8", parts: [], wires: [] });
  const { page, problems } = await open(t, "blink", file);
  await page.getByRole("button", { name: "breadboard", exact: true }).click();
  await page.waitForSelector('[data-part="breadboard1"]');

  // breadboard1 is in cell 0, snapped to (0, 96); hole a10 is 105.6 × 43.2 into it.
  // The LED's anode is 25 × 42 into the LED, so the LED goes at (80.6, 97.2):
  // dropped near there, it snaps to the grid, then into the holes.
  await page
    .getByRole("button", { name: "led", exact: true })
    .dragTo(page.locator("#circuit"), {
      targetPosition: { x: 80.6 * 1.5, y: 97.2 * 1.5 },
    });
  await until(
    () => note(page),
    "added led1 (2 in, 0 out): simulation restarted",
    "the header after the drop",
  );
  // PA0 to the anode's strip; the cathode's strip to the − rail, the rail to GND.
  await wire(page, "mcu.PA0", "breadboard1.e10");
  await wire(page, "breadboard1.e9", "breadboard1.tn3");
  await wire(page, "breadboard1.tn20", "GND");
  await until(() => lit(page), true, "the LED on");
  await until(() => lit(page), false, "the LED off");
  const saved = await save(page, file);
  assert.deepEqual(saved.parts[1], {
    id: "led1",
    type: "led",
    props: {},
    pos: { x: 80.6, y: 97.2 },
  });
  assert.deepEqual(saved.wires, [
    ["led1.A", "breadboard1.a10"],
    ["led1.C", "breadboard1.a9"],
    ["mcu.PA0", "breadboard1.e10"],
    ["breadboard1.e9", "breadboard1.tn3"],
    ["breadboard1.tn20", "GND"],
  ]);

  // Dragged off by its middle: the plugs come out, the jumper wires stay.
  const led = (await page
    .locator('[data-part="led1"] wokwi-led')
    .boundingBox())!;
  await page.mouse.move(led.x + led.width / 2, led.y + 15);
  await page.mouse.down();
  await page.mouse.move(led.x + 300, led.y + 400, { steps: 5 });
  await page.mouse.up();
  await until(
    () => note(page),
    "moved led1 (0 in, 2 out): simulation restarted",
    "the header after dragging it off",
  );
  assert.deepEqual((await save(page, file)).wires, saved.wires.slice(2));
  assert.deepEqual(problems, []);
});
