import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("target resolution normalizes HTTP/WS URLs and keeps secrets out of config", async () => {
  process.env.T3CTL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "t3ctl-connection-"));
  const { resolveTarget } = await import("../dist/connection.js");
  const target = resolveTarget({ serverUrl: "wss://example.test/path?x=1", token: "access-token" });
  assert.equal(target.httpBaseUrl, "https://example.test/");
  assert.equal(target.socketUrl, "wss://example.test/ws?token=access-token");
  assert.equal(target.token, "access-token");
});
