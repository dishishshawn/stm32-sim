// Microchip TC74 I2C temperature sensor. Behavior from the datasheet,
// DS21462D (§ and table numbers below refer to it). Pins are the TO-220-5
// pins 1-5 (Table 2-1). VDD and GND are for wiring only: power is not
// simulated, so create() is power-on reset.
import type { Part } from "./part.ts";

const VARIANTS: readonly string[] = [
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
];

/**
 * Nominal conversion rate, 8 samples/s (§1.0 DC Characteristics, CR typ).
 * The minimum is 4 SPS, and Note 2 allows up to 250 ms from POR to DATA_RDY.
 */
const T_CONV = 1 / 8;

/** Table 4-4: rounds down (+126.5 reads 126, -25.25 reads -26) and +130 reads +127. */
function toRegister(celsius: number): number {
  // Assumed: below -65 °C (the table's last row, and the storage minimum) reads -65.
  return Math.min(127, Math.max(-65, Math.floor(celsius))) & 0xff;
}

export const tc74: Part = {
  type: "tc74",
  pins: ["NC", "SDA", "GND", "SCLK", "VDD"],
  props: {
    // TC74A0-A7 answer 1001 000b-1001 111b; A5 is the default address (§3.1.2, §5.1).
    variant: { type: "string", default: "A5", options: VARIANTS },
    // The slider. -65 to +150 °C is the storage range (§1.1).
    temperature: { type: "number", default: 25, min: -65, max: 150 },
  },
  create(ctx) {
    const address = 0x48 + VARIANTS.indexOf(ctx.props.variant as string);
    let temperature = ctx.props.temperature as number;
    // Power-on state (Table 4-2, Table 4-5): TEMP 0, CONFIG 0, pointer on TEMP.
    let temp = 0;
    let shutdown = false;
    let ready = false;
    let sinceConversion = 0;
    let pointer = 0x00;
    let pointerNext = false;

    const config = () => (shutdown ? 0x80 : 0) | (ready ? 0x40 : 0);

    return {
      i2c: {
        sda: "SDA",
        scl: "SCLK",
        address: () => address,
        start() {
          pointerNext = true;
        },
        // The command byte sets the pointer; a data byte goes to that register
        // (Figure 3-1). Assumed: applied at once, though Figure 1-1 marks STOP as
        // "Data Executed by Slave".
        write(byte) {
          if (pointerNext) {
            pointer = byte;
            pointerNext = false;
          } else if (pointer === 0x01) {
            // Only SHDN is writable (Table 4-2). Entering standby clears
            // DATA_RDY (Table 4-2 note 1); leaving it starts a new conversion,
            // and DATA_RDY returns after it (Figure 4-1).
            const shdn = (byte & 0x80) !== 0;
            if (shdn && !shutdown) ready = false;
            if (!shdn && shutdown) sinceConversion = 0;
            shutdown = shdn;
          }
          // Assumed: a data byte to TEMP (read-only, Table 4-5) or to an
          // undefined command code is ACKed and ignored.
          return "ack";
        },
        // No auto-increment: every byte is the register the pointer is on
        // (Receive Byte, Figure 3-1). Assumed: undefined command codes read 0.
        read: () => (pointer === 0x00 ? temp : pointer === 0x01 ? config() : 0),
      },
      // Standby halts the A/D and freezes TEMP (§3.1.1). Otherwise a
      // conversion completes every T_CONV, setting DATA_RDY and TEMP (Table 4-5 note 1).
      tick(seconds) {
        if (shutdown) return;
        sinceConversion += seconds;
        if (sinceConversion < T_CONV) return;
        sinceConversion %= T_CONV;
        ready = true;
        temp = toRegister(temperature);
      },
      setProp(name, value) {
        if (name === "temperature") temperature = value as number;
      },
      state: () => ({ temperature, shutdown, dataReady: ready }),
    };
  },
};
