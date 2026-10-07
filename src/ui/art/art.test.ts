import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";
import { parts } from "../../parts/index.ts";
import { breadboard } from "./breadboard.ts";
import { dip28 } from "./dip28.ts";
import type { Art } from "./index.ts";
import { partArt } from "./index.ts";
import { nucleo } from "./nucleo-g031k8.ts";
import { tc74 } from "./to220-5.ts";

const arts: Record<string, Art> = {
  nucleo,
  breadboard,
  dip28: dip28("U1"),
  tc74,
  ...partArt,
};

for (const [name, art] of Object.entries(arts)) {
  test(`${name}: well-formed SVG, every pin inside the viewBox, no two pins on one spot`, () => {
    const svg = new DOMParser({
      onError: onWarningStopParsing,
    }).parseFromString(art.svg, "image/svg+xml").documentElement!;
    assert.equal(svg.getAttribute("viewBox"), `0 0 ${art.width} ${art.height}`);
    const seen = new Map<string, string>();
    for (const [pin, { x, y }] of Object.entries(art.pins)) {
      assert.ok(
        x >= 0 && x <= art.width && y >= 0 && y <= art.height,
        `${pin} at ${x},${y}`,
      );
      const other = seen.get(`${x},${y}`);
      assert.equal(other, undefined, `${pin} and ${other} share ${x},${y}`);
      seen.set(`${x},${y}`, pin);
    }
  });
}

test("every pin a registered part declares has a coordinate in its art", () => {
  for (const part of parts) {
    const art = partArt[part.type];
    if (!art) continue; // drawn by @wokwi/elements
    for (const pin of part.pins)
      assert.ok(art.pins[pin], `${part.type} pin ${pin}`);
  }
});

test("dip28: pins 1–28 run counter-clockwise from pin 1 at the bottom left", () => {
  const { pins } = dip28("U1");
  assert.equal(Object.keys(pins).length, 28);
  assert.deepEqual(pins["1"], { x: 10, y: 36 });
  assert.deepEqual(pins["14"], { x: 140, y: 36 });
  assert.deepEqual(pins["15"], { x: 140, y: 4 });
  assert.deepEqual(pins["28"], { x: 10, y: 4 });
  // Every pin gets a coordinate, including NC11/NC14 (wiring to them does nothing).
  assert.deepEqual(partArt.mcp23017.pins.SDA, pins["13"]);
  assert.equal(Object.keys(partArt.mcp23017.pins).length, 28);
});

test("tc74: TO-220 pin order is NC, SDA, GND, SCLK, VDD", () => {
  const order = Object.entries(tc74.pins)
    .sort(([, a], [, b]) => a.x - b.x)
    .map(([pin]) => pin);
  assert.deepEqual(order, ["NC", "SDA", "GND", "SCLK", "VDD"]);
});

test("nucleo: the map covers all 30 header positions exactly once", () => {
  const expected = ["CN3", "CN4"].flatMap((h) =>
    Array.from({ length: 15 }, (_, i) => `${h}.${i + 1}`),
  );
  assert.deepEqual(Object.keys(nucleo.pins).sort(), expected.sort());
  // An MCU pin is on one position only; NRST and GND are on two.
  const signals = Object.values(nucleo.pins).map((p) => p.signal);
  const mcu = signals.filter((s) => /^P[A-F]\d+$/.test(s));
  assert.equal(new Set(mcu).size, mcu.length);
  assert.equal(mcu.length, 22); // D0–D13 and A0–A7
  assert.equal(nucleo.pins["CN3.1"].signal, "PB6"); // I2C1 SCL
  assert.equal(nucleo.pins["CN3.2"].signal, "PB7"); // I2C1 SDA
  assert.equal(nucleo.pins["CN4.14"].signal, "3V3");
  // Each signal's circuit endpoint: an mcu pin or a rail; 5V has none.
  assert.equal(nucleo.pins["CN3.1"].endpoint, "mcu.PB6");
  assert.equal(nucleo.pins["CN4.14"].endpoint, "3V3");
  assert.equal(nucleo.pins["CN3.4"].endpoint, "GND");
  assert.equal(nucleo.pins["CN4.4"].endpoint, undefined);
});

test("breadboard: the hole groups cover every hole exactly once", () => {
  const holes = breadboard.groups.flat();
  assert.equal(holes.length, 400);
  assert.deepEqual([...holes].sort(), Object.keys(breadboard.pins).sort());
  assert.equal(breadboard.groups.length, 64); // 60 strips + 4 rails
  const groupOf = (h: string) =>
    breadboard.groups.findIndex((g) => g.includes(h));
  assert.equal(groupOf("a1"), groupOf("e1"));
  assert.notEqual(groupOf("e1"), groupOf("f1")); // across the channel
  assert.notEqual(groupOf("a1"), groupOf("a2"));
  assert.equal(groupOf("tp1"), groupOf("tp25"));
  // A DIP straddling the channel puts its rows in e and f.
  assert.equal(breadboard.pins.f1.y - breadboard.pins.e1.y, 30);
});
