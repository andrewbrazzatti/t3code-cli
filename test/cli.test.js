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

test("CLI accepts provider credentials flags and aliases", async () => {
  const { assertKnownFlags } = await import("../dist/index.js");
  assert.doesNotThrow(() => assertKnownFlags(["provider", "credentials"], ["provider", "name", "value", "sensitive", "non-sensitive"]));
  assert.doesNotThrow(() => assertKnownFlags(["provider", "get"], ["instance", "key"]));
  assert.doesNotThrow(() => assertKnownFlags(["provider", "set"], ["instance-id", "key", "val"]));
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

test("CLI accepts terminal attach, list, and close flags", async () => {
  const { assertKnownFlags } = await import("../dist/index.js");
  assert.doesNotThrow(() => assertKnownFlags(["terminal", "attach"], ["thread", "terminal-id", "cwd", "cols", "rows", "env-var"]));
  assert.doesNotThrow(() => assertKnownFlags(["terminal", "list"], ["thread-id"]));
  assert.doesNotThrow(() => assertKnownFlags(["terminal", "close"], ["thread", "terminal-id", "delete-history"]));
  // A model-selection flag from a sibling command must be rejected.
  assert.throws(() => assertKnownFlags(["terminal", "attach"], ["model"]), /Unknown flag "--model"/);
});

test("terminal commands are documented and scoped", async () => {
  const { commandHelp, topLevelHelp } = await import("../dist/commands.js");
  const attachHelp = commandHelp(["terminal", "attach"]);
  assert.match(attachHelp, /t3ctl terminal attach —/);
  assert.match(attachHelp, /--terminal-id/);
  assert.match(attachHelp, /--cwd/);
  // Flags belonging to sibling terminal commands must not leak.
  assert.doesNotMatch(attachHelp, /--delete-history/);
  assert.match(topLevelHelp(), /terminal attach/);
  assert.match(topLevelHelp(), /terminal list\|close/);
});

test("CLI parses --fast-mode as boolean without consuming positionals", async () => {
  const { parseArgs } = await import("../dist/index.js");
  const parsed = parseArgs(["thread", "update", "--fast-mode", "thread-123"]);
  assert.equal(parsed.command[0], "thread");
  assert.equal(parsed.command[1], "update");
  assert.equal(parsed.flags.get("fast-mode"), true);
  assert.equal(parsed.positionals[0], "thread-123");

  const startParsed = parseArgs(["thread", "start", "--project", "proj-1", "--fast-mode", "my prompt"]);
  assert.equal(startParsed.flags.get("fast-mode"), true);
  assert.equal(startParsed.positionals[0], "my prompt");
});

test("worktree flags are accepted by thread create and start, and documented", async () => {
  const { assertKnownFlags } = await import("../dist/index.js");
  const worktreeFlags = ["worktree", "worktree-path", "base-branch", "branch", "from-origin"];
  assert.doesNotThrow(() => assertKnownFlags(["thread", "start"], [...worktreeFlags, "project", "wait"]));
  assert.doesNotThrow(() => assertKnownFlags(["thread", "create"], worktreeFlags));

  const { commandHelp } = await import("../dist/commands.js");
  for (const command of [["thread", "start"], ["thread", "create"]]) {
    const help = commandHelp(command);
    assert.match(help, /--worktree/, `${command.join(" ")} help should document --worktree`);
    assert.match(help, /--worktree-path/, `${command.join(" ")} help should document --worktree-path`);
    assert.match(help, /--base-branch/, `${command.join(" ")} help should document --base-branch`);
  }
  // Sibling commands must not gain the flags.
  assert.throws(() => assertKnownFlags(["thread", "send"], ["worktree"]), /Unknown flag "--worktree"/);
  assert.doesNotThrow(() => assertKnownFlags(["thread", "update"], ["worktree-path"]));
});

test("thread start parses --worktree as boolean and --worktree-path with a value", async () => {
  const { parseArgs } = await import("../dist/index.js");
  const fresh = parseArgs(["thread", "start", "--project", "proj-1", "--worktree", "fix the bug"]);
  assert.equal(fresh.flags.get("worktree"), true);
  assert.deepEqual(fresh.positionals, ["fix the bug"]);

  const attached = parseArgs(["thread", "start", "--project", "proj-1", "--worktree-path", "/srv/repo/.t3/worktrees/feature-a", "fix the bug"]);
  assert.equal(attached.flags.get("worktree-path"), "/srv/repo/.t3/worktrees/feature-a");
  assert.deepEqual(attached.positionals, ["fix the bug"]);
});

test("CLI accepts schedule flags, rejects leaked ones, and documents the commands", async () => {
  const { assertKnownFlags } = await import("../dist/index.js");
  assert.doesNotThrow(() => assertKnownFlags(["schedule", "add"], ["thread", "message", "image", "at", "in", "retry-until", "retry-interval", "provider", "model", "runtime-mode"]));
  assert.doesNotThrow(() => assertKnownFlags(["schedule", "list"], ["all"]));
  assert.doesNotThrow(() => assertKnownFlags(["schedule", "cancel"], ["id"]));
  assert.doesNotThrow(() => assertKnownFlags(["schedule", "run"], ["interval", "once"]));
  // Aliased subcommands validate against the command they resolve to.
  assert.doesNotThrow(() => assertKnownFlags(["schedule", "rm"], ["id"]));
  // --wait makes no sense for a queued send; worktree flags belong to threads.
  assert.throws(() => assertKnownFlags(["schedule", "add"], ["wait"]), /Unknown flag "--wait"/);
  assert.throws(() => assertKnownFlags(["schedule", "add"], ["worktree"]), /Unknown flag "--worktree"/);
  assert.throws(() => assertKnownFlags(["schedule", "run"], ["in"]), /Unknown flag "--in"/);
});

test("schedule help is scoped and the root is documented", async () => {
  const { commandHelp, topLevelHelp } = await import("../dist/commands.js");
  const addHelp = commandHelp(["schedule", "add"]);
  assert.match(addHelp, /t3ctl schedule add —/);
  assert.match(addHelp, /--retry-until/);
  assert.match(addHelp, /--in/);
  // Sibling schedule commands must not leak into add's help.
  assert.doesNotMatch(addHelp, /--once/);
  const runHelp = commandHelp(["schedule", "run"]);
  assert.match(runHelp, /--once/);
  assert.match(runHelp, /--interval/);
  const top = topLevelHelp();
  assert.match(top, /schedule add <thread-id>/);
  assert.match(top, /schedule run/);
  assert.match(top, /queue a resume/i);
});

test("impossible worktree flag combinations are rejected before any network traffic", async () => {
  const { validateWorktreeSettings } = await import("../dist/app.js");
  // Valid shapes pass untouched.
  assert.doesNotThrow(() => validateWorktreeSettings({}));
  assert.doesNotThrow(() => validateWorktreeSettings({ worktree: true }));
  assert.doesNotThrow(() => validateWorktreeSettings({ worktree: true, baseBranch: "main", fromOrigin: true }));
  assert.doesNotThrow(() => validateWorktreeSettings({ worktreePath: "/srv/wt", branch: "feature-a" }));

  assert.throws(
    () => validateWorktreeSettings({ worktree: true, worktreePath: "/srv/wt" }),
    (error) => error.code === "cli_parse_failed" && /mutually exclusive/.test(error.message),
  );
  assert.throws(
    () => validateWorktreeSettings({ baseBranch: "main" }),
    (error) => error.code === "cli_parse_failed" && /--base-branch requires --worktree/.test(error.message),
  );
  assert.throws(
    () => validateWorktreeSettings({ fromOrigin: true }),
    (error) => error.code === "cli_parse_failed" && /--from-origin requires --worktree/.test(error.message),
  );
  assert.throws(
    () => validateWorktreeSettings({ branch: "feature-a" }),
    (error) => error.code === "cli_parse_failed" && /--branch requires --worktree or --worktree-path/.test(error.message),
  );
});

test("thread send and schedule add parse positional messages when --thread is passed", async () => {
  const { parseArgs } = await import("../dist/index.js");
  const sendPositional = parseArgs(["thread", "send", "thr_123", "hello"]);
  assert.equal(sendPositional.positionals[0], "thr_123");
  assert.equal(sendPositional.positionals[1], "hello");

  const sendFlag = parseArgs(["thread", "send", "--thread", "thr_123", "hello"]);
  assert.equal(sendFlag.flags.get("thread"), "thr_123");
  assert.equal(sendFlag.positionals[0], "hello");

  const schedPositional = parseArgs(["schedule", "add", "thr_123", "continue", "--in", "5h"]);
  assert.equal(schedPositional.positionals[0], "thr_123");
  assert.equal(schedPositional.positionals[1], "continue");

  const schedFlag = parseArgs(["schedule", "add", "--thread", "thr_123", "continue", "--in", "5h"]);
  assert.equal(schedFlag.flags.get("thread"), "thr_123");
  assert.equal(schedFlag.positionals[0], "continue");
});
test("ChatAttachment deserializes file, image, and unknown attachment variants", async () => {
  const { Schema } = await import("effect");
  const { ChatAttachment } = await import("@t3tools/contracts");

  const decodeAttachment = Schema.decodeUnknownSync(ChatAttachment);

  // 1. PDF file attachment
  const pdfAttachment = decodeAttachment({
    type: "file",
    id: "att_pdf_1",
    name: "architecture brief.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
  });
  assert.equal(pdfAttachment.type, "file");
  assert.equal(pdfAttachment.name, "architecture brief.pdf");
  assert.equal(pdfAttachment.mimeType, "application/pdf");

  // 2. Unknown non-image/non-file variant keeps its shared base fields
  const genericAttachment = decodeAttachment({
    type: "document",
    id: "att_doc_1",
    name: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 2048,
  });
  assert.equal(genericAttachment.type, "document");
  assert.equal(genericAttachment.name, "report.docx");

  // 3. Image attachment
  const imageAttachment = decodeAttachment({
    type: "image",
    id: "att_img_1",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 4096,
  });
  assert.equal(imageAttachment.type, "image");

  // 4. A malformed unknown variant missing its base fields is rejected outright.
  assert.throws(() => decodeAttachment({ type: "unrecognised_missing_required_fields" }));
});


