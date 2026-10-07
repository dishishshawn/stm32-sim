// Our own SVG art for what @wokwi/elements doesn't draw (docs/decisions.md §3).
//
// Units: 1 SVG unit = 0.01 in (0.254 mm), so the 0.1 in header and breadboard
// pitch is 10 units. wokwi-elements pinInfo is in CSS px (0.1 in = 9.6 px):
// scale our art by 0.96 to put both on the same grid.
import { dip28 } from "./dip28.ts";
import { tc74 } from "./to220-5.ts";

/** A pin's position in its art's SVG coordinates (inside the viewBox `0 0 width height`). */
export type Pin = { readonly x: number; readonly y: number };

export type Art = {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly pins: Readonly<Record<string, Pin>>;
};

/**
 * MCP23017 SPDIP pin names, pin 1 first. Microchip DS20001952C, Table 2-1
 * "Pinout description" (SPDIP column). Pin 12 is "SCK" in the datasheet.
 */
const MCP23017_PINS = [
  ...["GPB0", "GPB1", "GPB2", "GPB3", "GPB4", "GPB5", "GPB6", "GPB7"],
  ...["VDD", "VSS", "NC", "SCK", "SDA", "NC", "A0", "A1", "A2", "RESET"],
  ...["INTB", "INTA", "GPA0", "GPA1", "GPA2", "GPA3", "GPA4", "GPA5"],
  ...["GPA6", "GPA7"],
];

/** Art by part type, for parts wokwi-elements doesn't cover. Pin keys are the part's pin names. */
export const partArt: Readonly<Record<string, Art>> = {
  tc74,
  mcp23017: dip28("MCP23017", MCP23017_PINS),
};
