// The browser side of `sim ui`: loads the firmware and circuit from the
// server, runs the engine in this page at real-time speed, and shows each
// part's state(). Parts can be added, moved and removed, and the circuit saved
// back to its file. Choices are recorded in docs/decisions.md §15.
import { parseCircuit, serializeCircuit } from "../engine/circuit.ts";
import type { Circuit, CircuitPart } from "../engine/circuit.ts";
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
/** Parts without a "pos" go in a grid of these cells below the board: part i in cell i. */
const CELL = { w: 160, h: 110 };
const COLUMNS = 4;
const TOP = nucleo.height * PX_PER_UNIT + 24;
/** A moved part snaps to the 0.1 in grid, in CSS px. */
const GRID = 9.6;
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
/** The drag data of a part type dragged from the palette. */
const PART_TYPE = "application/x-sim-part-type";

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
/** Panels' snapshot callbacks (ui.onSnapshot). */
const updates: ((s: Snapshot) => void)[] = [];
/** The drawn circuit's: one per live element, replaced by each render(). */
let drawn: ((s: Snapshot) => void)[] = [];
/** Simulated time at the last frame. A prop set at it applies at once. */
let seconds = 0;
/** Panels (./panels.ts) pause the run loop through this. */
const loop = { paused: false, max: false };
let last: number | undefined;
/** A frame is due. The loop stops on a halt; a restart starts it again. */
let looping = false;
/** Edited in place, so panels' ui.circuit stays the one shown. */
let circuit: Circuit;

try {
  const [elf, text] = await Promise.all([
    firmware(),
    get("/circuit").then((r) => r.text()),
  ]);
  circuit = parseCircuit(text, catalog);
  engine.load(elf, circuit);
  render();
  mountPanels();
  mountEditing();
  schedule();
} catch (e) {
  $("run").textContent = `error: ${(e as Error).message}`;
}

function schedule() {
  if (looping) return;
  looping = true;
  requestAnimationFrame(frame);
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
    for (
      let t = 0;
      (loop.max || t < due) && performance.now() - start < BUDGET_MS;
      t += SLICE
    )
      engine.runFor(SLICE);
  const s = engine.snapshot();
  seconds = s.seconds;
  for (const update of drawn) update(s);
  for (const update of updates) update(s);
  $("time").textContent = s.seconds.toFixed(3);
  const run = status(s);
  if ($("run").textContent !== run) $("run").textContent = run;
  looping = !s.halt;
  if (looping) requestAnimationFrame(frame);
}

/** Gives each registered panel the engine, the snapshots and its own section. */
function mountPanels() {
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
  return loop.paused ? "paused" : "running";
}

function set(id: string, name: string, value: PropValue) {
  engine.setPropAt(seconds, id, name, value);
}

/** Part i's cell in the grid below the board. */
function cell(i: number) {
  return {
    x: (i % COLUMNS) * CELL.w,
    y: TOP + Math.floor(i / COLUMNS) * CELL.h,
  };
}
/** Where a part is drawn: its "pos", else its cell. */
function where(p: CircuitPart) {
  return p.pos ?? cell(circuit.parts.indexOf(p));
}
/** On the 0.1 in grid, written as 28.8 rather than 28.799999999999997, and on the canvas. */
function snap(v: number) {
  return Math.max(0, Number((Math.round(v / GRID) * GRID).toFixed(1)));
}

