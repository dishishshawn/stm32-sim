import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSON_PATH, SVD_PATH, svd2json } from "./svd2json.ts";

const committed = readFileSync(JSON_PATH, "utf8");
const chip = JSON.parse(committed);
const reg = (p: string, r: string) => chip.peripherals[p].registers[r];

test("committed registers JSON is exactly what svd2json generates", () => {
  // Byte-for-byte: proves the output is deterministic and the file is not stale.
  // On failure, run `node tools/svd2json.ts` and review the diff.
  assert.equal(svd2json(readFileSync(SVD_PATH, "utf8")), committed);
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
