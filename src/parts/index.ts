// The part registration list: add one import and one entry per part.
import { led } from "./led.ts";
import type { Part } from "./part.ts";
import { pushbutton } from "./pushbutton.ts";
import { resistor } from "./resistor.ts";
import { sevenSegment } from "./seven-segment.ts";
import { tc74 } from "./tc74.ts";

export const parts: readonly Part[] = [
  resistor,
  pushbutton,
  led,
  sevenSegment,
  tc74,
];
