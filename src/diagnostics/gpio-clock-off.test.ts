import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { Engine } from "../engine/engine.ts";
import { gpioClockOff } from "./gpio-clock-off.ts";
import { diagnose } from "./rule.ts";

const root = new URL("../../", import.meta.url);

/** The line in firmware/clock-off/main.c that starts with `text`, as the engine gives it. */
function line(text: string): string {
  const file = fileURLToPath(new URL("firmware/clock-off/main.c", root));
  const lines = readFileSync(file, "utf8").split("\n");
  const n = lines.findIndex((l) => l.trimStart().startsWith(text)) + 1;
  assert.ok(n > 0, `no line starting ${text}`);
  return `${file}:${n}`;
}

test("writing GPIOB with its clock off names the enable bit, at the line that wrote", () => {
  const url = new URL("build/clock-off.elf", root);
  assert.ok(existsSync(url), "build/clock-off.elf is missing: run `just fw`");
  const engine = new Engine();
  engine.load(readFileSync(url), {
    chip: "stm32g031k8",
    parts: [],
    wires: [],
  });
  const found = diagnose(engine.events, engine.view(), [gpioClockOff]);
  engine.runFor(0.3);

  const ds = found();
  const moder = ds.find((d) => d.message.startsWith("wrote GPIOB->MODER"));
  assert.ok(moder);
  assert.deepEqual(moder, {
    rule: "gpio-clock-off",
    severity: "warning",
    message:
      "wrote GPIOB->MODER while RCC->IOPENR.IOPBEN (bit 1) = 0 — " +
      "GPIOB's clock is off, so the write was ignored",
    periph: "GPIOB",
    reg: "MODER",
    count: 1,
    cycle: moder.cycle,
    pc: moder.pc,
    at: line("GPIOB->MODER ="),
  });
  // The toggle loop ran 3 times in 0.3 s: one diagnostic, counted.
  const odr = ds.filter((d) => d.message.startsWith("wrote GPIOB->ODR"));
  assert.equal(odr.length, 1);
  assert.equal(odr[0].count, 3);
  assert.equal(odr[0].at, line("GPIOB->ODR ^="));
  assert.match(
    ds.find((d) => d.message.startsWith("read GPIOB->ODR"))!.message,
    /so the read returned 0$/,
  );
});

test("any clock-gated peripheral: I2C1 names RCC->APBENR1.I2C1EN", () => {
  const chip = {
    ...stm32g031k8,
    peripherals: [
      {
        name: "I2C1",
        gate: { register: "RCC.APBENR1", field: "I2C1EN" },
        create: () => ({}),
      },
    ],
  };
  const board = {
    chip,
    regs: {},
    level: () => "floating" as const,
    where: () => "",
  };
  const found = gpioClockOff.check(
    {
      kind: "reg",
      cycle: 0,
      pc: 0,
      address: 0x40005400,
      periph: "I2C1",
      reg: "CR1",
      op: "write",
      old: 0,
      value: 1,
      flags: ["clock-off"],
    },
    board,
  );
  assert.equal(
    found[0].message,
    "wrote I2C1->CR1 while RCC->APBENR1.I2C1EN (bit 21) = 0 — " +
      "I2C1's clock is off, so the write was ignored",
  );
});
