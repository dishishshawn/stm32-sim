// The browser side of `sim ui`: loads the firmware and circuit from the
// server, runs the engine in this page at real-time speed, and shows each
// part's state(). Parts can be added, moved and removed, wires drawn and
// removed, and the circuit saved back to its file. Choices are recorded in
// docs/decisions.md §15.
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
/** Keys that move between a breadboard's holes: a direction, and whether to go as far as it can. */
const ROVE: Record<string, [number, number, boolean]> = {
  ArrowLeft: [-1, 0, false],
  ArrowRight: [1, 0, false],
  ArrowUp: [0, -1, false],
  ArrowDown: [0, 1, false],
  Home: [-1, 0, true],
  End: [1, 0, true],
  PageUp: [0, -1, true],
  PageDown: [0, 1, true],
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

/** Palette of vibrant jumper wire colors. */
const WIRE_COLORS = [
  "#2563eb", // blue
  "#16a34a", // emerald green
  "#d97706", // amber
  "#9333ea", // purple
  "#db2777", // pink
  "#0284c7", // sky
  "#ea580c", // orange
  "#0d9488", // teal
];

function wireColor(a: string, b: string, index: number): string {
  const isPower = (ep: string) =>
    ep === "3V3" || ep.endsWith(".VDD") || ep.endsWith(".V+");
  const isGnd = (ep: string) => ep === "GND" || ep.endsWith(".GND");
  const isScl = (ep: string) => ep.includes("SCL") || ep.includes("PB6");
  const isSda = (ep: string) => ep.includes("SDA") || ep.includes("PB7");

  if (isPower(a) || isPower(b)) return "#ef4444";
  if (isGnd(a) || isGnd(b)) return "#334155";
  if (isScl(a) || isScl(b)) return "#f59e0b";
  if (isSda(a) || isSda(b)) return "#06b6d4";

  return WIRE_COLORS[index % WIRE_COLORS.length];
}

/**
 * Calculates a smooth cubic Bezier arc for jumper wires.
 * Eliminates the chaotic "spiderweb" effect by fanning out parallel wires.
 */
function wirePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  index = 0,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }

  // Consistent orientation: always evaluate perpendicular from left to right (or top to bottom)
  // so wires in opposite endpoint order curve in the SAME direction and don't cross!
  const isLeftToRight = from.x < to.x || (from.x === to.x && from.y < to.y);
  const p1 = isLeftToRight ? from : to;
  const p2 = isLeftToRight ? to : from;
  const pdx = p2.x - p1.x;
  const pdy = p2.y - p1.y;

  const variance = ((index % 4) - 1.5) * 5;
  const sag = Math.min(40, Math.max(12, dist * 0.15)) + variance;

  // Normal pointing downward (+y, natural gravity drape) when moving left-to-right
  let nx = -pdy / dist;
  let ny = pdx / dist;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  if (Math.abs(pdx) < dist * 0.2) {
    nx = (index % 2 === 0 ? -1 : 1) * 0.8;
    ny = 0.2;
  }

  const dir = isLeftToRight ? 1 : -1;
  const cp1x = Number((from.x + pdx * 0.28 * dir + nx * sag).toFixed(1));
  const cp1y = Number((from.y + pdy * 0.28 * dir + ny * sag).toFixed(1));
  const cp2x = Number((to.x - pdx * 0.28 * dir + nx * sag).toFixed(1));
  const cp2y = Number((to.y - pdy * 0.28 * dir + ny * sag).toFixed(1));

  return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
}

type Wokwi = HTMLElement & Record<string, unknown>;
/** A pin's name and where it is drawn, from its figure's top-left, in CSS px. */
type Spot = { pin: string; x: number; y: number };
type Wire = [string, string];

