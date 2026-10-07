// The panel registration list: add one import and one entry per panel.
import { controls } from "./controls.ts";
import type { Panel } from "./ui.ts";

export const panels: readonly Panel[] = [controls];
