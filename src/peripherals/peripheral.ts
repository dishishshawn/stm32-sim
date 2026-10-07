// The Peripheral interface: one file per peripheral, registered in the chip
// definition's `peripherals` list. A peripheral file holds behavior only. Its
// registers, offsets and reset values come from the chip's register JSON, and the
// memory bus does address decoding, byte lanes, clock gating and event logging.
import type { EventLog } from "../engine/events.ts";
import type { Nets } from "../engine/nets.ts";
import type { PartInstance } from "../parts/part.ts";

/**
 * Register values by SVD register name, e.g. `regs.ODR`. Registers that share an
 * offset (TIMx `CCMR1_Input`/`CCMR1_Output`) share one value, under the first name
 * the JSON lists.
 */
export type Registers = Record<string, number>;

/** An RCC enable bit, e.g. `{ register: "RCC.IOPENR", field: "GPIOAEN" }`. */
export interface ClockGate {
  /** "<PERIPHERAL>.<REGISTER>" */
  readonly register: string;
  readonly field: string;
}

export interface Peripheral {
  /** SVD peripheral name, e.g. "GPIOA". */
  readonly name: string;
  /**
   * Enforced by the memory bus from the gate register's stored value: while the
   * bit is 0, writes are ignored and reads return 0, both flagged "clock-off".
   */
  readonly gate?: ClockGate;
  create(ctx: PeripheralContext): PeripheralInstance;
}

export interface PeripheralContext {
  /** This peripheral's register values, owned by the bus. */
  readonly regs: Registers;
  /**
   * The circuit. The chip's pins are the endpoints "mcu.<pin>", e.g. "mcu.PA0".
   * A peripheral's own signals are "mcu.<signal>", e.g. "mcu.I2C1_SCL": GPIO
   * joins a pin to one while the pin selects it in the chip's AF table.
   */
  readonly nets: Nets;
  /**
   * Another peripheral's registers, live and read-only, e.g.
   * `regsOf("RCC").APBENR1`. Throws for an unknown name.
   */
  regsOf(name: string): Readonly<Registers>;
  /** CPU cycles since reset: simulated time, at the chip's `clockHz`. */
  now(): number;
  readonly cpu: Cpu;
  /** The circuit's mounted parts by id, read live: I2C1's bus finds its targets here. */
  readonly parts: Iterable<readonly [id: string, part: PartInstance]>;
  /** The event log, for events a peripheral makes itself (I2C trace). Build one only while `events.active`. */
  readonly events: EventLog;
}

/** What a peripheral may ask of the CPU core. */
export interface Cpu {
  /**
   * Pend an exception, as the NVIC or SCB would: 2 NMI, 14 PendSV, 15 SysTick,
   * 16 + n for IRQ n. The core takes it when its priority and masks allow.
   */
  setPending(exception: number): void;
  /** Un-pend it (ICSR's PENDSTCLR for SysTick). */
  clearPending(exception: number): void;
  /** Whether it is pending (ICSR's PENDSTSET reads this for SysTick). */
  isPending(exception: number): boolean;
  /** A system handler's priority, 0 (highest) to 3, as SHPR3 sets it for 14 PendSV and 15 SysTick. */
  setPriority(exception: number, priority: number): void;
}

export interface PeripheralInstance {
  /** Chip reset. The bus has already put every register back to its reset value. */
  reset?(): void;
  /**
   * `cycles` CPU cycles have passed. The engine calls it after every instruction
   * (and per slice while the core sleeps), in registration order.
   */
  tick?(cycles: number): void;
  /** By register name: the value the CPU reads. Default: `regs[name]`. */
  readonly read?: Readonly<Record<string, () => number>>;
  /**
   * By register name. `value` is the whole register: the bytes the CPU wrote, and
   * the rest from `regs[name]`. `mask` marks the bits it wrote (0xffffffff for a
   * word). Default: `regs[name] = value`.
   */
  readonly write?: Readonly<
    Record<string, (value: number, mask: number) => void>
  >;
}
