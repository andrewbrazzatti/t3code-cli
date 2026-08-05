import assert from "node:assert/strict";
import test from "node:test";

test("CLI parser supports top-level and nested thread start forms", async () => {
  const { parseArgs } = await import("../dist/index.js");
  assert.deepEqual(parseArgs(["start", "thread-1", "continue"]), {
    command: ["start"],
    flags: new Map(),
    positionals: ["thread-1", "continue"],
    rawArgv: ["start", "thread-1", "continue"],
  });
  assert.deepEqual(parseArgs(["thread", "start", "--project", "project-1", "--image", "sample.png", "begin"]), {
    command: ["thread", "start"],
    flags: new Map([["project", "project-1"], ["image", "sample.png"]]),
    positionals: ["begin"],
    rawArgv: ["thread", "start", "--project", "project-1", "--image", "sample.png", "begin"],
  });
});

test("CLI parser rejects a missing output format value", async () => {
  const { outputFormatFromArgv } = await import("../dist/output.js");
  assert.throws(() => outputFormatFromArgv(["node", "t3ctl", "--format"]), /requires a value/);
});

test("CLI parses multiple --image flags and comma-separated image paths", async () => {
  const { parseArgs } = await import("../dist/index.js");
  const parsed = parseArgs(["thread", "send", "thread-123", "--image", "a.png,b.jpeg", "--image", "c.webp", "hello"]);
  assert.equal(parsed.command[0], "thread");
  assert.equal(parsed.command[1], "send");
  assert.equal(parsed.positionals[0], "thread-123");
  assert.equal(parsed.positionals[1], "hello");
});
