// Editing in the browser (T31): add parts from the palette, move them, remove
// them, and save the circuit back to its file. Each test edits a copy of the
// thermometer circuit, so Save never touches the repo's.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { digits, ends, open, root, until } from "./harness.ts";

const THERMOMETER = join(root, "firmware/thermometer/circuit.json");

/** The thermometer circuit in a temp file, dated 1970 so a write shows. */
function copy(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "sim-edit-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "circuit.json");
  copyFileSync(THERMOMETER, file);
  utimesSync(file, 0, 0);
  return file;
}

/** Each part's drawn top-left corner, by id. */
const layout = (page: Page) =>
  page.$$eval("#circuit figure", (figs) =>
    Object.fromEntries(
      figs.map((f) => [f.dataset.part, `${f.style.left} ${f.style.top}`]),
    ),
  );

const note = (page: Page) => page.textContent("#edit");

async function save(page: Page) {
  await page.click("#save");
  await until(() => note(page), "saved", "the header after Save");
}

test("the palette adds a part, by click or by dragging it onto the canvas; Delete removes one with its wires", async (t) => {
  const file = copy(t);
  const { page, problems } = await open(t, "thermometer", file);
  await until(() => digits(page), "22", "the digits at 22 °C");

  await page.getByRole("button", { name: "led", exact: true }).click();
  await page.waitForSelector('[data-part="led1"] wokwi-led');
  assert.equal(await note(page), "added led1: simulation restarted");
  const focused = () =>
    page.evaluate(() => (document.activeElement as HTMLElement).dataset.part);
  assert.equal(await focused(), "led1");
  // A fresh engine on the new circuit runs the firmware from reset.
  await until(() => digits(page), "22", "the digits after the restart");
  await page.getByRole("button", { name: "tc74", exact: true }).click();
  await page.waitForSelector('[data-part="tc74_1"] svg');

  // Dropped 480 × 300 screen px into the canvas: 320 × 200 CSS px at zoom
  // 1.5, snapped to 316.8 × 201.6. 7segment's ids start with a letter.
  await page
    .getByRole("button", { name: "7segment" })
    .dragTo(page.locator("#circuit"), { targetPosition: { x: 480, y: 300 } });
  await page.waitForSelector('[data-part="segment1"] wokwi-7segment');
  assert.equal((await layout(page)).segment1, "316.8px 201.6px");

  // Escape keeps it; Remove takes it and its two wires.
  await page.locator('[data-part="btn"]').focus();
  await page.keyboard.press("Delete");
  assert.equal(
    await page.textContent("#confirm p"),
    "Remove btn and its 2 wires? There is no undo.",
  );
  await page.keyboard.press("Escape");
  assert.ok(await page.$('[data-part="btn"]'));
  await page.locator('[data-part="btn"]').focus();
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "Remove" }).click();
  await page.waitForSelector('[data-part="btn"]', { state: "detached" });
  assert.equal(await note(page), "removed btn: simulation restarted");

  await save(page);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(
    saved.parts.map((p: { id: string }) => p.id),
    [
      ...["temp", "io", "tens", "units", "r_scl", "r_sda"],
      ...["led1", "tc74_1", "segment1"],
    ],
  );
  assert.deepEqual(saved.parts[6], {
    id: "led1",
    type: "led",
    props: {},
    pos: { x: 480, y: 201.6 },
  });
  assert.ok(!JSON.stringify(saved.wires).includes('"btn.'));
  assert.equal(saved.wires.length, 32);
  assert.equal(await page.textContent("#run"), "running");
  assert.deepEqual(problems, []);
});

test("dragging and the arrow keys move a part on the 0.1 in grid; Save writes pos for those only, and a reload shows the same layout", async (t) => {
  const file = copy(t);
  const { page, problems } = await open(t, "thermometer", file);
  const before = await layout(page);
  // T30's grid: io in cell 1, temp in cell 0, below the board.
  assert.equal(before.io, "160px 94.08px");
  assert.equal(before.temp, "0px 94.08px");

  // 144 × 72 screen px is 96 × 48 CSS px at zoom 1.5: io goes from (160,
  // 94.08) to (256, 142.08), snapped to (259.2, 144). Held by its middle:
  // its edges are pins (T32).
  const box = (await page.locator('[data-part="io"]').boundingBox())!;
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 144, mid.y + 72, { steps: 5 });
  await page.mouse.up();
  // One grid step per arrow key, from the grid.
  await page.locator('[data-part="temp"]').focus();
  for (const key of ["ArrowRight", "ArrowRight", "ArrowDown"])
    await page.keyboard.press(key);
  const moved = await layout(page);
  assert.deepEqual(moved, {
    ...before,
    io: "259.2px 144px",
    temp: "19.2px 105.6px",
  });

  await save(page);
  const text = readFileSync(file, "utf8");
  const pos = JSON.parse(text).parts.map((p: { pos?: unknown }) => p.pos);
  assert.deepEqual(pos, [
    { x: 19.2, y: 105.6 },
    { x: 259.2, y: 144 },
    ...Array(5).fill(undefined),
  ]);
  assert.ok(text.includes('"pos": { "x": 259.2, "y": 144 }'), text);

  await page.reload();
  await page.waitForFunction(
    () => document.getElementById("run")!.textContent === "running",
  );
  assert.deepEqual(await layout(page), moved);
  assert.deepEqual(problems, []);
});

