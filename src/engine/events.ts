// The single event log. Producers (memory bus, I2C bus, nets) emit; consumers
// (diagnostics, the I2C trace, `sim inspect`, the UI) subscribe. It stores
// nothing: blink writes ODR millions of times, so each consumer keeps what it needs.
import type { Level } from "./nets.ts";

/** Why an access deserves a second look. */
export type Flag =
  /** Nothing models it: an SVD register kept as plain storage, or the system control space. */
  | "unsimulated"
  /** Inside a peripheral's block, but no register there: reads 0, writes are ignored. */
  | "reserved"
  /** The peripheral's clock gate is 0: writes are ignored, reads return 0. */
  | "clock-off"
  /** A write the hardware ignores (flash memory). */
  | "read-only";

/** A CPU access to a peripheral register, the system control space, or a write to flash. */
export interface RegEvent {
  readonly kind: "reg";
  readonly cycle: number;
  readonly pc: number;
  readonly address: number;
  /** SVD peripheral name; "SCS" for the system control space, "flash" for flash memory. */
  readonly periph: string;
  /** SVD register name, or "" where there is none. */
  readonly reg: string;
  readonly op: "read" | "write";
  /** The register's value before the access. */
  readonly old: number;
  /**
   * Read: the value the CPU got. Write: the value the CPU wrote, merged into the
   * register's other bytes. Both are whole 32-bit registers (flash: the access width).
   */
  readonly value: number;
  readonly flags: readonly Flag[];
}

/** An endpoint's level changed (emitted by the engine). Each endpoint on a net that changed gets its own event. */
export interface NetEvent {
  readonly kind: "net";
  readonly cycle: number;
  /** "mcu.PA0", "led1.A", "3V3", ... */
  readonly endpoint: string;
  readonly level: Level;
}

/** Every event kind. Later tasks add theirs to this union (I2C in T13). */
export type SimEvent = RegEvent | NetEvent;

export type Subscriber = (event: SimEvent) => void;

export class EventLog {
  #subscribers: Subscriber[] = [];

  /** True when anyone is listening. Producers check it before building an event. */
  get active(): boolean {
    return this.#subscribers.length > 0;
  }

  /** Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.#subscribers.push(fn);
    return () => {
      this.#subscribers = this.#subscribers.filter((s) => s !== fn);
    };
  }

  emit(event: SimEvent): void {
    for (const fn of this.#subscribers) fn(event);
  }
}
