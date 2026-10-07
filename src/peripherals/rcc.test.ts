import { test } from "node:test";
import assert from "node:assert/strict";
import { stm32g031k8 } from "../chips/stm32g031k8.ts";
import { EventLog } from "../engine/events.ts";
import { MemoryBus } from "../engine/memory-bus.ts";
import { Nets } from "../engine/nets.ts";
import { clocks } from "./rcc.ts";

const RCC_CR = 0x40021000;
const RCC_CFGR = 0x40021008;
const RCC_PLLCFGR = 0x4002100c;
const RCC_CSR = 0x40021060;
const HSION_HSIRDY = 0x500;
const PLLON = 1 << 24;
const PLLRDY = 1 << 25;
const LSION = 1 << 0;
const LSIRDY = 1 << 1;
/** PLLR /2 (001), PLLREN, PLLN ×8, PLLM /1 (000), PLLSRC HSI16 (10): 64 MHz. */
const PLL_64MHZ = (1 << 29) | (1 << 28) | (8 << 8) | 2;
/** 15 µs, DS12992 Table 43's typical tLOCK, at 16 MHz. */
const LOCK_CYCLES = 240;

/** The G031K8's bus on its own, and the HCLK values RCC reported. */
function setup() {
  const hclk: number[] = [];
  const bus = new MemoryBus(stm32g031k8, {
    events: new EventLog(),
    now: () => ({ cycle: 0, pc: 0 }),
    nets: new Nets(),
    cpu: {
      setPending() {},
      clearPending() {},
      isPending: () => false,
      setPriority() {},
    },
    setCoreClock: (hz) => hclk.push(hz),
  });
  hclk.length = 0; // the reset's report
  const sws = () => (bus.readUint32(RCC_CFGR) >>> 3) & 7;
  return { bus, hclk, sws };
}

test("RCC_CR: HSI16 is on and ready, and the PLL never gets ready with no input", () => {
  const { bus } = setup();
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY);
  bus.writeUint32(RCC_CR, PLLON | PLLRDY); // also tries to clear HSION and set PLLRDY
  bus.tick(100_000); // PLLCFGR's reset PLLSRC is 00, no clock
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY | PLLON);
  bus.reset();
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY);
});

test("PLLRDY sets after the 15 µs lock time, not at once, and clears with PLLON", () => {
  const { bus } = setup();
  bus.writeUint32(RCC_PLLCFGR, PLL_64MHZ);
  bus.writeUint32(RCC_CR, HSION_HSIRDY | PLLON);
  assert.equal(bus.readUint32(RCC_CR) & PLLRDY, 0);
  bus.tick(LOCK_CYCLES - 10);
  assert.equal(bus.readUint32(RCC_CR) & PLLRDY, 0, "before tLOCK");
  bus.tick(20);
  assert.equal(bus.readUint32(RCC_CR) & PLLRDY, PLLRDY, "at tLOCK");
  bus.writeUint32(RCC_CR, HSION_HSIRDY);
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY);
});

test("SWS follows SW only once the source is ready: a switch to the PLL before PLLRDY waits", () => {
  const { bus, hclk, sws } = setup();
  bus.writeUint32(RCC_PLLCFGR, PLL_64MHZ);
  bus.writeUint32(RCC_CFGR, 2); // SW = PLLRCLK, with the PLL off
  bus.tick(100_000);
  assert.equal(sws(), 0, "the PLL is off: still HSISYS");
  assert.deepEqual(hclk, []);
  bus.writeUint32(RCC_CR, HSION_HSIRDY | PLLON);
  bus.tick(LOCK_CYCLES - 10);
  assert.equal(sws(), 0, "not locked yet: still HSISYS");
  // RM0444 §5.2.7: the switch happens when the source gets ready.
  bus.tick(20);
  assert.equal(sws(), 2);
  assert.deepEqual(hclk, [64e6]);
  // In use, the PLL can't be stopped nor its output turned off (§5.4.1, §5.4.4).
  bus.writeUint32(RCC_CR, 0);
  assert.equal(bus.readUint32(RCC_CR), HSION_HSIRDY | PLLON | PLLRDY);
  bus.writeUint32(RCC_PLLCFGR, 0);
  assert.equal(bus.readUint32(RCC_PLLCFGR), PLL_64MHZ);
  // SWS is read-only; back to HSISYS (ready) switches at once.
  bus.writeUint32(RCC_CFGR, 0x38);
  assert.equal(sws(), 0);
  assert.deepEqual(hclk, [64e6, 16e6]);
});

