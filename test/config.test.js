import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function isolatedDirectory() {
  return mkdtempSync(join(tmpdir(), "t3ctl-test-"));
}

test("AES-256-GCM credential round trip never writes the secret to the encrypted document", async () => {
  const directory = isolatedDirectory();
  process.env.T3CTL_CONFIG_DIR = directory;
  process.env.T3CTL_CREDENTIAL_BACKEND = "encrypted-file";
  const { createCredentialStore } = await import("../dist/credentials.js");
  const store = await createCredentialStore({ backend: "encrypted-file" });
  await store.set("env", "super-secret-token");
  assert.equal(await store.get("env"), "super-secret-token");
  const raw = readFileSync(join(directory, "credentials.enc"), "utf8");
  assert.equal(raw.includes("super-secret-token"), false);
  assert.equal(existsSync(join(directory, "credentials.key")), true);
});

test("versioned config rejects legacy plaintext token files with an actionable error", async () => {
  const directory = isolatedDirectory();
  process.env.T3CTL_CONFIG_DIR = directory;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ serverUrl: "http://localhost", token: "secret" }));
  const { loadConfig, ConfigError } = await import("../dist/config.js");
  assert.throws(() => loadConfig(), (error) => error instanceof ConfigError && error.code === "legacy_config_rejected" && !error.message.includes("secret"));
});
