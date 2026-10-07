// The I2C trace panel: one row per bus step, timed and worded as `sim inspect`
// prints them, grouped from START to STOP, a target's NACK highlighted. It only listens to
// the event log, so it can't change the run. Rows carry `data-cycle`, which the
// diagnostics panel (./diagnostics.ts) uses to jump to a step.
import type { I2cTraceEvent } from "../engine/events.ts";
import { i2cText } from "../engine/i2c.ts";
import type { Panel } from "./ui.ts";

/** Steps kept. The thermometer makes about 400 a second. */
const MAX = 500;

const CSS = `
.i2c-trace {
  max-height: 20rem;
  overflow: auto;
  font: 12px/1.5 ui-monospace, monospace;
}
.i2c-trace:empty::before {
  content: "No I2C steps yet";
  color: var(--muted);
}
.i2c-trace ol {
  list-style: none;
  margin: 0 0 4px;
  padding: 0 0 0 6px;
  border-left: 2px solid var(--line);
}
.i2c-trace li {
  white-space: pre;
}
.i2c-trace .nack {
  color: var(--high);
  font-weight: 600;
}
`;

export const tracePanel: Panel = (ui) => {
  // The subscriber only queues; drawing happens a few times a second.
  const pending: I2cTraceEvent[] = [];
  let dropped = false;
  ui.engine.events.subscribe((e) => {
    if (e.kind === "i2c" && pending.push(e) > MAX) {
      pending.shift();
      dropped = true;
    }
  });

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const body = ui.panel("I2C trace");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear";
  const note = document.createElement("p");
  note.textContent = "Earlier steps dropped";
  note.hidden = true;
  const list = document.createElement("div");
  list.className = "i2c-trace";
  list.tabIndex = 0; // scrollable by keyboard
  body.append(clear, note, list);

  /** The transaction being drawn: from a START to its STOP. */
  let group: HTMLOListElement | null = null;
  let rows = 0;
  clear.addEventListener("click", () => {
    list.replaceChildren();
    pending.length = rows = 0;
    group = null;
    dropped = false;
    note.hidden = true;
  });

  setInterval(() => {
    if (!pending.length) return;
    const atBottom =
      list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    for (const e of pending) {
      if (!group) list.append((group = document.createElement("ol")));
      const li = document.createElement("li");
      li.textContent = `${ui.engine.secondsAt(e.cycle).toFixed(6)} s  ${i2cText(e.step)}`;
      li.dataset.cycle = String(e.cycle);
      // Only a target's NACK is trouble: on its address, or on a byte the
      // controller wrote. The controller NACKs the last byte it reads on
      // purpose; that's how a read ends.
      const s = e.step;
      if ("ack" in s && s.ack === "nack" && (s.kind === "addr" || !s.read))
        li.className = "nack";
      group.append(li);
      rows++;
      if (e.step.kind === "stop") group = null;
    }
    pending.length = 0;
    // Oldest transactions go whole. The browser's scroll anchoring keeps the
    // rows in view still when the ones above them go.
    while (rows > MAX) {
      const first = list.firstElementChild!;
      if (first === group) group = null;
      rows -= first.childElementCount;
      first.remove();
      dropped = true;
    }
    note.hidden = !dropped;
    if (atBottom) list.scrollTop = list.scrollHeight;
  }, 250);
};