test("a switch to a source that never gets ready leaves SWS unchanged", () => {
  const { bus, sws } = setup();
  for (const sw of [1, 4, 7]) {
    // HSE (no clock on this board, UM2591), LSE (not simulated), reserved
    bus.writeUint32(RCC_CR, HSION_HSIRDY | (1 << 16)); // HSEON
    bus.writeUint32(RCC_CFGR, sw);
    bus.tick(1_000_000);
    assert.equal(sws(), 0, `SW = ${sw}`);
  }
});

test("PLLCFGR's dividers and source can't change while PLLON = 1; PLLREN gates the switch", () => {
  const { bus, sws } = setup();
  const noOutput = PLL_64MHZ & ~(1 << 28);
  bus.writeUint32(RCC_PLLCFGR, noOutput);
  bus.writeUint32(RCC_CR, HSION_HSIRDY | PLLON);
  bus.writeUint32(RCC_PLLCFGR, (4 << 29) | (16 << 8) | 2); // ignored but for PLLREN
  assert.equal(bus.readUint32(RCC_PLLCFGR), noOutput);
  bus.tick(LOCK_CYCLES);
  bus.writeUint32(RCC_CFGR, 2);
  assert.equal(sws(), 0, "PLLRCLK is off");
  bus.writeUint32(RCC_PLLCFGR, PLL_64MHZ); // only PLLREN takes
  assert.equal(sws(), 2);
});

test("PLL frequency: (HSI16 / M) × N / R", () => {
  const pll = (m: number, n: number, r: number) =>
    clocks({
      CR: HSION_HSIRDY,
      CFGR: 2 << 3,
      PLLCFGR: ((r - 1) << 29) | (n << 8) | ((m - 1) << 4) | 2,
    }).sysclk;
  assert.equal(pll(1, 8, 2), 64e6);
  assert.equal(pll(1, 8, 4), 32e6);
  assert.equal(pll(4, 32, 2), 64e6);
  assert.equal(pll(2, 12, 3), 32e6);
  assert.equal(pll(1, 86, 8), 172e6); // out of range, but the math holds
});

test("HPRE and PPRE give HCLK and PCLK; HSIDIV gives HSISYS", () => {
  const at = (cfgr: number, cr = HSION_HSIRDY) =>
    clocks({ CR: cr, CFGR: cfgr, PLLCFGR: 0x1000 });
  assert.deepEqual(at(0), { sysclk: 16e6, hclk: 16e6, pclk: 16e6 });
  assert.deepEqual(
    at(0x7 << 8),
    { sysclk: 16e6, hclk: 16e6, pclk: 16e6 },
    "HPRE 0111: 1",
  );
  assert.equal(at(0x8 << 8).hclk, 8e6);
  assert.equal(at(0xb << 8).hclk, 1e6);
  assert.equal(at(0xc << 8).hclk, 250e3); // 1100: /64, not /32
  assert.equal(at(0xf << 8).hclk, 31_250);
  assert.equal(at(0x3 << 12).pclk, 16e6, "PPRE 011: 1");
  assert.equal(at(0x4 << 12).pclk, 8e6);
  assert.equal(at(0x7 << 12).pclk, 1e6);
  assert.deepEqual(at((0x8 << 8) | (0x5 << 12)), {
    sysclk: 16e6,
    hclk: 8e6,
    pclk: 2e6,
  });
  assert.equal(at(0, HSION_HSIRDY | (3 << 11)).sysclk, 2e6, "HSIDIV 011: /8");
});

test("HPRE and HSIDIV writes report the new HCLK; LSI gets ready after 80 µs", () => {
  const { bus, hclk, sws } = setup();
  bus.writeUint32(RCC_CFGR, 0x9 << 8); // HPRE /4
  bus.writeUint32(RCC_CR, HSION_HSIRDY | (1 << 11)); // HSIDIV /2
  assert.deepEqual(hclk, [4e6, 2e6]);
  bus.writeUint32(RCC_CSR, LSION);
  bus.writeUint32(RCC_CFGR, (0x9 << 8) | 3); // SW = LSI, not ready yet
  assert.equal(sws(), 0);
  bus.tick(150); // 80 µs at 2 MHz is 160 cycles
  assert.equal(bus.readUint32(RCC_CSR) & LSIRDY, 0);
  bus.tick(20);
  assert.equal(sws(), 3);
  assert.deepEqual(hclk, [4e6, 2e6, 8e3]); // LSI / 4
  bus.writeUint32(RCC_CSR, 0); // LSI in use: LSION stays
  assert.equal(bus.readUint32(RCC_CSR), LSION | LSIRDY);
});
