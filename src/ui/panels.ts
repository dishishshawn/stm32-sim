// The panel registration list: add one import and one entry per panel.
import { diagnosticsPanel } from "./diagnostics.ts";
import { tracePanel } from "./trace.ts";
import type { Panel } from "./ui.ts";

export const panels: readonly Panel[] = [diagnosticsPanel, tracePanel];
