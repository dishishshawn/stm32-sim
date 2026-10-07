// The examples define registers by address, exam style:
//   #define RCC_IOPENR (*(volatile uint32_t *)0x40021034U)
// Each such #define in firmware/**/main.c must be named <PERIPH>_<REG> as the
// chip's register map names it (the SVD's, plus the hand-written SysTick), and
// have that register's base address + offset. Diagnostics use the same names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stm32g031k8 } from "../src/chips/stm32g031k8.ts";

const dir = fileURLToPath(new URL(".", import.meta.url));

test("every register #define in firmware/**/main.c has its register's name and address", () => {
  const address = new Map<string, number>();
  for (const [p, { baseAddress, registers }] of Object.entries(
    stm32g031k8.registers.peripherals,
  ))
    for (const [r, { offset }] of Object.entries(registers))
      address.set(`${p}_${r}`, Number(baseAddress) + Number(offset));

  let checked = 0;
  for (const file of globSync("**/main.c", { cwd: dir })) {
    const source = readFileSync(dir + file, "utf8");
    const defines = source.matchAll(
      /^#define (\w+) \(\*\(volatile uint32_t \*\)(0x[0-9A-Fa-f]+)U?\)/gm,
    );
    for (const [, name, addr] of defines) {
      assert.equal(address.get(name), Number(addr), `${file}: ${name}`);
      checked++;
    }
  }
  assert.ok(checked > 0, "no register #defines found");
});
