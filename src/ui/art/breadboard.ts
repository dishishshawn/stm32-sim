// A half-size breadboard (400 tie points): 30 columns of two 5-hole strips
// (rows a–e and f–j, either side of a 0.3 in channel, so a DIP fits across it)
// and four 25-hole power rails.
//
// Hole names: "a1".."j30" (row letter, column number), and rails "tp1".."tp25"
// (top +), "tn1".."tn25" (top −), "bp1".."bp25" (bottom +), "bn1".."bn25" (bottom −).
// `groups` lists the holes joined inside the board: each 5-hole strip, and each rail.
import type { Art, Pin } from "./index.ts";

const W = 330;
const H = 200;
const COLS = 30;
const colX = (c: number) => 20 + 10 * (c - 1);
// Rows e and f are 0.3 in apart, across the channel.
const ROWS_Y: Record<string, number> = {
  a: 45,
  b: 55,
  c: 65,
  d: 75,
  e: 85,
  f: 115,
  g: 125,
  h: 135,
  i: 145,
  j: 155,
};
// Rails sit in groups of 5 under columns 2–6, 8–12, …, 26–30.
const RAIL_COLS = Array.from(
  { length: 25 },
  (_, k) => 2 + k + Math.floor(k / 5),
);
const RAILS = [
  { name: "tn", y: 10, line: 4, color: "#1565c0", sign: "−" },
  { name: "tp", y: 20, line: 26, color: "#c62828", sign: "+" },
  { name: "bp", y: 180, line: 174, color: "#c62828", sign: "+" },
  { name: "bn", y: 190, line: 196, color: "#1565c0", sign: "−" },
];

const pins: Record<string, Pin> = {};
const groups: string[][] = [];

for (let c = 1; c <= COLS; c++) {
  for (const strip of ["abcde", "fghij"]) {
    const group = [...strip].map((r) => {
      pins[`${r}${c}`] = { x: colX(c), y: ROWS_Y[r] };
      return `${r}${c}`;
    });
    groups.push(group);
  }
}
let lines = "";
let labels = "";
for (const rail of RAILS) {
  const group = RAIL_COLS.map((c, k) => {
    pins[`${rail.name}${k + 1}`] = { x: colX(c), y: rail.y };
    return `${rail.name}${k + 1}`;
  });
  groups.push(group);
  lines += `<line x1="15" y1="${rail.line}" x2="315" y2="${rail.line}" stroke="${rail.color}" stroke-width="1"/>`;
  for (const x of [8, 322])
    labels += `<text x="${x}" y="${rail.y}" dy="0.35em" font-size="6" fill="${rail.color}">${rail.sign}</text>`;
}
for (const [r, y] of Object.entries(ROWS_Y))
  for (const x of [8, 322])
    labels += `<text x="${x}" y="${y}" dy="0.35em">${r}</text>`;
for (const c of [1, 5, 10, 15, 20, 25, 30])
  for (const y of [37, 163])
    labels += `<text x="${colX(c)}" y="${y}" dy="0.35em">${c}</text>`;

const holes = Object.values(pins)
  .map(
    ({ x, y }) =>
      `<rect x="${x - 1.5}" y="${y - 1.5}" width="3" height="3" rx="0.6"/>`,
  )
  .join("");

export const breadboard: Art & {
  readonly groups: readonly (readonly string[])[];
} = {
  svg:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="4" fill="#f4f1ea" stroke="#c8c2b4"/>` +
    `<rect x="4" y="96" width="${W - 8}" height="8" rx="2" fill="#e2ddd1"/>` + // centre channel
    lines +
    `<g fill="#4a4a4a">${holes}</g>` +
    `<g font-size="4" fill="#8a8478" text-anchor="middle">${labels}</g>` +
    `</svg>`,
  width: W,
  height: H,
  pins,
  groups,
};
