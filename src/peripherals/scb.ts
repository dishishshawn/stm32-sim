// The two System Control Block registers SysTick needs: ICSR's PENDSTSET and
// PENDSTCLR, and SHPR3, which holds SysTick's (and PendSV's) priority. Like
// SysTick, the SCB is part of the core and not in the SVD (T4), so the registers
// are hand-written from the ARMv6-M Architecture Reference Manual (B3.2). The
// rest of the SCB (CPUID, VTOR, AIRCR, SCR, CCR, SHPR2) and ICSR's other bits
// stay unsimulated: they read 0 and ignore writes. See docs/decisions.md §11.
import type { Peripheral } from "./peripheral.ts";

const PENDSTCLR = 1 << 25;
const PENDSTSET = 1 << 26;
// ARMv6-M implements the top 2 bits of each 8-bit priority field.
const PRI_14 = 0xc0 << 16;
const PRI_15 = 0xc0 << 24;
const EXC_PENDSV = 14;
const EXC_SYSTICK = 15;

export const scbRegisters = {
  baseAddress: "0xE000ED00",
  registers: {
    ICSR: {
      offset: "0x04",
      size: 32,
      access: "read-write",
      resetValue: "0x00000000",
      description: "Interrupt control and state register",
      fields: {
        PENDSTCLR: {
          bitOffset: 25,
          bitWidth: 1,
          description: "Write 1: un-pend SysTick",
        },
        PENDSTSET: {
          bitOffset: 26,
          bitWidth: 1,
          description: "Write 1: pend SysTick. Reads 1 while it is pending",
        },
      },
    },
    SHPR3: {
      offset: "0x20",
      size: 32,
      access: "read-write",
      resetValue: "0x00000000",
      description: "System handler priority register 3",
      fields: {
        PRI_14: {
          bitOffset: 16,
          bitWidth: 8,
          description: "PendSV priority (bits 7:6 implemented)",
        },
        PRI_15: {
          bitOffset: 24,
          bitWidth: 8,
          description: "SysTick priority (bits 7:6 implemented)",
        },
      },
    },
  },
};

export const scb: Peripheral = {
  name: "SCB",
  create: ({ regs, cpu }) => ({
    read: {
      ICSR: () => (cpu.isPending(EXC_SYSTICK) ? PENDSTSET : 0),
    },
    write: {
      // Writing PENDSTSET and PENDSTCLR together is UNPREDICTABLE; set wins here.
      ICSR: (value) => {
        if (value & PENDSTSET) cpu.setPending(EXC_SYSTICK);
        else if (value & PENDSTCLR) cpu.clearPending(EXC_SYSTICK);
      },
      SHPR3: (value) => {
        regs.SHPR3 = (value & (PRI_14 | PRI_15)) >>> 0;
        cpu.setPriority(EXC_PENDSV, (value >>> 22) & 3);
        cpu.setPriority(EXC_SYSTICK, value >>> 30);
      },
    },
  }),
};
