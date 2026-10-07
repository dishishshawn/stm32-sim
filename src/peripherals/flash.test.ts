import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { EventLog } from "../engine/events.ts";
import type { RegEvent } from "../engine/events.ts";
import { MemoryBus } from "../engine/memory-bus.ts";
import { Nets } from "../engine/nets.ts";

const FLASH_ACR = 0x40022000;
const FLASH_KEYR = 0x40022008;

test("FLASH_ACR: LATENCY reads back, unflagged; programming registers stay unsimulated", () => {
  const events = new EventLog();
  const flags: Record<string, RegEvent["flags"]> = {};
  events.subscribe((e) => {
    if (e.kind === "reg") flags[e.reg] = e.flags;
  });
  const bus = new MemoryBus(stm32g031k8, {
    events,
    now: () => ({ cycle: 0, pc: 0 }),
    nets: new Nets(),
    cpu: {
      setPending() {},
      clearPending() {},
      isPending: () => false,
      setPriority() {},
    },
  });
  assert.equal(bus.readUint32(FLASH_ACR), 0x600); // ICEN, PRFTEN
  bus.writeUint32(FLASH_ACR, 0x602);
  assert.equal(bus.readUint32(FLASH_ACR) & 7, 2);
  assert.deepEqual(flags.ACR, []);
  bus.writeUint32(FLASH_KEYR, 0x45670123);
  assert.deepEqual(flags.KEYR, ["unsimulated"]);
});
