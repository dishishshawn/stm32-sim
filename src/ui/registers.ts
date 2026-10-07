// The register view (T34): every register's stored value and its named fields,
// live, one collapsible section per peripheral. A register is named as
// diagnostics name it, the way exam-style C #defines it:
// "GPIOA_MODER (0x50000000)" (src/diagnostics/names.ts).
import { fieldName, hex32, regName } from "../diagnostics/names.ts";
import type { Snapshot } from "../engine/engine.ts";
import type { Ui } from "./ui.ts";

/** Redraw at most this often, and only the open sections, so the page stays smooth. */
const EVERY_MS = 200;
/** How long a changed value stays highlighted. */
const CHANGED_MS = 1000;

const CSS = `
.regs { --changed: #fff8c5; }
@media (prefers-color-scheme: dark) { .regs { --changed: #5c4307; } }
.regs label { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
.regs input { flex: 1; font: inherit; }
.regs summary h3 { display: inline; font-size: 0.95rem; margin: 0; }
.regs .reg { margin: 0.25rem 0 0.5rem 1rem; font: 12px/1.5 ui-monospace, monospace; }
.regs .value { font-weight: 600; }
.regs .unsim, .regs .fields { color: var(--muted); }
.regs .fields { display: flex; flex-wrap: wrap; gap: 0 1ch; }
.regs .changed { background: var(--changed); color: var(--fg); }
`;

interface Row {
  el: HTMLElement;
  /** "GPIOA_MODER", upper case, for the filter. */
  name: string;
  reg: string;
  value: HTMLElement;
  fields: { el: HTMLElement; name: string; lo: number; width: number }[];
  /** The value shown. */
  last: number;
}

interface Section {
  periph: string;
  details: HTMLDetailsElement;
  rows: Row[];
}

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), props);

/** The register JSON has descriptions; RegisterMap doesn't type them. */
const describe = (x: object) =>
  (x as { description?: string }).description ?? "";

export function registerView(ui: Ui): void {
  const { chip } = ui.engine.view();
  const map = chip.registers.peripherals;
  // The memory bus's rule: a registered peripheral simulates `simulates`, else all.
  const simulated = (periph: string, reg: string) =>
    chip.peripherals.some(
      (p) => p.name === periph && (p.simulates?.includes(reg) ?? true),
    );
  // Shown while the filter is empty, as `sim inspect` shows them: the
  // simulated peripherals, and any the firmware touches.
  const shown = new Set(chip.peripherals.map((p) => p.name));
  ui.engine.events.subscribe((e) => {
    if (e.kind === "reg") shown.add(e.periph);
  });

  const body = ui.panel("Registers");
  body.className = "regs";
  const filter = h("input", {
    type: "search",
    placeholder: "GPIOA, MODER, …",
  });
  const label = h("label", { textContent: "Filter" });
  label.append(filter);
  body.append(h("style", { textContent: CSS }), label);

  /** Highlighted elements, by when they changed. */
  const lit = new Map<HTMLElement, number>();
  let latest = ui.engine.snapshot();
  const sections: Section[] = Object.entries(latest.registers).map(
    ([periph, regs]) => {
      const details = h("details");
      details.dataset.periph = periph;
      const summary = h("summary");
      summary.append(h("h3", { textContent: periph }));
      details.append(summary);
      const rows = Object.keys(regs).map((reg): Row => {
        const r = map[periph].registers[reg];
        const el = h("div", { className: "reg" });
        el.dataset.reg = `${periph}_${reg}`;
        const value = h("span", { className: "value" });
        const head = h("div", { title: describe(r) });
        head.append(regName(chip, periph, reg), " ", value);
        if (!simulated(periph, reg)) {
          const tag = { className: "unsim", textContent: "not simulated" };
          head.append(" ", h("small", tag));
        }
        const list = h("div", { className: "fields" });
        const fields = Object.entries(r.fields).map(([name, f]) => {
          const title = `${fieldName(chip, periph, reg, name)}: ${describe(f)}`;
          const fel = h("span", { title });
          fel.dataset.field = name;
          list.append(fel, " ");
          return { el: fel, name, lo: f.bitOffset, width: f.bitWidth };
        });
        el.append(head, list);
        details.append(el);
        return {
          el,
          name: el.dataset.reg.toUpperCase(),
          reg,
          value,
          fields,
          last: NaN,
        };
      });
      const section = { periph, details, rows };
      // Brought up to date without highlighting: nothing changed in front of the user.
      details.addEventListener("toggle", () => {
        if (details.open) refresh(section, latest);
      });
      refresh(section, latest);
      body.append(details);
      return section;
    },
  );

  const query = () => filter.value.trim().toUpperCase();
  const showSections = () => {
    for (const s of sections)
      s.details.hidden = query()
        ? s.rows.every((r) => r.el.hidden)
        : !shown.has(s.periph);
  };
  filter.addEventListener("input", () => {
    for (const s of sections)
      for (const r of s.rows) r.el.hidden = !r.name.includes(query());
    showSections();
  });
  showSections();

  let next = 0;
  ui.onSnapshot((s) => {
    latest = s;
    const now = performance.now();
    if (now < next) return;
    next = now + EVERY_MS;
    for (const [el, t] of lit) {
      if (now - t < CHANGED_MS) continue;
      el.classList.remove("changed");
      lit.delete(el);
    }
    showSections();
    for (const section of sections)
      if (section.details.open && !section.details.hidden)
        refresh(section, s, now);
  });

  /** Shows `s`'s values; with `now`, highlights what changed. */
  function refresh(section: Section, s: Snapshot, now?: number) {
    const regs = s.registers[section.periph];
    for (const row of section.rows) {
      const v = regs[row.reg];
      if (v === row.last) continue;
      row.last = v;
      set(row.value, hex32(v), now);
      for (const f of row.fields)
        set(f.el, `${f.name}=${Math.floor(v / 2 ** f.lo) % 2 ** f.width}`, now);
    }
  }

  function set(el: HTMLElement, text: string, now?: number) {
    if (el.textContent === text) return;
    el.textContent = text;
    if (now === undefined) return;
    el.classList.add("changed");
    lit.set(el, now);
  }
}
