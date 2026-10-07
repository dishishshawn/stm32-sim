// The part registration list: add one import and one entry per part.
import { led } from "./led.ts";
import { mcp23017 } from "./mcp23017.ts";
import { mcp9808 } from "./mcp9808.ts";
import type { Part } from "./part.ts";
import { pushbutton } from "./pushbutton.ts";
import { resistor } from "./resistor.ts";
import { sevenSegment } from "./seven-segment.ts";
import { tc74 } from "./tc74.ts";
import { tmp102 } from "./tmp102.ts";

export const parts: readonly Part[] = [
  resistor,
  pushbutton,
  led,
  sevenSegment,
  tc74,
  mcp23017,
  tmp102,
  mcp9808,
];
