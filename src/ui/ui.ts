// What a UI panel gets. Each panel is one file in src/ui/, registered in
// ./panels.ts, so panels can be added side by side without editing main.ts.
import type { Circuit } from "../engine/circuit.ts";
import type { Engine, Snapshot } from "../engine/engine.ts";

export interface Ui {
  readonly engine: Engine;
  readonly circuit: Circuit;
  /**
   * The run loop: `paused` stops it (the page keeps redrawing); `max` runs as
   * fast as the frame budget allows instead of keeping pace with the wall clock.
   */
  readonly run: { paused: boolean; max: boolean };
  /** Called with a fresh snapshot after every frame. */
  onSnapshot(fn: (s: Snapshot) => void): void;
  /** A new titled section in the side panel; returns the element to fill. */
  panel(title: string): HTMLElement;
  /** The header toolbar, for run controls. */
  readonly toolbar: HTMLElement;
  /** Called with the id of the part selected on the canvas (clicked or focused), or undefined once it is removed. */
  onSelect(fn: (id: string | undefined) => void): void;
  /**
   * Applies `edit` to `circuit`, then restarts the simulation on it and
   * redraws, as adding a part does. `edit` returns what it did, for the header.
   */
  change(edit: () => string): Promise<void>;
}

export type Panel = (ui: Ui) => void;
