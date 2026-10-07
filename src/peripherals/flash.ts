// FLASH: only FLASH_ACR is simulated, as plain storage, so LATENCY reads back what
// the firmware wrote. RM0444 §3.7.1: a new LATENCY "becomes effective when it
// returns the same value upon read", so firmware polls it (§3.3.4). Wait states
// aren't modelled: real silicon misreads flash when LATENCY is too low for HCLK
// (§3.3.4, Table 13), and a diagnostic, not the simulator, should say so (T42).
// Programming and option bytes (KEYR, SR, CR, OPTR, ...) stay plain storage,
// flagged "unsimulated". See docs/decisions.md §14.
import type { Peripheral } from "./peripheral.ts";

export const flash: Peripheral = {
  name: "FLASH",
  simulates: ["ACR"],
  create: () => ({}),
};
