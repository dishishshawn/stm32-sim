import { test } from "node:test";
import assert from "node:assert/strict";
import { Nets } from "../engine/nets.ts";
import { led } from "./led.ts";
import { mountPart } from "./part.ts";

const lit = (nets: Nets) => mountPart(nets, led, "d1").state?.().lit;

test("an LED is lit only when its anode is high and its cathode low", () => {
  const nets = new Nets([
    ["mcu.PA5", "d1.A"],
    ["d1.C", "GND"],
  ]);
  const d1 = mountPart(nets, led, "d1");
  assert.equal(d1.state?.().lit, false, "anode floating");
  nets.drive("mcu.PA5", "high");
  assert.equal(d1.state?.().lit, true);
  nets.drive("mcu.PA5", "low");
  assert.equal(d1.state?.().lit, false, "anode low");

  // Reversed: anode low, cathode high.
  assert.equal(
    lit(
      new Nets([
        ["d1.A", "GND"],
        ["d1.C", "3V3"],
      ]),
    ),
    false,
  );
  // A shorted anode net is undefined, so unlit.
  const short = new Nets([
    ["d1.A", "3V3"],
    ["d1.A", "mcu.PA0"],
    ["d1.C", "GND"],
  ]);
  short.drive("mcu.PA0", "low");
  assert.equal(short.level("d1.A"), "conflict");
  assert.equal(lit(short), false);
});

test("an LED behind a series resistor from a push-pull pin lights", () => {
  const nets = new Nets([["d1.C", "GND"]]);
  nets.addResistor("mcu.PA5", "d1.A");
  const d1 = mountPart(nets, led, "d1");
  nets.drive("mcu.PA5", "high");
  assert.equal(d1.state?.().lit, true); // a weak high still resolves to "high"
  nets.drive("mcu.PA5", "hi-z");
  assert.equal(d1.state?.().lit, false);
});
