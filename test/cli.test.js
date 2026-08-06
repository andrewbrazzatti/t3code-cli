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

test("CLI rejects a flag the command does not accept", async () => {
  const { assertKnownFlags } = await import("../dist/index.js");
  // --instance is a plausible guess for --provider; it used to be accepted and
  // silently ignored, leaving the thread on whatever model it already had.
  assert.throws(
    () => assertKnownFlags(["thread", "update"], ["thread", "instance", "model"]),
    (error) => {
      assert.match(error.message, /Unknown flag "--instance"/);
      assert.match(error.message, /--provider/);
      assert.equal(error.code, "cli_parse_failed");
      return true;
    },
  );
});

test("CLI accepts global flags, aliases and per-command flags", async () => {
  const { assertKnownFlags } = await import("../dist/index.js");
  assert.doesNotThrow(() => assertKnownFlags(["thread", "start"], ["project", "provider", "model", "wait", "env", "format"]));
  assert.doesNotThrow(() => assertKnownFlags(["thread", "send"], ["thread-id", "prompt", "environment"]));
  // Aliased subcommands validate against the command they resolve to.
  assert.doesNotThrow(() => assertKnownFlags(["project", "rename"], ["project", "title"]));
  // An unrecognised command is left for the dispatcher to report.
  assert.doesNotThrow(() => assertKnownFlags(["nonsense", "verb"], ["anything"]));
});

test("help is scoped to the resolved command", async () => {
  const { commandHelp, topLevelHelp } = await import("../dist/commands.js");
  const startHelp = commandHelp(["thread", "start"]);
  assert.match(startHelp, /t3ctl thread start —/);
  assert.match(startHelp, /--wait/);
  // Flags belonging to sibling commands must not leak into this command's help.
  assert.doesNotMatch(startHelp, /--answers/);
  // Hidden aliases are accepted but not advertised.
  assert.doesNotMatch(startHelp, /--thread-id/);
  // env was previously undocumented despite being implemented.
  assert.match(topLevelHelp(), /env list\|use\|remove/);
});

test("a server/CLI schema mismatch is reported as a version problem", async () => {
  const { describeSchemaMismatch } = await import("../dist/app.js");
  const raw = new Error(
    'Expected "sidebar.toggle" | "terminal.toggle", got "filePicker.toggle"\n  at ["value"]["keybindings"][42]["command"]',
  );
  const described = describeSchemaMismatch(raw);
  assert.ok(described, "expected a decode failure to be recognised");
  assert.equal(described.code, "version_mismatch");
  assert.match(described.message, /older than the T3 Code server/);
  assert.match(described.message, /filePicker\.toggle/);
  // Unrelated failures must pass through untouched.
  assert.equal(describeSchemaMismatch(new Error("WebSocket connection failed: 401 Unauthorized")), undefined);
});
