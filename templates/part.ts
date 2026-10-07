// TEMPLATE: a minimal I2C part. Copy it to src/parts/<your-part>.ts and follow
// docs/adding-a-part.md. Each "TEMPLATE:" comment says what to change; delete
// those comments when you are done. The worked example is src/parts/tc74.ts.
//
// LX01 is a made-up I2C ambient-light sensor, so that this template has a
// concrete device to model. It has no datasheet: in your part, cite the
// datasheet's section or table for each behavior, and write "Assumed:" before
// anything the datasheet doesn't settle.
//
// LX01 register map (8-bit registers, one pointer):
//   0x00 ID      read-only, reads 0xA1
//   0x01 CONFIG  read/write, reset value 0x00 (stored only; it changes nothing)
//   0x02 DATA_H  read-only, light level in lux, bits 15-8
//   0x03 DATA_L  read-only, light level in lux, bits 7-0
// The first byte written after a START sets the pointer. Every data byte read
// or written after that moves the pointer on by one.
//
// VDD and GND are for wiring only: power is not simulated, so create() is the
// power-on reset.
import type { Part } from "../src/parts/part.ts"; // TEMPLATE: in src/parts/ this is "./part.ts"

// TEMPLATE: your datasheet's register addresses and fixed values.
const ID = 0x00;
const CONFIG = 0x01;
const DATA_H = 0x02;
const DATA_L = 0x03;
const ID_VALUE = 0xa1;

// TEMPLATE: rename the export and `type` after your part, e.g. `tmp102` / "tmp102".
export const lx01: Part = {
  /** The "type" used in circuit JSON. */
  type: "lx01",
  // TEMPLATE: the pin names from the datasheet's pin table, each one unique.
  pins: ["VDD", "GND", "SDA", "SCL", "ADDR"],
  props: {
    // The slider: what the sensor measures. TEMPLATE: your quantity and its range.
    lux: { type: "number", default: 100, min: 0, max: 65535 },
  },
  create(ctx) {
    // Props arrive validated, with defaults filled in, typed as PropValue.
    let lux = ctx.props.lux as number;
    // Power-on state. TEMPLATE: the datasheet's reset values.
    let config = 0x00;
    let pointer = ID;
    /** True from a START until the first byte written: that byte is the pointer. */
    let pointerNext = false;

    // ADDR low answers 0x44, ADDR high 0x45. Asked at every address phase, so
    // it follows the pin at run time. Assumed: a floating ADDR (or a short)
    // answers no address, so every transfer NACKs.
    const address = () => {
      const addr = ctx.level("ADDR");
      return addr === "low" ? 0x44 : addr === "high" ? 0x45 : undefined;
    };

    // TEMPLATE: one case per readable register. Assumed: addresses past
    // DATA_L read 0.
    const readRegister = (r: number): number => {
      const counts = Math.floor(lux); // 1 count per lux
      switch (r) {
        case ID:
          return ID_VALUE;
        case CONFIG:
          return config;
        case DATA_H:
          return counts >> 8;
        case DATA_L:
          return counts & 0xff;
        default:
          return 0;
      }
    };

    return {
      i2c: {
        sda: "SDA",
        scl: "SCL",
        address,
        start() {
          pointerNext = true;
        },
        write(byte) {
          if (pointerNext) {
            pointer = byte;
            pointerNext = false;
            return "ack";
          }
          // TEMPLATE: one branch per writable register. Assumed: a write to a
          // read-only or undefined register is ACKed and ignored.
          if (pointer === CONFIG) config = byte;
          pointer = (pointer + 1) & 0xff;
          return "ack";
        },
        // No reset of the pointer between transfers: a read that skips setting
        // it starts wherever the last transfer left it, as on the real part.
        read() {
          const byte = readRegister(pointer);
          pointer = (pointer + 1) & 0xff;
          return byte;
        },
      },
      // The slider moved. TEMPLATE: if the datasheet gives a conversion time,
      // store the value here and copy it into the register in tick(), as
      // src/parts/tc74.ts does.
      setProp(name, value) {
        if (name === "lux") lux = value as number;
      },
      // What `sim inspect` and tests show for this part.
      state: () => ({ lux, address: address() }),
    };
  },
};
