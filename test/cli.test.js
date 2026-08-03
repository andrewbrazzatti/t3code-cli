import assert from "node:assert/strict";
import test from "node:test";

test("CLI parser supports top-level and nested thread start forms", async () => {
  const { parseArgs } = await import("../dist/index.js");
  assert.deepEqual(parseArgs(["start", "thread-1", "continue"]), {
    command: ["start"],
    flags: new Map(),
    positionals: ["thread-1", "continue"],
  });
  assert.deepEqual(parseArgs(["thread", "start", "--project", "project-1", "begin"]), {
    command: ["thread", "start"],
    flags: new Map([["project", "project-1"]]),
    positionals: ["begin"],
  });
});

test("CLI parser rejects a missing output format value", async () => {
  const { outputFormatFromArgv } = await import("../dist/output.js");
  assert.throws(() => outputFormatFromArgv(["node", "t3ctl", "--format"]), /requires a value/);
});
