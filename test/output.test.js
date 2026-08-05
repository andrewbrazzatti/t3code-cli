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

test("createOutputSink human format renders clean human-readable output instead of JSON", async () => {
  const { createOutputSink } = await import("../dist/output.js");

  let stdoutText = "";
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => { stdoutText += String(chunk); return true; };

  try {
    const sink = createOutputSink("human");
    sink.write({
      projects: [
        {
          id: "proj_1",
          title: "My Project",
          workspaceRoot: "/path/to/project",
          repositoryIdentity: { canonicalKey: "github.com/org/repo" },
          defaultModelSelection: { instanceId: "claudeAgent", model: "claude-3-5-sonnet" },
        },
      ],
    });
    assert.match(stdoutText, /• My Project \(proj_1\)/);
    assert.match(stdoutText, /Workspace: \/path\/to\/project/);
    assert.match(stdoutText, /Repo: github\.com\/org\/repo/);
    assert.match(stdoutText, /Model: claudeAgent \/ claude-3-5-sonnet/);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

