// A half-size breadboard. Its pins are its 400 holes, named by its art
// (src/ui/art/breadboard.ts): "a1".."j30", and the rails "tp1".."bn25". Inside
// the board each 5-hole strip and each rail is joined, as by the real metal
// clips, so a wire or a part's pin in any hole of a strip is on that strip's net.
import { breadboard as art } from "../ui/art/breadboard.ts";
import type { Part } from "./part.ts";

export const breadboard: Part = {
  type: "breadboard",
  pins: Object.keys(art.pins),
  props: {},
  create(ctx) {
    for (const [first, ...rest] of art.groups)
      for (const hole of rest) ctx.setSwitch(first, hole, true);
    return {};
  },
};
