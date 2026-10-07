// Firmware ELF: what to load where, symbols, and PC → source line.
// Symbols and DWARF come from @gba-kit/debug-info; it doesn't expose program
// headers or the entry point, so those are read here (docs/decisions.md §5).
import { attrStr, DebugInfo, normalizePath } from "@gba-kit/debug-info";

/** A PT_LOAD segment, placed at its load address (LMA, `p_paddr`). */
export interface Segment {
  addr: number;
  /** The segment's bytes in the file (`p_filesz` of them). */
  data: Uint8Array;
  /** `p_memsz`. Bytes past `data.length` are zero (.bss). */
  memSize: number;
}

export interface SourceLine {
  file: string;
  line: number;
}

export interface Elf {
  /** `e_entry`, as the ELF records it: bit 0 set for Thumb. */
  entry: number;
  segments: Segment[];
  /** A symbol's address. Function addresses have the Thumb bit cleared. */
  symbol(name: string): number | undefined;
  /** The name of the function containing `addr`. */
  functionAt(addr: number): string | undefined;
  /** File and line from DWARF. A relative file is resolved against its compile directory. */
  pcToSource(pc: number): SourceLine | undefined;
  /** Every file pcToSource() can give, once each: the line table's files, resolved as it resolves them. */
  sources(): string[];
}

const EM_ARM = 40;
const PT_LOAD = 1;
const DW_AT_comp_dir = 0x1b;

export function loadElf(bytes: Uint8Array): Elf {
  const di = DebugInfo.fromElf(bytes); // throws if it isn't an ELF32 file
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    !di.elf.littleEndian ||
    v.getUint16(0x12, true) !== EM_ARM ||
    !di.isLinked
  ) {
    throw new Error("not a linked little-endian ARM ELF");
  }

  const segments: Segment[] = [];
  const phoff = v.getUint32(0x1c, true);
  const phentsize = v.getUint16(0x2a, true);
  for (let i = 0; i < v.getUint16(0x2c, true); i++) {
    const ph = phoff + i * phentsize;
    if (v.getUint32(ph, true) !== PT_LOAD) continue;
    const offset = v.getUint32(ph + 4, true);
    const filesz = v.getUint32(ph + 16, true);
    if (offset + filesz > bytes.length)
      throw new Error(`ELF segment ${i} runs past the end of the file`);
    segments.push({
      addr: v.getUint32(ph + 12, true),
      data: bytes.subarray(offset, offset + filesz),
      memSize: v.getUint32(ph + 20, true),
    });
  }

  const pcToSource = (pc: number): SourceLine | undefined => {
    const src = di.lines.pcToSource(pc);
    if (!src) return undefined;
    const unit = /^([A-Za-z]:)?[\\/]/.test(src.file)
      ? null
      : di.scopes.unitContaining(pc);
    const dir = unit && attrStr(unit.root, DW_AT_comp_dir);
    return {
      file: dir ? normalizePath(`${dir}/${src.file}`) : src.file,
      line: src.line,
    };
  };

  return {
    entry: v.getUint32(0x18, true),
    segments,
    symbol: (name) => di.symbolToAddress(name) ?? undefined,
    functionAt: (addr) => di.pcToFunction(addr)?.name,
    pcToSource,
    // pcToSource(pc) is the row at or before pc, so the rows' own addresses give every answer.
    sources: () => [
      ...new Set(
        di.lines.rows.flatMap((r) => {
          const src = r.endSequence ? undefined : pcToSource(r.address);
          return src ? [src.file] : [];
        }),
      ),
    ],
  };
}
