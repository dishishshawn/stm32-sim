// unsimulated-register: an access to a register nothing simulates yet, so the
// learner knows the limit is the simulator's, not their code's. The bus flags
// it "unsimulated" (docs/decisions.md §8): an SVD register is plain storage,
// and the system control space (NVIC, ...) reads 0 and ignores writes.
import type { Rule } from "./rule.ts";

export const unsimulatedRegister: Rule = {
  id: "unsimulated-register",
  check(e) {
    if (e.kind !== "reg" || !e.flags.includes("unsimulated")) return [];
    // The system control space has no register names.
    const reg = e.reg || `0x${e.address.toString(16).padStart(8, "0")}`;
    const [name, does] = e.reg
      ? [`${e.periph}->${reg}`, "it reads back what was written"]
      : [`${e.periph} ${reg}`, "it reads 0 and ignores writes"];
    return [
      {
        severity: "info",
        message: `${name}: this register isn't simulated yet; ${does}`,
        periph: e.periph,
        reg,
      },
    ];
  },
};
