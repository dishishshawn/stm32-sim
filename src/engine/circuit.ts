// Circuit JSON: parse (with validation) and serialize. Strings in, strings out;
// reading and writing files is the caller's job.
//
// {
//   "chip": "stm32g031k8",
//   "parts": [{ "id": "temp", "type": "tc74", "props": { ... }, "pos": { "x": 0, "y": 0 } }],
//   "wires": [["mcu.PB7", "temp.SDA"], ["temp.VDD", "3V3"]]
// }
//
// "pos" is optional. "props" holds only what the author wrote: defaults are
// filled in by mountPart(), not here, so a file round-trips without growing.
// Endpoints are "<id>.<pin>" (split at the first dot), "mcu.<pin>", "3V3" or "GND".
import type { Part, PropValue } from "../parts/part.ts";
import { propError } from "../parts/part.ts";
import { RAILS } from "./nets.ts";

export interface CircuitPart {
  id: string;
  type: string;
  props: Record<string, PropValue>;
  pos?: { x: number; y: number };
}

export interface Circuit {
  chip: string;
  parts: CircuitPart[];
  wires: [string, string][];
}

/** What a circuit is checked against. Tests pass fakes. */
export interface CircuitCatalog {
  /** The part registry: src/parts/index.ts in production. */
  parts: readonly Part[];
  /** Each known chip and its pin names, e.g. { stm32g031k8: ["PA0", ...] }. */
  chips: Readonly<Record<string, readonly string[]>>;
}

/** Invalid circuit input. The message starts with the path of the bad field. */
export class CircuitError extends Error {
  override name = "CircuitError";
}

/** The chip's endpoints are "mcu.<pin>", so no part may use this id. */
const MCU_ID = "mcu";
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function parseCircuit(text: string, catalog: CircuitCatalog): Circuit {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail("circuit", `invalid JSON: ${(e as Error).message}`);
  }
  const top = fields(raw, "", ["chip", "parts", "wires"]);

  const chip = str(top.chip, "chip");
  if (!Object.hasOwn(catalog.chips, chip)) {
    fail(
      "chip",
      `unknown chip ${q(chip)} (known: ${Object.keys(catalog.chips).join(", ")})`,
    );
  }
  const pinsOf = new Map<string, readonly string[]>([
    [MCU_ID, catalog.chips[chip]],
  ]);

  const parts = list(top.parts, "parts").map((rawPart, i): CircuitPart => {
    const path = `parts[${i}]`;
    const o = fields(rawPart, path, ["id", "type", "props"], ["pos"]);

    const id = str(o.id, `${path}.id`);
    if (!ID.test(id))
      fail(
        `${path}.id`,
        `invalid id ${q(id)}: use letters, digits, _ and -, starting with a letter`,
      );
    if (id === MCU_ID)
      fail(`${path}.id`, `${q(MCU_ID)} is reserved for the chip`);
    if (pinsOf.has(id)) fail(`${path}.id`, `duplicate id ${q(id)}`);

    const type = str(o.type, `${path}.type`);
    const part =
      catalog.parts.find((p) => p.type === type) ??
      fail(`${path}.type`, `unknown part type ${q(type)}`);
    pinsOf.set(id, part.pins);

    const props: Record<string, PropValue> = {};
    for (const [name, value] of Object.entries(
      fields(o.props, `${path}.props`),
    )) {
      const at = `${path}.props.${name}`;
      if (!Object.hasOwn(part.props, name)) {
        fail(
          at,
          `unknown prop for ${type} (has: ${Object.keys(part.props).join(", ") || "none"})`,
        );
      }
      const err = propError(part.props[name], value);
      if (err) fail(at, err);
      props[name] = value as PropValue;
    }

    const result: CircuitPart = { id, type, props };
    if (o.pos !== undefined) {
      const pos = fields(o.pos, `${path}.pos`, ["x", "y"]);
      result.pos = {
        x: num(pos.x, `${path}.pos.x`),
        y: num(pos.y, `${path}.pos.y`),
      };
    }
    return result;
  });

  const endpoint = (v: unknown, path: string): string => {
    const e = str(v, path);
    if (Object.hasOwn(RAILS, e)) return e;
    const dot = e.indexOf(".");
    if (dot < 1 || dot === e.length - 1) {
      fail(
        path,
        `malformed endpoint ${q(e)}: expected "part.pin", "3V3" or "GND"`,
      );
    }
    const id = e.slice(0, dot);
    const pin = e.slice(dot + 1);
    const pins = pinsOf.get(id) ?? fail(path, `unknown part ${q(id)}`);
    if (!pins.includes(pin)) fail(path, `unknown pin ${q(pin)} on ${q(id)}`);
    return e;
  };
  const wires = list(top.wires, "wires").map((w, i): [string, string] => {
    const path = `wires[${i}]`;
    if (!Array.isArray(w) || w.length !== 2)
      fail(path, `expected a pair ["part.pin", "part.pin"]`);
    return [endpoint(w[0], `${path}[0]`), endpoint(w[1], `${path}[1]`)];
  });

  return { chip, parts, wires };
}

/**
 * Canonical text: fixed key order (props sorted by name), 2-space indent, one
 * wire per line, trailing newline. parse → serialize of canonical text is
 * byte-identical.
 */
export function serializeCircuit(c: Circuit): string {
  const j = JSON.stringify;
  const part = (p: CircuitPart) => {
    const props = Object.fromEntries(
      Object.keys(p.props)
        .sort()
        .map((k) => [k, p.props[k]]),
    );
    const lines = [
      `"id": ${j(p.id)}`,
      `"type": ${j(p.type)}`,
      `"props": ${j(props, null, 2).replaceAll("\n", "\n      ")}`,
    ];
    if (p.pos) lines.push(`"pos": { "x": ${j(p.pos.x)}, "y": ${j(p.pos.y)} }`);
    return `    {\n      ${lines.join(",\n      ")}\n    }`;
  };
  const array = (items: string[]) =>
    items.length ? `[\n${items.join(",\n")}\n  ]` : "[]";
  return [
    "{",
    `  "chip": ${j(c.chip)},`,
    `  "parts": ${array(c.parts.map(part))},`,
    `  "wires": ${array(c.wires.map(([a, b]) => `    [${j(a)}, ${j(b)}]`))}`,
    "}",
    "",
  ].join("\n");
}

function fail(path: string, message: string): never {
  throw new CircuitError(`${path}: ${message}`);
}

const q = (s: string) => JSON.stringify(s);

/** An object whose keys are all in `required` or `optional`; with no lists, any keys. */
function fields(
  v: unknown,
  path: string,
  required?: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail(path || "circuit", "expected an object");
  const o = v as Record<string, unknown>;
  if (!required) return o;
  const at = (k: string) => (path ? `${path}.${k}` : k);
  const allowed = [...required, ...optional];
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k))
      fail(at(k), `unknown field (expected ${allowed.join(", ")})`);
  }
  for (const k of required) if (!Object.hasOwn(o, k)) fail(at(k), "missing");
  return o;
}

function list(v: unknown, path: string): unknown[] {
  return Array.isArray(v) ? v : fail(path, "expected an array");
}

function str(v: unknown, path: string): string {
  return typeof v === "string"
    ? v
    : fail(path, `expected a string, got ${JSON.stringify(v)}`);
}

function num(v: unknown, path: string): number {
  return typeof v === "number" && Number.isFinite(v)
    ? v
    : fail(path, `expected a number, got ${JSON.stringify(v)}`);
}
