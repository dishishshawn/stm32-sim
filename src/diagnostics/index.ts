// The diagnostic rule registration list: add one import and one entry per rule.
import { clockSwitchNotReady } from "./clock-switch-not-ready.ts";
import { flashLatency } from "./flash-latency.ts";
import { gpioClockOff } from "./gpio-clock-off.ts";
import { i2cBusNotIdle } from "./i2c-bus-not-idle.ts";
import { i2cNackNoDevice } from "./i2c-nack-no-device.ts";
import { i2cPinPushPull } from "./i2c-pin-push-pull.ts";
import { i2cPinsNotAf6 } from "./i2c-pins-not-af6.ts";
import { pllConfigWhileOn } from "./pll-config-while-on.ts";
import { pllOutOfRange } from "./pll-out-of-range.ts";
import type { Rule } from "./rule.ts";
import { timingrWhilePe } from "./timingr-while-pe.ts";
import { unsimulatedRegister } from "./unsimulated-register.ts";

export const rules: readonly Rule[] = [
  gpioClockOff,
  unsimulatedRegister,
  timingrWhilePe,
  i2cPinsNotAf6,
  i2cPinPushPull,
  i2cBusNotIdle,
  i2cNackNoDevice,
  flashLatency,
  pllOutOfRange,
  clockSwitchNotReady,
  pllConfigWhileOn,
];