test("Save on an unchanged circuit writes it byte for byte", async (t) => {
  const file = copy(t);
  const { page, problems } = await open(t, "thermometer", file);
  await save(page);
  assert.ok(statSync(file).mtimeMs > 0, "Save wrote the file");
  assert.equal(readFileSync(file, "utf8"), readFileSync(THERMOMETER, "utf8"));
  assert.deepEqual(problems, []);
});

test("an add whose restart can't load the ELF changes nothing, so Save writes the file unchanged", async (t) => {
  const file = copy(t);
  // A copy of the firmware in build/, broken once the page has loaded.
  const elf = `t31-${process.pid}`;
  const path = join(root, `build/${elf}.elf`);
  copyFileSync(join(root, "build/thermometer.elf"), path);
  t.after(() => rmSync(path));
  const { page, problems } = await open(t, elf, file);
  writeFileSync(path, "not an ELF");
  await page.getByRole("button", { name: "led", exact: true }).click();
  await until(
    async () => (await note(page))!.startsWith("error: "),
    true,
    "the header after the failed restart",
  );
  assert.equal(await page.$('[data-part="led1"]'), null);
  await save(page);
  assert.equal(readFileSync(file, "utf8"), readFileSync(THERMOMETER, "utf8"));
  assert.equal(await page.textContent("#run"), "running");
  assert.deepEqual(problems, []);
});

test("the save route refuses a body parseCircuit rejects, and a PUT from anywhere but the page, writing nothing", async (t) => {
  const file = copy(t);
  const { page } = await open(t, "thermometer", file);
  const bad = [
    "{",
    "",
    '{"chip":"stm32g031k8","parts":[{"id":"x","type":"nope","props":{}}],"wires":[]}',
    '{"chip":"stm32g031k8","parts":[],"wires":[["nope.1","GND"]]}',
  ];
  const replies = await page.evaluate(
    (bodies) =>
      Promise.all(
        bodies.map(async (body) => {
          const r = await fetch("/circuit", { method: "PUT", body });
          return `${r.status} ${await r.text()}`;
        }),
      ),
    bad,
  );
  assert.deepEqual(replies, [
    "400 circuit: invalid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    "400 circuit: invalid JSON: Unexpected end of JSON input",
    '400 parts[0].type: unknown part type "nope"',
    '400 wires[0][0]: unknown part "nope"',
  ]);
  // From outside the page: no Origin, or another site's.
  const valid = readFileSync(file, "utf8");
  const origins: Record<string, string>[] = [
    {},
    { Origin: "http://evil.example" },
  ];
  for (const headers of origins) {
    const r = await fetch(`${page.url()}circuit`, {
      method: "PUT",
      headers,
      body: valid,
    });
    assert.equal(r.status, 403);
  }
  assert.equal(statSync(file).mtimeMs, 0, "nothing wrote the file");
  assert.equal(readFileSync(file, "utf8"), readFileSync(THERMOMETER, "utf8"));
});

test("dragging and the arrow keys move the board, and the wires to its pins follow; Save writes boardPos, and a reload shows the same layout", async (t) => {
  const file = copy(t);
  const { page, problems } = await open(t, "thermometer", file);
  const before = await layout(page);
  assert.equal(before.mcu, "0px 0px");
  const wire = await ends(page, 0); // mcu.PB6 to temp.SCLK
  assert.deepEqual(wire.line, wire.pins);

  // 144 × 72 screen px is 96 × 48 CSS px at zoom 1.5, then one grid step
  // right. Held by its middle: its edges are pins.
  const box = (await page
    .locator('[data-part="mcu"] svg')
    .first()
    .boundingBox())!;
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 144, mid.y + 72, { steps: 5 });
  await page.mouse.up();
  await page.locator('[data-part="mcu"]').focus();
  await page.keyboard.press("ArrowRight");
  const moved = await layout(page);
  assert.deepEqual(moved, { ...before, mcu: "105.6px 48px" });

  // The board's end of the wire moved with it; the TC74's stayed.
  const after = await ends(page, 0);
  assert.deepEqual(after.line, after.pins);
  assert.deepEqual(
    after.line.map((v, i) => Math.round((v - wire.line[i]) * 10) / 10),
    [105.6, 48, 0, 0],
  );

  await save(page);
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes('"boardPos": { "x": 105.6, "y": 48 },'), text);
  assert.ok(!text.includes('"pos"'), "no part moved");

  await page.reload();
  await page.waitForFunction(
    () => document.getElementById("run")!.textContent === "running",
  );
  assert.deepEqual(await layout(page), moved);
  assert.deepEqual(await ends(page, 0), after);
  assert.deepEqual(problems, []);
});
