// MCP23017 16-bit I2C I/O expander. Behavior is from Microchip's datasheet
// DS20001952D (2022); § numbers below are its sections. VDD and VSS are not
// simulated (no power model).
//
// Not simulated, so state().notSimulated logs every access that would need it:
// - IOCON.BANK=1: the bit is stored, but registers keep their BANK=0 addresses;
// - interrupt-on-change (GPINTEN, DEFVAL, INTCON): INTF and INTCAP stay 0;
// - the INTA/INTB outputs (IOCON.MIRROR, ODR, INTPOL): both pins stay hi-z.
//
// Not modelled: rev D makes GPA7 and GPB7 output-only (Table 2-1, and the note
// under the IODIR register says IO7 "must be set ... to 0"). Here they still
// work as inputs, like the other pins.
import type { Level } from "../engine/nets.ts";
import type { Part } from "./part.ts";

const GPA = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `GPA${i}`);
const GPB = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `GPB${i}`);
const A = ["A0", "A1", "A2"];

/** The BANK=0 register map, 0x00–0x15 (Table 3-5). IOCON sits at 0x0A and 0x0B. */
const NAMES = (
  "IODIRA IODIRB IPOLA IPOLB GPINTENA GPINTENB DEFVALA DEFVALB INTCONA INTCONB " +
  "IOCON IOCON GPPUA GPPUB INTFA INTFB INTCAPA INTCAPB GPIOA GPIOB OLATA OLATB"
).split(" ");
const IODIRA = 0x00;
const IPOLA = 0x02;
const GPINTENA = 0x04;
const INTCONB = 0x09;
const IOCON = 0x0a;
const GPPUA = 0x0c;
const INTFA = 0x0e;
const INTCAPB = 0x11;
const GPIOA = 0x12;
const OLATA = 0x14;
const LAST = 0x15;
/** IOCON bits (Register 3-5). Bit 0 is unimplemented and reads 0. */
const SEQOP = 0x20;
const IOCON_UNSIMULATED: [number, string][] = [
  [0x80, "IOCON.BANK"],
  [0x40, "IOCON.MIRROR"],
  [0x04, "IOCON.ODR"],
  [0x02, "IOCON.INTPOL"],
];

/** Only a "high" net reads 1. Assumed: floating or conflict reads 0. */
const bit = (level: Level) => (level === "high" ? 1 : 0);

