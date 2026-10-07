// Microchip MCP9808 I2C temperature sensor. Behavior from the datasheet,
// DS20005095B (§, table, register and figure numbers below refer to it).
// Pins are the MSOP-8 pins 1-8 (Table 3-1); the DFN's exposed pad (EP, pin 9)
// is joined to GND inside the chip (§3.7), so it is not a pin here. VDD and
// GND are for wiring only: power is not simulated, so create() is power-on reset.
//
// Registers (Register 5-1, Table 5-1): 16-bit, MSB first, except RESOLUTION.
//   0x00 RFU         read-only, 0x001F      0x05 TA          read-only
//   0x01 CONFIG      read/write             0x06 Manuf. ID   read-only, 0x0054
//   0x02 TUPPER      read/write             0x07 Device ID   read-only, 0x0400
//   0x03 TLOWER      read/write             0x08 RESOLUTION  8-bit, read/write
//   0x04 TCRIT       read/write
//
// Not simulated:
// - the Alert output (§5.2.3): the pin stays hi-z, CONFIG's Alert Stat. reads
//   0 and Int. Clear does nothing. CONFIG's alert bits are stored, with their
//   locks, and state().notSimulated lists "Alert output" once Alert Cnt. is
//   set. The TA<15:13> flags are simulated: they don't depend on the alert
//   setup (Register 5-4 note 1).
// - the factory-option address code 1001 A2 A1 A0 (Table 3-2 note 2);
// - the SMBus time-out, tOUT (§4.1.7): the bus is simulated a step at a time;
// - the test and calibration registers behind the reserved pointers
//   (Register 5-1): see write() below.
import type { Part } from "./part.ts";

const RFU = 0x00;
const CONFIG = 0x01;
const TUPPER = 0x02;
const TLOWER = 0x03;
const TCRIT = 0x04;
const TA = 0x05;
const MANUFACTURER_ID = 0x06;
const DEVICE_ID = 0x07;
const RESOLUTION = 0x08;

// CONFIG bits (Register 5-2).
const SHDN = 0x0100;
const CRIT_LOCK = 0x0080;
const WIN_LOCK = 0x0040;
const ALERT_CNT = 0x0008;
const ALERT_SEL = 0x0004;
/** THYST (bits 10-9), Alert Cnt., Alert Pol. and Alert Mod.: held while either Lock bit is set. */
const HELD_BY_EITHER_LOCK = 0x0600 | 0x000b;

/** tCONV by Resolution<1:0>: 30, 65, 130, 250 ms typical (Table 5-2, Register 5-7). */
const T_CONV = [0.03, 0.065, 0.13, 0.25];
/** THYST by CONFIG<10:9>: 0, +1.5, +3, +6 °C (Register 5-2), in 1/16 °C. */
const HYST = [0, 24, 48, 96];

/** Bits 12-0 as a 13-bit two's complement number of 1/16 °C (Registers 5-3, 5-4). */
const signed13 = (v: number) => ((v & 0x1fff) ^ 0x1000) - 0x1000;

