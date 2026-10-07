// T33 in the page: `sim ui` on a temp copy of an ELF; rebuilding it reloads
// the firmware in the open page within 1 s (src/ui/watch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadElf } from "../engine/elf.ts";
import { open, root } from "./harness.ts";

test("a rebuilt ELF reloads in the page within 1 s, resetting the MCU; a broken one is reported", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sim-watch-ui-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const fw = join(dir, "fw.elf");
  copyFileSync(join(root, "build/blink.elf"), fw);
  const circuit = join(dir, "circuit.json");
  writeFileSync(
    circuit,
    JSON.stringify({
      chip: "stm32g031k8",
      parts: [{ id: "led", type: "led", props: {} }],
      wires: [
        ["mcu.PA0", "led.A"],
        ["led.C", "GND"],
      ],
    }),
  );
  const { page, problems } = await open(t, fw, circuit);
  const time = async () => Number(await page.textContent("#time"));
  const reload = () => page.textContent("#reload");

  await page.waitForFunction(
    () => Number(document.getElementById("time")!.textContent) > 0.6,
  );
  copyFileSync(join(root, "build/blink-systick-poll.elf"), fw);
  const start = Date.now();
  await page.waitForFunction(
    () => document.getElementById("reload")!.textContent !== "",
    null,
    { timeout: 1000 },
  );
  t.diagnostic(`reloaded ${Date.now() - start} ms after the write`);
  assert.match((await reload())!, /^firmware reloaded at \d\d:\d\d:\d\d$/);
  assert.ok((await time()) < 0.5, "the MCU was reset");
  assert.equal(await page.textContent("#run"), "running");

  writeFileSync(
    fw,
    readFileSync(join(root, "build/blink.elf")).subarray(0, 1000),
  );
  await page.waitForFunction(
    () => /failed/.test(document.getElementById("reload")!.textContent!),
    null,
    { timeout: 1000 },
  );
  assert.equal(await page.textContent("#run"), "running");

  // A halt stops main.ts's frame loop, so the next rebuild reloads the page.
  const bkpt = new Uint8Array(readFileSync(join(root, "build/blink.elf")));
  const elf = loadElf(bkpt);
  const flash = elf.segments[0]; // its data is a view into `bkpt`
  const main = elf.symbol("main")! - flash.addr + flash.data.byteOffset;
  new DataView(bkpt.buffer).setUint32(main, 0xbe07be07, true); // BKPT #7
  writeFileSync(fw, bkpt);
  await page.waitForFunction(() =>
    document.getElementById("run")!.textContent!.startsWith("breakpoint"),
  );
  copyFileSync(join(root, "build/blink.elf"), fw);
  await page.waitForFunction(
    () => document.getElementById("run")?.textContent === "running",
    null,
    { timeout: 1000 },
  );
  assert.deepEqual(problems, []);
});
