import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadElf } from "./elf.ts";

const root = new URL("../../", import.meta.url);

function elf(name: string) {
  const url = new URL(`build/${name}.elf`, root);
  assert.ok(
    existsSync(url),
    `build/${name}.elf is missing: run \`just fw\` first`,
  );
  return loadElf(readFileSync(url));
}

const u32 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);

test("blink: symbols resolve, and flash starts with the vector table", () => {
  const blink = elf("blink");
  const reset = blink.symbol("Reset_Handler");
  const main = blink.symbol("main");
  assert.ok(reset !== undefined && main !== undefined);
  assert.equal(blink.functionAt(reset), "Reset_Handler");
  assert.equal(blink.functionAt(main + 2), "main");
  assert.equal(blink.entry, reset | 1);

  const flash = blink.segments.find((s) => s.addr === 0x08000000);
  assert.ok(flash);
  assert.equal(u32(flash.data, 0), blink.symbol("_estack"));
  assert.equal(u32(flash.data, 4), reset | 1);
});

test("blink: a PC inside main maps to firmware/blink/main.c", () => {
  const blink = elf("blink");
  const file = fileURLToPath(new URL("firmware/blink/main.c", root));
  const line =
    readFileSync(file, "utf8").split("\n").indexOf("int main(void) {") + 1;
  assert.ok(line > 0);
  assert.deepEqual(blink.pcToSource(blink.symbol("main")!), { file, line });
  assert.equal(blink.pcToSource(0), undefined);
});

test("elf-fixture: the .data initial image is at its LMA in flash", () => {
  const fixture = elf("elf-fixture");
  const lma = fixture.symbol("_sidata")!;
  assert.ok(lma >= 0x08000000 && lma < 0x08010000, "LMA is in flash");
  const answer = fixture.symbol("answer")!;
  assert.ok(
    answer >= 0x20000000 && answer < 0x20002000,
    "the variable runs from SRAM",
  );

  const data = fixture.segments.find((s) => s.addr === lma);
  assert.ok(data, "a segment is placed at the LMA");
  assert.equal(u32(data.data, 0), 0xc0ffee42);
});
