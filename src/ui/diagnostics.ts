// The diagnostics panel: what `sim run` reports, live, from the same rules and
// diagnose() (docs/decisions.md §13), so it explains and never changes the run.
// A click on one highlights the trace step it happened at (./trace.ts), or
// else itself, and dispatches a "diagnostic-select" CustomEvent on `document`,
// with the Diagnostic as `detail`, for any panel that shows its register or pin.
import { rules } from "../diagnostics/index.ts";
import { diagnose } from "../diagnostics/rule.ts";
import type { Diagnostic } from "../diagnostics/rule.ts";
import type { Panel } from "./ui.ts";

const CSS = `
.diagnostics {
  list-style: none;
  margin: 0;
  padding: 0;
}
.diagnostics button {
  display: block;
  width: 100%;
  margin: 0 0 4px;
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
}
.diagnostics .warning .severity {
  color: var(--high);
}
.diagnostics .rule {
  color: var(--muted);
}
.diagnostics .subject {
  display: block;
  color: var(--muted);
}
.diag-target {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
`;

export const diagnosticsPanel: Panel = (ui) => {
  const found = diagnose(ui.engine.events, ui.engine.view(), rules);

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const body = ui.panel("Diagnostics");
  const none = document.createElement("p");
  none.textContent = "No problems found";
  const list = document.createElement("ul");
  list.className = "diagnostics";
  body.append(none, list);

  /** Each diagnostic shown, and the element showing its count. */
  const shown = new Map<Diagnostic, HTMLElement>();
  setInterval(() => {
    for (const d of found()) {
      let count = shown.get(d);
      if (!count) shown.set(d, (count = item(d, list)));
      const text = d.count > 1 ? ` (${d.count} times)` : "";
      if (count.textContent !== text) count.textContent = text;
    }
    none.hidden = shown.size > 0;
  }, 250);
};

/**
 * Adds `d` to `list`, worded as `sim run` words it ("main.c:119: warning:
 * message [rule] (n times)"), then the register or pin it names. Returns the
 * count's element.
 */
function item(d: Diagnostic, list: HTMLElement): HTMLElement {
  const li = document.createElement("li");
  li.className = d.severity;
  const button = document.createElement("button");
  button.type = "button";
  const at = document.createElement("code");
  // The file name only: the sidebar is narrow. The whole path is the tooltip.
  at.textContent = d.at?.replace(/^.*[\\/]/, "") ?? `cycle ${d.cycle}`;
  if (d.at) at.title = d.at;
  const severity = document.createElement("strong");
  severity.className = "severity";
  severity.textContent = d.severity;
  const rule = document.createElement("span");
  rule.className = "rule";
  rule.textContent = ` [${d.rule}]`;
  const count = document.createElement("span");
  count.className = "rule";
  button.append(at, ": ", severity, `: ${d.message}`, rule, count);
  const what = d.reg ? `${d.periph}_${d.reg}` : (d.pin ?? d.periph);
  if (what) {
    const subject = document.createElement("code");
    subject.className = "subject";
    subject.textContent = what;
    button.append(subject);
  }
  button.addEventListener("click", () => {
    const step = document.querySelector<HTMLElement>(
      `.i2c-trace [data-cycle="${d.cycle}"]`,
    );
    const target = step ?? li;
    document.querySelector(".diag-target")?.classList.remove("diag-target");
    target.classList.add("diag-target");
    target.scrollIntoView({ block: "nearest" });
    document.dispatchEvent(new CustomEvent("diagnostic-select", { detail: d }));
  });
  li.append(button);
  list.append(li);
  return count;
}
