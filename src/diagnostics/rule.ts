// The diagnostic rule interface. A rule explains a likely mistake and never
// alters behavior (docs/decisions.md §13): it gets each event and read-only views of the
// board, and returns what it found. diagnose() runs the rules over an event log
// and counts repeats, so a mistake inside a loop is reported once. A rule that
// throws is reported as a "rule-error" diagnostic, and the run goes on.
import type { BoardView } from "../engine/engine.ts";
import type { EventLog, SimEvent } from "../engine/events.ts";

export type Severity = "warning" | "info";

/** What a rule reports about one event. */
export interface Finding {
  readonly severity: Severity;
  /** What the learner reads. A repeat of the same rule and message is counted, not reported again. */
  readonly message: string;
  /** What it is about: a register ("GPIOB", "MODER"), or a pin ("PB6"). */
  readonly periph?: string;
  readonly reg?: string;
  readonly pin?: string;
}

export interface Rule {
  /** E.g. "gpio-clock-off". */
  readonly id: string;
  /** Called for every event. The board is read-only: a rule never changes the simulation. */
  check(event: SimEvent, board: BoardView): readonly Finding[];
}

/** A finding, where it first happened, and how many times it did. */
export interface Diagnostic extends Finding {
  readonly rule: string;
  count: number;
  readonly cycle: number;
  /** For a register access: the PC of the instruction, and its file:line. Else null. */
  readonly pc: number | null;
  readonly at: string | null;
}

/**
 * Runs `rules` on every event `events` emits from now on. Returns a function
 * giving the diagnostics so far, in order of first occurrence.
 */
export function diagnose(
  events: EventLog,
  board: BoardView,
  rules: readonly Rule[],
): () => Diagnostic[] {
  const found = new Map<string, Diagnostic>();
  events.subscribe((event) => {
    for (const rule of rules) {
      let id = rule.id;
      let findings: readonly Finding[];
      try {
        findings = rule.check(event, board);
      } catch (e) {
        // A bug in a rule must not stop or change the run: report it instead.
        id = "rule-error";
        const why = e instanceof Error ? e.message : String(e);
        findings = [
          {
            severity: "info",
            message:
              `the diagnostic rule "${rule.id}" failed: ${why}. The run is ` +
              "unaffected, but that rule's findings may be missing",
          },
        ];
      }
      for (const f of findings) {
        const key = `${id}\n${f.message}`;
        const seen = found.get(key);
        if (seen) {
          seen.count++;
          continue;
        }
        const pc = event.kind === "reg" ? event.pc : null;
        found.set(key, {
          rule: id,
          ...f,
          count: 1,
          cycle: event.cycle,
          pc,
          at: pc === null ? null : board.where(pc),
        });
      }
    }
  });
  return () => [...found.values()];
}
