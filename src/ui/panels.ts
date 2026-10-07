// The panel registration list: add one import and one entry per panel.
<<<<<<< HEAD
import { registerView } from "./registers.ts";
||||||| c14b0c2
=======
import { controls } from "./controls.ts";
>>>>>>> worktree-agent-afe54d0060cbda529
import type { Panel } from "./ui.ts";

<<<<<<< HEAD
export const panels: readonly Panel[] = [registerView];
||||||| c14b0c2
export const panels: readonly Panel[] = [];
=======
export const panels: readonly Panel[] = [controls];
>>>>>>> worktree-agent-afe54d0060cbda529
