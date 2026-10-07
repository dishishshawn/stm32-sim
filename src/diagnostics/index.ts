// The diagnostic rule registration list: add one import and one entry per rule.
import { gpioClockOff } from "./gpio-clock-off.ts";
import type { Rule } from "./rule.ts";
import { unsimulatedRegister } from "./unsimulated-register.ts";

export const rules: readonly Rule[] = [gpioClockOff, unsimulatedRegister];
