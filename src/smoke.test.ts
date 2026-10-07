import { test } from "node:test";
import assert from "node:assert/strict";

// Node runs our .ts files directly; type stripping needs Node 24 or later.
test("runs on Node 24 or later", () => {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
});
