// NUCLEO-G031K8 (MB1455), our own drawing. The wokwi-boards Nucleo-32 art has no
// license, so none of it is used (docs/decisions.md §3).
//
// Pinout: ST UM2591 Rev 1 (June 2019), §7.1, Table 9 "Arduino connectors
// pinout" and Figure 8; all 30 positions also match Rev 2 (April 2026),
// Table 9. Board size and the 0.6 in header spacing: Figure 6.
// Orientation: Figure 4 (top view) has the USB connector at the top, CN3 on
// the left and CN4 on the right, pin 1 of each next to the USB. This drawing is
// that view turned 90° anticlockwise: USB on the left, CN4 along the top, CN3
// along the bottom, pin 1 at the left.
//
// Caveats from UM2591:
// - NRST is on two positions (CN3.3 and CN4.3), and so is GND (CN3.4, CN4.2).
// - The board ships with a jumper between D2 (CN3.5, PA15) and GND (CN3.4)
//   (§5.1, step 5). This drawing assumes it has been removed.
// - D13 (CN4.15, PB3) also drives the user LED LD3 if SB12 is ON. By default
//   SB12 is OFF and LD3 is on PC6, which isn't on a header (§6.5.1, Table 8).
// - AREF (CN4.13) is AVDD; SB10 ties it to 3.3 V (Table 8).
// - Table 10 lists PA11 as "PA11 [PA9]" and PA12 as "PA12 [PA10]": the SYSCFG
//   remap can put PA9/PA10 (D5/D4) on A5/A4 too. Signals here are without remap.
// - Table 10 swaps D0/D1 (PB6/PB7) against Table 9. Table 9 and Figure 8 agree,
//   and PB6 is USART1_TX, so they are used here: D1 = PB6, D0 = PB7.
// - The VCP (USART2, PA2/PA3) goes to the ST-LINK, not to a header (Table 7).
//
// I2C1 is PB6 = SCL (CN3.1) and PB7 = SDA (CN3.2), AF6.
import { RAILS } from "../../engine/nets.ts";
import type { Art, Pin } from "./index.ts";

/** A header position: the MCU pin or board signal on it, and its Arduino Nano name. */
export type NucleoPin = Pin & {
  /** "PB6", or a board signal: "GND", "3V3", "5V", "VIN", "NRST", "AREF". */
  readonly signal: string;
  /** The Arduino name from Table 9: "D1", "A7", "+3V3". */
  readonly label: string;
  /**
   * The circuit endpoint the pin is on: "mcu.PB6", or a rail ("3V3", "GND").
   * None for 5V, VIN, NRST and AREF, which the simulation doesn't have.
   */
  readonly endpoint?: string;
};

// [Arduino name, signal] for pins 1..15 of each header, from Table 9.
const CN3 = [
  ["D1", "PB6"],
  ["D0", "PB7"],
  ["NRST", "NRST"],
  ["GND", "GND"],
  ["D2", "PA15"],
  ["D3", "PB1"],
  ["D4", "PA10"],
  ["D5", "PA9"],
  ["D6", "PB0"],
  ["D7", "PB2"],
  ["D8", "PB8"],
  ["D9", "PA8"],
  ["D10", "PB9"],
  ["D11", "PB5"],
  ["D12", "PB4"],
];
const CN4 = [
  ["VIN", "VIN"],
  ["GND", "GND"],
  ["NRST", "NRST"],
  ["+5V", "5V"],
  ["A7", "PA7"],
  ["A6", "PA6"],
  ["A5", "PA11"],
  ["A4", "PA12"],
  ["A3", "PA5"],
  ["A2", "PA4"],
  ["A1", "PA1"],
  ["A0", "PA0"],
  ["AREF", "AREF"],
  ["+3V3", "3V3"],
  ["D13", "PB3"],
];

// 50.30 mm x 18.54 mm (Figure 6). Pin 15 is 5.84 mm from the far edge.
const W = 198;
const H = 73;

const COLOR: Record<string, string> = {
  GND: "#1565c0",
  "3V3": "#c62828",
  "5V": "#c62828",
  VIN: "#c62828",
};

const pins: Record<string, NucleoPin> = {};
let pads = "";
let text = "";
for (const [header, rows, top] of [
  ["CN4", CN4, true],
  ["CN3", CN3, false],
] as const) {
  const y = top ? 6.5 : 66.5;
  rows.forEach(([label, signal], i) => {
    const x = 35 + 10 * i;
    const endpoint = /^P[A-F]\d+$/.test(signal)
      ? `mcu.${signal}`
      : Object.hasOwn(RAILS, signal)
        ? signal
        : undefined;
    pins[`${header}.${i + 1}`] = { x, y, signal, label, endpoint };
    pads +=
      i === 0
        ? `<rect x="${x - 2.8}" y="${y - 2.8}" width="5.6" height="5.6"/>`
        : `<circle cx="${x}" cy="${y}" r="2.8"/>`;
    // Labels read bottom-to-top, starting from the pin's edge of the board:
    // the MCU pin (or board label) first, then the Arduino name for MCU pins.
    const mcu = signal.startsWith("P");
    const lines: [string, number, string][] = [
      [mcu ? signal : label, 4, COLOR[signal] ?? "#1f2937"],
    ];
    if (mcu) lines.push([label, 3, "#64748b"]);
    lines.forEach(([s, size, fill], j) => {
      const ty = top ? 11 + 12 * j : 62 - 12 * j;
      text += `<text x="${x}" y="${ty}" dy="0.35em" font-size="${size}" fill="${fill}"${top ? ' text-anchor="end"' : ""} transform="rotate(-90 ${x} ${ty})">${s}</text>`;
    });
  });
  text += `<text x="30.5" y="${y}" dy="0.35em" text-anchor="end" font-size="3" fill="#64748b">${header}</text>`;
}

export const nucleo: Art & {
  readonly pins: Readonly<Record<string, NucleoPin>>;
} = {
  svg:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="2" fill="#fdfdfb" stroke="#8c959f"/>` +
    `<rect x="0" y="27" width="13" height="19" rx="1" fill="#9ca3af" stroke="#6b7280" stroke-width="0.5"/>` + // USB (CN1)
    `<g fill="#c9a227" stroke="#8a6d1a" stroke-width="0.5">${pads}</g>` +
    `<text x="110" y="36.5" dy="0.35em" text-anchor="middle" font-size="6" font-weight="bold" fill="#03234b">NUCLEO-G031K8</text>` +
    text +
    `</svg>`,
  width: W,
  height: H,
  pins,
};
