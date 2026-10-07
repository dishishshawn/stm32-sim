// The part registration list: add one import and one entry per part.
import { led } from "./led.ts";
import type { Part } from "./part.ts";
import { sevenSegment } from "./seven-segment.ts";

export const parts: readonly Part[] = [led, sevenSegment];
