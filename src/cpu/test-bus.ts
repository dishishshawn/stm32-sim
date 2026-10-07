import type { Bus } from "./bus.ts";

/**
 * Flat little-endian RAM for CPU tests. Any access outside it throws a
 * RangeError, so a test that strays off its memory fails loudly.
 */
export class TestBus implements Bus {
  readonly base: number;
  readonly ram: Uint8Array;
  private readonly view: DataView;

  // Defaults cover every address the upstream instruction tests touch.
  constructor(base = 0x20000000, size = 0x42000) {
    this.base = base;
    this.ram = new Uint8Array(size);
    this.view = new DataView(this.ram.buffer);
  }

  onBreak = (code: number) => {
    void code;
  };

  private offset(address: number) {
    return (address >>> 0) - this.base;
  }

  readUint8(address: number) {
    return this.view.getUint8(this.offset(address));
  }

  readUint16(address: number) {
    return this.view.getUint16(this.offset(address), true);
  }

  readUint32(address: number) {
    return this.view.getUint32(this.offset(address), true);
  }

  writeUint8(address: number, value: number) {
    this.view.setUint8(this.offset(address), value);
  }

  writeUint16(address: number, value: number) {
    this.view.setUint16(this.offset(address), value, true);
  }

  writeUint32(address: number, value: number) {
    this.view.setUint32(this.offset(address), value, true);
  }
}
