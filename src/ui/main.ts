// The browser side of `sim ui`: loads the firmware and circuit from the
// server, runs the engine in this page at real-time speed, and shows each
// part's state(). Choices are recorded in docs/decisions.md §15.
import { parseCircuit } from "../engine/circuit.ts";
import type { Circuit } from "../engine/circuit.ts";
import { catalog, Engine, propSpec } from "../engine/engine.ts";
import type { Snapshot } from "../engine/engine.ts";
import type { PropValue } from "../parts/part.ts";
import { partArt, PX_PER_UNIT } from "./art/index.ts";
import type { Art } from "./art/index.ts";
import { nucleo } from "./art/nucleo-g031k8.ts";
import { panels } from "./panels.ts";
import type { Ui } from "./ui.ts";

/** Simulated seconds per runFor(), and the wall-clock ms a frame may spend simulating. */
const SLICE = 0.001;
const BUDGET_MS = 12;
/** Parts without a "pos" go in a grid of these cells below the board, in circuit order. */
const CELL = { w: 160, h: 110 };
const COLUMNS = 4;

/** The @wokwi/elements tag of each part type it draws; T29's art draws the rest. */
const ELEMENT: Record<string, string> = {
  led: "wokwi-led",
  "7segment": "wokwi-7segment",
  pushbutton: "wokwi-pushbutton",
  resistor: "wokwi-resistor",
};

type Wokwi = HTMLElement & Record<string, unknown>;

const $ = (id: string) => document.getElementById(id)!;
const engine = new Engine();
/** What each frame does with the snapshot: one per live element. */
const updates: ((s: Snapshot) => void)[] = [];
/** Simulated time at the last frame. A prop set at it applies at once. */
let seconds = 0;
/** Panels (./panels.ts) pause the run loop through this. */
const loop = { paused: false };
let last: number | undefined;

try {
  const [elf, text] = await Promise.all([
    get("/elf").then((r) => r.arrayBuffer()),
    get("/circuit").then((r) => r.text()),
  ]);
  const circuit = parseCircuit(text, catalog);
  engine.load(new Uint8Array(elf), circuit);
  render(circuit);
  mountPanels(circuit);
  requestAnimationFrame(frame);
} catch (e) {
  $("run").textContent = `error: ${(e as Error).message}`;
}

/** Runs the wall time since the last frame, then shows the result. */
function frame(now: number) {
  // At most 100 ms, so a hidden tab (no frames) doesn't leave a backlog. At
  // most BUDGET_MS of work, so firmware slower than real time runs slower
  // instead of freezing the page.
  const due = Math.min(now - (last ?? now), 100) / 1000;
  last = now;
  const start = performance.now();
  if (!loop.paused)
    for (let t = 0; t < due && performance.now() - start < BUDGET_MS; t += SLICE)
      engine.runFor(SLICE);
  const s = engine.snapshot();
  seconds = s.seconds;
  for (const update of updates) update(s);
  $("time").textContent = s.seconds.toFixed(3);
  const run = status(s);
  if ($("run").textContent !== run) $("run").textContent = run;
  if (!s.halt) requestAnimationFrame(frame);
}

/** Gives each registered panel the engine, the snapshots and its own section. */
function mountPanels(circuit: Circuit) {
  const ui: Ui = {
    engine,
    circuit,
    run: loop,
    onSnapshot: (fn) => void updates.push(fn),
    panel(title) {
      const section = document.createElement("section");
      section.className = "panel";
      const h2 = document.createElement("h2");
      h2.textContent = title;
      const body = document.createElement("div");
      section.append(h2, body);
      $("panels").append(section);
      return body;
    },
    toolbar: $("toolbar"),
  };
  for (const mount of panels) mount(ui);
}

/** As `sim run` words it. */
function status(s: Snapshot): string {
  if (s.halt?.kind === "lockup") return `lockup: ${s.halt.reason} (at ${s.at})`;
  if (s.halt) return `breakpoint: ${s.halt.reason} at ${s.at}`;
  if (s.fault) return `HardFault: ${s.fault.reason} at ${s.fault.at}`;
  return "running";
}

function set(id: string, name: string, value: PropValue) {
  engine.setPropAt(seconds, id, name, value);
}

