// The register view (T34) in the page, headless, with blink running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { open, until } from "./harness.ts";

const field = (reg: string, name: string) =>
  `[data-reg="${reg}"] [data-field="${name}"]`;

test("registers: GPIOA_MODER with MODE0=1, ODR's OD0 changing and highlighted, RCC_IOPENR's GPIOAEN=1", async (t) => {
  const { page, problems } = await open(
    t,
    "blink",
    "firmware/blink/circuit.json",
  );
  const text = (selector: string) => page.textContent(selector);
  const lit = (selector: string) =>
    page.$eval(selector, (el) => el.classList.contains("changed"));

  await page.click('details[data-periph="GPIOA"] summary');
  assert.match(
    (await text('[data-reg="GPIOA_MODER"]'))!,
    /^GPIOA_MODER \(0x50000000\) /,
  );
  await until(
    () => text('[data-reg="GPIOA_MODER"] .value'),
    "0xebfffffd",
    "GPIOA_MODER's value",
  );
  assert.equal(await text(field("GPIOA_MODER", "MODE0")), "MODE0=1");
  const od0 = field("GPIOA_ODR", "OD0");
  const state = async () => `${await text(od0)} ${await lit(od0)}`;
  await until(state, "OD0=1 true", "OD0 set and highlighted");
  await until(state, "OD0=0 true", "OD0 cleared and highlighted");
  // Set once at the start: highlighted for about a second, then not.
  await until(
    () => lit(field("GPIOA_MODER", "MODE0")),
    false,
    "MODE0 not highlighted",
  );

  await page.click('details[data-periph="RCC"] summary');
  await until(
    () => text(field("RCC_IOPENR", "GPIOAEN")),
    "GPIOAEN=1",
    "RCC_IOPENR's GPIOAEN",
  );
  assert.deepEqual(problems, []);
});

test("registers: the default list, the filter, and an unsimulated register marked", async (t) => {
  const { page, problems } = await open(
    t,
    "blink",
    "firmware/blink/circuit.json",
  );
  const shown = () =>
    page.$$eval("details[data-periph]:not([hidden])", (ds) =>
      ds.map((d) => (d as HTMLElement).dataset.periph).join(" "),
    );
  // The simulated peripherals, and the ones blink touches (RCC and GPIOA, both simulated).
  assert.equal(await shown(), "I2C1 RCC FLASH GPIOA GPIOB SysTick SCB");

  const filter = page.getByLabel("Filter");
  await filter.fill("moder");
  assert.equal(await shown(), "GPIOA GPIOB GPIOC GPIOD GPIOF");
  await filter.fill("flash_keyr");
  assert.equal(await shown(), "FLASH");
  assert.deepEqual(
    await page.$$eval(".reg:not([hidden])", (rs) =>
      rs.map((r) => (r as HTMLElement).dataset.reg),
    ),
    ["FLASH_KEYR"],
  );
  assert.equal(
    await page.textContent('[data-reg="FLASH_KEYR"] .unsim'),
    "not simulated",
  );
  // FLASH simulates ACR only.
  assert.equal(await page.locator('[data-reg="FLASH_ACR"] .unsim').count(), 0);
  await filter.fill("");
  assert.equal(await shown(), "I2C1 RCC FLASH GPIOA GPIOB SysTick SCB");
  assert.deepEqual(problems, []);
});
