// Run controls in the header toolbar (Pause/Resume, Step, speed) and a Source
// panel: the line the PC is on, in its file, from the server's /source route.
// Choices are in docs/decisions.md §15 (T36); docs/cli.md describes them for users.
import type { Snapshot } from "../engine/engine.ts";
import type { Ui } from "./ui.ts";

/** While running, the Source panel follows the PC at most this often (wall ms). */
const FOLLOW_MS = 250;

const STYLE = `
.source-at { margin: 0 0 0.5rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.source { position: relative; max-height: 22rem; overflow: auto; margin: 0; padding: 0 0 0 5ch;
  font: 12px/1.5 ui-monospace, monospace; border: 1px solid var(--line); }
.source li { white-space: pre; padding-right: 1ch; }
.source li::marker { color: var(--muted); }
.source li[aria-current] { background: color-mix(in srgb, var(--focus) 25%, transparent); }
.source:empty::before { content: "No source file for this line."; color: var(--muted); }
`;

export function controls(ui: Ui) {
  const pause = button("Pause");
  const step = button("Step");
  step.disabled = true;
  const speed = document.createElement("select");
  speed.append(new Option("real time", "realtime"), new Option("max", "max"));
  speed.addEventListener("change", () => (ui.run.max = speed.value === "max"));
  const label = document.createElement("label");
  label.append("Speed ", speed);
  ui.toolbar.append(pause, step, label);

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  const body = ui.panel("Source");
  const at = document.createElement("p");
  at.className = "source-at";
  const list = document.createElement("ol");
  list.className = "source";
  body.append(at, list);

  /** The file the list holds (or is loading), and the line to highlight in it. */
  let file: string | undefined;
  let line = 0;
  let current: Element | undefined;
  let shown = "";
  let followed = -Infinity;

  /** Shows where the PC is: its file:line and PC, and the line highlighted in its file. */
  function show(s: Snapshot) {
    const state = s.halt
      ? `${s.halt.kind}: ${s.halt.reason}`
      : ui.run.paused
        ? "Paused"
        : "Running";
    const text = `${state} at ${s.at}, PC 0x${s.pc.toString(16).padStart(8, "0")}`;
    if (text === shown) return;
    at.textContent = shown = text;
    const m = /^(.*):(\d+)$/.exec(s.at);
    line = m ? Number(m[2]) : 0;
    if (m?.[1] === file) highlight();
    else load((file = m?.[1]));
  }

  async function load(path: string | undefined) {
    list.replaceChildren();
    current = undefined;
    const r = path && (await fetch(`/source?file=${encodeURIComponent(path)}`));
    const text = r && r.ok ? await r.text() : "";
    if (path !== file || !text) return;
    list.replaceChildren(
      ...text.split("\n").map((l) => {
        const li = document.createElement("li");
        li.textContent = l;
        return li;
      }),
    );
    highlight();
  }

  /** Marks `line` as current and scrolls the list (only the list) to it. */
  function highlight() {
    current?.removeAttribute("aria-current");
    current = list.children[line - 1];
    if (!(current instanceof HTMLElement)) return;
    current.setAttribute("aria-current", "true");
    list.scrollTop =
      current.offsetTop - (list.clientHeight - current.offsetHeight) / 2;
  }

  pause.addEventListener("click", () => {
    ui.run.paused = !ui.run.paused;
    pause.textContent = ui.run.paused ? "Resume" : "Pause";
    step.disabled = !ui.run.paused;
    show(ui.engine.snapshot());
  });
  step.addEventListener("click", () => {
    ui.engine.step();
    show(ui.engine.snapshot());
  });

  // `#paused` in the URL: stop at the reset vector, before the first instruction.
  if (location.hash === "#paused") pause.click();

  ui.onSnapshot((s) => {
    // Nothing runs on from a halt: running or stepping a BKPT stops on it again.
    if (s.halt) pause.disabled = step.disabled = true;
    const now = performance.now();
    if (ui.run.paused || s.halt || now - followed >= FOLLOW_MS) {
      followed = now;
      show(s);
    }
  });
}

function button(text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  return b;
}
