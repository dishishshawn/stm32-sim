// A one-digit 7-segment display. Pins and `values` order match @wokwi/elements'
// wokwi-7segment (digits = 1): COM.1 and COM.2 are joined inside the part.
import type { Part } from "./part.ts";

/** The order of `values`, as in the element: A–G, then DP. */
const SEGMENTS = ["A", "B", "C", "D", "E", "F", "G", "DP"];

export const sevenSegment: Part = {
  type: "7segment",
  pins: ["COM.1", "COM.2", ...SEGMENTS],
  // Default "anode", as on wokwi.com.
  props: {
    common: { type: "string", default: "anode", options: ["anode", "cathode"] },
  },
  create(ctx) {
    ctx.setSwitch("COM.1", "COM.2", true);
    // A segment is lit when COM and the segment pin forward-bias it; floating or conflict is unlit.
    const [com, seg] =
      ctx.props.common === "anode" ? ["high", "low"] : ["low", "high"];
    return {
      state: () => ({
        values: SEGMENTS.map((s) =>
          ctx.level("COM.1") === com && ctx.level(s) === seg ? 1 : 0,
        ),
      }),
    };
  },
};
