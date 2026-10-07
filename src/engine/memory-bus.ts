// The chip's address space behind the core's Bus interface. Flash and SRAM are
// byte arrays. Everything else is a peripheral register, decoded by address from
// the chip's register JSON. Byte lanes, clock gating and event logging happen
// here, once, for every peripheral. Choices are recorded in docs/decisions.md §8.

import { BusFault } from "../cpu/bus.ts";
import type { Bus } from "../cpu/bus.ts";
import type { EventLog, Flag } from "./events.ts";
import type { Nets } from "./nets.ts";
import type {
  ClockGate,
  Cpu,
  Peripheral,
  PeripheralContext,
  PeripheralInstance,
  Registers,
} from "../peripherals/peripheral.ts";

/** The register JSON's shape (docs/decisions.md §4), as far as the bus reads it. */
export interface RegisterMap {
  readonly peripherals: Readonly<
    Record<
      string,
      {
        readonly baseAddress: string;
        readonly registers: Readonly<
          Record<
            string,
            {
              readonly offset: string;
              readonly resetValue: string;
              readonly fields: Readonly<
                Record<
                  string,
                  { readonly bitOffset: number; readonly bitWidth: number }
                >
              >;
            }
          >
        >;
      }
    >
  >;
}

export interface Region {
  readonly base: number;
  readonly size: number;
}

/** The chip-specific facts. One file per chip in src/chips/. */
export interface Chip {
  readonly name: string;
  readonly core: "cortex-m0+";
  readonly clockHz: number;
  readonly irqCount: number;
  /** Also mapped at 0x00000000 (boot from main flash), where the core reads the vector table. */
  readonly flash: Region;
  readonly sram: Region;
  readonly registers: RegisterMap;
  /** The package's I/O pins, e.g. "PA0": circuit JSON may wire "mcu.<pin>". */
  readonly pins: readonly string[];
  /** The registration list: one entry per simulated peripheral. */
  readonly peripherals: readonly Peripheral[];
}

export interface MemoryBusOptions {
  readonly events: EventLog;
  /** The current cycle and PC. Called when an event is emitted, and by a peripheral's `now()`. */
  readonly now: () => { cycle: number; pc: number };
  /** The circuit, passed to each peripheral. */
  readonly nets: Nets;
  /** The core, passed to each peripheral. */
  readonly cpu: Cpu;
  /**
   * The circuit's parts by id, passed to each peripheral and read live, so the
   * engine can mount them after building the bus. Default: none.
   */
  readonly parts?: PeripheralContext["parts"];
}

// The Cortex-M system control space (SysTick, NVIC, SCB). Not in the SVD.
const SCS_BASE = 0xe000e000;
const SCS_END = 0xe000f000;
// STM32 peripherals sit in 1 KB-aligned blocks. One block can hold two SVD
// peripherals: SYSCFG and VREFBUF share 0x40010000.
const BLOCK_MASK = ~0x3ff;

const SIMULATED: readonly Flag[] = [];
const UNSIMULATED: readonly Flag[] = ["unsimulated"];
const RESERVED: readonly Flag[] = ["reserved"];
const CLOCK_OFF: readonly Flag[] = ["clock-off"];
const READ_ONLY: readonly Flag[] = ["read-only"];

/** One 32-bit register. Its value lives in `regs[reg]`. */
interface Slot {
  periph: string;
  reg: string;
  regs: Registers;
  flags: readonly Flag[];
  read?: () => number;
  write?: (value: number, mask: number) => void;
  gate?: { regs: Registers; reg: string; mask: number };
}

export class MemoryBus implements Bus {
  readonly flash: Uint8Array;
  readonly sram: Uint8Array;
  /** Every SVD register's value, by peripheral and register name. */
  readonly regs: Readonly<Record<string, Registers>>;
  /** Called by BKPT (UDF is a HardFault). The engine sets it. */
  onBreak = (code: number): void => void code;

  readonly #flashBase: number;
  readonly #sramBase: number;
  readonly #flashView: DataView;
  readonly #sramView: DataView;
  readonly #slots = new Map<number, Slot>(); // by word address
  readonly #blocks = new Map<number, string>(); // 1 KB block → peripheral name
  readonly #resetValues: [Registers, Registers][] = [];
  readonly #instances: PeripheralInstance[] = [];
  readonly #tickers: ((cycles: number) => void)[] = [];
  readonly #events: EventLog;
  readonly #now: MemoryBusOptions["now"];