export const mcp23017: Part = {
  type: "mcp23017",
  // The 28-pin SPDIP/SOIC pinout, pin 1 first (Table 2-1). The two NC pins
  // are named by pin number, since pin names must be unique. Rev D's Table 2-1
  // calls pin 12 "SCK" (shared with the SPI MCP23S17); we use the I2C name
  // "SCL" from the functional block diagram.
  pins: [
    ...GPB,
    ..."VDD VSS NC11 SCL SDA NC14 A0 A1 A2 RESET INTB INTA".split(" "),
    ...GPA,
  ],
  props: {},
  create(ctx) {
    const regs = new Uint8Array(LAST + 1);
    let ptr = 0;
    /** The next byte written is the register address (§3.2.2.1, Figure 3-6). */
    let pointerNext = false;
    const notSimulated = new Set<string>();

    const port = (pins: string[]) =>
      pins.reduce((b, pin, i) => b | (bit(ctx.level(pin)) << i), 0);

    // RESET is active-low. Table 2-1 says it "must be externally biased";
    // assumed: floating or conflict holds the part in reset, as low does.
    const inReset = () => ctx.level("RESET") !== "high";

    // 0b0100 A2 A1 A0 (§3.3.1, Figure 3-4), read from the pins every time.
    // Assumed: a floating or conflicting A pin (Table 2-1: "must be externally
    // biased") matches no address.
    const address = () =>
      inReset() || A.some((p) => !["high", "low"].includes(ctx.level(p)))
        ? undefined
        : 0x20 | port(A);

    // An output (IODIR bit 0) drives its OLAT bit push-pull. An input is hi-z,
    // or pulled up (100 kΩ) if its GPPU bit is set (§3.4, §3.5.1, §3.5.7).
    const drivePins = () =>
      [GPA, GPB].forEach((pins, p) =>
        pins.forEach((pin, i) => {
          const m = 1 << i;
          const output = !(regs[IODIRA + p] & m);
          const pullUp = regs[GPPUA + p] & m;
          const high = regs[OLATA + p] & m;
          ctx.drive(
            pin,
            output ? (high ? "high" : "low") : pullUp ? "pull-up" : "hi-z",
          );
        }),
      );

    // Power-on values (Table 3-5): IODIR 0xFF, the rest 0. While RESET is low
    // the outputs are hi-z (Table 1-2, param 34), which IODIR=0xFF gives.
    // Assumed: the register pointer resets to 0x00.
    const powerOn = () => {
      regs.fill(0);
      regs[IODIRA] = regs[IODIRA + 1] = 0xff;
      ptr = 0;
      drivePins();
    };
    powerOn();

    // GPIO reads the pins XOR IPOL (§3.5.2, §3.5.10); an output reads its pin,
    // not OLAT (§3.4). Assumed: IPOL applies to output pins too (§3.5.2 says
    // the GPIO bit "will reflect the inverted value on the pin"; Register 3-1
    // says "input pins"). Assumed: a pointer past 0x15 reads 0.
    const readReg = (r: number) =>
      r === GPIOA || r === GPIOA + 1
        ? port(r === GPIOA ? GPA : GPB) ^ regs[IPOLA + r - GPIOA]
        : (regs[r === IOCON + 1 ? IOCON : r] ?? 0);

    // Assumed: a pointer past 0x15 ignores writes.
    const writeReg = (r: number, v: number) => {
      if (r === IOCON + 1) r = IOCON;
      if (r === GPIOA || r === GPIOA + 1) r += OLATA - GPIOA; // to OLAT (§3.4)
      if (r > LAST || (r >= INTFA && r <= INTCAPB)) return; // INTF, INTCAP: read-only (§3.5.8, §3.5.9)
      regs[r] = r === IOCON ? v & 0xfe : v;
      drivePins();
    };

    const log = (r: number, written?: number) => {
      if (r > LAST) notSimulated.add(`register 0x${r.toString(16)}`);
      else if (
        (r >= GPINTENA && r <= INTCONB) ||
        (r >= INTFA && r <= INTCAPB)
      ) {
        notSimulated.add(NAMES[r]);
      } else if (written !== undefined && NAMES[r] === "IOCON") {
        for (const [m, name] of IOCON_UNSIMULATED)
          if (written & m) notSimulated.add(name);
      }
    };

    // Sequential mode (SEQOP=0) increments, rolling over to 0x00 after the
    // last register (§3.2.1, §3.2.2.3). Byte mode (SEQOP=1) with BANK=0
    // toggles between the A/B pair, e.g. GPIOA <-> GPIOB (§3.2.1).
    const advance = () => {
      ptr = regs[IOCON] & SEQOP ? ptr ^ 1 : ptr >= LAST ? 0 : ptr + 1;
    };

    return {
      onLevel(pin) {
        if (pin === "RESET" && inReset()) powerOn();
      },
      i2c: {
        sda: "SDA",
        scl: "SCL",
        address,
        start() {
          pointerNext = true;
        },
        write(byte) {
          if (inReset()) return "nack";
          if (pointerNext) {
            ptr = byte;
            pointerNext = false;
          } else {
            log(ptr, byte);
            writeReg(ptr, byte);
            advance();
          }
          return "ack";
        },
        read() {
          if (inReset()) return 0xff;
          log(ptr);
          const v = readReg(ptr);
          advance();
          return v;
        },
      },
      state: () => ({
        reset: inReset(),
        address: address(),
        GPA: GPA.map((p) => ctx.level(p)),
        GPB: GPB.map((p) => ctx.level(p)),
        registers: Object.fromEntries(NAMES.map((n, r) => [n, readReg(r)])),
        notSimulated: [...notSimulated],
      }),
    };
  },
};
