// A 28-pin DIP (300 mil), drawn lying down as it sits across a breadboard's
// centre channel: notch on the left, pin 1 bottom-left, pins numbered
// counter-clockwise (1–14 left to right along the bottom, 15–28 right to left
// along the top). Rows are 0.3 in apart, so they land in breadboard rows e and f.
import type { Art, Pin } from "./index.ts";

const W = 150;
const H = 40;

/**
 * `label` is printed on the body. `names[n - 1]` names pin n and is its key in
 * `pins` (default: "1".."28"). Every pin gets a coordinate, NC included: like a real NC pin, wiring to it does nothing.
 */
export function dip28(
  label: string,
  names: readonly string[] = Array.from({ length: 28 }, (_, i) => `${i + 1}`),
): Art {
  const pins: Record<string, Pin> = {};
  let legs = "";
  let text = "";
  names.forEach((name, i) => {
    const bottom = i < 14;
    const x = bottom ? 10 + 10 * i : 10 + 10 * (27 - i);
    const y = bottom ? 36 : 4;
    pins[name] = { x, y };
    legs += `<rect x="${x - 1.5}" y="${bottom ? 32 : 1}" width="3" height="7" rx="0.5"/>`;
    // Read bottom-to-top, starting at the pin's edge of the body.
    text += bottom
      ? `<text x="${x}" y="31.5" dy="0.35em" transform="rotate(-90 ${x} 31.5)">${name}</text>`
      : `<text x="${x}" y="8.5" dy="0.35em" text-anchor="end" transform="rotate(-90 ${x} 8.5)">${name}</text>`;
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">` +
    `<g fill="#b8bcc2">${legs}</g>` +
    `<rect x="2" y="7" width="146" height="26" rx="1.5" fill="#2b2b2b"/>` +
    `<path d="M2 17 A3 3 0 0 1 2 23 Z" fill="#5a5a5a"/>` + // notch
    `<circle cx="5.5" cy="29" r="1" fill="#5a5a5a"/>` + // pin 1 dot
    `<g font-size="3" fill="#e5e7eb">${text}</g>` +
    `<text x="75" y="20" dy="0.35em" text-anchor="middle" font-size="5" font-weight="bold" fill="#ffffff">${label}</text>` +
    `</svg>`;
  return { svg, width: W, height: H, pins };
}
