// What a UI panel gets. Each panel is one file in src/ui/, registered in
// ./panels.ts, so panels can be added side by side without editing main.ts.
import type { Circuit } from "../engine/circuit.ts";
import type { Engine, Snapshot } from "../engine/engine.ts";

export interface Ui {
  readonly engine: Engine;
  readonly circuit: Circuit;
  /** Set `paused` to stop the run loop; the page keeps redrawing. */
  readonly run: { paused: boolean };
  /** Called with a fresh snapshot after every frame. */
  onSnapshot(fn: (s: Snapshot) => void): void;
  /** A new titled section in the side panel; returns the element to fill. */
  panel(title: string): HTMLElement;
  /** The header toolbar, for run controls. */
  readonly toolbar: HTMLElement;
}

export type Panel = (ui: Ui) => void;
