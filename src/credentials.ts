import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import * as fs from "node:fs";
import { execFile as execFileCallback, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { getConfigDir, getCredentialFilePath, getCredentialKeyPath } from "./config.js";

const execFile = promisify(execFileCallback);
const CREDENTIAL_FILE_VERSION = 1;
const KEYRING_SERVICE = "t3code-cli";

function runWithInput(command: string, args: readonly string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
    child.stdin.end(input);
  });
}

export type CredentialBackendKind = "keyring" | "encrypted-file";

export interface CredentialStore {
  readonly kind: CredentialBackendKind;
  get(id: string): Promise<string | undefined>;
  set(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface EncryptedSecret {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

function secretKey(): Buffer {
  const configured = process.env.T3CTL_CREDENTIAL_KEY?.trim();
  if (configured) {
    const asHex = /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, "hex") : undefined;
    if (asHex) return asHex;
    return createHash("sha256").update(configured, "utf8").digest();
  }
  const keyFile = getCredentialKeyPath();
  try {
    const existing = fs.readFileSync(keyFile);
    if (existing.length === 32) return existing;
  } catch {
    // Generate below.
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {
    // Best effort on filesystems without Unix permissions.
  }
  return key;
}

export function encryptSecret(secret: string, key = secretKey()): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    version: CREDENTIAL_FILE_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptSecret(payload: EncryptedSecret, key = secretKey()): string {
  if (payload.version !== CREDENTIAL_FILE_VERSION || payload.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported credential encryption format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

type CredentialDocument = {
  readonly version: 1;
  readonly entries: Record<string, EncryptedSecret>;
};

function readCredentialDocument(): CredentialDocument {
  const file = getCredentialFilePath();
  if (!fs.existsSync(file)) return { version: CREDENTIAL_FILE_VERSION, entries: {} };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as CredentialDocument;
    if (value.version !== CREDENTIAL_FILE_VERSION || typeof value.entries !== "object") {
      throw new Error("unsupported version");
    }
    return value;
  } catch (error) {
    throw new Error(
      `Encrypted credential store is unreadable at ${file}: ${error instanceof Error ? error.message : "invalid JSON"}.`,
    );
  }
}

function writeCredentialDocument(document: CredentialDocument): void {
  const file = getCredentialFilePath();
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

class EncryptedFileCredentialStore implements CredentialStore {
  readonly kind = "encrypted-file" as const;

  async get(id: string): Promise<string | undefined> {
    const entry = readCredentialDocument().entries[id];
    return entry ? decryptSecret(entry) : undefined;
  }

  async set(id: string, secret: string): Promise<void> {
    const document = readCredentialDocument();
    writeCredentialDocument({
      version: CREDENTIAL_FILE_VERSION,
      entries: { ...document.entries, [id]: encryptSecret(secret) },
    });
  }

  async delete(id: string): Promise<void> {
    const document = readCredentialDocument();
    const entries = { ...document.entries };
    delete entries[id];
    writeCredentialDocument({ version: CREDENTIAL_FILE_VERSION, entries });
  }
}

class NativeKeyringCredentialStore implements CredentialStore {
  readonly kind = "keyring" as const;

  constructor(private readonly platform: NodeJS.Platform) {}

  async get(id: string): Promise<string | undefined> {
    try {
      if (this.platform === "darwin") {
        const result = await execFile("security", ["find-generic-password", "-a", id, "-s", KEYRING_SERVICE, "-w"]);
        return result.stdout.trim() || undefined;
      }
      const result = await execFile("secret-tool", ["lookup", "service", KEYRING_SERVICE, "account", id]);
      return result.stdout.trim() || undefined;
    } catch (error) {
      const exitCode = (error as { code?: number }).code;
      if (exitCode === 44 || exitCode === 1) return undefined;
      throw error;
    }
  }

  async set(id: string, secret: string): Promise<void> {
      if (this.platform === "darwin") {
      await runWithInput("security", ["add-generic-password", "-a", id, "-s", KEYRING_SERVICE, "-w", "-U"], secret);
      return;
    }
    await runWithInput("secret-tool", ["store", "--label", KEYRING_SERVICE, "service", KEYRING_SERVICE, "account", id], secret);
  }

  async delete(id: string): Promise<void> {
    try {
      if (this.platform === "darwin") {
        await execFile("security", ["delete-generic-password", "-a", id, "-s", KEYRING_SERVICE]);
      } else {
        await execFile("secret-tool", ["clear", "service", KEYRING_SERVICE, "account", id]);
      }
    } catch {
      // Deleting an absent credential is idempotent.
    }
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFile("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createCredentialStore(options?: {
  readonly backend?: "auto" | CredentialBackendKind;
}): Promise<CredentialStore> {
  const requested = options?.backend ?? (process.env.T3CTL_CREDENTIAL_BACKEND as "auto" | CredentialBackendKind | undefined) ?? "auto";
  if (requested === "encrypted-file") return new EncryptedFileCredentialStore();
  if (requested === "keyring" || requested === "auto") {
    const keyringCommand = os.platform() === "darwin" ? "security" : "secret-tool";
    if (await commandAvailable(keyringCommand)) {
      return new NativeKeyringCredentialStore(os.platform());
    }
    if (requested === "keyring") {
      throw new Error(`No supported OS keyring was found (expected ${keyringCommand}).`);
    }
  }
  return new EncryptedFileCredentialStore();
}

export function credentialIdForEnvironment(name: string, serverUrl: string): string {
  return `${name}:${createHash("sha256").update(serverUrl).digest("hex").slice(0, 16)}`;
}
