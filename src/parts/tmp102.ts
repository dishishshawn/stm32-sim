// Texas Instruments TMP102 I2C temperature sensor. Behavior from the
// datasheet, SBOS397I (June 2024); § and table numbers below refer to it.
// Pins are the SOT563 pins 1-6 (Table 4-1). V+ and GND are for wiring only:
// power is not simulated, so create() is the power-on reset.
//
// Not simulated: the general call reset (§6.3.8) and the SMBus alert response
// (§6.3.7), which need the part to answer an address other than its own; the
// serial-interface timeout (§6.3.10). The high-speed mode controller code
// (§6.3.9) is NACKed, as on the real part, because no address matches it.
import type { Part } from "./part.ts";

/** Typical conversion time, 10 ms (§5.5, §6.4.1; 15 ms max). */
const T_CONV = 0.01;
/**
 * Seconds per conversion by CR1:CR0: 0.25, 1, 4 (default) or 8 Hz (Table 6-5).
 * Assumed: the period runs from one conversion's start to the next.
 */
const PERIOD = [4, 1, 0.25, 0.125];
/** Consecutive faults that flip the alert, by F1:F0 (Table 6-12). */
const FAULTS = [1, 2, 4, 6];

// Registers by pointer P1:P0 (Table 6-7).
const TEMP = 0;
const CONFIG = 1;
const TLOW = 2;

// CONFIG bits stored as written (Tables 6-10, 6-11). OS, R1 R0 and AL are
// computed on read.
const SD = 0x0100;
const TM = 0x0200;
const POL = 0x0400;
const EM = 0x0010;

