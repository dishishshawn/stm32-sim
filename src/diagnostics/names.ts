// How every diagnostic names a register or a field: the way exam-style C
// #defines it, with its address, e.g.
// `#define GPIOB_MODER (*(volatile uint32_t *)0x50000400U)`, so a learner can
// check their #define against the message. Names are the register JSON's
// (docs/decisions.md §4), and addresses come from it too.
import type { Chip } from "../engine/memory-bus.ts";

/** An address as diagnostics print it: 8 lowercase hex digits, "0x50000400". */
export const hex32 = (a: number): string =>
  `0x${a.toString(16).padStart(8, "0")}`;

/** "GPIOB_MODER (0x50000400)". */
export function regName(chip: Chip, periph: string, reg: string): string {
  const p = chip.registers.peripherals[periph];
  const address =
    parseInt(p.baseAddress, 16) + parseInt(p.registers[reg].offset, 16);
  return `${periph}_${reg} (${hex32(address)})`;
}

/** "RCC_IOPENR (0x40021034) bit 1 GPIOBEN", or "GPIOB_MODER (0x50000400) bits 13:12 MODE6". */
export function fieldName(
  chip: Chip,
  periph: string,
  reg: string,
  field: string,
): string {
  const { bitOffset: lo, bitWidth } =
    chip.registers.peripherals[periph].registers[reg].fields[field];
  const bits = bitWidth === 1 ? `bit ${lo}` : `bits ${lo + bitWidth - 1}:${lo}`;
  return `${regName(chip, periph, reg)} ${bits} ${field}`;
}
