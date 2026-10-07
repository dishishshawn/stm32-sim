// The breadboard from the keyboard, and moving it (T44): its 400 holes are one
// tab stop with the arrow keys between them; the arrow keys seat a part in
// its holes as a drop does; and moving it carries the parts plugged into it,
// with no restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { note, open, save, until, write } from "./harness.ts";

/** breadboard1 at (0, 96): hole a10 is at (105.6, 139.2), a9 at (96, 139.2). */
const BOARD = {
  id: "breadboard1",
  type: "breadboard",
  props: {},
  pos: { x: 0, y: 96 },
};
/** PA0 to the strip of a10 (the LED's anode); a9's strip to the − rail, and the rail to GND. */
const JUMPERS = [
  ["mcu.PA0", "breadboard1.e10"],
  ["breadboard1.e9", "breadboard1.tn3"],
  ["breadboard1.tn20", "GND"],
];
const PLUGS = [
  ["led1.A", "breadboard1.a10"],
  ["led1.C", "breadboard1.a9"],
];

const focused = (page: Page) =>
  page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    return e.title.startsWith("breadboard1 hole")
      ? e.title
      : `${e.dataset.part}`;
  });

const lit = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector<HTMLElement & { value: boolean }>("wokwi-led")!
        .value,
  );

async function blinks(page: Page) {
  await until(() => lit(page), true, "the LED on");
  await until(() => lit(page), false, "the LED off");
}

test("a breadboard's holes are one tab stop: the arrow keys, Home, End, PageUp and PageDown move between them, and Enter wires", async (t) => {
  const file = write(t, {
    chip: "stm32g031k8",
    parts: [
      BOARD,
      { id: "led1", type: "led", props: {}, pos: { x: 345.6, y: 96 } },
    ],
    wires: [],
  });
  const { page, problems } = await open(t, "blink", file);
  const stops = () =>
    page.$$eval(
      '[data-part="breadboard1"] .pin-target',
      (holes) => holes.filter((h) => (h as HTMLElement).tabIndex === 0).length,
    );
  assert.equal(await stops(), 1);

  await page.locator('[data-part="breadboard1"]').focus();
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "breadboard1 hole a1");
  const moves: [string, string][] = [
    ["ArrowRight", "a2"],
    ["ArrowDown", "b2"],
    ["End", "b30"],
    ["PageUp", "tn25"],
    ["Home", "tn1"],
    ["PageDown", "bn1"],
    ["ArrowUp", "bp1"],
    ["ArrowLeft", "bp1"], // the rail starts at column 2
  ];
  for (const [key, hole] of moves) {
    await page.keyboard.press(key);
    assert.equal(await focused(page), `breadboard1 hole ${hole}`, key);
  }
  // One Tab leaves the breadboard; Shift+Tab comes back to the same hole.
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "led1");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(page), "breadboard1 hole bp1");
  assert.equal(await stops(), 1);

  // Enter on a hole starts a wire, Enter on another ends it.
  await page.keyboard.press("Enter");
  assert.equal(
    await note(page),
    "wiring from breadboard1.bp1: pick the other pin, or Escape",
  );
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await until(
    () => note(page),
    "wired breadboard1.bp1 to breadboard1.j2: simulation restarted",
    "the header after wiring from the keyboard",
  );
  assert.equal(await focused(page), "breadboard1 hole j2");
  assert.equal(await stops(), 1);
  assert.deepEqual(problems, []);
});

test("the arrow keys seat an LED in the breadboard as a drop does: plugged in, it blinks through a strip and a rail", async (t) => {
  // The LED's anode is 3.8 × 10.8 px from a10: not plugged, nor near enough to seat.
  const file = write(t, {
    chip: "stm32g031k8",
    parts: [
      BOARD,
      { id: "led1", type: "led", props: {}, pos: { x: 76.8, y: 86.4 } },
    ],
    wires: JUMPERS,
  });
  const { page, problems } = await open(t, "blink", file);
  await page.locator('[data-part="led1"]').focus();
  // One grid step down, to (76.8, 96), then seated: the anode in a10.
  await page.keyboard.press("ArrowDown");
  await until(
    () => note(page),
    "moved led1 (2 in, 0 out): simulation restarted",
    "the header after the arrow key",
  );
  await blinks(page);
  const saved = await save(page, file);
  assert.deepEqual(saved.parts[1].pos, { x: 80.6, y: 97.2 });
  assert.deepEqual(saved.wires, [...JUMPERS, ...PLUGS]);
  assert.deepEqual(problems, []);
});

test("dragging a breadboard, or the arrow keys, carries the LED plugged into it: still plugged, it blinks on with no restart", async (t) => {
  const file = write(t, {
    chip: "stm32g031k8",
    parts: [
      BOARD,
      { id: "led1", type: "led", props: {}, pos: { x: 80.6, y: 97.2 } },
    ],
    wires: [...PLUGS, ...JUMPERS],
  });
  const { page, problems } = await open(t, "blink", file);
  await blinks(page);
  const time = () => page.textContent("#time").then(Number);
  const before = await time();

  // Held by its centre channel at (250, 192), clear of holes, the LED and
  // wires; 144 × 72 screen px is 96 × 48 CSS px at zoom 1.5.
  const box = (await page.locator("#circuit").boundingBox())!;
  const from = { x: box.x + 250 * 1.5, y: box.y + 192 * 1.5 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 144, from.y + 72, { steps: 5 });
  await page.mouse.up();
  const pos = () =>
    page.$$eval("#circuit figure[data-type]", (figs) =>
      figs.map((f) => `${f.style.left} ${f.style.top}`),
    );
  assert.deepEqual(await pos(), ["96px 144px", "176.6px 145.2px"]);
  await page.locator('[data-part="breadboard1"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await pos(), ["105.6px 144px", "186.2px 145.2px"]);

  // No restart: nothing in the header, and the simulated time went on.
  assert.equal(await note(page), "");
  assert.ok((await time()) >= before);
  await blinks(page);
  const saved = await save(page, file);
  assert.deepEqual(saved.wires, [...PLUGS, ...JUMPERS]);
  assert.deepEqual(problems, []);
});
