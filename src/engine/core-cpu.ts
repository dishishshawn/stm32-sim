// What peripherals may ask of the core (`Cpu` in peripheral.ts), done on
// our copy of rp2040js's CortexM0Core, the way upstream's NVIC and SCB registers
// (ppb.ts) do it.
import type { CortexM0Core } from "../cpu/cortex-m0-core.ts";
import type { Cpu } from "../peripherals/peripheral.ts";

/** The core's pending flag for NMI, PendSV and SysTick, which the SCB's ICSR sets and clears. */
const PENDING_FLAG = {
  2: "pendingNMI",
  14: "pendingPendSV",
  15: "pendingSystick",
} as const;

/** `core()` returns the current core: the engine builds the bus before the core. */
export function coreCpu(core: () => CortexM0Core): Cpu {
  const irq = (exception: number) =>
    exception >= 16 && exception < 16 + core().irqCount
      ? exception - 16
      : undefined;
  const flag = (exception: number) => {
    if (!Object.hasOwn(PENDING_FLAG, exception))
      throw new Error(`exception ${exception} can't be pended or read`);
    return PENDING_FLAG[exception as keyof typeof PENDING_FLAG];
  };
  const setPending = (exception: number, pending: boolean) => {
    const c = core();
    const n = irq(exception);
    if (n === undefined) c[flag(exception)] = pending;
    else c.setInterrupt(n, pending);
    if (pending) c.interruptsUpdated = true;
  };
  return {
    setPending: (exception) => setPending(exception, true),
    clearPending: (exception) => setPending(exception, false),
    isPending(exception) {
      const n = irq(exception);
      if (n === undefined) return core()[flag(exception)];
      return ((core().pendingInterrupts >>> n) & 1) === 1;
    },
    // SHPR3, where the core reads them: PendSV in bits 23:22, SysTick in 31:30.
    setPriority(exception, priority) {
      const shift = exception === 15 ? 30 : exception === 14 ? 22 : undefined;
      if (shift === undefined)
        throw new Error(`exception ${exception}'s priority can't be set`);
      const c = core();
      c.SHPR3 = ((c.SHPR3 & ~(3 << shift)) | ((priority & 3) << shift)) >>> 0;
      c.interruptsUpdated = true;
    },
  };
}