/** The board at the top left, and each part at its "pos" or in the grid. */
function render() {
  drawn = [];
  $("circuit").replaceChildren();
  const place = (id: string, x: number, y: number, ...content: Node[]) => {
    const fig = document.createElement("figure");
    fig.dataset.part = id;
    fig.style.left = `${x}px`;
    fig.style.top = `${y}px`;
    const caption = document.createElement("figcaption");
    caption.textContent = id;
    fig.append(...content, caption);
    $("circuit").append(fig);
    return fig;
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
  drawn.push((s) =>
    pins.forEach((p, i) => {
      const level = s.pins[p.signal];
      if (dots[i].dataset.level === level) return;
      dots[i].dataset.level = level;
      dots[i].firstChild!.textContent = `${p.signal} (${p.label}): ${level}`;
    }),
  );
  place("mcu", 0, 0, board);

  engine.view().parts.forEach((p, i) => {
    const pos = where(circuit.parts[i]);
    const content: Node[] = [];
    const tag = ELEMENT[p.type];
    const art = partArt[p.type];
    if (tag) {
      const el = document.createElement(tag) as Wokwi;
      content.push(el);
      if (p.type === "resistor") el.value = String(p.props.ohms);
      if (p.type === "led") drawn.push((s) => (el.value = s.parts[p.id].lit));
      if (p.type === "7segment") {
        drawn.push((s) => {
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
    movable(place(p.id, pos.x, pos.y, ...content), circuit.parts[i]);
  });
  fit();
}

/** Sizes the canvas to hold every part, so it scrolls to them. */
function fit() {
  const at = [{ x: 0, y: 0 }, ...circuit.parts.map(where)];
  $("circuit").style.width = `${Math.max(...at.map((p) => p.x)) + CELL.w}px`;
  $("circuit").style.height = `${Math.max(...at.map((p) => p.y)) + CELL.h}px`;
}

/** The canvas's CSS zoom: pointer distances divide by it. */
function zoom() {
  return Number(getComputedStyle($("circuit")).zoom) || 1;
}

/**
 * Drag with the pointer, or the arrow keys for one grid step; either writes
 * the part's "pos". Delete asks, then removes it. Moving doesn't restart the
 * simulation: "pos" isn't simulated.
 */
function movable(fig: HTMLElement, part: CircuitPart) {
  fig.tabIndex = 0;
  fig.title = "Drag or use the arrow keys to move it; Delete removes it";
  const move = (x: number, y: number) => {
    const old = where(part);
    const pos = { x: snap(x), y: snap(y) };
    if (pos.x === old.x && pos.y === old.y) return;
    part.pos = pos;
    fig.style.left = `${pos.x}px`;
    fig.style.top = `${pos.y}px`;
    fit();
  };
  fig.addEventListener("keydown", (e) => {
    if (e.target !== fig) return; // the slider's arrows are its own
    const step = ARROWS[e.key];
    if (step) {
      e.preventDefault();
      const { x, y } = where(part);
      move(x + step[0] * GRID, y + step[1] * GRID);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(part);
    }
  });
  fig.addEventListener("pointerdown", (e) => {
    // The push-button and the slider keep their own pointer.
    const own = (e.target as Element).closest(".control, wokwi-pushbutton");
    if (own || e.button !== 0) return;
    fig.setPointerCapture(e.pointerId);
    const from = { ...where(part), cx: e.clientX, cy: e.clientY, z: zoom() };
    let moved = false;
    const drag = (e: PointerEvent) => {
      const dx = (e.clientX - from.cx) / from.z;
      const dy = (e.clientY - from.cy) / from.z;
      // A click isn't a move: it would snap an unmoved part to the grid.
      if (!moved && Math.hypot(dx, dy) < GRID / 2) return;
      moved = true;
      move(from.x + dx, from.y + dy);
    };
    fig.addEventListener("pointermove", drag);
    fig.addEventListener(
      "lostpointercapture",
      () => fig.removeEventListener("pointermove", drag),
      { once: true },
    );
  });
}

/** Asks in the page, then removes the part and its wires. */
function remove(part: CircuitPart) {
  const dialog = $("confirm") as HTMLDialogElement;
  const n = circuit.wires.filter((w) =>
    w.some((e) => e.startsWith(`${part.id}.`)),
  ).length;
  dialog.querySelector("p")!.textContent =
    `Remove ${part.id} and its ${n} wire${n === 1 ? "" : "s"}? There is no undo.`;
  dialog.returnValue = "";
  dialog.addEventListener(
    "close",
    () => {
      if (dialog.returnValue !== "remove") return;
      $("circuit").focus();
      void change(() => {
        circuit.parts = circuit.parts.filter((p) => p !== part);
        // An endpoint is "<id>.<pin>", and an id has no dot.
        circuit.wires = circuit.wires.filter(
          (w) => !w.some((e) => e.startsWith(`${part.id}.`)),
        );
        return `removed ${part.id}`;
      });
    },
    { once: true },
  );
  dialog.showModal();
}

/** A new part of `type`, with its default props, at `at` or in the first free cell. */
async function add(type: string, at?: { x: number; y: number }) {
  let id = "";
  await change(() => {
    // An id starts with a letter (7segment's are segment1, segment2...), and
    // a type ending in a digit gets a "_": tc74_1, not tc741.
    const base = type.replace(/^[^A-Za-z]+/, "").replace(/\d$/, "$&_");
    for (let n = 1; !id || circuit.parts.some((p) => p.id === id); n++)
      id = `${base}${n}`;
    const pos = at ? { x: snap(at.x), y: snap(at.y) } : free();
    circuit.parts.push({ id, type, props: {}, pos });
    return `added ${id}`;
  });
  document.querySelector<HTMLElement>(`[data-part="${id}"]`)?.focus();
}

/**
 * The first cell no part overlaps.
 * ponytail: takes every part as one cell big; measure the figures if large parts overlap.
 */
function free() {
  const taken = circuit.parts.map(where);
  // In whole px: 204.08 - 94.08 is a hair under 110.
  const apart = (a: number, b: number, size: number) =>
    Math.round(Math.abs(a - b)) >= size;
  for (let i = 0; ; i++) {
    const c = cell(i);
    const clear = taken.every(
      (p) => apart(p.x, c.x, CELL.w) || apart(p.y, c.y, CELL.h),
    );
    if (clear) return { x: snap(c.x), y: snap(c.y) };
  }
}

/**
 * Applies `edit` to the circuit, then restarts the simulation on it: a fresh
 * MCU and parts, with the ELF on disk now, as a page reload would.
 */
async function change(edit: () => string) {
  // If load() throws (a bad ELF on disk), the engine keeps the old board,
  // which reads this same circuit: put its parts and wires back.
  let undo: Pick<Circuit, "parts" | "wires"> | undefined;
  try {
    const elf = await firmware();
    undo = { parts: [...circuit.parts], wires: [...circuit.wires] };
    const what = edit();
    engine.load(elf, circuit);
    undo = undefined;
    render();
    note(`${what}: simulation restarted`);
    schedule();
  } catch (e) {
    if (undo) Object.assign(circuit, undo);
    note(`error: ${(e as Error).message}`);
  }
}

/** The palette (click to add, or drag onto the canvas) and Save. */
function mountEditing() {
  for (const { type } of catalog.parts) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = type;
    b.draggable = true;
    b.addEventListener("click", () => add(type));
    b.addEventListener("dragstart", (e) =>
      e.dataTransfer!.setData(PART_TYPE, type),
    );
    $("palette").append(b);
  }
  const canvas = $("circuit");
  canvas.addEventListener("dragover", (e) => {
    if (e.dataTransfer!.types.includes(PART_TYPE)) e.preventDefault();
  });
  canvas.addEventListener("drop", (e) => {
    const type = e.dataTransfer!.getData(PART_TYPE);
    if (!catalog.parts.some((p) => p.type === type)) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    void add(type, {
      x: (e.clientX - r.left) / zoom(),
      y: (e.clientY - r.top) / zoom(),
    });
  });
  $("save").addEventListener("click", async () => {
    note("saving");
    try {
      const r = await fetch("/circuit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: serializeCircuit(circuit),
      });
      note(r.ok ? "saved" : `not saved: ${await r.text()}`);
    } catch (e) {
      note(`not saved: ${(e as Error).message}`);
    }
  });
}

/** Says what an edit or save did, in the header. */
function note(text: string) {
  $("edit").textContent = text;
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

/** The ELF on disk now: the server reads it on every request. */
async function firmware(): Promise<Uint8Array> {
  return new Uint8Array(await (await get("/elf")).arrayBuffer());
}

async function get(path: string): Promise<Response> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r;
}
