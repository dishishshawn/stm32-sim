import { test } from "node:test";
import assert from "node:assert/strict";
import { Nets } from "../engine/nets.ts";
import { mountPart } from "./part.ts";
import { pushbutton } from "./pushbutton.ts";
import { resistor } from "./resistor.ts";

test("a button to GND pulls a pulled-up net low while pressed, and releases it", () => {
  // PA1 has a 10k pull-up to 3V3; the button joins it to GND through the
  // opposite corners, so the always-joined pairs are in the path too.
  const nets = new Nets([
    ["mcu.PA1", "r1.1"],
    ["r1.2", "3V3"],
    ["mcu.PA1", "btn.1.l"],
    ["btn.2.r", "GND"],
  ]);
  mountPart(nets, resistor, "r1");
  const btn = mountPart(nets, pushbutton, "btn");
  assert.equal(nets.level("mcu.PA1"), "high");
  btn.setProp?.("pressed", true);
  assert.equal(nets.level("mcu.PA1"), "low");
  btn.setProp?.("pressed", false);
  assert.equal(nets.level("mcu.PA1"), "high");
});

test("1.l-1.r and 2.l-2.r are always joined; the sides join only while pressed", () => {
  const nets = new Nets();
  const btn = mountPart(nets, pushbutton, "btn");
  nets.drive("btn.1.l", "high");
  nets.drive("btn.2.l", "low");
  assert.equal(nets.level("btn.1.r"), "high");
  assert.equal(nets.level("btn.2.r"), "low");
  btn.setProp?.("pressed", true);
  assert.equal(nets.level("btn.1.r"), "conflict");

  const held = new Nets([["btn.2.r", "GND"]]);
  mountPart(held, pushbutton, "btn", { pressed: true });
  assert.equal(held.level("btn.1.l"), "low");
});
