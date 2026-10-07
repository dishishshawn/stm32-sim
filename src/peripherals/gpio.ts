// GPIO ports: one implementation for every port. Each pin the package has drives
// its endpoint ("mcu.PA0") from MODER, OTYPER, PUPDR and ODR, and IDR follows the
// endpoints' levels. In AF mode, AFRL/AFRH route a pin to a peripheral signal: a
// switch joins "mcu.PB6" to "mcu.I2C1_SCL" while the pin selects it in the chip's
// AF table. OSPEEDR and LCKR are plain storage.
// Choices are recorded in docs/decisions.md §9 and §12.
import type { Drive } from "../engine/nets.ts";
import type { ClockGate, Peripheral, Registers } from "./peripheral.ts";

const OUTPUT = 1;
const AF = 2;
const ANALOG = 3;

/**
 * The chip's alternate functions that the simulator routes: per pin, AF number
 * → peripheral signal, e.g. `{ PB6: { 6: "I2C1_SCL" } }`. The signal's endpoint
 * is "mcu.<signal>".
 */
export type AfTable = Readonly<
  Record<string, Readonly<Record<number, string>>>
>;

/**
 * A GPIO port. `name` is its SVD name ("GPIOA"). Of the package's `pins`, it
 * drives the ones on this port; the others don't exist on the package.
 */
export function gpio(
  name: string,
  gate: ClockGate,
  pins: readonly string[],
  af: AfTable,
): Peripheral {
  const port = `P${name.slice(4)}`; // "GPIOA" → "PA"
  const bonded = pins.flatMap((p) =>
    p.startsWith(port) ? [Number(p.slice(port.length))] : [],
  );
  const endpoint = (n: number) => `mcu.${port}${n}`;
  const routes = bonded.flatMap((n) =>
    Object.entries(af[`${port}${n}`] ?? {}).map(([num, signal]) => ({
      n,
      af: Number(num),
      signal: `mcu.${signal}`,
    })),
  );

  return {
    name,
    gate,
    create({ regs, nets }) {
      /** The drive this port last put on each pin. */
      const driven: Drive[] = [];

      const updateIdr = () => {
        let idr = 0;
        for (const n of bonded) {
          // Analog mode disconnects the input: it reads 0 (RM0444 §7.3, assumed).
          // Assumed: a floating or conflicting net reads 0, like low.
          if (mode(regs, n) !== ANALOG && nets.level(endpoint(n)) === "high")
            idr |= 1 << n;
        }
        regs.IDR = idr;
      };

      const update = () => {
        for (const n of bonded) {
          const d = pinDrive(regs, n);
          // Only on a change, so writes to other pins don't undo what an AF
          // peripheral drives on this one.
          if (driven[n] !== d) nets.drive(endpoint(n), (driven[n] = d));
        }
        // The pin's PUPDR pull stays on it, so the signal sees it through the switch.
        for (const r of routes) {
          const closed = alternateFunction(regs, r.n) === r.af;
          nets.setSwitch(endpoint(r.n), r.signal, closed);
        }
        updateIdr(); // MODER can change IDR without changing a level
      };

      nets.listen((e) => {
        if (e.startsWith(`mcu.${port}`)) updateIdr();
      });

      const store = (reg: string) => (value: number) => {
        regs[reg] = value;
        update();
      };
      return {
        reset() {
          driven.length = 0;
          update();
        },
        write: {
          MODER: store("MODER"),
          OTYPER: store("OTYPER"),
          PUPDR: store("PUPDR"),
          ODR: store("ODR"),
          AFRL: store("AFRL"),
          AFRH: store("AFRH"),
          IDR: () => {}, // read-only
          // BSRR and BRR are write-only (they read 0) and act on ODR. In BSRR,
          // set wins when a pin's set and reset bits are both written.
          BSRR: (v) => {
            regs.ODR = ((regs.ODR & ~(v >>> 16)) | (v & 0xffff)) >>> 0;
            update();
          },
          BRR: (v) => {
            regs.ODR = (regs.ODR & ~(v & 0xffff)) >>> 0;
            update();
          },
        },
      };
    },
  };
}

/**
 * The alternate function pin `n` is routed to, or undefined when MODER doesn't
 * select AF mode, e.g. `alternateFunction(regsOf("GPIOB"), 6) === 6` for I2C1
 * SCL on PB6. GPIO routes pins with it; a diagnostic can explain a route with it.
 */
export function alternateFunction(
  regs: Readonly<Registers>,
  n: number,
): number | undefined {
  if (mode(regs, n) !== AF) return undefined;
  return ((n < 8 ? regs.AFRL : regs.AFRH) >>> ((n % 8) * 4)) & 0xf;
}

function mode(regs: Readonly<Registers>, n: number): number {
  return (regs.MODER >>> (2 * n)) & 3;
}

function pinDrive(regs: Registers, n: number): Drive {
  const pupd = (regs.PUPDR >>> (2 * n)) & 3;
  // Assumed: 11 (reserved) pulls neither way.
  const pull = pupd === 1 ? "pull-up" : pupd === 2 ? "pull-down" : "hi-z";
  switch (mode(regs, n)) {
    case OUTPUT: {
      const high = (regs.ODR >>> n) & 1;
      if ((regs.OTYPER >>> n) & 1) return high ? pull : "low"; // open-drain
      return high ? "high" : "low";
    }
    case ANALOG:
      return "hi-z"; // the pulls are disconnected too
    default:
      // Input, or AF: the peripheral that owns the pin drives it through ctx.nets.
      return pull;
  }
}
