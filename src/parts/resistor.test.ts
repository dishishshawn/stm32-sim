import { test } from "node:test";
import assert from "node:assert/strict";
import { Nets } from "../engine/nets.ts";
import { mountPart } from "./part.ts";
import { resistor } from "./resistor.ts";

test("a resistor to 3V3 pulls an undriven net high, and an open-drain low wins", () => {
  const nets = new Nets([
    ["mcu.PA0", "r1.1"],
    ["r1.2", "3V3"],
  ]);
  assert.equal(nets.level("mcu.PA0"), "floating");
  mountPart(nets, resistor, "r1");
  assert.equal(nets.level("mcu.PA0"), "high");
  nets.drive("mcu.PA0", "low"); // open-drain pulls low
  assert.equal(nets.level("mcu.PA0"), "low");
  nets.drive("mcu.PA0", "hi-z"); // open-drain releases
  assert.equal(nets.level("mcu.PA0"), "high");
});
