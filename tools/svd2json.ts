// Converts the vendored stm32-rs patched SVD into the checked-in register JSON.
// Run: node tools/svd2json.ts
//
// Handles what this SVD uses and throws on anything else, so a new SVD fails
// loudly instead of converting wrong:
// - derivedFrom on peripherals, registers and fields, resolved as svd-rs does:
//   the element's own values win, and a child list (registers, fields) is
//   inherited whole only when the element has none;
// - dim arrays on registers, clusters and fields (`%s` names);
// - one level of cluster, flattened to `<cluster>_<register>` (DMA1 `CH1_CR`).
//
// Field names follow ST's CMSIS device header, the names learners type in C
// (RCC_IOPENR_GPIOBEN, not the SVD's IOPBEN): see cmsisNames.
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";

export const SVD_PATH = new URL(
  "../vendor/svd/stm32g031.svd.patched",
  import.meta.url,
);
export const JSON_PATH = new URL(
  "../src/chips/stm32g031k8.registers.json",
  import.meta.url,
);
export const HEADER_PATH = new URL(
  "../vendor/cmsis-device-g0/stm32g031xx.h",
  import.meta.url,
);

type Field = {
  bitOffset: number;
  bitWidth: number;
  access: string;
  description: string;
  svdName?: string;
};
type Register = {
  offset: string;
  size: number;
  access: string;
  resetValue: string;
  description: string;
  fields: Record<string, Field>;
};
type Peripheral = {
  baseAddress: string;
  registers: Record<string, Register>;
};
type Defaults = { size?: string; access?: string; resetValue?: string };

function kids(el: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === n.ELEMENT_NODE && (n as Element).tagName === tag) {
      out.push(n as Element);
    }
  }
  return out;
}

function own(el: Element, tag: string): string | undefined {
  return kids(el, tag)[0]?.textContent ?? undefined;
}

