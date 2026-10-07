// The headless engine: one board (chip, circuit and firmware) run in simulated
// time. The CLI and the UI are thin layers over it. Time is CPU cycles at the
// chip's clockHz. Only runRealtime() reads the wall clock, and only to wait, so
// the same ELF and circuit always give the same run. Choices are recorded in
// docs/decisions.md §10 and §11.
import { chips } from "../chips/index.ts";
import { CortexM0Core } from "../cpu/cortex-m0-core.ts";
import { parts as partTypes } from "../parts/index.ts";
import { mountPart } from "../parts/part.ts";
import type { PartInstance } from "../parts/part.ts";
import type { Circuit, CircuitCatalog } from "./circuit.ts";
import { coreCpu } from "./core-cpu.ts";
import { loadElf } from "./elf.ts";
import type { Elf } from "./elf.ts";
import { EventLog } from "./events.ts";
import { MemoryBus } from "./memory-bus.ts";
import type { Chip } from "./memory-bus.ts";
import { Nets } from "./nets.ts";
import type { Level } from "./nets.ts";

/** What parseCircuit() checks a circuit against: the part and chip registration lists. */
export const catalog: CircuitCatalog = {
  parts: partTypes,
  chips: Object.fromEntries(
    Object.entries(chips).map(([name, chip]) => [name, chip.pins]),
  ),
};

/** Parts' tick(seconds) runs once per this much simulated time. */
const PART_TICK_SECONDS = 0.001;
/** runRealtime() checks the wall clock once per this much simulated time. */
const REALTIME_SLICE_SECONDS = 0.01;

/** Why the CPU stopped. */
export interface Halt {
  kind: "lockup" | "breakpoint";
  reason: string;
}

export interface Snapshot {
  /** CPU cycles since reset. */
  cycles: number;
  /** Simulated seconds since reset: `cycles` at the chip's clockHz. */
  seconds: number;
  pc: number;
  /** The PC as "file:line", else "function+0xoffset", else "0x08000123". */
  at: string;
  /** Null while the CPU can run. */
  halt: Halt | null;
  /** Each package pin's net level, by pin name ("PA0"). */
  pins: Record<string, Level>;
  /** Stored register values by peripheral and register name. Taking them has no read side effects. */
  registers: Record<string, Record<string, number>>;
  /** state() of each part that has one, by part id. */
  parts: Record<string, Readonly<Record<string, unknown>>>;
  /** The HardFault the CPU is in (IPSR = 3), else null. */
  fault: Fault | null;
  /** The core's messages since load (HardFault, lockup, ...), oldest first. At most LOG_LIMIT. */
  log: string[];
}

/** A HardFault taken: where the faulting instruction is. */
export interface Fault {
  /** The PC stacked on exception entry (SP+24): the faulting instruction. */
  pc: number;
  /** That PC as `at` gives it. */
  at: string;
  /** E.g. "undefined instruction 0xdeff", "bus fault at 0x30000000". */
  reason: string;
}

const LOG_LIMIT = 100;
const HARDFAULT = 3;

interface Board {
  chip: Chip;
  elf: Elf;
  nets: Nets;
  bus: MemoryBus;
  core: CortexM0Core;
  parts: Map<string, PartInstance>;
  /** Cycles per part tick, and the cycle the next one is due at. */
  partTick: number;
  nextPartTick: number;
}

export class Engine {
  /** Register and net events. Subscribers stay across loads. */
  readonly events = new EventLog();
  #board: Board | undefined;
  /** The address of the instruction executing, for events. */
  #pc = 0;
  #break: Halt | null = null;
  #fault: Fault | null = null;
  #log: string[] = [];
  #lastWarn = "";

