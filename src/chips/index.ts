// The chip registration list, by the name circuit JSON uses ("chip": "stm32g031k8").
import type { Chip } from "../engine/memory-bus.ts";
import { stm32g031k8 } from "./stm32g031k8.ts";

export const chips: Readonly<Record<string, Chip>> = { stm32g031k8 };
