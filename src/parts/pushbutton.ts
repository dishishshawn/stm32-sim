// A push-button: side 1 (1.l, 1.r) joins side 2 (2.l, 2.r) while pressed.
import type { Part } from "./part.ts";

export const pushbutton: Part = {
  type: "pushbutton",
  pins: ["1.l", "1.r", "2.l", "2.r"],
  props: { pressed: { type: "boolean", default: false } },
  create(ctx) {
    ctx.setSwitch("1.l", "1.r", true);
    ctx.setSwitch("2.l", "2.r", true);
    ctx.setSwitch("1.l", "2.l", ctx.props.pressed === true);
    return {
      setProp(name, value) {
        if (name === "pressed") ctx.setSwitch("1.l", "2.l", value === true);
      },
    };
  },
};
