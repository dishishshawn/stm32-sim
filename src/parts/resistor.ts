// A resistor: a weak link between its two pins. Between a net and 3V3 it is a pull-up.
import type { Part } from "./part.ts";

export const resistor: Part = {
  type: "resistor",
  pins: ["1", "2"],
  // Not used by the digital model; kept for the UI and later analog work.
  props: { ohms: { type: "number", default: 10000, min: 0 } },
  create(ctx) {
    ctx.addResistor("1", "2");
    return {};
  },
};
