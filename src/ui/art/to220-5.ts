// The TC74 in its 5-pin TO-220 package, tab up, leads down, viewed from the front.
//
// Pin order: Microchip TC74 datasheet DS21462D, Table 2-1 "Pin function table"
// (5-pin TO-220 column): 1 NC, 2 SDA, 3 GND, 4 SCLK, 5 VDD. The page-1 package
// note says the tab is connected to pin 3 (GND).
import type { Art, Pin } from "./index.ts";

const W = 50;
const H = 70;
const NAMES = ["NC", "SDA", "GND", "SCLK", "VDD"];

// ponytail: the real lead pitch is about 0.067 in (DS21462D package outline);
// the tips are drawn on the 0.1 in grid, as if bent to fit a breadboard.
const pins: Record<string, Pin> = {};
let leads = "";
let text = "";
NAMES.forEach((name, i) => {
  const x = 5 + 10 * i;
  pins[name] = { x, y: 65 };
  leads += `<rect x="${x - 1.2}" y="49" width="2.4" height="19"/>`;
  text += `<text x="${x}" y="46" text-anchor="middle">${name}</text>`;
});

export const tc74: Art = {
  svg:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">` +
    `<g fill="#b8bcc2">${leads}` +
    `<path fill-rule="evenodd" d="M4 0H46V20H4Z M21 9A4 4 0 1 0 29 9A4 4 0 1 0 21 9Z"/></g>` + // metal tab with its hole
    `<rect x="0" y="18" width="50" height="32" rx="1" fill="#2b2b2b"/>` +
    `<text x="25" y="32" text-anchor="middle" font-size="8" font-weight="bold" fill="#ffffff">TC74</text>` +
    `<g font-size="2.8" fill="#e5e7eb">${text}</g>` +
    `</svg>`,
  width: W,
  height: H,
  pins,
};
