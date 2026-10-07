// The panel registration list: add one import and one entry per panel.
import { registerView } from "./registers.ts";
import type { Panel } from "./ui.ts";

export const panels: readonly Panel[] = [registerView];
