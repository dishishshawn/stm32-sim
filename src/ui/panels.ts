// The panel registration list: add one import and one entry per panel.
import { controls } from "./controls.ts";
import { registerView } from "./registers.ts";
import type { Panel } from "./ui.ts";

export const panels: readonly Panel[] = [controls, registerView];
