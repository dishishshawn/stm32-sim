import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HEADER_PATH, JSON_PATH, SVD_PATH, svd2json } from "./svd2json.ts";

const committed = readFileSync(JSON_PATH, "utf8");
const chip = JSON.parse(committed);
const reg = (p: string, r: string) => chip.peripherals[p].registers[r];

test("committed registers JSON is exactly what svd2json generates", () => {
  // Byte-for-byte: proves the output is deterministic and the file is not stale.
  // On failure, run `node tools/svd2json.ts` and review the diff.
  const svd = readFileSync(SVD_PATH, "utf8");
  const header = readFileSync(HEADER_PATH, "utf8");
  assert.equal(svd2json(svd, header).json, committed);
});

// Expected values are read from RM0444 Rev 6, not from the SVD.
test("GPIO matches RM0444 §7.5.1 and the memory map", () => {
  assert.equal(chip.peripherals.GPIOA.baseAddress, "0x50000000");
  assert.equal(reg("GPIOA", "MODER").resetValue, "0xEBFFFFFF");
  assert.equal(reg("GPIOB", "MODER").resetValue, "0xFFFFFFFF");
});

test("RCC IOPENR is at offset 0x34 (RM0444 §5.4.13)", () => {
  assert.equal(reg("RCC", "IOPENR").offset, "0x34");
});

test("I2C1 matches RM0444 §32.9 and the memory map", () => {
  assert.equal(chip.peripherals.I2C1.baseAddress, "0x40005400");
  assert.equal(reg("I2C1", "TIMINGR").offset, "0x10");
  const cr2 = reg("I2C1", "CR2").fields;
  const at = (f: string) => [cr2[f].bitOffset, cr2[f].bitWidth];
  assert.deepEqual(at("SADD"), [0, 10]); // bits 9:0
  assert.deepEqual(at("RD_WRN"), [10, 1]); // bit 10
  assert.deepEqual(at("NBYTES"), [16, 8]); // bits 23:16
  assert.deepEqual(at("AUTOEND"), [25, 1]); // bit 25
});

// Field names are the CMSIS header's (stm32g031xx.h): the names learners type.
test("field names follow the CMSIS header, keeping the SVD's as svdName", () => {
  const field = (p: string, r: string, bit: number) =>
    Object.entries<any>(reg(p, r).fields).find(([, f]) => f.bitOffset === bit);
  // RCC_IOPENR_GPIOBEN: bit 1, which the SVD calls IOPBEN.
  const [gpioben, iopenr1] = field("RCC", "IOPENR", 1)!;
  assert.equal(gpioben, "GPIOBEN");
  assert.equal(iopenr1.svdName, "IOPBEN");
  // GPIO_MODER_MODE0: bits 1:0, the SVD's MODER0.
  const [mode0, moder0] = field("GPIOA", "MODER", 0)!;
  assert.equal(mode0, "MODE0");
  assert.deepEqual([moder0.bitWidth, moder0.svdName], [2, "MODER0"]);
  // I2C_CR2_SADD: the same name in both, so no svdName.
  assert.equal(field("I2C1", "CR2", 0)![0], "SADD");
  assert.equal(reg("I2C1", "CR2").fields.SADD.svdName, undefined);
});