function num(s: string): number {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad number "${s}"`);
  return n;
}

const hex = (n: number, digits: number) =>
  "0x" + n.toString(16).toUpperCase().padStart(digits, "0");

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

// The names, descriptions and offset steps of a (possibly dim) element. The
// name and dim are always the element's own; the description may be derived.
function instances(el: Element, derivedDescription: string | undefined) {
  const name = own(el, "name")!;
  const description = clean(derivedDescription);
  const dim = own(el, "dim");
  if (dim === undefined) return [{ name, description, step: 0 }];
  if (name.includes("[%s]")) throw new Error(`array dim not handled: ${name}`);
  const n = num(dim);
  const spec = own(el, "dimIndex");
  const range = spec && /^(\d+)-(\d+)$/.exec(spec);
  const idx = range
    ? Array.from({ length: num(range[2]) - num(range[1]) + 1 }, (_, i) =>
        String(num(range[1]) + i),
      )
    : spec
      ? spec.split(",").map((s) => s.trim())
      : Array.from({ length: n }, (_, i) => String(i));
  if (idx.length !== n) throw new Error(`${name}: dimIndex "${spec}" != ${n}`);
  const inc = num(own(el, "dimIncrement")!);
  return idx.map((i, k) => ({
    name: name.replaceAll("%s", i),
    description: description.replaceAll("%s", i),
    step: k * inc,
  }));
}

// A lookup of each field's name in the CMSIS device header, or undefined when
// the header has no match. The peripheral's instance and TYPE come from the
// header's `#define GPIOB ((GPIO_TypeDef *) GPIOB_BASE)`, matched on base
// address. A field matches `<TYPE>_<REG>_<NAME>_Pos` (or `<INSTANCE>_…`, as in
// TIM1_AF1) when the _Pos is its bit offset and the _Msk its width. The SVD
// name wins if the header has it too (I2C OA2MSK is also OA2MASK07); any other
// tie throws.
function cmsisNames(header: string) {
  const defs = new Map<string, string>();
  for (const m of header.matchAll(/^#define\s+(\w+)\s+(.+?)\s*(\/\*.*)?$/gm)) {
    defs.set(m[1], m[2]);
  }
  // A base address: `(APBPERIPH_BASE + 0x00005400UL)` and the like.
  const value = (expr: string): number =>
    expr
      .replace(/[()]/g, "")
      .split("+")
      .reduce(
        (sum, t) =>
          sum + (/^\s*\d/.test(t) ? parseInt(t) : value(defs.get(t.trim())!)),
        0,
      );
  const instances = new Map<number, { name: string; type: string }>();
  for (const m of header.matchAll(
    /^#define\s+(\w+)\s+\(\((\w+?)_TypeDef \*\)\s*(\w+)\)/gm,
  )) {
    const at = value(defs.get(m[3])!);
    // DMAMUX_Channel_TypeDef's macros start DMAMUX_: TYPE ends at the first _.
    if (!instances.has(at)) {
      instances.set(at, { name: m[1], type: m[2].split("_")[0] });
    }
  }
  const macros = [
    ...header.matchAll(/^#define\s+(\w+)_Pos\s+\((\d+)U\)/gm),
  ].map((m) => ({
    name: m[1],
    bitOffset: Number(m[2]),
    mask: parseInt(/0x\w+/.exec(defs.get(`${m[1]}_Msk`)!)![0]),
  }));
  return (base: number, reg: string, svdName: string, f: Field) => {
    const i = instances.get(base);
    if (!i) return undefined;
    const prefixes = [`${i.type}_${reg}_`, `${i.name}_${reg}_`];
    const names = new Set(
      macros
        .filter(
          (m) => m.bitOffset === f.bitOffset && m.mask === 2 ** f.bitWidth - 1,
        )
        .flatMap((m) =>
          prefixes
            .filter((p) => m.name.startsWith(p))
            .map((p) => m.name.slice(p.length)),
        ),
    );
    if (names.has(svdName)) return svdName;
    if (names.size > 1)
      throw new Error(`${reg}.${svdName}: CMSIS ${[...names]}`);
    return [...names][0];
  };
}

export function svd2json(xml: string, header: string) {
  const cmsis = cmsisNames(header);
  let renamed = 0;
  let unmatched = 0;
  // One register's fields under their CMSIS names, keeping svdName if it differs.
  const rename = (base: number, reg: string, fields: Record<string, Field>) =>
    keyed(
      Object.entries(fields).map(([svdName, f]) => {
        const name = cmsis(base, reg, svdName, f);
        if (name === undefined) unmatched++;
        if (name === undefined || name === svdName) {
          return { name: svdName, ...f };
        }
        renamed++;
        return { name, ...f, svdName };
      }),
      ({ name, ...f }) => f,
    );
  const doc = new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    xml,
    "text/xml",
  );
  const device = doc.documentElement!;
  const byName = (els: Element[], name: string, ctx: string) => {
    const hit = els.find((e) => own(e, "name") === name);
    if (!hit) throw new Error(`derivedFrom "${ctx}": "${name}" not found`);
    return hit;
  };
  const allPeripherals = kids(kids(device, "peripherals")[0], "peripheral");
  const registersOf = (p: Element) =>
    kids(container(p, "registers")!, "register");
  const fieldsOf = (r: Element) => {
    const c = container(r, "fields");
    return c ? kids(c, "field") : [];
  };

  // The element an element's derivedFrom names. A dotted path starts at a
  // peripheral; a bare name is a sibling in the same parent.
  function base(el: Element): Element | undefined {
    const ref = el.getAttribute("derivedFrom");
    if (!ref) return undefined;
    const path = ref.split(".");
    if (el.tagName === "peripheral") return byName(allPeripherals, ref, ref);
    if (path.length === 1) {
      return byName(kids(el.parentNode as Element, el.tagName), ref, ref);
    }
    const p = byName(allPeripherals, path[0], ref);
    const r = byName(registersOf(p), path[1], ref);
    if (el.tagName === "register" && path.length === 2) return r;
    if (el.tagName === "field" && path.length === 3) {
      return byName(fieldsOf(r), path[2], ref);
    }
    throw new Error(`derivedFrom "${ref}" on <${el.tagName}> not handled`);
  }

  const get = (el: Element, tag: string): string | undefined => {
    const v = own(el, tag);
    if (v !== undefined) return v;
    const b = base(el);
    return b && get(b, tag);
  };

  function container(el: Element, tag: string): Element | undefined {
    const c = kids(el, tag)[0];
    if (c) return c;
    const b = base(el);
    return b && container(b, tag);
  }

  const inst = (el: Element) => instances(el, get(el, "description"));

  const props = (el: Element, d: Defaults): Defaults => ({
    size: get(el, "size") ?? d.size,
    access: get(el, "access") ?? d.access,
    resetValue: get(el, "resetValue") ?? d.resetValue,
  });

  function field(el: Element) {
    if (!get(el, "bitOffset") || !get(el, "bitWidth")) {
      throw new Error(
        `field ${own(el, "name")}: only bitOffset/bitWidth handled`,
      );
    }
    return inst(el).map((i) => ({
      name: i.name,
      bitOffset: num(get(el, "bitOffset")!) + i.step,
      bitWidth: num(get(el, "bitWidth")!),
      access: get(el, "access"),
      description: i.description,
    }));
  }

  // A register's fields, sorted, and its access. stm32-rs drops a register's
  // access when its fields differ; like svd2rust, take the fields' access when
  // they all agree, else read-write (the CMSIS-SVD default). A field with no
  // access of its own takes the register's.
  function fieldsAndAccess(el: Element, access: string | undefined) {
    const raw = fieldsOf(el).flatMap(field);
    const all = new Set(raw.map((f) => f.access));
    const [only] = all;
    const regAccess =
      access ?? (all.size === 1 ? only : undefined) ?? "read-write";
    const fields = raw
      .map((f) => ({ ...f, access: f.access ?? regAccess }))
      .sort((a, b) => a.bitOffset - b.bitOffset || cmp(a.name, b.name));
    return { regAccess, fields };
  }

  type Flat = Register & { name: string; at: number };
  function registers(parent: Element, at: number, d: Defaults, prefix: string) {
    const out: Flat[] = [];
    for (let n = parent.firstChild; n; n = n.nextSibling) {
      const el = n as Element;
      if (el.tagName !== "register" && el.tagName !== "cluster") continue;
      const p = props(el, d);
      const offset = at + num(get(el, "addressOffset")!);
      if (el.tagName === "cluster") {
        for (const i of inst(el)) {
          out.push(...registers(el, offset + i.step, p, `${prefix}${i.name}_`));
        }
        continue;
      }
      if (p.size === undefined || p.resetValue === undefined) {
        throw new Error(`${own(el, "name")}: no size or resetValue`);
      }
      const { regAccess, fields } = fieldsAndAccess(el, p.access);
      for (const i of inst(el)) {
        out.push({
          name: prefix + i.name,
          at: offset + i.step,
          offset: hex(offset + i.step, 2),
          size: num(p.size),
          access: regAccess,
          resetValue: hex(num(p.resetValue), 8),
          description: i.description,
          fields: keyed(fields, ({ name, ...f }) => f),
        });
      }
    }
    return out;
  }

  const deviceDefaults = props(device, {});
  const peripherals = allPeripherals
    .map((p) => {
      const base = num(get(p, "baseAddress")!);
      const regs = registers(
        container(p, "registers")!,
        0,
        props(p, deviceDefaults),
        "",
      ).sort((a, b) => a.at - b.at || cmp(a.name, b.name));
      return {
        name: own(p, "name")!,
        at: base,
        registers: keyed(regs, ({ name, at, ...r }) => ({
          ...r,
          fields: rename(base, name, r.fields),
        })),
      };
    })
    .sort((a, b) => a.at - b.at || cmp(a.name, b.name));

  const out = {
    device: own(device, "name"),
    source: "vendor/svd/stm32g031.svd.patched",
    generatedBy: "node tools/svd2json.ts (do not edit by hand)",
    peripherals: keyed(peripherals, (p): Peripheral => ({
      baseAddress: hex(p.at, 8),
      registers: p.registers,
    })),
  };
  return { json: JSON.stringify(out, null, 2) + "\n", renamed, unmatched };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Array of named items -> object keyed by name, in array order. Throws on a
// duplicate name rather than silently dropping one.
function keyed<T extends { name: string }, U>(items: T[], f: (t: T) => U) {
  const out: Record<string, U> = {};
  for (const it of items) {
    if (Object.hasOwn(out, it.name))
      throw new Error(`duplicate name ${it.name}`);
    out[it.name] = f(it);
  }
  return out;
}

if (import.meta.main) {
  const { json, renamed, unmatched } = svd2json(
    readFileSync(SVD_PATH, "utf8"),
    readFileSync(HEADER_PATH, "utf8"),
  );
  writeFileSync(JSON_PATH, json);
  console.log(
    `${renamed} fields renamed to their CMSIS name; ` +
      `${unmatched} with no CMSIS match keep the SVD name`,
  );
}
