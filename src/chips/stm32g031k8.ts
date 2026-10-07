// The STM32G031K8 (NUCLEO-G031K8). Chip-specific facts live here, not in the engine.
import type { Chip } from "../engine/memory-bus.ts";
import { gpio } from "../peripherals/gpio.ts";
import type { AfTable } from "../peripherals/gpio.ts";
import { i2c1 } from "../peripherals/i2c.ts";
import { rcc } from "../peripherals/rcc.ts";
import { scb, scbRegisters } from "../peripherals/scb.ts";
import { systick, systickRegisters } from "../peripherals/systick.ts";
import registers from "./stm32g031k8.registers.json" with { type: "json" };

// The I/O pins of the LQFP32 and UFQFPN32 packages (same pinout), from
// embassy-rs/stm32-data-generated data/chips/STM32G031K8.json (MIT/Apache-2.0).
// Package pins 22 and 23 are PA11 and PA12; SYSCFG can remap them to PA9 and PA10
// (not simulated). PF2 doubles as NRST.
const pins = [
  "PA0",
  "PA1",
  "PA2",
  "PA3",
  "PA4",
  "PA5",
  "PA6",
  "PA7",
  "PA8",
  "PA9",
  "PA10",
  "PA11",
  "PA12",
  "PA13",
  "PA14",
  "PA15",
  "PB0",
  "PB1",
  "PB2",
  "PB3",
  "PB4",
  "PB5",
  "PB6",
  "PB7",
  "PB8",
  "PB9",
  "PC6",
  "PC14",
  "PC15",
  "PF2",
];

// The alternate functions GPIO routes to a simulated peripheral (docs/decisions.md
// §12). AF numbers are from DS12992 Rev 4, Table 13 (port A) and Table 14 (port B):
// I2C1 is AF6 on all six pins. PB6/PB7 is the brief's example; the NUCLEO-G031K8
// labels D5 = PA9 as I2C1_SCL and D4 = PA10 as I2C1_SDA (UM2591 Rev 2, Table 9).
const af: AfTable = {
  PA9: { 6: "I2C1_SCL" },
  PA10: { 6: "I2C1_SDA" },
  PB6: { 6: "I2C1_SCL" },
  PB7: { 6: "I2C1_SDA" },
  PB8: { 6: "I2C1_SCL" },
  PB9: { 6: "I2C1_SDA" },
};

export const stm32g031k8: Chip = {
  name: "STM32G031K8",
  core: "cortex-m0+",
  clockHz: 16_000_000,
  irqCount: 32,
  flash: { base: 0x0800_0000, size: 64 * 1024 },
  sram: { base: 0x2000_0000, size: 8 * 1024 },
  registers: {
    peripherals: {
      ...registers.peripherals,
      // Core registers the SVD doesn't have (T4), hand-written from the ARMv6-M ARM.
      // RM0444 §12.2: "The SysTick calibration value is set to 1000".
      SysTick: systickRegisters(1000),
      SCB: scbRegisters,
    },
  },
  pins,
  // The peripheral registration list: one import and one entry per peripheral.
  // Every SVD register without one is plain storage, logged as "unsimulated".
  peripherals: [
    rcc,
    gpio("GPIOA", { register: "RCC.IOPENR", field: "IOPAEN" }, pins, af),
    gpio("GPIOB", { register: "RCC.IOPENR", field: "IOPBEN" }, pins, af),
    systick,
    scb,
    i2c1,
  ],
};
