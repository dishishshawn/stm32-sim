import { test } from "node:test";
import assert from "node:assert/strict";
import type { Drive, Level } from "./nets.ts";
import { Nets } from "./nets.ts";

test("one net: drives resolve to a level", () => {
  const table: [Drive[], Level][] = [
    [[], "floating"],
    [["hi-z", "hi-z"], "floating"],
    [["high", "hi-z"], "high"],
    [["low", "hi-z"], "low"],
    [["high", "low"], "conflict"], // push-pull high against push-pull low: a short
    [["high", "high"], "high"],
    [["low", "pull-up"], "low"], // open-drain low beats a pull-up
    [["high", "pull-down"], "high"],
    [["hi-z", "pull-up"], "high"],
    [["hi-z", "pull-down"], "low"],
    [["pull-up", "pull-up"], "high"],
    [["pull-up", "pull-down"], "conflict"], // assumed: see resolveNet()
  ];
  for (const [drives, expected] of table) {
    const nets = new Nets([
      ["a.P", "b.P"],
      ["b.P", "c.P"],
    ]);
    drives.forEach((d, i) => nets.drive(`${"abc"[i]}.P`, d));
    assert.equal(nets.level("c.P"), expected, `drives ${drives.join(", ")}`);
  }
});

test("open-drain outputs with a pull-up are wired-AND", () => {
  const nets = new Nets([
    ["a.SDA", "b.SDA"],
    ["b.SDA", "mcu.PB7"],
  ]);
  nets.drive("mcu.PB7", "pull-up");
  // a released (hi-z) is a 1, a pulling low is a 0; the net is a AND b.
  const od = (bit: number): Drive => (bit ? "hi-z" : "low");
  for (const [a, b, expected] of [
    [0, 0, "low"],
    [0, 1, "low"],
    [1, 0, "low"],
    [1, 1, "high"],
  ] as const) {
    nets.drive("a.SDA", od(a));
    nets.drive("b.SDA", od(b));
    assert.equal(nets.level("mcu.PB7"), expected, `a=${a} b=${b}`);
  }
});

test("an undriven or unknown endpoint is floating", () => {
  const nets = new Nets([["a.X", "b.X"]]);
  assert.equal(nets.level("a.X"), "floating");
  assert.equal(nets.level("nobody.Y"), "floating");
});

test("rails are strong, and shorting them is a conflict", () => {
  const nets = new Nets([["a.P", "3V3"]]);
  assert.equal(nets.level("3V3"), "high");
  assert.equal(nets.level("GND"), "low");
  assert.equal(nets.level("a.P"), "high");
  nets.drive("a.P", "low");
  assert.equal(nets.level("3V3"), "conflict");
  assert.equal(new Nets([["3V3", "GND"]]).level("GND"), "conflict");
});

test("a switch joins two nets only while closed", () => {
  const nets = new Nets([["btn.2", "GND"]]);
  nets.drive("mcu.PA0", "pull-up");
  nets.setSwitch("mcu.PA0", "btn.2", false);
  assert.equal(nets.level("mcu.PA0"), "high");
  nets.setSwitch("mcu.PA0", "btn.2", true);
  assert.equal(nets.level("mcu.PA0"), "low");
  nets.setSwitch("mcu.PA0", "btn.2", false);
  assert.equal(nets.level("mcu.PA0"), "high");
  // Closing a switch between two strongly driven nets shorts them.
  nets.drive("mcu.PA0", "high");
  nets.setSwitch("mcu.PA0", "btn.2", true);
  assert.equal(nets.level("mcu.PA0"), "conflict");
});

test("a resistor to 3V3 is a pull-up that an open-drain low still beats", () => {
  const nets = new Nets([
    ["r.1", "3V3"],
    ["r.2", "mcu.PB6"],
  ]);
  nets.addResistor("r.1", "r.2");
  assert.equal(nets.level("mcu.PB6"), "high");
  nets.drive("mcu.PB6", "low");
  assert.equal(nets.level("mcu.PB6"), "low");
  assert.equal(nets.level("3V3"), "high"); // the rail side is untouched
  nets.drive("mcu.PB6", "hi-z");
  assert.equal(nets.level("mcu.PB6"), "high");
});

test("a resistor to GND is a pull-down, and works in either direction", () => {
  const nets = new Nets([
    ["r.1", "mcu.PA1"],
    ["r.2", "GND"],
  ]);
  nets.addResistor("r.1", "r.2");
  assert.equal(nets.level("mcu.PA1"), "low");
});

test("a resistor carries strong levels only: no weak-to-weak chaining", () => {
  const nets = new Nets([
    ["r1.1", "3V3"],
    ["r1.2", "x.P"],
    ["r2.1", "x.P"],
    ["r2.2", "y.P"],
  ]);
  nets.addResistor("r1.1", "r1.2");
  nets.addResistor("r2.1", "r2.2");
  assert.equal(nets.level("x.P"), "high");
  assert.equal(nets.level("y.P"), "floating");
  nets.drive("x.P", "low"); // now strong, so r2 carries it
  assert.equal(nets.level("y.P"), "low");
});

test("listeners hear each endpoint that changed, once", () => {
  const nets = new Nets([["a.P", "b.P"]]);
  const heard: string[] = [];
  nets.listen((e, level) => heard.push(`${e}=${level}`));
  nets.drive("a.P", "high");
  assert.deepEqual(heard.sort(), ["a.P=high", "b.P=high"]);
  heard.length = 0;
  nets.drive("a.P", "high"); // no change
  nets.drive("b.P", "pull-down"); // still high
  assert.deepEqual(heard, []);
});

test("a listener may change drives; nets settle, or fail loudly if they never do", () => {
  const nets = new Nets();
  // An inverter: out = not in.
  nets.listen((e, level) => {
    if (e === "inv.IN")
      nets.drive("inv.OUT", level === "high" ? "low" : "high");
  });
  nets.drive("inv.IN", "high");
  assert.equal(nets.level("inv.OUT"), "low");
  nets.drive("inv.IN", "low");
  assert.equal(nets.level("inv.OUT"), "high");

  // An inverter whose output feeds its own input oscillates forever.
  const ring = new Nets([["osc.OUT", "osc.IN"]]);
  ring.listen((e, level) => {
    if (e === "osc.IN")
      ring.drive("osc.OUT", level === "high" ? "low" : "high");
  });
  assert.throws(() => ring.drive("osc.OUT", "high"), /did not settle/);
});
