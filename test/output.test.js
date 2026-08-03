import assert from "node:assert/strict";
import test from "node:test";

test("output format resolution selects JSON for non-interactive auto mode and NDJSON for streams", async () => {
  const { resolveOutputFormat, parseOutputFormat, structuredError } = await import("../dist/output.js");
  assert.equal(resolveOutputFormat("auto", { stdoutIsTTY: false }), "json");
  assert.equal(resolveOutputFormat("auto", { stdoutIsTTY: false, stream: true }), "ndjson");
  assert.equal(parseOutputFormat("human"), "human");
  assert.throws(() => parseOutputFormat("yaml"));
  assert.deepEqual(structuredError("credential_missing", "Authenticate first."), {
    version: 1,
    error: { code: "credential_missing", message: "Authenticate first." },
  });
});