/** The board's header pins that are circuit endpoints, by endpoint. GND is on two: wires go to the first. */
const HEADER = new Map(
  Object.values(nucleo.pins)
    .filter((p) => p.endpoint)
    .reverse()
    .map((p) => [p.endpoint!, p]),
);

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
/** The Nucleo board's position on the canvas. */
let boardPos = { x: 0, y: 0 };
/** The endpoint a wire being drawn starts at: its first pin is picked, not its second. */
let pending: string | undefined;
/** pinSpots() by part type. */
const spotsOf = new Map<string, readonly Spot[]>();
/** The id of the part selected on the canvas, and the panels told of it (ui.onSelect). */
let selected: string | undefined;
const selects: ((id: string | undefined) => void)[] = [];

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
    onSelect: (fn) => void selects.push(fn),
    change,
  };
  for (const mount of panels) mount(ui);
}

/** Tells the panels which part is selected, if that changed. */
function select(id: string | undefined) {
  if (id === selected) return;
  selected = id;
  for (const fn of selects) fn(id);
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
  return tenth(Math.round(v / GRID) * GRID);
}
/** To 0.1 px, and on the canvas. */
function tenth(v: number) {
  return Math.max(0, Number(v.toFixed(1)));
}

/**
 * Where a part type's pins are drawn: its element's pinInfo, or its art's
 * pins. A part drawn as a plain box gets a row of pins along its top.
 */
function pinSpots(type: string): readonly Spot[] {
  let spots = spotsOf.get(type);
  if (spots) return spots;
  const { pins } = catalog.parts.find((p) => p.type === type)!;
  const art = partArt[type];
  spots = ELEMENT[type]
    ? (
        (document.createElement(ELEMENT[type]) as Wokwi).pinInfo as {
          name: string;
          x: number;
          y: number;
        }[]
      )
        .filter((p) => pins.includes(p.name))
        .map(({ name, x, y }) => ({ pin: name, x, y }))
    : art
      ? pins.map((pin) => ({
          pin,
          x: art.pins[pin].x * PX_PER_UNIT,
          y: art.pins[pin].y * PX_PER_UNIT,
        }))
      : pins.map((pin, i) => ({ pin, x: GRID / 2 + i * GRID, y: 0 }));
  spotsOf.set(type, spots);
  return spots;
}

/** Where an endpoint is on the canvas; undefined if it isn't drawn (an MCU pin on no header). */
function spot(endpoint: string): { x: number; y: number } | undefined {
  const header = HEADER.get(endpoint);
  if (header)
    return {
      x: boardPos.x + header.x * PX_PER_UNIT,
      y: boardPos.y + header.y * PX_PER_UNIT,
    };
  // An endpoint is "<id>.<pin>", and an id has no dot.
  const dot = endpoint.indexOf(".");
  const part = circuit.parts.find((p) => p.id === endpoint.slice(0, dot));
  const pin = endpoint.slice(dot + 1);
  const s = part && pinSpots(part.type).find((s) => s.pin === pin);
  if (!part || !s) return undefined;
  const at = where(part);
  return { x: at.x + s.x, y: at.y + s.y };
}

/**
 * The board at the top left, each part at its "pos" or in the grid, and the
 * wires over them. Every pin gets a button: click one, then another, to wire them.
 */
