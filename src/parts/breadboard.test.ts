import { test } from "node:test";
import assert from "node:assert/strict";
import { Nets } from "../engine/nets.ts";
import { breadboard } from "./breadboard.ts";
import { led } from "./led.ts";
import { mountPart } from "./part.ts";

test("each 5-hole strip is one net, and so is each rail; nothing else is joined", () => {
  const nets = new Nets([
    ["mcu.PA0", "bb.a1"],
    ["bb.tp1", "3V3"],
  ]);
  mountPart(nets, breadboard, "bb");
  nets.drive("mcu.PA0", "low");
  for (const hole of ["a1", "b1", "c1", "d1", "e1"])
    assert.equal(nets.level(`bb.${hole}`), "low", hole);
  assert.equal(nets.level("bb.f1"), "floating"); // across the channel
  assert.equal(nets.level("bb.a2"), "floating"); // the next strip
  assert.equal(nets.level("bb.tp25"), "high");
  assert.equal(nets.level("bb.tn1"), "floating");
  assert.equal(nets.level("bb.bp1"), "floating"); // the bottom + rail is separate
});

test("a part plugged into a row joins that row's net", () => {
  // The LED's legs in a5 and a6; PA0 on e5, and a6's strip to the − rail and GND.
  const nets = new Nets([
    ["led.A", "bb.a5"],
    ["led.C", "bb.a6"],
    ["mcu.PA0", "bb.e5"],
    ["bb.d6", "bb.tn3"],
    ["bb.tn20", "GND"],
  ]);
  mountPart(nets, breadboard, "bb");
  const light = mountPart(nets, led, "led");
  nets.drive("mcu.PA0", "high");
  assert.equal(light.state?.().lit, true);
  nets.drive("mcu.PA0", "low");
  assert.equal(light.state?.().lit, false);
});