export const mcp9808: Part = {
  type: "mcp9808",
  pins: ["SDA", "SCL", "Alert", "GND", "A2", "A1", "A0", "VDD"],
  props: {
    // The slider. -40 to +125 °C is the operating range (Temperature Characteristics).
    temperature: { type: "number", default: 25, min: -40, max: 125 },
  },
  create(ctx) {
    let temperature = ctx.props.temperature as number;
    // Power-on state (Table 5-3). The pointer powers up as 0x00 (Register 5-1, W-0).
    let config = 0x0000;
    let tupper = 0x0000;
    let tlower = 0x0000;
    let tcrit = 0x0000;
    let ta = 0x0000;
    // +0.0625 °C (Register 5-7, Table 5-2, Table 5-3), although Register 5-4
    // note 2 says the power-up default is 0.25 °C/bit.
    let resolution = 0x03;
    let sinceConversion = 0;
    let pointer = RFU;
    /** True from a START until the first byte written: that byte is the pointer. */
    let pointerNext = false;
    /** Data bytes since the START: even is an MSB, odd an LSB. */
    let byteIndex = 0;
    let latched = 0;
    let msb = 0;
    const notSimulated = new Set<string>();

    // 0011 A2 A1 A0 (§4.1.4, Table 3-2), read from the pins every time.
    // Assumed: a floating or conflicting A pin matches no address.
    const address = () => {
      const levels = ["A2", "A1", "A0"].map((p) => ctx.level(p));
      if (levels.some((l) => l !== "high" && l !== "low")) return undefined;
      return levels.reduce((a, l) => (a << 1) | (l === "high" ? 1 : 0), 0b0011);
    };

    // A conversion loads TA (§5.1.3): 1/16 °C per LSB, with the bits below the
    // resolution clear (Register 5-4 note 2). Assumed: the ADC rounds down.
    // The flags follow Figure 5-10: each sets past its limit, and hysteresis
    // applies only as the temperature falls (§5.2.2): TCRIT clears below
    // TCRIT - THYST, TUPPER at or below TUPPER - THYST, and TLOWER sets below
    // TLOWER - THYST. Assumed: the flags change only at a conversion, not when
    // a limit is written.
    const convert = () => {
      const step = 1 << (3 - resolution);
      const t = Math.floor((temperature * 16) / step) * step;
      const hyst = HYST[(config >> 9) & 3];
      const crit = t >= signed13(tcrit) - (ta & 0x8000 ? hyst : 0);
      const upper = t > signed13(tupper) - (ta & 0x4000 ? hyst : 0);
      const lower = t < signed13(tlower) - (ta & 0x2000 ? 0 : hyst);
      ta =
        (crit ? 0x8000 : 0) |
        (upper ? 0x4000 : 0) |
        (lower ? 0x2000 : 0) |
        (t & 0x1fff);
    };

    // Register 5-2. The Lock bits stay set until power-on reset; while either
    // is set, THYST, Alert Cnt., Alert Pol. and Alert Mod. can't change and
    // SHDN can be cleared but not set (§5.2.1). Win. Lock also holds Alert Sel.
    // Int. Clear reads 0 and Alert Stat. is read-only, so neither is stored.
    // Assumed: the locks that count are those set before this write.
    const writeConfig = (v: number) => {
      const locked = (config & (CRIT_LOCK | WIN_LOCK)) !== 0;
      let next = config | (v & (CRIT_LOCK | WIN_LOCK));
      if (!locked)
        next = (next & ~HELD_BY_EITHER_LOCK) | (v & HELD_BY_EITHER_LOCK);
      if (!(config & WIN_LOCK)) next = (next & ~ALERT_SEL) | (v & ALERT_SEL);
      if (!(v & SHDN)) next &= ~SHDN;
      else if (!locked) next |= SHDN;
      // Assumed: leaving shutdown starts a new conversion, done after tCONV.
      if (config & SHDN && !(next & SHDN)) sinceConversion = 0;
      config = next;
      if (config & ALERT_CNT) notSimulated.add("Alert output");
    };

    // Limits keep bits 12-2 (Register 5-3). Win. Lock holds TUPPER and
    // TLOWER, Crit. Lock holds TCRIT (Register 5-2 bits 7-6). Assumed: a write
    // to a locked or read-only register is ACKed and ignored.
    const writeRegister = (r: number, v: number) => {
      if (r === CONFIG) writeConfig(v);
      else if (r === TUPPER && !(config & WIN_LOCK)) tupper = v & 0x1ffc;
      else if (r === TLOWER && !(config & WIN_LOCK)) tlower = v & 0x1ffc;
      else if (r === TCRIT && !(config & CRIT_LOCK)) tcrit = v & 0x1ffc;
    };

    // Table 5-1. Assumed: register 0x00 (RFU, "Read-Only register") always
    // reads Table 5-1's 0x001F; §5.1.6 says the resolution is "also reflected in
    // the Capability register", which this datasheet doesn't define.
    const readRegister = (r: number): number => {
      switch (r) {
        case RFU:
          return 0x001f;
        case CONFIG:
          return config;
        case TUPPER:
          return tupper;
        case TLOWER:
          return tlower;
        case TCRIT:
          return tcrit;
        case TA:
          return ta;
        case MANUFACTURER_ID:
          return 0x0054; // §5.1.4
        case DEVICE_ID:
          return 0x0400; // §5.1.5: device ID 0x04, revision 0x00
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
          byteIndex = 0;
        },
        // The first byte is the Register Pointer (§5.1, Figure 5-2). Pointers
        // past 0x08, and any with bits 7-4 set, are reserved for test and
        // calibration (Register 5-1). Assumed: those read 0 and ignore writes.
        // A 16-bit register is written MSB, then LSB (Figure 5-4). Assumed: it
        // changes once its LSB is in (a STOP after the MSB changes nothing),
        // and a third byte starts the register again.
        write(byte) {
          if (pointerNext) {
            pointer = byte;
            pointerNext = false;
            if (pointer > RESOLUTION)
              notSimulated.add(`register 0x${pointer.toString(16)}`);
          } else if (pointer === RESOLUTION) {
            resolution = byte & 0x03; // bits 7-2 read 0 (Register 5-7)
          } else {
            if (byteIndex % 2 === 0) msb = byte;
            else writeRegister(pointer, (msb << 8) | byte);
            byteIndex++;
          }
          return "ack";
        },
        // No auto-increment: the pointer stays where it was set, and a read
        // without setting it reads that register again (§4.1.1). MSB first,
        // then LSB (Figure 5-5), latched at the MSB so a conversion between
        // the two bytes can't mix two readings (TA is double-buffered, §5.1.3).
        // Assumed: a third byte starts the register again, and every byte of
        // 8-bit RESOLUTION is RESOLUTION.
        read() {
          if (pointer === RESOLUTION) return resolution;
          if (byteIndex % 2 === 0) latched = readRegister(pointer);
          const byte = byteIndex % 2 === 0 ? latched >> 8 : latched & 0xff;
          byteIndex++;
          return byte;
        },
      },
      // Shutdown stops conversions and TA keeps its last reading (§5.1.1,
      // §5.2.1). Otherwise a conversion completes every tCONV (Table 5-2).
      // Assumed: the first one is tCONV after power-on, with TA 0 until then
      // (Table 5-3), and a resolution change applies to the conversion in progress.
      tick(seconds) {
        if (config & SHDN) return;
        sinceConversion += seconds;
        const tconv = T_CONV[resolution];
        if (sinceConversion < tconv) return;
        sinceConversion %= tconv;
        convert();
      },
      setProp(name, value) {
        if (name === "temperature") temperature = value as number;
      },
      state: () => ({
        temperature,
        address: address(),
        shutdown: (config & SHDN) !== 0,
        resolution: 0.5 / 2 ** resolution,
        notSimulated: [...notSimulated],
      }),
    };
  },
};