function render() {
  drawn = [];
  stop();
  $("circuit").replaceChildren();
  /** A figure at (x, y): `visual` at its top-left with `pins` [label, endpoint, spot] on it, then `rest`. */
  const place = (
    id: string,
    x: number,
    y: number,
    visual: Node,
    pins: [string, string, Spot][],
    ...rest: Node[]
  ) => {
    const fig = document.createElement("figure");
    fig.dataset.part = id;
    fig.style.left = `${x}px`;
    fig.style.top = `${y}px`;
    const body = document.createElement("div");
    body.className = "body";
    body.append(visual);
    for (const [label, endpoint, s] of pins) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pin-target";
      b.title = label;
      b.dataset.endpoint = endpoint;
      b.style.left = `${s.x}px`;
      b.style.top = `${s.y}px`;
      body.append(b);
    }
    const caption = document.createElement("figcaption");
    caption.textContent = id;
    fig.append(body, ...rest, caption);
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
  const boardFig = place(
    "mcu",
    boardPos.x,
    boardPos.y,
    board,
    Object.values(nucleo.pins).flatMap((p) =>
      p.endpoint
        ? [
            [
              `board pin ${p.signal}${p.endpoint.startsWith("mcu.") ? ` (${p.label})` : ""}`,
              p.endpoint,
              { pin: p.signal, x: p.x * PX_PER_UNIT, y: p.y * PX_PER_UNIT },
            ],
          ]
        : [],
    ),
  );
  movableBoard(boardFig);

  engine.view().parts.forEach((p, i) => {
    const pos = where(circuit.parts[i]);
    let visual: Node;
    const content: Node[] = [];
    const tag = ELEMENT[p.type];
    const art = partArt[p.type];
    if (tag) {
      const el = document.createElement(tag) as Wokwi;
      visual = el;
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
      visual = svg(art, p.type);
    } else {
      const box = document.createElement("span");
      box.className = "chip";
      box.textContent = p.type;
      box.style.minWidth = `${p.pins.length * GRID}px`; // its row of pins
      visual = box;
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
    const breadboard = p.type === "breadboard";
    const spots = pinSpots(p.type).map((s): [string, string, Spot] => [
      `${p.id} ${breadboard ? "hole" : "pin"} ${s.pin}`,
      `${p.id}.${s.pin}`,
      s,
    ]);
    const fig = place(p.id, pos.x, pos.y, visual, spots, ...content);
    fig.dataset.type = p.type;
    // A breadboard's holes are one tab stop; the arrow keys move between
    // them (rove()), and the focused one becomes the stop.
    if (breadboard)
      fig
        .querySelectorAll<HTMLElement>(".pin-target")
        .forEach((b, i) => (b.tabIndex = i ? -1 : 0));
    movable(fig, circuit.parts[i]);
  });

  // The wires, each coloured by its net's level, and the rubber band of one
  // being drawn. A wire is focusable: click or Tab to it, then Delete.
  const t = document.createElement("template");
  t.innerHTML = `<svg id="wires" role="group" aria-label="Wires">${circuit.wires
    .map(
      ([a, b], i) =>
        `<g class="wire" data-wire="${i}" tabindex="0" role="button" aria-label="wire ${a} to ${b}" aria-keyshortcuts="Delete"><title/><line class="hit straight-hit"/><path class="hit curve-hit"/><path class="wire-shadow"/><path class="line"/><circle class="wire-cap wire-cap-from" r="2.5"/><circle class="wire-cap wire-cap-to" r="2.5"/></g>`,
    )
    .join("")}<path class="band"/></svg>`;
  const overlay = t.content.firstElementChild!;
  $("circuit").append(overlay);
  const wires = overlay.querySelectorAll<SVGGElement>(".wire");
  drawn.push(() => {
    const view = engine.view();
    wires.forEach((g, i) => {
      const level = view.level(circuit.wires[i][0]);
      if (g.dataset.level === level) return;
      g.dataset.level = level;
      g.firstChild!.textContent = `${circuit.wires[i].join(" to ")}: ${level}. Click, then Delete, to remove it`;
    });
  });
  fit();
  drawWires();
  if (!circuit.parts.some((p) => p.id === selected)) select(undefined);
}

/** Puts each wire between its pins' spots. A wire to a pin that isn't drawn is hidden. */
function drawWires() {
  const lines = $("circuit").querySelectorAll<SVGGElement>(".wire");
  circuit.wires.forEach(([a, b], i) => {
    const from = spot(a);
    const to = spot(b);
    lines[i].style.display = from && to ? "" : "none";
    if (from && to) updateWire(lines[i], from, to, i, a, b);
  });
}

function updateWire(
  g: SVGGElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  index: number,
  a: string,
  b: string,
) {
  const d = wirePath(from, to, index);
  const color = wireColor(a, b, index);
  g.style.setProperty("--wire-color", color);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const isPlug = dist < 5;

  const straightHit = g.querySelector(".straight-hit");
  if (straightHit) {
    straightHit.setAttribute("x1", String(from.x));
    straightHit.setAttribute("y1", String(from.y));
    straightHit.setAttribute("x2", String(to.x));
    straightHit.setAttribute("y2", String(to.y));
  }

  const curveHit = g.querySelector(".curve-hit");
  if (curveHit) {
    curveHit.setAttribute("d", d);
  }

  const lineEl = g.querySelector(".line");
  if (lineEl) {
    lineEl.setAttribute("x1", String(from.x));
    lineEl.setAttribute("y1", String(from.y));
    lineEl.setAttribute("x2", String(to.x));
    lineEl.setAttribute("y2", String(to.y));
    lineEl.setAttribute("d", d);
  }

  const shadow = g.querySelector(".wire-shadow");
  if (shadow) {
    shadow.setAttribute("d", d);
    if (isPlug) shadow.setAttribute("display", "none");
    else shadow.removeAttribute("display");
  }

  const capFrom = g.querySelector(".wire-cap-from");
  if (capFrom) {
    capFrom.setAttribute("cx", String(from.x));
    capFrom.setAttribute("cy", String(from.y));
    if (isPlug) capFrom.setAttribute("display", "none");
    else capFrom.removeAttribute("display");
  }

  const capTo = g.querySelector(".wire-cap-to");
  if (capTo) {
    capTo.setAttribute("cx", String(to.x));
    capTo.setAttribute("cy", String(to.y));
    if (isPlug) capTo.setAttribute("display", "none");
    else capTo.removeAttribute("display");
  }
}

function line(l: Element, from: { x: number; y: number }, to = from) {
  l.setAttribute("x1", String(from.x));
  l.setAttribute("y1", String(from.y));
  l.setAttribute("x2", String(to.x));
  l.setAttribute("y2", String(to.y));
  l.setAttribute("d", `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
}

/** Sizes the canvas to hold every part, so it scrolls to them. */
function fit() {
  const at = [boardPos, ...circuit.parts.map(where)];
  $("circuit").style.width = `${Math.max(...at.map((p) => p.x + (p === boardPos ? nucleo.width * PX_PER_UNIT : 0))) + CELL.w}px`;
  $("circuit").style.height = `${Math.max(...at.map((p) => p.y + (p === boardPos ? nucleo.height * PX_PER_UNIT : 0))) + CELL.h}px`;
}

/** Drag with the pointer, or use the arrow keys to move the Nucleo board. */
function movableBoard(fig: HTMLElement) {
  fig.tabIndex = 0;
  fig.title = "Drag or use the arrow keys to move the board";

  const put = (pos: { x: number; y: number }) => {
    boardPos = { x: snap(pos.x), y: snap(pos.y) };
    fig.style.left = `${boardPos.x}px`;
    fig.style.top = `${boardPos.y}px`;
    fit();
    drawWires();
  };

  fig.addEventListener("keydown", (e) => {
    if (e.target !== fig) return;
    const step = ARROWS[e.key];
    if (step) {
      e.preventDefault();
      put({ x: boardPos.x + step[0] * GRID, y: boardPos.y + step[1] * GRID });
    }
  });

  fig.addEventListener("pointerdown", (e) => {
    const own = (e.target as Element).closest(".pin-target");
    if (own || e.button !== 0) return;
    fig.setPointerCapture(e.pointerId);
    const from = { ...boardPos, cx: e.clientX, cy: e.clientY, z: zoom() };
    let moved = false;
    const drag = (e: PointerEvent) => {
      const dx = (e.clientX - from.cx) / from.z;
      const dy = (e.clientY - from.cy) / from.z;
      if (!moved && Math.hypot(dx, dy) < GRID / 2) return;
      moved = true;
      put({ x: from.x + dx, y: from.y + dy });
    };
    fig.addEventListener("pointermove", drag);
    fig.addEventListener(
      "lostpointercapture",
      () => fig.removeEventListener("pointermove", drag),
      { once: true },
    );
  });
}

/** The canvas's CSS zoom: pointer distances divide by it. */
function zoom() {
  return Number(getComputedStyle($("circuit")).zoom) || 1;
}

/**
 * Drag with the pointer, or the arrow keys for one grid step; either writes
 * the part's "pos", seats it in a breadboard's holes if it ends over them,
 * and a breadboard carries the parts plugged into it. Delete asks, then
 * removes it. Moving restarts the simulation only if it plugs pins into a
 * breadboard or pulls them out (plugs()): "pos" itself isn't simulated.
 */
function movable(fig: HTMLElement, part: CircuitPart) {
  fig.tabIndex = 0;
  fig.title = "Drag or use the arrow keys to move it; Delete removes it";
  /** The plugs before a move, and the parts plugged into this one (a breadboard), which it carries. */
  const grab = () => {
    const before = plugs();
    const carried = circuit.parts.filter((p) =>
      before.some(
        ([pin, hole]) =>
          pin.startsWith(`${p.id}.`) && hole.startsWith(`${part.id}.`),
      ),
    );
    return { before, carried };
  };
  const put = (pos: { x: number; y: number }, carried: CircuitPart[]) => {
    const old = where(part);
    const dx = pos.x - old.x;
    const dy = pos.y - old.y;
    if (!dx && !dy) return;
    for (const p of [part, ...carried]) {
      const at = where(p);
      p.pos = p === part ? pos : { x: tenth(at.x + dx), y: tenth(at.y + dy) };
      const f = document.querySelector<HTMLElement>(`[data-part="${p.id}"]`)!;
      f.style.left = `${p.pos.x}px`;
      f.style.top = `${p.pos.y}px`;
    }
    fit();
    drawWires();
  };
  fig.addEventListener("keydown", (e) => {
    if (e.target !== fig) return; // the slider's and pins' keys are their own
    const step = ARROWS[e.key];
    if (step) {
      e.preventDefault();
      const { before, carried } = grab();
      const x = where(part).x + step[0] * GRID;
      const y = where(part).y + step[1] * GRID;
      // A part in a breadboard moves hole to hole, not back onto the grid.
      const plugged = before.some(([pin]) => pin.startsWith(`${part.id}.`));
      put(
        plugged ? { x: tenth(x), y: tenth(y) } : { x: snap(x), y: snap(y) },
        carried,
      );
      const seated = seat(part);
      if (seated) put(seated, carried);
      replug(part, before);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(part);
    }
  });
  fig.addEventListener("pointerdown", (e) => {
    // The push-button, the slider and the pins keep their own pointer.
    const own = (e.target as Element).closest(
      ".control, wokwi-pushbutton, .pin-target",
    );
    if (own || e.button !== 0) return;
    fig.setPointerCapture(e.pointerId);
    const from = { ...where(part), cx: e.clientX, cy: e.clientY, z: zoom() };
    const { before, carried } = grab();
    let moved = false;
    const drag = (e: PointerEvent) => {
      const dx = (e.clientX - from.cx) / from.z;
      const dy = (e.clientY - from.cy) / from.z;
      // A click isn't a move: it would snap an unmoved part to the grid.
      if (!moved && Math.hypot(dx, dy) < GRID / 2) return;
      moved = true;
      put({ x: snap(from.x + dx), y: snap(from.y + dy) }, carried);
    };
    fig.addEventListener("pointermove", drag);
    fig.addEventListener(
      "lostpointercapture",
      () => {
        fig.removeEventListener("pointermove", drag);
        if (!moved) return;
        const seated = seat(part);
        if (seated) put(seated, carried);
        replug(part, before);
      },
      { once: true },
    );
  });
}

/**
 * The hole a key goes to from `pin`: the nearest in its direction (or the
 * farthest, for Home, End, PageUp and PageDown), in its column or the nearest
 * one that has a hole there. Left and right stay in the row.
 */
function rove(
  spots: readonly Spot[],
  pin: string,
  [dx, dy, far]: [number, number, boolean],
) {
  const at = spots.find((s) => s.pin === pin)!;
  let best: { s: Spot; along: number; across: number } | undefined;
  for (const s of spots) {
    const along = (s.x - at.x) * dx + (s.y - at.y) * dy;
    const across = Math.abs((s.x - at.x) * dy - (s.y - at.y) * dx);
    if (along <= 0 || (dx && across)) continue;
    if (
      !best ||
      across < best.across ||
      (across === best.across &&
        (far ? along > best.along : along < best.along))
    )
      best = { s, along, across };
  }
  return best?.s;
}

/** Every breadboard hole on the canvas. */
function holes() {
  return circuit.parts
    .filter((p) => p.type === "breadboard")
    .flatMap((bb) => {
      const at = where(bb);
      return pinSpots(bb.type).map((s) => ({
        endpoint: `${bb.id}.${s.pin}`,
        x: at.x + s.x,
        y: at.y + s.y,
      }));
    });
}

/**
 * Plugs: each part pin within GRID / 3 of a breadboard hole, as the wire
 * [pin, hole]. Wokwi's parts aren't all on the 0.1 in pitch (an LED's legs are
 * 10 px apart, not 9.6), so a pin need not be dead on its hole.
 */
function plugs(): Wire[] {
  const all = holes();
  if (!all.length) return [];
  return circuit.parts
    .filter((p) => p.type !== "breadboard")
    .flatMap((p) =>
      pinSpots(p.type).flatMap((s): Wire[] => {
        const pin = `${p.id}.${s.pin}`;
        const at = spot(pin)!;
        const hole = all.find(
          (h) => Math.hypot(h.x - at.x, h.y - at.y) < GRID / 3,
        );
        return hole ? [[pin, hole.endpoint]] : [];
      }),
    );
}

/**
 * Where a part dropped on a breadboard goes: moved so that its pin nearest a
 * hole sits in it. Undefined if no pin is over the holes.
 */
function seat(part: CircuitPart) {
  if (part.type === "breadboard") return undefined;
  const all = holes();
  let best: { d: number; dx: number; dy: number } | undefined;
  for (const s of pinSpots(part.type)) {
    const at = spot(`${part.id}.${s.pin}`)!;
    for (const h of all) {
      const d = Math.hypot(h.x - at.x, h.y - at.y);
      // 0.75 grid reaches a hole from anywhere over the board.
      if (d < GRID * 0.75 && (!best || d < best.d))
        best = { d, dx: h.x - at.x, dy: h.y - at.y };
    }
  }
  if (!best) return undefined;
  const at = where(part);
  return { x: tenth(at.x + best.dx), y: tenth(at.y + best.dy) };
}

/**
 * The wires after a move, given the plugs before it: a plug that came apart
 * is taken out, and a pin now on a hole gets its plug, appended. Undefined if
 * nothing changed. A plug is an ordinary wire, so Save writes it like any other.
 */
function rewire(before: Wire[]) {
  const key = (w: Wire) => [...w].sort().join(" ");
  const after = plugs();
  const now = new Set(after.map(key));
  const apart = new Set(before.map(key).filter((k) => !now.has(k)));
  const have = new Set(circuit.wires.map(key));
  const added = after.filter((w) => !have.has(key(w)));
  const kept = circuit.wires.filter((w) => !apart.has(key(w)));
  const out = circuit.wires.length - kept.length;
  if (!added.length && !out) return undefined;
  return {
    wires: [...kept, ...added],
    text: `${added.length} in, ${out} out`,
  };
}

/** After `part` moved: if its move plugged or unplugged pins, applies that and restarts. */
function replug(part: CircuitPart, before: Wire[]) {
  const plugged = rewire(before);
  if (!plugged) return;
  void change(() => {
    circuit.wires = plugged.wires;
    return `moved ${part.id} (${plugged.text})`;
  }).then(() =>
    document.querySelector<HTMLElement>(`[data-part="${part.id}"]`)?.focus(),
  );
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
    const part: CircuitPart = { id, type, props: {}, pos };
    circuit.parts.push(part);
    // Dropped on a breadboard: into its holes.
    part.pos = (at && seat(part)) || pos;
    const plugged = rewire([]);
    if (plugged) circuit.wires = plugged.wires;
    return plugged ? `added ${id} (${plugged.text})` : `added ${id}`;
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
    b.dataset.type = type;
    b.draggable = true;
    b.addEventListener("click", () => add(type));
    b.addEventListener("dragstart", (e) =>
      e.dataTransfer!.setData(PART_TYPE, type),
    );
    $("palette").append(b);
  }
  const canvas = $("circuit");
  // Wiring: click (or Enter on) a pin, then another; Escape cancels. The
  // rubber band follows the pointer, or the pin the keyboard is on.
  canvas.addEventListener("click", (e) => {
    const pin = (e.target as Element).closest<HTMLElement>(".pin-target");
    if (pin) pick(pin);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pending === undefined) return;
    const r = canvas.getBoundingClientRect();
    band({
      x: (e.clientX - r.left) / zoom(),
      y: (e.clientY - r.top) / zoom(),
    });
  });
  canvas.addEventListener("focusin", (e) => {
    // A part is selected by focusing it, or anything on it (a click focuses it).
    const fig = (e.target as Element).closest<HTMLElement>("figure[data-type]");
    if (fig) select(fig.dataset.part);
    const pin = (e.target as Element).closest<HTMLElement>(".pin-target");
    if (pin && pending !== undefined) band(spot(pin.dataset.endpoint!));
    // A breadboard's focused hole is its one tab stop.
    if (pin && fig?.dataset.type === "breadboard") {
      const stop = fig.querySelector<HTMLElement>('.pin-target[tabindex="0"]');
      if (stop) stop.tabIndex = -1;
      pin.tabIndex = 0;
    }
  });
  // On a breadboard's hole, the arrow keys (and Home, End, PageUp, PageDown) move to another.
  canvas.addEventListener("keydown", (e) => {
    const hole = (e.target as Element).closest<HTMLElement>(
      '[data-type="breadboard"] .pin-target',
    );
    if (!hole || !ROVE[e.key]) return;
    e.preventDefault();
    const [id, pin] = hole.dataset.endpoint!.split(".");
    const to = rove(pinSpots("breadboard"), pin, ROVE[e.key]);
    if (to)
      document
        .querySelector<HTMLElement>(`[data-endpoint="${id}.${to.pin}"]`)!
        .focus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || pending === undefined) return;
    stop();
    note("wiring cancelled");
  });
  // A focused wire: Delete removes it.
  canvas.addEventListener("keydown", (e) => {
    const g = (e.target as Element).closest<SVGGElement>(".wire");
    if (!g || (e.key !== "Delete" && e.key !== "Backspace")) return;
    e.preventDefault();
    const wire = circuit.wires[Number(g.dataset.wire)];
    void change(() => {
      circuit.wires = circuit.wires.filter((w) => w !== wire);
      return `removed the wire ${wire[0]} to ${wire[1]}`;
    }).then(() => canvas.focus());
  });
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

/**
 * A pin clicked: the first starts a wire, the second ends it and restarts the
 * simulation with the wire appended (so the file's wire order stays as it was).
 * The same pin again cancels.
 */
function pick(pin: HTMLElement) {
  const endpoint = pin.dataset.endpoint!;
  const from = pending;
  if (from === undefined) {
    pending = endpoint;
    pin.classList.add("from");
    $("circuit").dataset.wiring = "";
    line($("circuit").querySelector(".band")!, spot(endpoint)!);
    note(`wiring from ${endpoint}: pick the other pin, or Escape`);
    return;
  }
  stop();
  if (from === endpoint) return note("wiring cancelled");
  if (circuit.wires.some((w) => w.includes(from) && w.includes(endpoint)))
    return note(`${from} and ${endpoint} are already wired`);
  void change(() => {
    circuit.wires.push([from, endpoint]);
    return `wired ${from} to ${endpoint}`;
  }).then(() =>
    document
      .querySelector<HTMLElement>(`[data-endpoint="${endpoint}"]`)
      ?.focus(),
  );
}

/** Ends drawing a wire, if one is being drawn. */
function stop() {
  pending = undefined;
  delete $("circuit").dataset.wiring;
  document.querySelector(".pin-target.from")?.classList.remove("from");
}

/** Moves the free end of the rubber band. */
function band(to: { x: number; y: number } | undefined) {
  const l = $("circuit").querySelector(".band");
  if (!l || !to) return;
  l.setAttribute("x2", String(to.x));
  l.setAttribute("y2", String(to.y));
  const fromX = Number(l.getAttribute("x1"));
  const fromY = Number(l.getAttribute("y1"));
  l.setAttribute("d", wirePath({ x: fromX, y: fromY }, to, 0));
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
