import { test } from "node:test";
import assert from "node:assert/strict";
import { Nets } from "../engine/nets.ts";
import { parts } from "./index.ts";
import { mountPart, propError } from "./part.ts";
import type { Part, PropValue } from "./part.ts";

// A fake part: OUT follows IN inverted, and a "closed" prop joins A and B.
// It logs every level change it hears into `heard`.
const heard: string[] = [];
const fake: Part = {
  type: "fake",
  pins: ["IN", "OUT", "A", "B"],
  props: { closed: { type: "boolean", default: false } },
  create(ctx) {
    ctx.setSwitch("A", "B", ctx.props.closed === true);
    return {
      onLevel(pin, level) {
        heard.push(`${ctx.id} ${pin}=${level}`);
        if (pin === "IN") ctx.drive("OUT", level === "high" ? "low" : "high");
      },
      setProp(name: string, value: PropValue) {
        if (name === "closed") ctx.setSwitch("A", "B", value === true);
      },
    };
  },
};

test("a mounted part drives its pins and hears its own pins change", () => {
  heard.length = 0;
  const nets = new Nets([["mcu.PA0", "inv.IN"]]);
  mountPart(nets, fake, "inv");
  mountPart(nets, fake, "other");
  nets.drive("mcu.PA0", "high");
  assert.equal(nets.level("inv.OUT"), "low");
  nets.drive("mcu.PA0", "low");
  assert.equal(nets.level("inv.OUT"), "high");
  assert.deepEqual(heard, ["inv IN=high", "inv OUT=low", "inv IN=low", "inv OUT=high"]);
});

test("props get defaults, and setProp can close a switch at run time", () => {
  const nets = new Nets([
    ["mcu.PA1", "sw.A"],
    ["sw.B", "GND"],
  ]);
  nets.drive("mcu.PA1", "pull-up");
  const sw = mountPart(nets, fake, "sw"); // closed defaults to false
  assert.equal(nets.level("mcu.PA1"), "high");
  sw.setProp?.("closed", true);
  assert.equal(nets.level("mcu.PA1"), "low");
  sw.setProp?.("closed", false);
  assert.equal(nets.level("mcu.PA1"), "high");

  const preset = new Nets([["s.B", "GND"]]);
  mountPart(preset, fake, "s", { closed: true });
  assert.equal(preset.level("s.A"), "low");
});

test("a part using a pin it didn't declare is a bug, caught at once", () => {
  const bad: Part = {
    ...fake,
    create: (ctx) => (ctx.drive("NOPE", "high"), {}),
  };
  assert.throws(
    () => mountPart(new Nets(), bad, "b"),
    /fake "b" has no pin "NOPE"/,
  );
});

test("propError checks type, range and options", () => {
  assert.equal(propError({ type: "boolean", default: false }, true), undefined);
  assert.equal(
    propError({ type: "boolean", default: false }, "yes"),
    'expected true or false, got "yes"',
  );
  const temp = { type: "number", default: 25, min: -65, max: 125 } as const;
  assert.equal(propError(temp, 22), undefined);
  assert.equal(propError(temp, 200), "expected -65 to 125, got 200");
  assert.equal(propError(temp, "22"), 'expected a number, got "22"');
  const variant = {
    type: "string",
    default: "A5",
    options: ["A0", "A5"],
  } as const;
  assert.equal(propError(variant, "A0"), undefined);
  assert.equal(
    propError(variant, "A9"),
    'expected one of "A0", "A5", got "A9"',
  );
});

test("every registered part has a unique type, unique pins and valid defaults", () => {
  const types = new Set<string>();
  for (const part of parts) {
    assert.ok(!types.has(part.type), `duplicate part type ${part.type}`);
    types.add(part.type);
    assert.equal(
      new Set(part.pins).size,
      part.pins.length,
      `${part.type}: duplicate pin`,
    );
    for (const [name, spec] of Object.entries(part.props)) {
      assert.equal(
        propError(spec, spec.default),
        undefined,
        `${part.type}.${name} default`,
      );
    }
  }
});

test("sameNet tells a part where one of its pins is tied (e.g. an address pin)", () => {
  let ctx: Parameters<Part["create"]>[0] | undefined;
  const addrPart: Part = {
    type: "addr-probe",
    pins: ["ADD0", "SDA", "SCL", "GND"],
    props: {},
    create(c) {
      ctx = c;
      return {};
    },
  };
  const nets = new Nets([
    ["u1.ADD0", "u1.SDA"],
    ["u1.GND", "GND"],
  ]);
  mountPart(nets, addrPart, "u1");
  assert.ok(ctx);
  assert.equal(ctx.sameNet("ADD0", "SDA"), true);
  assert.equal(ctx.sameNet("ADD0", "SCL"), false);
  assert.equal(ctx.sameNet("ADD0", "GND"), false);
  // A switch closing between two pins counts too.
  ctx.setSwitch("ADD0", "SCL", true);
  assert.equal(ctx.sameNet("ADD0", "SCL"), true);
});