  /**
   * Builds a new board, sharing nothing with the last one: nets from the
   * circuit's wires, its parts, the memory bus with the firmware image, and the
   * core. Then resets: SP and PC from the vector table.
   */
  load(elfBytes: Uint8Array, circuit: Circuit): void {
    if (!Object.hasOwn(chips, circuit.chip))
      throw new Error(`unknown chip "${circuit.chip}"`);
    const chip = chips[circuit.chip];
    const elf = loadElf(elfBytes);
    // A new Nets every load: its listeners can't be removed (T8).
    const nets = new Nets(circuit.wires);
    let core: CortexM0Core | undefined;
    const cycle = () => core?.cycles ?? 0;
    nets.listen((endpoint, level) => {
      if (this.events.active)
        this.events.emit({ kind: "net", cycle: cycle(), endpoint, level });
    });
    const parts = new Map<string, PartInstance>();
    const bus = new MemoryBus(chip, {
      events: this.events,
      now: () => ({ cycle: cycle(), pc: this.#pc }),
      nets,
      cpu: coreCpu(() => core!),
      parts, // filled below; I2C1 reads it live
    });

    // Each segment at its load address. Only the file's bytes, not memSize:
    // .data and .bss can share a segment, and zeroing .bss is the startup
    // code's job (T6).
    const regions = [
      { base: chip.flash.base, mem: bus.flash },
      { base: chip.sram.base, mem: bus.sram },
    ];
    for (const { addr, data } of elf.segments) {
      const r = regions.find(
        (r) => addr >= r.base && addr + data.length <= r.base + r.mem.length,
      );
      if (!r) {
        throw new Error(
          `ELF segment at ${hex(addr)} (${data.length} bytes) is outside flash and SRAM`,
        );
      }
      r.mem.set(data, addr - r.base);
    }

    // A new core every load: reset() doesn't clear lockup, IPSR or the mode (T11).
    core = new CortexM0Core(bus, chip.irqCount);
    core.reset();
    // The core's messages go into the snapshot, not the console.
    // ponytail: keeps the first LOG_LIMIT; a firmware that faults in a loop logs forever.
    const note = (message: string) => {
      if (this.#log.length < LOG_LIMIT) this.#log.push(message);
    };
    core.logger = {
      warn: (_, message) => {
        this.#lastWarn = message;
        note(message);
      },
      info: (_, message) => note(message),
    };
    bus.onBreak = (code) => {
      this.#break = { kind: "breakpoint", reason: `BKPT #${code}` };
    };

    for (const p of circuit.parts) {
      const type = partTypes.find((t) => t.type === p.type);
      if (!type) throw new Error(`unknown part type "${p.type}"`);
      parts.set(p.id, mountPart(nets, type, p.id, p.props));
    }

    const partTick = Math.round(chip.clockHz * PART_TICK_SECONDS);
    this.#board = {
      chip,
      elf,
      nets,
      bus,
      core,
      parts,
      partTick,
      nextPartTick: partTick,
    };
    this.#pc = core.PC;
    this.#break = null;
    this.#fault = null;
    this.#log = [];
  }

  /**
   * Runs for `seconds` of simulated time, stopping at the first instruction
   * boundary at or past it, or earlier if the CPU locks up or hits a BKPT.
   * Running on from a BKPT executes it again.
   */
  runFor(seconds: number): void {
    const b = this.#loaded();
    const end = b.core.cycles + Math.round(seconds * b.chip.clockHz);
    this.#break = null;
    while (b.core.cycles < end && !b.core.lockedUp && !this.#break)
      this.#advance(b, end);
  }

  /**
   * runFor() at real-time speed: runs `seconds` of simulated time in 10 ms slices
   * and, after each, waits until the wall clock has caught up. The simulation
   * itself is the same as runFor's. If it is slower than real time it never waits.
   */
  async runRealtime(seconds: number): Promise<void> {
    const b = this.#loaded();
    const { clockHz } = b.chip;
    const start = { cycles: b.core.cycles, ms: performance.now() };
    const end = start.cycles + Math.round(seconds * clockHz);
    do {
      const left = (end - b.core.cycles) / clockHz;
      this.runFor(Math.min(left, REALTIME_SLICE_SECONDS));
      const simMs = ((b.core.cycles - start.cycles) / clockHz) * 1000;
      const ahead = simMs - (performance.now() - start.ms);
      if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
    } while (b.core.cycles < end && !b.core.lockedUp && !this.#break);
  }

  /** Executes one instruction. While the core sleeps (WFI), advances to the next part tick instead. */
  step(): void {
    const b = this.#loaded();
    this.#break = null;
    if (!b.core.lockedUp) this.#advance(b, Infinity);
  }

  snapshot(): Snapshot {
    const { chip, elf, nets, bus, core, parts } = this.#loaded();
    return {
      cycles: core.cycles,
      seconds: core.cycles / chip.clockHz,
      pc: core.PC,
      at: where(elf, core.PC),
      halt: core.lockedUp
        ? { kind: "lockup", reason: core.lockupReason }
        : this.#break,
      pins: Object.fromEntries(
        chip.pins.map((pin) => [pin, nets.level(`mcu.${pin}`)]),
      ),
      registers: Object.fromEntries(
        Object.entries(bus.regs).map(([name, regs]) => [name, { ...regs }]),
      ),
      parts: Object.fromEntries(
        [...parts].flatMap(([id, p]) => (p.state ? [[id, p.state()]] : [])),
      ),
      fault: core.IPSR === HARDFAULT ? this.#fault : null,
      log: [...this.#log],
    };
  }

  #loaded(): Board {
    if (!this.#board) throw new Error("no firmware loaded: call load() first");
    return this.#board;
  }

  /** One instruction, or while asleep the time up to the next part tick or `end`. Then the ticks. */
  #advance(b: Board, end: number): void {
    const { core } = b;
    // Take a pending exception; that also wakes the core from WFI.
    if (core.interruptsUpdated && core.checkForInterrupts())
      core.waiting = false;
    let cycles: number;
    if (core.waiting) {
      // ponytail: sleeps in slices up to 1 ms, so a peripheral's tick() sees
      // them whole and a wake-up can be up to 1 ms late. Ask peripherals for
      // their next deadline if WFI firmware needs better.
      cycles = Math.min(end, b.nextPartTick) - core.cycles;
      core.cycles += cycles;
    } else {
      this.#pc = core.PC;
      const inHardFault = core.IPSR === HARDFAULT;
      cycles = core.executeInstruction();
      // Stop on the BKPT itself, as a debugger shows it (decisions.md §2).
      if (this.#break) core.PC -= core.breakRewind;
      if (!inHardFault && core.IPSR === HARDFAULT) {
        // Just entered: the frame is on the stack EXC_RETURN bit 2 names.
        const sp = core.LR & 4 ? core.SPprocess : core.SPmain;
        const pc = b.bus.readUint32(sp + 24);
        this.#fault = {
          pc,
          at: where(b.elf, pc),
          reason: this.#lastWarn.replace(/^HardFault at \S+ /, ""),
        };
      }
    }
    b.bus.tick(cycles);
    while (core.cycles >= b.nextPartTick) {
      b.nextPartTick += b.partTick;
      for (const p of b.parts.values()) p.tick?.(b.partTick / b.chip.clockHz);
    }
  }
}

/** The PC as "file:line", else "function+0xoffset", else the bare address. */
function where(elf: Elf, pc: number): string {
  const line = elf.pcToSource(pc);
  if (line) return `${line.file}:${line.line}`;
  const fn = elf.functionAt(pc);
  const start = fn === undefined ? undefined : elf.symbol(fn);
  if (start !== undefined) return `${fn}+0x${(pc - start).toString(16)}`;
  return hex(pc);
}

const hex = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
