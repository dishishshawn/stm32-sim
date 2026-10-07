// The STM32G031K8 (NUCLEO-G031K8). Chip-specific facts live here, not in the engine.
import type { Chip } from "../engine/memory-bus.ts";
import registers from "./stm32g031k8.registers.json" with { type: "json" };

export const stm32g031k8: Chip = {
  name: "STM32G031K8",
  core: "cortex-m0+",
  clockHz: 16_000_000,
  irqCount: 32,
  flash: { base: 0x0800_0000, size: 64 * 1024 },
  sram: { base: 0x2000_0000, size: 8 * 1024 },
  registers,
  // The peripheral registration list: one import and one entry per peripheral.
  // Every SVD register without one is plain storage, logged as "unsimulated".
  peripherals: [],
};
