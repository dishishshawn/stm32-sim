// I2C1: the STM32 "v2" I2C, as a bus controller (master) with 7-bit addresses.
// Behavior is from RM0444 Rev 6 chapter 32; § numbers below are RM0444's. It
// drives an I2cBus (src/engine/i2c.ts) on its own signals "mcu.I2C1_SCL" and
// "mcu.I2C1_SDA", which GPIO joins to a pin only while the pin is in AF mode
// with the right AF number. So a pin that isn't routed leaves the lines
// floating: never idle, BUSY, and START never goes out. Choices, and what isn't
// simulated, are recorded in docs/decisions.md §12.
import { I2cBus } from "../engine/i2c.ts";
import type { Ack } from "../engine/i2c.ts";
import type { Peripheral, Registers } from "./peripheral.ts";
import { clocks, HSI16_HZ } from "./rcc.ts";

// I2C_CR1 (§32.9.1)
const PE = 1 << 0;
// I2C_CR2 (§32.9.2)
const RD_WRN = 1 << 10;
const START = 1 << 13;
const STOP = 1 << 14;
const NACK = 1 << 15;
const AUTOEND = 1 << 25;
const PECBYTE = 1 << 26;
// I2C_ISR (§32.9.7)
const TXE = 1 << 0;
const TXIS = 1 << 1;
const RXNE = 1 << 2;
const NACKF = 1 << 4;
const STOPF = 1 << 5;
const TC = 1 << 6;
const BUSY = 1 << 15;
/** The ISR bits PE = 0 clears (§32.4.6): bits 1-13 and BUSY. TXE is set instead. */
const PE_RESET_FLAGS = 0xbffe;
/** I2C_ICR (§32.9.8): each bit clears the ISR flag at the same position. */
const ICR_FLAGS = 0x3f38;
const ADDRCF = 1 << 3;
/** RCC_APBENR1.I2C1EN, the clock gate. */
const I2C1EN = 1 << 21;

/**
 * Fields that select behavior the simulator doesn't model, by register and bit:
 * interrupts and DMA (§32.6, §32.7), target mode, SMBus, 10-bit addresses and
 * reload mode. Setting one is logged as an "unsimulated" event.
 */
const NOT_SIMULATED: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  CR1: {
    TXIE: 1,
    RXIE: 2,
    ADDRIE: 3,
    NACKIE: 4,
    STOPIE: 5,
    TCIE: 6,
    ERRIE: 7,
    TXDMAEN: 14,
    RXDMAEN: 15,
    SBC: 16,
    NOSTRETCH: 17,
    WUPEN: 18,
    GCEN: 19,
    SMBHEN: 20,
    SMBDEN: 21,
    ALERTEN: 22,
    PECEN: 23,
  },
  CR2: { ADD10: 11, NACK: 15, RELOAD: 24, PECBYTE: 26 },
  OAR1: { OA1EN: 15 },
  OAR2: { OA2EN: 15 },
  TIMEOUTR: { TIMOUTEN: 15, TEXTEN: 31 },
};

/**
 * What the controller is doing. "addr", "byte" and "stop" are on the wire until
 * `due`; "tx" and "tc" hold SCL low until the firmware acts (§32.4.7, §32.4.9).
 */
type State = "idle" | "addr" | "byte" | "stop" | "tx" | "tc";

/**
 * SCL period in I2CCLK cycles (§32.4.9): tSYNC1 + tSYNC2 + [(SCLH + 1) +
 * (SCLL + 1)] × (PRESC + 1). tSYNC1 + tSYNC2 is taken as its 4-cycle minimum
 * (Table 173 note 2) plus the digital filter's DNF on each edge. Assumed: the
 * analog filter adds nothing. SDADEL and SCLDEL stretch only when they outlast
 * SCLL, so they're left out. `coreCycles` turns I2CCLK cycles into core cycles.
 */
function sclCycles(regs: Registers): number {
  const t = regs.TIMINGR;
  const presc = (t >>> 28) + 1;
  const dnf = (regs.CR1 >>> 8) & 0xf;
  return (((t >>> 8) & 0xff) + 1 + (t & 0xff) + 1) * presc + 2 * (2 + dnf);
}

