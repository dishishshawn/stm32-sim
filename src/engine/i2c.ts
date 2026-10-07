// The I2C bus, simulated one transaction step at a time (START, address, byte,
// STOP), not bit by bit. The nets are only read: isIdle() checks the line
// levels, and a target is on the bus if its SDA and SCL pins are on the bus's
// nets. See docs/decisions.md §7.
//
// A controller (the I2C1 peripheral) calls start(), address(), write() or
// read() any number of times, then stop(). The controller, not the bus,
// decides what BUSY and the ISR flags mean.
import type { PartInstance } from "../parts/part.ts";
import type { Nets } from "./nets.ts";

export type Ack = "ack" | "nack";

/** A part's I2C side, set as `PartInstance.i2c`. */
export interface I2cTarget {
  /** This part's SDA and SCL pin names, e.g. "SDA" and "SCL". */
  readonly sda: string;
  readonly scl: string;
  /**
   * The 7-bit address it answers now, or undefined to answer none (e.g. RESET
   * low). Asked at every address phase, so it may follow pins at run time.
   */
  address(): number | undefined;
  /** A byte the controller wrote, after this target answered its address. */
  write(byte: number): Ack;
  /** The next byte to send, after this target answered its address for a read. */
  read(): number;
  /** A START or repeated START. Every target on the bus sees it, addressed or not. */
  start?(): void;
  /** A STOP. Every target on the bus sees it. */
  stop?(): void;
}

/** One bus trace event. `t` is whatever `now()` returned. */
export type I2cEvent =
  | { t: number; kind: "start" }
  | { t: number; kind: "addr"; addr: number; read: boolean; ack: Ack }
  /** On a read, `ack` is the controller's ACK or NACK. */
  | { t: number; kind: "data"; byte: number; read: boolean; ack: Ack }
  | { t: number; kind: "stop" };

export interface I2cBusOptions {
  nets: Nets;
  /** The bus's SDA and SCL endpoints, e.g. "mcu.PB7" and "mcu.PB6". */
  sda: string;
  scl: string;
  /** The circuit's parts by id (a Map works). Read on every call. */
  parts: Iterable<readonly [id: string, part: PartInstance]>;
  /** Simulated time, stamped on each event. */
  now(): number;
  trace(event: I2cEvent): void;
}

export class I2cBus {
  #o: I2cBusOptions;
  /** The targets that answered the last address phase. */
  #selected: I2cTarget[] = [];

  constructor(options: I2cBusOptions) {
    this.#o = options;
  }

  /** Both lines resolve high. With no pull-ups they float, so the bus is not idle. */
  isIdle(): boolean {
    const { nets, sda, scl } = this.#o;
    return nets.level(sda) === "high" && nets.level(scl) === "high";
  }

  /** START, or a repeated START. The controller checks isIdle() first. */
  start(): void {
    this.#selected = [];
    this.#o.trace({ t: this.#o.now(), kind: "start" });
    for (const target of this.#targets()) target.start?.();
  }

  /** ACKs if any target on the bus answers `addr7`; all that answer are selected. */
  address(addr7: number, read: boolean): Ack {
    this.#selected = this.#targets().filter((t) => t.address() === addr7);
    const ack = this.#selected.length > 0 ? "ack" : "nack";
    this.#o.trace({ t: this.#o.now(), kind: "addr", addr: addr7, read, ack });
    return ack;
  }

  /** Every selected target takes the byte. Any one pulling SDA low is an ACK. */
  write(byte: number): Ack {
    const acks = this.#selected.map((t) => t.write(byte));
    const ack = acks.includes("ack") ? "ack" : "nack";
    this.#o.trace({ t: this.#o.now(), kind: "data", byte, read: false, ack });
    return ack;
  }

  /**
   * Open drain: every selected target sends, and SDA is the AND of their
   * bytes. Assumed: with none selected, SDA stays released and reads 0xFF.
   */
  read(ack: Ack): number {
    let byte = 0xff;
    for (const t of this.#selected) byte &= t.read();
    this.#o.trace({ t: this.#o.now(), kind: "data", byte, read: true, ack });
    return byte;
  }

  stop(): void {
    this.#selected = [];
    this.#o.trace({ t: this.#o.now(), kind: "stop" });
    for (const target of this.#targets()) target.stop?.();
  }

  /** Targets whose SDA and SCL pins are on this bus's nets. */
  #targets(): I2cTarget[] {
    const { nets, sda, scl, parts } = this.#o;
    const found: I2cTarget[] = [];
    for (const [id, part] of parts) {
      const t = part.i2c;
      if (
        t &&
        nets.sameNet(`${id}.${t.sda}`, sda) &&
        nets.sameNet(`${id}.${t.scl}`, scl)
      ) {
        found.push(t);
      }
    }
    return found;
  }
}
