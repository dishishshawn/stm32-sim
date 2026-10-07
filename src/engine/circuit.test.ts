import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitError, parseCircuit, serializeCircuit } from "./circuit.ts";
import type { CircuitCatalog } from "./circuit.ts";

const catalog: CircuitCatalog = {
  parts: [
    {
      type: "fake",
      pins: ["IN", "OUT", "1.l"],
      props: {
        gain: { type: "number", default: 1, min: 0, max: 10 },
        mode: { type: "string", default: "slow", options: ["fast", "slow"] },
        on: { type: "boolean", default: false },
      },
      create: () => ({}),
    },
  ],
  chips: { testchip: ["PA0", "PA1"] },
};

// Hand-written in canonical form.
const sample = `{
  "chip": "testchip",
  "parts": [
    {
      "id": "sensor",
      "type": "fake",
      "props": {
        "gain": 2.5,
        "mode": "fast"
      },
      "pos": { "x": 120, "y": -40 }
    },
    {
      "id": "btn_1",
      "type": "fake",
      "props": {}
    }
  ],
  "wires": [
    ["mcu.PA0", "sensor.OUT"],
    ["sensor.1.l", "GND"],
    ["btn_1.IN", "3V3"]
  ]
}
`;

test("load then save is byte-identical", () => {
  assert.equal(serializeCircuit(parseCircuit(sample, catalog)), sample);
});

test("save is canonical whatever the input layout and prop order", () => {
  const messy = JSON.parse(sample);
  messy.parts[0].props = { mode: "fast", gain: 2.5 };
  assert.equal(
    serializeCircuit(parseCircuit(JSON.stringify(messy), catalog)),
    sample,
  );
});

test("an empty circuit round-trips", () => {
  const empty = `{\n  "chip": "testchip",\n  "parts": [],\n  "wires": []\n}\n`;
  assert.equal(serializeCircuit(parseCircuit(empty, catalog)), empty);
});

test("invalid input is an error naming the bad field", () => {
  // Each case edits a copy of the sample.
  const cases: [string, (c: any) => void][] = [
    [
      'parts[1].type: unknown part type "tc75"',
      (c) => (c.parts[1].type = "tc75"),
    ],
    [
      "parts[0].props.gian: unknown prop for fake (has: gain, mode, on)",
      (c) => (c.parts[0].props.gian = 1),
    ],
    [
      'parts[0].props.mode: expected one of "fast", "slow", got "medium"',
      (c) => (c.parts[0].props.mode = "medium"),
    ],
    [
      "parts[0].props.gain: expected 0 to 10, got 11",
      (c) => (c.parts[0].props.gain = 11),
    ],
    [
      'parts[0].props.on: expected true or false, got "yes"',
      (c) => (c.parts[0].props.on = "yes"),
    ],
    [
      'wires[0][1]: unknown pin "OUTPUT" on "sensor"',
      (c) => (c.wires[0][1] = "sensor.OUTPUT"),
    ],
    [
      'wires[0][0]: unknown pin "PZ9" on "mcu"',
      (c) => (c.wires[0][0] = "mcu.PZ9"),
    ],
    [
      'wires[2][0]: unknown part "button"',
      (c) => (c.wires[2][0] = "button.IN"),
    ],
    [
      'wires[1][1]: malformed endpoint "gnd": expected "part.pin", "3V3" or "GND"',
      (c) => (c.wires[1][1] = "gnd"),
    ],
    [
      'wires[1][0]: malformed endpoint "sensor.": expected "part.pin", "3V3" or "GND"',
      (c) => (c.wires[1][0] = "sensor."),
    ],
    [
      'wires[1]: expected a pair ["part.pin", "part.pin"]',
      (c) => c.wires[1].push("3V3"),
    ],
    ['parts[1].id: duplicate id "sensor"', (c) => (c.parts[1].id = "sensor")],
    [
      'parts[1].id: "mcu" is reserved for the chip',
      (c) => (c.parts[1].id = "mcu"),
    ],
    [
      'parts[1].id: invalid id "my.btn": use letters, digits, _ and -, starting with a letter',
      (c) => (c.parts[1].id = "my.btn"),
    ],
    ["parts[1].props: missing", (c) => delete c.parts[1].props],
    [
      "parts[1].prop: unknown field (expected id, type, props, pos)",
      (c) => (c.parts[1].prop = {}),
    ],
    [
      'parts[0].pos.x: expected a number, got "120"',
      (c) => (c.parts[0].pos.x = "120"),
    ],
    ["wire: unknown field (expected chip, parts, wires)", (c) => (c.wire = [])],
    [
      'chip: unknown chip "stm32f411" (known: testchip)',
      (c) => (c.chip = "stm32f411"),
    ],
    ["parts: expected an array", (c) => (c.parts = {})],
  ];
  for (const [message, edit] of cases) {
    const c = JSON.parse(sample);
    edit(c);
    assert.throws(
      () => parseCircuit(JSON.stringify(c), catalog),
      { name: "CircuitError", message },
      message,
    );
  }
  // JSON.parse turns "__proto__" into an ordinary own key: just an unknown prop.
  assert.throws(
    () =>
      parseCircuit(
        sample.replace('"props": {}', '"props": { "__proto__": {} }'),
        catalog,
      ),
    {
      message:
        "parts[1].props.__proto__: unknown prop for fake (has: gain, mode, on)",
    },
  );
  assert.throws(
    () => parseCircuit("{", catalog),
    (e) =>
      e instanceof CircuitError && /^circuit: invalid JSON/.test(e.message),
  );
});
