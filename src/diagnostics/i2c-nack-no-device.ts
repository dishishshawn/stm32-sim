// i2c-nack-no-device: an address phase got NACK, so no target on the bus
// answers that address. Names the I2C parts that are on the bus (their SDA and
// SCL on the controller's lines) and the address each answers now, or that it
// answers none, e.g. an MCP23017 held in reset by a RESET pin that is low or
// floating.
import type { BoardView, PartView } from "../engine/engine.ts";
import type { Rule } from "./rule.ts";

const hex = (a: number) => `0x${a.toString(16).padStart(2, "0")}`;

/** E.g. "TC74 'temp' at 0x48 (variant A0)". */
function describe({ level }: BoardView, p: PartView): string {
  const name = `${p.type.toUpperCase()} '${p.id}'`;
  const address = p.i2c!.address();
  if (address !== undefined) {
    const variant = p.props.variant;
    return `${name} at ${hex(address)}${variant === undefined ? "" : ` (variant ${variant})`}`;
  }
  const reset = p.pins.includes("RESET") ? level(`${p.id}.RESET`) : "high";
  if (reset === "high") return `${name}, which answers no address now`;
  return (
    `${name}, held in reset because its RESET pin is ${reset}, so it answers no address ` +
    "(RESET is active low: wire it to 3V3)"
  );
}

export const i2cNackNoDevice: Rule = {
  id: "i2c-nack-no-device",
  check(e, board) {
    if (e.kind !== "i2c" || e.step.kind !== "addr" || e.step.ack !== "nack")
      return [];
    const { parts, sameNet } = board;
    const on = (id: string, pin: string, line: string) =>
      sameNet(`${id}.${pin}`, `mcu.${e.periph}_${line}`);
    const devices = parts.filter(
      ({ id, i2c }) => i2c && on(id, i2c.sda, "SDA") && on(id, i2c.scl, "SCL"),
    );
    const there = devices.length
      ? `on this bus: ${devices.map((p) => describe(board, p)).join("; ")}`
      : `no I2C part's SDA and SCL are wired to ${e.periph}'s pins`;
    return [
      {
        severity: "warning",
        message: `no device answered address ${hex(e.step.addr)} (NACK); ${there}`,
        periph: e.periph,
      },
    ];
  },
};
