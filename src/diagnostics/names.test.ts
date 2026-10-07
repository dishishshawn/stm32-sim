import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 as chip } from "../chips/stm32g031k8.ts";
import { fieldName, regName } from "./names.ts";

test("registers and fields are named as exam-style C #defines them, with the address", () => {
  assert.equal(regName(chip, "GPIOB", "MODER"), "GPIOB_MODER (0x50000400)");
  assert.equal(regName(chip, "I2C1", "TIMINGR"), "I2C1_TIMINGR (0x40005410)");
  assert.equal(regName(chip, "SysTick", "LOAD"), "SysTick_LOAD (0xe000e014)");
  assert.equal(
    fieldName(chip, "RCC", "IOPENR", "GPIOBEN"),
    "RCC_IOPENR (0x40021034) bit 1 GPIOBEN",
  );
  assert.equal(
    fieldName(chip, "GPIOB", "MODER", "MODE6"),
    "GPIOB_MODER (0x50000400) bits 13:12 MODE6",
  );
});
