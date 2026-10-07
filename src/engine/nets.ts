// The digital net model. Endpoints are strings: "<partId>.<pin>" (the chip is
// "mcu", e.g. "mcu.PA0"), plus the two built-in rails "3V3" and "GND".

/**
 * What a net reads as. A string union, not a boolean, so analog work can add a
 * voltage later without changing parts that only read levels. Readers should
 * treat "floating" and "conflict" as "undefined level".
 */
export type Level = "high" | "low" | "floating" | "conflict";

/**
 * What one endpoint does to its net.
 * - strong: "high" | "low". Push-pull drives both; an open-drain output drives
 *   "low" or releases to "hi-z".
 * - weak: "pull-up" | "pull-down".
 * - "hi-z": nothing (an input, or an endpoint that has never been driven).
 */
export type Drive = "high" | "low" | "pull-up" | "pull-down" | "hi-z";

export type Listener = (endpoint: string, level: Level) => void;

/** Built-in rails and the strong level each one holds. */
export const RAILS: Readonly<Record<string, "high" | "low">> = {
  "3V3": "high",
  GND: "low",
};

const MAX_ROUNDS = 100;

/**
 * Wires join endpoints into nets, and so does a switch while it is closed.
 * A resistor is a weak link between two nets: a *strong* level on one side
 * becomes a weak drive on the other. Weak levels are not carried across, so
 * there is no weak-to-weak chaining and resolution is one pass.
 *
 * Every change (drive, switch, resistor) re-resolves at once and calls the
 * listeners for each endpoint whose level changed. A listener may change a
 * drive itself; that triggers another round once the current one has
 * finished, and level() reads the previous round until then.
 */
export class Nets {
  #wires: (readonly [string, string])[];
  #switches = new Map<string, { a: string; b: string; closed: boolean }>();
  #resistors: [string, string][] = [];
  #drives = new Map<string, Drive>();
  #levels = new Map<string, Level>();
  #listeners: Listener[] = [];
  #settling = false;
  #dirty = false;

  constructor(wires: readonly (readonly [string, string])[] = []) {
    this.#wires = [...wires];
    this.#settle();
  }

  /** The level of an endpoint's net. An endpoint never mentioned is "floating". */
  level(endpoint: string): Level {
    return this.#levels.get(endpoint) ?? "floating";
  }

  drive(endpoint: string, drive: Drive): void {
    if (this.#drives.get(endpoint) === drive) return;
    this.#drives.set(endpoint, drive);
    this.#settle();
  }

  /** Join endpoints a and b while closed. Calls with the same (a, b) update one switch. */
  setSwitch(a: string, b: string, closed: boolean): void {
    const key = `${a} ${b}`;
    if (this.#switches.get(key)?.closed === closed) return;
    this.#switches.set(key, { a, b, closed });
    this.#settle();
  }

  /** A weak link: a strong level on either side pulls the other side the same way. */
  addResistor(a: string, b: string): void {
    this.#resistors.push([a, b]);
    this.#settle();
  }

  /** Called with each endpoint whose level changed, after every change. */
  listen(fn: Listener): void {
    this.#listeners.push(fn);
  }

  #settle(): void {
    if (this.#settling) {
      this.#dirty = true;
      return;
    }
    this.#settling = true;
    try {
      for (let round = 0; ; round++) {
        if (round === MAX_ROUNDS) {
          throw new Error(
            `nets did not settle after ${MAX_ROUNDS} rounds: parts keep changing drives in reply to each other`,
          );
        }
        this.#dirty = false;
        for (const [endpoint, level] of this.#resolve()) {
          for (const fn of this.#listeners) fn(endpoint, level);
        }
        if (!this.#dirty) return;
      }
    } finally {
      this.#settling = false;
    }
  }

  /** Recompute every level; return the endpoints that changed. */
  // ponytail: full recompute on every change, fine for breadboard-sized circuits;
  // recompute only the touched nets if a fast GPIO toggle loop profiles slow.
  #resolve(): [string, Level][] {
    const links: (readonly [string, string])[] = [...this.#wires];
    for (const s of this.#switches.values())
      if (s.closed) links.push([s.a, s.b]);

    // Group endpoints into nets (union-find); each net is named by its root.
    const parent = new Map<string, string>();
    const root = (e: string): string => {
      const p = parent.get(e);
      if (p === undefined || p === e) return e;
      const r = root(p);
      parent.set(e, r);
      return r;
    };
    for (const [a, b] of links) parent.set(root(a), root(b));

    // Collect the drives on each net: the rails, then each endpoint's own drive.
    const drives = new Map<string, Set<Drive>>();
    const add = (endpoint: string, d: Drive) => {
      const r = root(endpoint);
      let set = drives.get(r);
      if (!set) drives.set(r, (set = new Set()));
      set.add(d);
    };
    for (const [rail, level] of Object.entries(RAILS)) add(rail, level);
    for (const [endpoint, d] of this.#drives) add(endpoint, d);

    // Resistors carry strong levels only. Adding a weak drive never changes a
    // net's strong level, so the order resistors are visited in doesn't matter.
    const strong = (endpoint: string): "high" | "low" | undefined => {
      const set = drives.get(root(endpoint));
      const hi = set?.has("high");
      const lo = set?.has("low");
      return hi && !lo ? "high" : lo && !hi ? "low" : undefined;
    };
    for (const [a, b] of this.#resistors) {
      const la = strong(a);
      const lb = strong(b);
      if (la) add(b, la === "high" ? "pull-up" : "pull-down");
      if (lb) add(a, lb === "high" ? "pull-up" : "pull-down");
    }

    // Every endpoint ever mentioned. Nothing is removed (an open switch stays
    // listed), so an endpoint's last level never goes stale.
    const endpoints = new Set([
      ...Object.keys(RAILS),
      ...this.#drives.keys(),
      ...this.#wires.flat(),
      ...this.#resistors.flat(),
      ...[...this.#switches.values()].flatMap((s) => [s.a, s.b]),
    ]);
    const changed: [string, Level][] = [];
    for (const e of endpoints) {
      const level = resolveNet(drives.get(root(e)));
      if (level !== this.level(e)) changed.push([e, level]);
      this.#levels.set(e, level);
    }
    return changed;
  }
}

function resolveNet(d: Set<Drive> | undefined): Level {
  if (!d) return "floating";
  if (d.has("high") && d.has("low")) return "conflict"; // a short
  if (d.has("high")) return "high";
  if (d.has("low")) return "low";
  // Assumed: a pull-up against a pull-down is "conflict" (the level is undefined
  // because two drivers disagree). Really a divider decides it by resistance,
  // which the digital model doesn't have.
  if (d.has("pull-up") && d.has("pull-down")) return "conflict";
  if (d.has("pull-up")) return "high";
  if (d.has("pull-down")) return "low";
  return "floating";
}
