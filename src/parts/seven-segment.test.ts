import { test } from "node:test";
import assert from "node:assert/strict";
import { Nets } from "../engine/nets.ts";
import { mountPart } from "./part.ts";
import type { PropValue } from "./part.ts";
import { sevenSegment } from "./seven-segment.ts";

// @wokwi/elements order for `values`, written out independently of the part.
const ORDER = ["A", "B", "C", "D", "E", "F", "G", "DP"];

// Segment pins wired to mcu.P0..P7; COM.2 wired to `com` (COM.1 is read by the part,
// so this also checks the two common pins are joined inside it).
function display(com: string | null, props: Record<string, PropValue> = {}) {
  const nets = new Nets([
    ...ORDER.map((s, i) => [`mcu.P${i}`, `sd.${s}`] as const),
    ...(com ? [["sd.COM.2", com] as const] : []),
  ]);
  const sd = mountPart(nets, sevenSegment, "sd", props);
  const values = () => sd.state?.().values;
  return { nets, values };
}

test("common-anode lights a segment when COM is high and the segment pin low", () => {
  const { nets, values } = display("3V3", { common: "anode" });
  nets.drive("mcu.P0", "low"); // A
  nets.drive("mcu.P1", "high"); // B
  assert.deepEqual(values(), [1, 0, 0, 0, 0, 0, 0, 0]);
});

test("common-anode is the default, as on wokwi.com", () => {
  const { nets, values } = display("3V3");
  nets.drive("mcu.P0", "low");
  assert.deepEqual(values(), [1, 0, 0, 0, 0, 0, 0, 0]);
});

test("common-cathode is the reverse", () => {
  const { nets, values } = display("GND", { common: "cathode" });
  nets.drive("mcu.P0", "high"); // A
  nets.drive("mcu.P1", "low"); // B
  assert.deepEqual(values(), [1, 0, 0, 0, 0, 0, 0, 0]);
});

test("a floating pin stays unlit", () => {
  // Segment pins floating, COM driven.
  assert.deepEqual(display("3V3").values(), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    display("GND", { common: "cathode" }).values(),
    [0, 0, 0, 0, 0, 0, 0, 0],
  );
  // COM floating, segment pins driven.
  const { nets, values } = display(null);
  for (let i = 0; i < 8; i++) nets.drive(`mcu.P${i}`, "low");
  assert.deepEqual(values(), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("values are in element order: A–G, then DP", () => {
  const { nets, values } = display("GND", { common: "cathode" });
  ORDER.forEach((_, i) => {
    nets.drive(`mcu.P${i}`, "high");
    assert.deepEqual(
      values(),
      ORDER.map((__, j) => (j === i ? 1 : 0)),
      ORDER[i],
    );
    nets.drive(`mcu.P${i}`, "low");
  });
});
