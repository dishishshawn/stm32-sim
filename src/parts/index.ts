// The part registration list: add one import and one entry per part.
import { led } from "./led.ts";
import { mcp23017 } from "./mcp23017.ts";
import type { Part } from "./part.ts";
import { pushbutton } from "./pushbutton.ts";
import { resistor } from "./resistor.ts";
import { sevenSegment } from "./seven-segment.ts";

export const parts: readonly Part[] = [
  resistor,
  pushbutton,
  led,
  sevenSegment,
  mcp23017,
];
