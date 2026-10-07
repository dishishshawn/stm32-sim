// The panel registration list: add one import and one entry per panel.
// The order is the sidebar's, top to bottom.
import { controls } from "./controls.ts";
import { diagnosticsPanel } from "./diagnostics.ts";
import { propsPanel } from "./props.ts";
import { registerView } from "./registers.ts";
import { tracePanel } from "./trace.ts";
import type { Panel } from "./ui.ts";
import { watch } from "./watch.ts";

export const panels: readonly Panel[] = [
  propsPanel,
  controls,
  diagnosticsPanel,
  tracePanel,
  registerView,
  watch,
];