export const tmp102: Part = {
  type: "tmp102",
  pins: ["SCL", "GND", "ALERT", "ADD0", "V+", "SDA"],
  props: {
    // The slider. -55 to +150 °C is the operating range (§5.5).
    temperature: { type: "number", default: 25, min: -55, max: 150 },
  },
  create(ctx) {
    let temperature = ctx.props.temperature as number;
    // Power-up state. Temperatures are counts of 0.0625 °C (§6.3.1).
    let temp = 0; // reads 0 °C until the first conversion (§6.3.1)
    let tlow = 75 * 16; // §6.5.4
    let thigh = 80 * 16;
    let config = 0x0080; // CR = 10, 4 Hz; reads 0x60A0 (Tables 6-10, 6-11)
    let converting = true; // power-up starts a conversion at once (§6.4.1, Figure 6-5)
    let sinceStart = 0; // seconds since the current conversion started
    let oneShot = false; // the running conversion is a one-shot
    let os = false; // OS: a one-shot has finished
    let tripped = false; // THIGH reached, TLOW not yet (§6.5.3.8)
    let faults = 0;
    // ALERT latched in interrupt mode. Assumed: only conversions in TM = 1
    // latch it; switching TM doesn't.
    let interrupt = false;
    let pointer = TEMP; // §6.5.1
    let pointerNext = false;
    let byteIndex = 0;
    let latched = 0;

    const has = (bit: number) => (config & bit) !== 0;

    // ADD0 to GND, V+, SDA or SCL answers 1001000b-1001011b (Table 6-4,
    // §7.2.1). Assumed: ADD0 tied to none of these answers no address.
    const address = () => {
      const i = ["GND", "V+", "SDA", "SCL"].findIndex((p) =>
        ctx.sameNet("ADD0", p),
      );
      return i < 0 ? undefined : 0x48 + i;
    };

    // 12-bit left-justified, or 13-bit with EM (Tables 6-8, 6-9, 6-13 to
    // 6-16). Table 6-2: 128 °C reads 7FF in 12 bits. Assumed: so does any
    // value past the 12-bit range, including one kept from extended mode.
    const toWord = (counts: number) =>
      has(EM)
        ? (counts << 3) & 0xffff
        : (Math.max(-0x800, Math.min(counts, 0x7ff)) << 4) & 0xffff;
    const fromWord = (word: number) =>
      ((word << 16) >> 16) >> (has(EM) ? 3 : 4);

    const readRegister = (r: number): number => {
      switch (r) {
        case TEMP:
          return toWord(temp) | (has(EM) ? 1 : 0); // D0 flags EM (Table 6-9)
        case CONFIG:
          // R1 R0 read 11 (§6.5.3.5). AL reads 1 until tripped, inverted by
          // POL, whatever TM is (§6.5.3.8).
          return (
            (os ? 0x8000 : 0) |
            0x6000 |
            config |
            (tripped === has(POL) ? 0x20 : 0)
          );
        case TLOW:
          return toWord(tlow);
        default:
          return toWord(thigh);
      }
    };

    // Open drain (Table 4-1): pulls low when active, or when inactive with
    // POL = 1, active high (§6.5.3.3). Comparator mode follows the
    // comparator; interrupt mode the latch (§6.4.5, §6.5.4).
    const alertActive = () => (has(TM) ? interrupt : tripped);
    const updateAlert = () =>
      ctx.drive("ALERT", alertActive() !== has(POL) ? "low" : "hi-z");

    const startConversion = () => {
      converting = true;
      sinceStart = 0;
    };

    // A conversion stores TEMP and compares it with the limits (§6.5.4). A
    // fault is reaching THIGH, or once tripped falling below TLOW; F1:F0
    // consecutive faults flip the comparator (§6.5.3.4, §6.5.3.8).
    // Assumed: TEMP rounds down to the 0.0625 °C step (Table 6-2 lists
    // exact steps only). Assumed: in interrupt mode each flip latches
    // ALERT; §6.5.4 describes the THIGH-then-TLOW cycle, not a TLOW
    // crossing while still latched.
    const convert = () => {
      temp = Math.floor(temperature * 16);
      faults = (tripped ? temp < tlow : temp >= thigh) ? faults + 1 : 0;
      if (faults >= FAULTS[(config >> 11) & 3]) {
        tripped = !tripped;
        faults = 0;
        if (has(TM)) interrupt = true;
      }
      if (oneShot) {
        oneShot = false;
        os = true;
      }
    };

    const writeByte = (index: number, byte: number) => {
      if (pointer === CONFIG && index === 0) {
        const wasShutdown = has(SD);
        config = (config & 0x00ff) | ((byte & 0x1f) << 8); // F1 F0 POL TM SD
        // Shutdown clears ALERT in interrupt mode (§6.5.4).
        if (has(SD) && !wasShutdown) interrupt = false;
        // Assumed: leaving shutdown starts a conversion at once, as at
        // power-up (Figure 6-5).
        if (!has(SD) && wasShutdown && !converting) startConversion();
        // OS = 1 in shutdown starts one conversion; OS reads 0 until it ends,
        // then 1 (§6.4.4). Assumed: OS written with SD in the same byte
        // starts it too; a conversion already running becomes the one-shot;
        // OS = 1 outside shutdown is ignored; OS stays 1 until the next.
        if (byte & 0x80 && has(SD)) {
          oneShot = true;
          os = false;
          if (!converting) startConversion();
        }
      } else if (pointer === CONFIG) {
        // CR1 CR0 EM. AL is read-only (§6.5.3.8) and D3-D0 read 0 (Table 6-11).
        config = (config & 0xff00) | (byte & 0xd0);
      } else if (pointer !== TEMP) {
        // TLOW, THIGH: the temperature format (§6.5.4), updated byte by byte
        // (§6.5.3). Unused low bits read 0 (Tables 6-14, 6-16).
        const word = toWord(pointer === TLOW ? tlow : thigh);
        const counts = fromWord(
          index === 0 ? (word & 0xff) | (byte << 8) : (word & 0xff00) | byte,
        );
        if (pointer === TLOW) tlow = counts;
        else thigh = counts;
      }
      // Assumed: a data byte to read-only TEMP (Table 6-7) is ACKed and ignored.
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
        write(byte) {
          // The first byte is the pointer (§6.3.5, Figure 6-2); only P1 P0
          // select a register (§6.5.1). Assumed: P7-P2, which "must always
          // be 0" (Table 6-6), are ignored and the byte is ACKed.
          if (pointerNext) {
            pointer = byte & 3;
            pointerNext = false;
            return "ack";
          }
          // Then MSB, LSB, each applied as it arrives (§6.5.3, and §6.3.11
          // "Data Transfer": a STOP after the MSB updates only the MSB). No
          // auto-increment (§6.3.6.1). Assumed: a third byte is the MSB again.
          writeByte(byteIndex++ % 2, byte);
          updateAlert();
          return "ack";
        },
        // MSB, then LSB, of the register the pointer is on; the pointer
        // stays there (§6.3.5, §6.3.6.2). Assumed: the word is latched at the
        // MSB, so a conversion between the bytes can't tear it, and a third
        // byte is the MSB again.
        read() {
          if (byteIndex % 2 === 0) latched = readRegister(pointer);
          const byte = byteIndex++ % 2 === 0 ? latched >> 8 : latched & 0xff;
          // A read of any register clears the interrupt-mode ALERT (§6.5.4).
          // §6.4.5.2 says the temperature register only; we follow §6.5.4.
          interrupt = false;
          updateAlert();
          return byte;
        },
      },
      // Conversions repeat at the CR rate; SD = 1 stops after the current one
      // (§6.4.1, §6.4.3).
      tick(seconds) {
        sinceStart += seconds;
        for (;;) {
          if (converting) {
            if (sinceStart < T_CONV) break;
            converting = false;
            convert();
          }
          const period = PERIOD[(config >> 6) & 3];
          if (has(SD) || sinceStart < period) break;
          sinceStart -= period;
          converting = true;
        }
        updateAlert();
      },
      setProp(name, value) {
        if (name === "temperature") temperature = value as number;
      },
      state: () => ({
        temperature,
        address: address(),
        shutdown: has(SD),
        alert: alertActive(),
      }),
    };
  },
};
