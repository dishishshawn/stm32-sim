// An LED. Pins match @wokwi/elements' wokwi-led: A (anode), C (cathode).
import type { Part } from "./part.ts";

export const led: Part = {
  type: "led",
  pins: ["A", "C"],
  props: {},
  create: (ctx) => ({
    // Lit only with current flowing anode to cathode; floating or conflict is unlit.
    state: () => ({
      lit: ctx.level("A") === "high" && ctx.level("C") === "low",
    }),
  }),
};