export const i2c1: Peripheral = {
  name: "I2C1",
  gate: { register: "RCC.APBENR1", field: "I2C1EN" },
  create({ regs, nets, regsOf, now, parts, events }) {
    const rcc = regsOf("RCC");
    /**
     * Core cycles for `n` I2CCLK cycles at the clocks of the moment, rounded:
     * events carry whole cycles. I2CCLK is RCC_CCIPR.I2C1SEL's choice (RM0444
     * §5.4.21): 00 PCLK, 01 SYSCLK, 10 HSI16. Assumed: 11 (reserved) acts as 00.
     */
    const coreCycles = (n: number) => {
      const c = clocks(rcc);
      const sel = (rcc.CCIPR >>> 12) & 3;
      return Math.round(
        (n * c.hclk) / (sel === 1 ? c.sysclk : sel === 2 ? HSI16_HZ : c.pclk),
      );
    };
    let state: State = "idle";
    /** When the step on the wire ends, in cycles. */
    let due = 0;
    /** The time the bus trace stamps: the cycle the current step happened at. */
    let at = 0;
    // Latched from CR2 at each START (§32.4.9: they mustn't change while START is set).
    let addr = 0;
    let reading = false;
    let nbytes = 0;
    /** Bytes started in this transfer. */
    let count = 0;
    /** The byte being sent: TXDR's content, copied when the byte starts (§32.4.7). */
    let shift = 0;

    const bus = new I2cBus({
      nets,
      sda: "mcu.I2C1_SDA",
      scl: "mcu.I2C1_SCL",
      parts,
      now: () => at,
      trace(step) {
        if (events.active)
          events.emit({ kind: "i2c", cycle: step.t, periph: "I2C1", step });
      },
    });

    const logUnsimulated = (reg: string, value: number) => {
      if (!events.active) return;
      for (const [field, bit] of Object.entries(NOT_SIMULATED[reg])) {
        if ((value >>> bit) & 1) {
          const feature = `${reg}.${field}`;
          events.emit({
            kind: "unsimulated",
            cycle: now(),
            periph: "I2C1",
            feature,
          });
        }
      }
    };
    const store = (reg: string) => (value: number) => {
      regs[reg] = value;
      logUnsimulated(reg, value);
    };

    const set = (flags: number) => (regs.ISR = (regs.ISR | flags) >>> 0);
    const clear = (flags: number) => (regs.ISR = (regs.ISR & ~flags) >>> 0);
    const onWire = (s: State, i2cclk: number) => {
      state = s;
      due = at + coreCycles(i2cclk);
    };

    /** START (or a repeated START) and the address byte. Counted as 10 SCL periods. */
    const startAddress = () => {
      const cr2 = regs.CR2;
      // 7-bit addressing: SADD[7:1] is the address (§32.9.2).
      addr = (cr2 >>> 1) & 0x7f;
      reading = (cr2 & RD_WRN) !== 0;
      nbytes = (cr2 >>> 16) & 0xff;
      count = 0;
      bus.start();
      onWire("addr", 10 * sclCycles(regs));
    };
    const startByte = () => {
      count++;
      if (!reading) {
        // §32.4.7: TXDR is copied to the shift register and TXE is set. TXIS asks
        // for the next byte at once, if one is due (Figure 303, EV1 and EV2).
        shift = regs.TXDR;
        set(TXE | (count < nbytes ? TXIS : 0));
      }
      onWire("byte", 9 * sclCycles(regs));
    };
    const startStop = () => onWire("stop", sclCycles(regs));

    /** After an ACKed address or byte (§32.4.9, controller transmitter and receiver). */
    const afterAck = () => {
      // §32.9.2: a STOP the firmware asked for goes out after the current byte.
      if (regs.CR2 & STOP) startStop();
      else if (count < nbytes) {
        if (reading || !(regs.ISR & TXE)) startByte();
        else {
          set(TXIS);
          state = "tx"; // §32.4.7: SCL stretched until TXDR is written
        }
      } else if (regs.CR2 & AUTOEND) startStop();
      else {
        set(TC);
        state = "tc";
      }
    };

    /** The step on the wire ends at `at`. */
    const finish = () => {
      if (state === "stop") {
        bus.stop();
        // §32.9.2: a STOP clears STOP, NACK and PECBYTE.
        regs.CR2 = (regs.CR2 & ~(STOP | NACK | PECBYTE)) >>> 0;
        set(STOPF);
        state = "idle";
        return;
      }
      let ack: Ack;
      if (state === "addr") {
        // §32.9.2: START is cleared once the address is sent, whatever the ACK.
        regs.CR2 = (regs.CR2 & ~START) >>> 0;
        ack = bus.address(addr, reading);
      } else if (reading) {
        // §32.4.9: the controller NACKs the last byte of the transfer. Its own
        // ACK or NACK doesn't stop the transfer.
        regs.RXDR = bus.read(count === nbytes ? "nack" : "ack");
        set(RXNE);
        ack = "ack";
      } else {
        ack = bus.write(shift);
      }
      if (ack === "ack") return afterAck();
      // §32.4.9: on a NACK, NACKF is set, TXIS isn't, and a STOP is sent
      // automatically, whatever AUTOEND says.
      set(NACKF);
      startStop();
    };

    /** Leave a waiting state if the firmware has done what it waits for. */
    const resume = (): boolean => {
      const cr2 = regs.CR2;
      if (state === "idle") {
        // §32.4.9: START goes out once the bus is free. Assumed
        // (decisions.md §12): free means both lines are high now.
        if (!(cr2 & START) || !bus.isIdle()) return false;
        startAddress();
      } else if (cr2 & STOP) startStop();
      else if (state === "tx") {
        if (regs.ISR & TXE) return false;
        startByte();
      } else {
        // "tc": §32.4.9, setting START sends a repeated START.
        if (!(cr2 & START)) return false;
        startAddress();
      }
      return true;
    };

    const disable = () => {
      // §32.4.6: clearing PE releases the lines and resets the state machine,
      // CR2's START, STOP, PECBYTE and NACK, and the ISR flags; TXE is set.
      // Assumed: a transfer cut off this way puts no STOP on the bus.
      state = "idle";
      regs.CR2 = (regs.CR2 & ~(START | STOP | PECBYTE | NACK)) >>> 0;
      regs.ISR = ((regs.ISR & ~PE_RESET_FLAGS) | TXE) >>> 0;
    };

    return {
      reset() {
        state = "idle";
      },

      tick() {
        if (!(regs.CR1 & PE) || !(rcc.APBENR1 & I2C1EN)) return;
        const t = now();
        at = t;
        for (;;) {
          if (state === "addr" || state === "byte" || state === "stop") {
            if (t < due) break;
            // §32.4.7: with RXNE still set, SCL is stretched before the ACK
            // until RXDR is read.
            if (state === "byte" && reading && regs.ISR & RXNE) {
              due = t;
              break;
            }
            at = due;
            finish();
          } else if (!resume()) break;
        }
        // §32.9.7: BUSY is set by a START and cleared by a STOP. Assumed
        // (decisions.md §12): a line that isn't high also reads BUSY.
        if (state !== "idle" || !bus.isIdle()) set(BUSY);
        else clear(BUSY);
      },

      write: {
        CR1(value) {
          const wasOn = regs.CR1 & PE;
          store("CR1")(value);
          if (wasOn && !(value & PE)) disable();
        },
        CR2(value) {
          logUnsimulated("CR2", value);
          const sticky = START | STOP | NACK | PECBYTE;
          // §32.9.2: writing 0 to START, STOP, NACK or PECBYTE has no effect.
          // Assumed: while PE = 0 they stay cleared ("cleared ... when PE = 0").
          regs.CR2 =
            (regs.CR1 & PE ? value | (regs.CR2 & sticky) : value & ~sticky) >>>
            0;
          // §32.9.7: TC is cleared when software sets START or STOP.
          if (value & (START | STOP)) clear(TC);
        },
        OAR1: store("OAR1"),
        OAR2: store("OAR2"),
        TIMEOUTR: store("TIMEOUTR"),
        // §32.9.5: "must be configured when the I2C peripheral is disabled
        // (PE = 0)", without saying what a write with PE = 1 does. Assumed, per
        // As on silicon, never "fixed" for the firmware: it is ignored, silently.
        TIMINGR(value) {
          if (!(regs.CR1 & PE)) regs.TIMINGR = value;
        },
        // §32.9.7: only TXE is writable, to 1, which flushes TXDR. (TXIS is
        // writable with NOSTRETCH = 1, target mode only.)
        ISR(value) {
          if (value & TXE) set(TXE);
        },
        ICR(value) {
          clear(value & ICR_FLAGS);
          // §32.9.8: ADDRCF also clears CR2.START.
          if (value & ADDRCF) regs.CR2 = (regs.CR2 & ~START) >>> 0;
        },
        PECR() {}, // read-only
        RXDR() {}, // read-only
        // §32.9.11: TXDATA "can be written only when TXE = 1"; otherwise the
        // write is ignored. Writing it clears TXE and TXIS (§32.9.7). Assumed:
        // ignored while PE = 0, where TXE is held set.
        TXDR(value) {
          if (!(regs.CR1 & PE) || !(regs.ISR & TXE)) return;
          regs.TXDR = value & 0xff;
          clear(TXE | TXIS);
        },
      },
      read: {
        ICR: () => 0, // write-only
        // §32.9.7: reading RXDR clears RXNE.
        RXDR() {
          clear(RXNE);
          return regs.RXDR;
        },
      },
    };
  },
};
