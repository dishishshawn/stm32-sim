/** The CPU core's only view of the chip: memory accesses and the break hook. */
export interface Bus {
  readUint8(address: number): number;
  readUint16(address: number): number;
  readUint32(address: number): number;
  writeUint8(address: number, value: number): void;
  writeUint16(address: number, value: number): void;
  writeUint32(address: number, value: number): void;
  /** Called by BKPT and UDF with the instruction's immediate. */
  onBreak(code: number): void;
}
