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
  const socket = new URL(target.socketUrl);
  assert.equal(socket.protocol, "wss:");
  assert.equal(socket.host, "example.test");
  assert.equal(socket.pathname, "/ws");
  assert.equal(socket.searchParams.get("token"), "access-token");
  assert.equal(socket.searchParams.get("orchestrationProtocol"), "2");
  assert.equal(target.token, "access-token");
});

test("errorMessage extracts nested WebSocket and RPC error causes", async () => {
  const { errorMessage } = await import("../dist/connection.js");
  const rpc401Error = {
    _tag: "RpcClientError",
    reason: {
      _tag: "SocketOpenError",
      kind: "Unknown",
      cause: { message: "Unexpected server response: 401" },
    },
  };
  assert.equal(
    errorMessage(rpc401Error),
    'WebSocket connection failed: 401 Unauthorized. Run "t3ctl auth pair" or "t3ctl auth local" to re-authenticate.',
  );

  const econnrefusedError = {
    _tag: "RpcClientError",
    reason: {
      _tag: "SocketOpenError",
      kind: "Unknown",
      cause: { message: "connect ECONNREFUSED 127.0.0.1:3000" },
    },
  };
  assert.equal(
    errorMessage(econnrefusedError),
    "SocketOpenError: connect ECONNREFUSED 127.0.0.1:3000",
  );
});

