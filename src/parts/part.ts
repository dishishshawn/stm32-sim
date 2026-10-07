// The Part interface: one file per part, registered in ./index.ts.
import type { Drive, Level, Nets } from "../engine/nets.ts";

export type PropValue = number | string | boolean;

/**
 * One typed property. Circuit JSON and CLI input are checked against it with
 * propError(). A string prop with `options` is an enum (e.g. a variant).
 */
export type PropSpec =
  | { type: "boolean"; default: boolean }
  | { type: "number"; default: number; min?: number; max?: number }
  | { type: "string"; default: string; options?: readonly string[] };

export interface Part {
  /** The "type" used in circuit JSON, e.g. "tc74". */
  readonly type: string;
  /** Pin names. A pin's endpoint is "<id>.<pin>"; a pin name may contain dots ("1.l"). */
  readonly pins: readonly string[];
  /** Props by name, in the order a UI should show them. */
  readonly props: Readonly<Record<string, PropSpec>>;
  create(ctx: PartContext): PartInstance;
}

/** What a part instance can do to the circuit. Pins are this part's own pin names. */
export interface PartContext {
  readonly id: string;
  /** Every prop, validated, with defaults filled in. */
  readonly props: Readonly<Record<string, PropValue>>;
  drive(pin: string, drive: Drive): void;
  level(pin: string): Level;
  /** Join two pins while closed: a switch, or pins joined inside the part (GND.1/GND.2). */
  setSwitch(a: string, b: string, closed: boolean): void;
  /** A resistor between two pins: a strong level on one side weakly pulls the other. */
  addResistor(a: string, b: string): void;
}

export interface PartInstance {
  /** A pin's level changed. Levels already present during create() aren't reported: read them with ctx.level(). */
  onLevel?(pin: string, level: Level): void;
  /** Simulated time passed since the last tick, in seconds. */
  tick?(seconds: number): void;
  /** A prop changed at run time (button pressed, slider moved). The caller has already checked it with propError(). */
  setProp?(name: string, value: PropValue): void;
}

/** Why `value` is not valid for `spec`, or undefined if it is. */
export function propError(spec: PropSpec, value: unknown): string | undefined {
  const got = `got ${JSON.stringify(value)}`;
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : `expected true or false, ${got}`;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return `expected a number, ${got}`;
      if (
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        return `expected ${spec.min ?? "-∞"} to ${spec.max ?? "∞"}, ${got}`;
      }
      return undefined;
    case "string":
      if (typeof value !== "string") return `expected a string, ${got}`;
      if (spec.options && !spec.options.includes(value)) {
        return `expected one of ${spec.options.map((o) => JSON.stringify(o)).join(", ")}, ${got}`;
      }
      return undefined;
  }
}

/**
 * Create a part instance whose pins are the endpoints "<id>.<pin>" in `nets`,
 * and route level changes on those endpoints to its onLevel(). Props left out
 * get their defaults.
 */
export function mountPart(
  nets: Nets,
  part: Part,
  id: string,
  props: Readonly<Record<string, PropValue>> = {},
): PartInstance {
  const endpoint = (pin: string) => {
    if (!part.pins.includes(pin))
      throw new Error(`${part.type} "${id}" has no pin "${pin}"`);
    return `${id}.${pin}`;
  };
  const defaults = Object.fromEntries(
    Object.entries(part.props).map(([name, spec]) => [name, spec.default]),
  );
  const prefix = `${id}.`;
  let instance: PartInstance | undefined;
  nets.listen((e, level) => {
    if (e.startsWith(prefix))
      instance?.onLevel?.(e.slice(prefix.length), level);
  });
  instance = part.create({
    id,
    props: { ...defaults, ...props },
    drive: (pin, d) => nets.drive(endpoint(pin), d),
    level: (pin) => nets.level(endpoint(pin)),
    setSwitch: (a, b, closed) =>
      nets.setSwitch(endpoint(a), endpoint(b), closed),
    addResistor: (a, b) => nets.addResistor(endpoint(a), endpoint(b)),
  });
  return instance;
}