  constructor(
    chip: Chip,
    { events, now, nets, cpu, parts = [] }: MemoryBusOptions,
  ) {
    this.#events = events;
    this.#now = now;
    this.#flashBase = chip.flash.base >>> 0;
    this.#sramBase = chip.sram.base >>> 0;
    this.flash = new Uint8Array(chip.flash.size).fill(0xff); // erased
    this.sram = new Uint8Array(chip.sram.size);
    this.#flashView = new DataView(this.flash.buffer);
    this.#sramView = new DataView(this.sram.buffer);

    const all: Record<string, Registers> = {};
    for (const [periph, p] of Object.entries(chip.registers.peripherals)) {
      const regs: Registers = (all[periph] = {});
      const reset: Registers = {};
      const base = parseInt(p.baseAddress, 16);
      for (const [reg, r] of Object.entries(p.registers)) {
        const address = (base + parseInt(r.offset, 16)) >>> 0;
        // A register sharing an offset with an earlier one is another view of it.
        if (this.#slots.has(address)) continue;
        regs[reg] = reset[reg] = parseInt(r.resetValue, 16) >>> 0;
        this.#slots.set(address, { periph, reg, regs, flags: UNSIMULATED });
        const block = (address & BLOCK_MASK) >>> 0;
        if (!this.#blocks.has(block)) this.#blocks.set(block, periph);
      }
      this.#resetValues.push([regs, reset]);
    }
    this.regs = all;
    const regsOf = (name: string): Registers => {
      if (!Object.hasOwn(all, name))
        throw new Error(`peripheral ${name} is not in the register map`);
      return all[name];
    };

    for (const p of chip.peripherals) {
      const regs = regsOf(p.name);
      const instance = p.create({
        regs,
        nets,
        regsOf,
        now: () => now().cycle,
        cpu,
        parts,
        events,
      });
      const hooks = { ...instance.read, ...instance.write };
      for (const reg of Object.keys(hooks)) {
        if (!Object.hasOwn(regs, reg))
          throw new Error(`${p.name} has no register ${reg}`);
      }
      const gate = p.gate && resolveGate(chip.registers, all, p.gate);
      for (const slot of this.#slots.values()) {
        if (slot.periph !== p.name) continue;
        if (slot.flags === SIMULATED)
          throw new Error(`${p.name} is registered twice`);
        slot.flags = SIMULATED;
        slot.read = instance.read?.[slot.reg];
        slot.write = instance.write?.[slot.reg];
        slot.gate = gate;
      }
      this.#instances.push(instance);
      if (instance.tick) this.#tickers.push(instance.tick.bind(instance));
    }
    this.reset();
  }

  /** Puts every register back to its reset value, then resets each peripheral. Flash and SRAM are kept. */
  reset(): void {
    for (const [regs, reset] of this.#resetValues) Object.assign(regs, reset);
    for (const p of this.#instances) p.reset?.();
  }

  /** `cycles` CPU cycles have passed: calls each peripheral's tick(), in registration order. */
  tick(cycles: number): void {
    for (const tick of this.#tickers) tick(cycles);
  }

  readUint8(address: number): number {
    return this.#read(address >>> 0, 1);
  }
  readUint16(address: number): number {
    return this.#read(address >>> 0, 2);
  }
  readUint32(address: number): number {
    return this.#read(address >>> 0, 4);
  }
  writeUint8(address: number, value: number): void {
    this.#write(address >>> 0, 1, value);
  }
  writeUint16(address: number, value: number): void {
    this.#write(address >>> 0, 2, value);
  }
  writeUint32(address: number, value: number): void {
    this.#write(address >>> 0, 4, value);
  }

  #read(a: number, size: number): number {
    const s = a - this.#sramBase;
    if (s >= 0 && s + size <= this.sram.length)
      return get(this.#sramView, s, size);
    const f = a >= this.#flashBase ? a - this.#flashBase : a; // or the alias at 0
    if (f + size <= this.flash.length) return get(this.#flashView, f, size);

    if (a & (size - 1)) throw new BusFault(a); // ARMv6-M faults unaligned accesses
    const slot = this.#slots.get((a & ~3) >>> 0);
    let periph: string;
    let reg = "";
    let flags: readonly Flag[];
    let old = 0;
    let value = 0;
    if (slot) {
      ({ periph, reg, flags } = slot);
      old = slot.regs[reg];
      if (gatedOff(slot)) flags = CLOCK_OFF;
      else value = slot.read ? slot.read() >>> 0 : old;
    } else {
      ({ periph, flags } = this.#unmodelled(a));
    }
    if (this.#events.active)
      this.#emit(a, periph, reg, "read", old, value, flags);
    if (size === 4) return value;
    return (value >>> ((a & 3) * 8)) & (size === 2 ? 0xffff : 0xff);
  }

  #write(a: number, size: number, data: number): void {
    const s = a - this.#sramBase;
    if (s >= 0 && s + size <= this.sram.length)
      return set(this.#sramView, s, size, data);
    const f = a >= this.#flashBase ? a - this.#flashBase : a;
    if (f + size <= this.flash.length) {
      // Ignored: programming needs FLASH_CR.PG and double-word writes (§8).
      if (this.#events.active) {
        const old = get(this.#flashView, f, size);
        const value =
          size === 4 ? data >>> 0 : data & (size === 2 ? 0xffff : 0xff);
        this.#emit(a, "flash", "", "write", old, value, READ_ONLY);
      }
      return;
    }

    if (a & (size - 1)) throw new BusFault(a);
    const shift = (a & 3) * 8;
    const mask =
      size === 4 ? 0xffffffff : ((size === 2 ? 0xffff : 0xff) << shift) >>> 0;
    const slot = this.#slots.get((a & ~3) >>> 0);
    if (!slot) {
      const { periph, flags } = this.#unmodelled(a);
      if (this.#events.active) {
        this.#emit(
          a,
          periph,
          "",
          "write",
          0,
          ((data << shift) & mask) >>> 0,
          flags,
        );
      }
      return;
    }
    const old = slot.regs[slot.reg];
    const value = ((old & ~mask) | ((data << shift) & mask)) >>> 0;
    const off = gatedOff(slot);
    // Emitted first, so events the write causes come after it.
    if (this.#events.active) {
      this.#emit(
        a,
        slot.periph,
        slot.reg,
        "write",
        old,
        value,
        off ? CLOCK_OFF : slot.flags,
      );
    }
    if (off) return;
    if (slot.write) slot.write(value, mask);
    else slot.regs[slot.reg] = value;
  }

  /** An address with no register: the system control space, a reserved offset, or nothing. */
  #unmodelled(a: number): { periph: string; flags: readonly Flag[] } {
    if (a >= SCS_BASE && a < SCS_END)
      return { periph: "SCS", flags: UNSIMULATED };
    const periph = this.#blocks.get((a & BLOCK_MASK) >>> 0);
    if (periph !== undefined) return { periph, flags: RESERVED };
    throw new BusFault(a);
  }

  #emit(
    address: number,
    periph: string,
    reg: string,
    op: "read" | "write",
    old: number,
    value: number,
    flags: readonly Flag[],
  ): void {
    const { cycle, pc } = this.#now();
    this.#events.emit({
      kind: "reg",
      cycle,
      pc,
      address,
      periph,
      reg,
      op,
      old,
      value,
      flags,
    });
  }
}

function resolveGate(
  map: RegisterMap,
  all: Record<string, Registers>,
  gate: ClockGate,
): Slot["gate"] {
  const [periph, reg] = gate.register.split(".");
  const field = map.peripherals[periph]?.registers[reg]?.fields[gate.field];
  if (!field || !Object.hasOwn(all[periph], reg)) {
    throw new Error(
      `clock gate ${gate.register}.${gate.field} is not in the register map`,
    );
  }
  const mask = ((2 ** field.bitWidth - 1) * 2 ** field.bitOffset) >>> 0;
  return { regs: all[periph], reg, mask };
}

function gatedOff(slot: Slot): boolean {
  return (
    slot.gate !== undefined &&
    (slot.gate.regs[slot.gate.reg] & slot.gate.mask) === 0
  );
}

function get(view: DataView, offset: number, size: number): number {
  if (size === 4) return view.getUint32(offset, true);
  return size === 2 ? view.getUint16(offset, true) : view.getUint8(offset);
}

function set(
  view: DataView,
  offset: number,
  size: number,
  value: number,
): void {
  if (size === 4) view.setUint32(offset, value, true);
  else if (size === 2) view.setUint16(offset, value, true);
  else view.setUint8(offset, value);
}
