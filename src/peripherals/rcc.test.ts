import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { EventLog } from "../engine/events.ts";
import { MemoryBus } from "../engine/memory-bus.ts";
import { Nets } from "../engine/nets.ts";

const RCC_CR = 0x40021000;
const HSION_HSIRDY = 0x500;
const PLLON = 1 << 24;

test("RCC_CR: HSI16 is on and ready, and the PLL never gets ready", () => {
  const bus = new MemoryBus(stm32g031k8, {
    events: new EventLog(),
    now: () => ({ cycle: 0, pc: 0 }),
    nets: new Nets(),
  });
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY);
  bus.writeUint32(RCC_CR, PLLON | (1 << 25)); // also tries to clear HSION and set PLLRDY
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY | PLLON);
  bus.reset();
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY);
});
