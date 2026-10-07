// The panel registration list: add one import and one entry per panel.
import type { Panel } from "./ui.ts";
import { watch } from "./watch.ts";

export const panels: readonly Panel[] = [watch];
