/**
 * Thrown by a Bus for an access with nothing behind it. The core turns it into
 * a HardFault: ARMv6-M has no separate BusFault exception.
 */
export class BusFault extends Error {
  readonly address: number;
  constructor(address: number) {
    super(`bus fault at 0x${(address >>> 0).toString(16).padStart(8, "0")}`);
    this.address = address >>> 0;
  }
}

/** The CPU core's only view of the chip: memory accesses and the break hook. */
export interface Bus {
  readUint8(address: number): number;
  readUint16(address: number): number;
  readUint32(address: number): number;
  writeUint8(address: number, value: number): void;
  writeUint16(address: number, value: number): void;
  writeUint32(address: number, value: number): void;
  /** Called by BKPT with its immediate: the simulator halts as a debugger would. UDF is a HardFault (T11). */
  onBreak(code: number): void;
}
