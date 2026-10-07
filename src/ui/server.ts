// The local server behind `sim ui`: the page, the firmware and circuit it runs,
// and the engine's own .ts files with their types stripped (docs/decisions.md
// §15). Localhost only, nothing fetched from anywhere else.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { stripTypeScriptTypes } from "node:module";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadElf } from "../engine/elf.ts";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const INDEX = join(SRC, "ui/index.html");
const WOKWI = fileURLToPath(
  import.meta.resolve("@wokwi/elements/dist/wokwi-elements.bundle.js"),
);
const DEBUG_INFO = dirname(
  fileURLToPath(import.meta.resolve("@gba-kit/debug-info")),
);

const JS = "text/javascript; charset=utf-8";
const HEADERS = {
  // Every reload gets the current firmware, circuit and code.
  "Cache-Control": "no-store",
  // Nothing from outside this server, even if a part's art asked for it.
  "Content-Security-Policy": "default-src 'self' 'unsafe-inline'",
};

// Node 24 says once per process that stripTypeScriptTypes is experimental.
// Say it here, silently, so `sim ui` doesn't print it.
const { emitWarning } = process;
process.emitWarning = () => {};
stripTypeScriptTypes("");
process.emitWarning = emitWarning;

export interface UiInput {
  /** Read on every request, so a reload picks up a rebuilt ELF or an edited circuit. */
  elf(): Uint8Array;
  circuit(): string;
}

/** Serves the UI on 127.0.0.1:`port` (0: any free port). Resolves to its URL. */
export function serveUi(port: number, input: UiInput): Promise<string> {
  const server = createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    // Only pages from this server: a site that rebinds its DNS name to
    // 127.0.0.1 would send its own Host, and can't read these files.
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host!)
    ) {
      res.writeHead(403).end();
      return;
    }
    // Dot segments are already resolved here, and %2F isn't decoded.
    const path = new URL(req.url!, "http://localhost").pathname;
    let type = JS;
    let body: string | Uint8Array;
    try {
      if (path === "/") {
        type = "text/html; charset=utf-8";
        body = readFileSync(INDEX);
      } else if (path === "/elf") {
        type = "application/octet-stream";
        body = input.elf();
      } else if (path === "/circuit") {
        type = "application/json";
        body = input.circuit();
      } else if (path === "/wokwi-elements.js") {
        body = readFileSync(WOKWI);
      } else if (path.startsWith("/debug-info/") && path.endsWith(".js")) {
        body = readFileSync(inside(DEBUG_INFO, path.slice(12)));
      } else if (path.startsWith("/src/") && path.endsWith(".ts")) {
        body = stripTypeScriptTypes(
          readFileSync(inside(SRC, path.slice(5)), "utf8"),
        );
      } else if (path.startsWith("/src/") && path.endsWith(".json")) {
        type = "application/json";
        body = readFileSync(inside(SRC, path.slice(5)));
      } else if (path === "/source") {
        // ---- T36: source text for the Source panel (see sourceFile) ----
        type = "text/plain; charset=utf-8";
        const file = sourceFile(
          input.elf(),
          new URL(req.url!, "http://localhost").searchParams.get("file"),
        );
        // Named but not on this machine (the C library's): no text, rather
        // than a 404 the browser would log as an error on every step into it.
        body = existsSync(file) ? readFileSync(file) : "";
        // ---- end T36 ----
      } else {
        res.writeHead(404, HEADERS).end();
        return;
      }
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      res
        .writeHead(missing ? 404 : 500, {
          ...HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
        })
        .end((e as Error).message);
      return;
    }
    res.writeHead(200, { ...HEADERS, "Content-Type": type }).end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`),
    );
  });
}

/** `dir`/`rest`, or a not-found error if that is outside `dir`. */
function inside(dir: string, rest: string): string {
  const file = join(dir, rest);
  if (!file.startsWith(dir.endsWith(sep) ? dir : dir + sep))
    throw Object.assign(new Error("not found"), { code: "ENOENT" });
  return file;
}

// ---- T36: /source?file=<path> ----
// A safety boundary: the page may read the source files the loaded ELF's DWARF
// line table names, as the absolute paths pcToSource() gives them (decisions.md
// §5), read-only, and nothing else. The path must equal one of them exactly, so
// a relative path, a ".." or any other file is not found.

/** `file`, if it is one of the ELF's source files; else a not-found error. */
function sourceFile(elf: Uint8Array, file: string | null): string {
  if (!file || !isAbsolute(file) || !loadElf(elf).sources().includes(file))
    throw Object.assign(new Error("not found"), { code: "ENOENT" });
  return file;
}
