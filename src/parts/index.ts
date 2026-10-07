// The part registration list: add one import and one entry per part.
import type { Part } from "./part.ts";
import { resistor } from "./resistor.ts";
import { pushbutton } from "./pushbutton.ts";

export const parts: readonly Part[] = [resistor, pushbutton];