/** The board at the top left, and each part at its "pos" or in the grid. */
function render(circuit: Circuit) {
  const size = { w: 0, h: 0 };
  const place = (id: string, x: number, y: number, ...content: Node[]) => {
    const fig = document.createElement("figure");
    fig.dataset.part = id;
    fig.style.left = `${x}px`;
    fig.style.top = `${y}px`;
    const caption = document.createElement("figcaption");
    caption.textContent = id;
    fig.append(...content, caption);
    $("circuit").append(fig);
    size.w = Math.max(size.w, x + CELL.w);
    size.h = Math.max(size.h, y + CELL.h);
  };

  // The board's header pins, coloured by level: the MCU's, not the rails'.
  const pins = Object.values(nucleo.pins).filter((p) =>
    p.endpoint?.startsWith("mcu."),
  );
  const board = svg(
    nucleo,
    "NUCLEO-G031K8",
    pins
      .map(
        (p) =>
          `<circle class="pin" data-pin="${p.signal}" cx="${p.x}" cy="${p.y}" r="2"><title/></circle>`,
      )
      .join(""),
  );
  const dots = board.querySelectorAll<SVGCircleElement>(".pin");
  updates.push((s) =>
    pins.forEach((p, i) => {
      const level = s.pins[p.signal];
      if (dots[i].dataset.level === level) return;
      dots[i].dataset.level = level;
      dots[i].firstChild!.textContent = `${p.signal} (${p.label}): ${level}`;
    }),
  );
  place("mcu", 0, 0, board);

  const top = nucleo.height * PX_PER_UNIT + 24;
  let cell = 0;
  for (const p of engine.view().parts) {
    const pos = circuit.parts.find((c) => c.id === p.id)!.pos ?? {
      x: (cell % COLUMNS) * CELL.w,
      y: top + Math.floor(cell++ / COLUMNS) * CELL.h,
    };
    const content: Node[] = [];
    const tag = ELEMENT[p.type];
    const art = partArt[p.type];
    if (tag) {
      const el = document.createElement(tag) as Wokwi;
      content.push(el);
      if (p.type === "resistor") el.value = String(p.props.ohms);
      if (p.type === "led") updates.push((s) => (el.value = s.parts[p.id].lit));
      if (p.type === "7segment") {
        updates.push((s) => {
          const values = s.parts[p.id].values as number[];
          if (String(values) !== String(el.values)) el.values = values;
        });
      }
      if (p.type === "pushbutton") {
        el.addEventListener("button-press", () => set(p.id, "pressed", true));
        el.addEventListener("button-release", () =>
          set(p.id, "pressed", false),
        );
      }
    } else if (art) {
      content.push(svg(art, p.type));
    } else {
      const box = document.createElement("span");
      box.className = "chip";
      box.textContent = p.type;
      content.push(box);
    }
    // A temperature sensor's slider (TC74, and any part with the same prop).
    const spec = Object.hasOwn(p.props, "temperature")
      ? propSpec(circuit, p.id, "temperature")
      : undefined;
    if (spec?.type === "number") {
      const control = document.createElement("div");
      const label = document.createElement("label");
      const input = document.createElement("input");
      const output = document.createElement("output");
      control.className = "control";
      label.textContent = "temperature, °C";
      input.type = "range";
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.value = output.value = String(p.props.temperature);
      input.addEventListener("input", () => {
        output.value = input.value;
        set(p.id, "temperature", Number(input.value));
      });
      label.append(input);
      control.append(label, output);
      content.push(control);
    }
    place(p.id, pos.x, pos.y, ...content);
  }
  $("circuit").style.width = `${size.w}px`;
  $("circuit").style.height = `${size.h}px`;
}

/** T29 art as an SVG element, at PX_PER_UNIT, with `extra` drawn on top. */
function svg(art: Art, label: string, extra = ""): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = art.svg.replace(/<\/svg>$/, `${extra}</svg>`);
  const el = t.content.firstElementChild as SVGSVGElement;
  el.setAttribute("width", String(art.width * PX_PER_UNIT));
  el.setAttribute("height", String(art.height * PX_PER_UNIT));
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  return el;
}

async function get(path: string): Promise<Response> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r;
}
