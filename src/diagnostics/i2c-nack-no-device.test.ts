import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { parseCircuit } from "../engine/circuit.ts";
import { catalog, Engine } from "../engine/engine.ts";
import type { PartView } from "../engine/engine.ts";
import type { I2cTraceEvent } from "../engine/events.ts";
import type { Level } from "../engine/nets.ts";
import { i2cNackNoDevice } from "./i2c-nack-no-device.ts";
import { diagnose } from "./rule.ts";

const nack = (addr: number): I2cTraceEvent => ({
  kind: "i2c",
  cycle: 9,
  periph: "I2C1",
  step: { t: 9, kind: "addr", addr, read: false, ack: "nack" },
});

/** Every part's SDA and SCL pins are on I2C1's lines, except `off`'s. */
function board(
  parts: PartView[],
  levels: Record<string, Level> = {},
  off = "",
) {
  return {
    chip: stm32g031k8,
    regs: {},
    level: (e: string) => levels[e] ?? "floating",
    where: () => "",
    sameNet: (a: string, b: string) =>
      !a.startsWith(`${off}.`) && b.startsWith("mcu.I2C1_"),
    parts,
  };
}

const tc74: PartView = {
  id: "temp",
  type: "tc74",
  pins: ["NC", "SDA", "GND", "SCLK", "VDD"],
  props: { variant: "A0", temperature: 25 },
  i2c: { sda: "SDA", scl: "SCLK", address: () => 0x48 },
};
const mcp: PartView = {
  id: "io",
  type: "mcp23017",
  pins: ["SCL", "SDA", "A0", "A1", "A2", "RESET"],
  props: {},
  i2c: { sda: "SDA", scl: "SCL", address: () => undefined },
};

test("a NACKed address names the devices on the bus and their addresses", () => {
  assert.deepEqual(i2cNackNoDevice.check(nack(0x49), board([tc74])), [
    {
      severity: "warning",
      message:
        "no device answered address 0x49 (NACK); on this bus: TC74 'temp' at 0x48 (variant A0)",
      periph: "I2C1",
    },
  ]);
});

test("an MCP23017 whose RESET floats is held in reset; a part off the bus isn't named", () => {
  const [d] = i2cNackNoDevice.check(nack(0x20), board([tc74, mcp], {}, "temp"));
  assert.equal(
    d.message,
    "no device answered address 0x20 (NACK); on this bus: MCP23017 'io', held in reset " +
      "because its RESET pin is floating, so it answers no address (RESET is active " +
      "low: wire it to 3V3)",
  );
  const high = board([mcp], { "io.RESET": "high" });
  assert.match(
    i2cNackNoDevice.check(nack(0x20), high)[0].message,
    /MCP23017 'io', which answers no address now$/,
  );
});

test("nothing on the bus, and nothing for an ACK", () => {
  assert.equal(
    i2cNackNoDevice.check(nack(0x48), board([]))[0].message,
    "no device answered address 0x48 (NACK); no I2C part's SDA and SCL are wired to I2C1's pins",
  );
  const ack = nack(0x48);
  const step = { ...ack.step, ack: "ack" as const };
  assert.deepEqual(i2cNackNoDevice.check({ ...ack, step }, board([tc74])), []);
});

test("end to end: tc74-read (0x48) against a TC74A1 (0x49)", () => {
  const url = new URL("../../build/tc74-read.elf", import.meta.url);
  assert.ok(existsSync(url), "build/tc74-read.elf is missing: run `just fw`");
  const json = readFileSync(
    new URL("../../firmware/tc74-read/circuit.json", import.meta.url),
    "utf8",
  ).replace('"A0"', '"A1"');
  const engine = new Engine();
  engine.load(readFileSync(url), parseCircuit(json, catalog));
  const found = diagnose(engine.events, engine.view(), [i2cNackNoDevice]);
  engine.runFor(0.6); // reads at 0.25 s and 0.5 s
  const [d] = found();
  assert.equal(
    d.message,
    "no device answered address 0x48 (NACK); on this bus: TC74 'temp' at 0x49 (variant A1)",
  );
  assert.equal(d.count, 2);
});
