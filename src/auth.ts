import { platform } from "node:os";

import { ConfigError, loadConfig, removeEnvironment, setActiveEnvironment, upsertEnvironment } from "./config.js";
import { createCredentialStore, credentialIdForEnvironment } from "./credentials.js";
import { errorMessage } from "./connection.js";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const STANDARD_SCOPES = "orchestration:read orchestration:operate terminal:operate review:write relay:read";

export interface AuthResult {
  readonly environment: string;
  readonly serverUrl: string;
  readonly credentialStored: boolean;
  readonly credentialBackend?: string;
}

function parseAuthInput(input: string): { serverUrl: string; credential?: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConfigError("Invalid pairing URL or server URL.", "server_url_invalid");
  }
  const hostedHost = url.searchParams.get("host");
  const credential = url.hash.startsWith("#")
    ? new URLSearchParams(url.hash.slice(1)).get("token") ?? undefined
    : url.searchParams.get("token") ?? undefined;
  if (hostedHost) {
    const hostUrl = hostedHost.startsWith("http://") || hostedHost.startsWith("https://") ? hostedHost : `https://${hostedHost}`;
    return { serverUrl: hostUrl, credential };
  }
  url.searchParams.delete("token");
  url.pathname = "/";
  url.hash = "";
  return { serverUrl: url.toString(), credential };
}

async function exchangeCredential(serverUrl: string, credential: string): Promise<string> {
  const response = await fetch(new URL("/oauth/token", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: credential,
      subject_token_type: BOOTSTRAP_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      scope: STANDARD_SCOPES,
      client_label: "t3code-cli",
      client_device_type: "bot",
      client_os: `${platform()} ${process.version}`,
    }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error_description?: string; message?: string };
      detail = (body.error_description || body.message || "").replaceAll(credential, "[redacted]");
    } catch {
      // Keep the error stable if the server returned non-JSON content.
    }
    throw new ConfigError(`Authentication failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`, "auth_exchange_failed");
  }
  const body = await response.json() as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new ConfigError("Authentication response did not contain an access token.", "auth_exchange_invalid");
  }
  return body.access_token;
}

function defaultEnvironmentName(serverUrl: string): string {
  const hostname = new URL(serverUrl).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "local";
  return hostname.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "default";
}

async function storeEnvironment(input: {
  readonly name?: string;
  readonly serverUrl: string;
  readonly accessToken?: string;
}): Promise<AuthResult> {
  const name = input.name?.trim() || defaultEnvironmentName(input.serverUrl);
  const credentialId = input.accessToken ? credentialIdForEnvironment(name, input.serverUrl) : undefined;
  let backend: string | undefined;
  if (input.accessToken && credentialId) {
    let credentials = await createCredentialStore();
    try {
      await credentials.set(credentialId, input.accessToken);
    } catch (error) {
      // A locked/unavailable keyring must not make authentication store a
      // plaintext fallback. Use the encrypted file store explicitly.
      credentials = await createCredentialStore({ backend: "encrypted-file" });
      await credentials.set(credentialId, input.accessToken);
    }
    backend = credentials.kind;
  }
  upsertEnvironment({ name, serverUrl: input.serverUrl, credentialId, credentialBackend: backend as "keyring" | "encrypted-file" | undefined, setActive: true });
  return { environment: name, serverUrl: input.serverUrl, credentialStored: Boolean(input.accessToken), ...(backend ? { credentialBackend: backend } : {}) };
}

export async function authenticatePair(options: {
  readonly input: string;
  readonly name?: string;
  readonly credential?: string;
}): Promise<AuthResult> {
  const parsed = parseAuthInput(options.input);
  const credential = options.credential?.trim() || parsed.credential;
  if (!credential) throw new ConfigError("Pairing requires a pairing URL with a token or --token.", "credential_missing");
  const accessToken = await exchangeCredential(parsed.serverUrl, credential);
  return storeEnvironment({ name: options.name, serverUrl: parsed.serverUrl, accessToken });
}

export async function authenticateLocal(options: {
  readonly serverUrl: string;
  readonly name?: string;
  readonly bootstrapToken?: string;
  readonly accessToken?: string;
}): Promise<AuthResult> {
  const serverUrl = parseAuthInput(options.serverUrl).serverUrl;
  const directAccessToken = options.accessToken?.trim() || process.env.T3_ACCESS_TOKEN?.trim();
  const bootstrapToken = options.bootstrapToken?.trim() || process.env.T3_LOCAL_TOKEN?.trim() || process.env.T3_TOKEN?.trim();
  if (directAccessToken) return storeEnvironment({ name: options.name, serverUrl, accessToken: directAccessToken });
  if (bootstrapToken) {
    const accessToken = await exchangeCredential(serverUrl, bootstrapToken);
    return storeEnvironment({ name: options.name, serverUrl, accessToken });
  }
  // Unsafe/no-auth local deployments intentionally have no credential. The
  // connection boundary will still make this explicit by omitting auth.
  return storeEnvironment({ name: options.name, serverUrl });
}

export async function authStatus(options?: { readonly environment?: string }): Promise<unknown> {
  const config = loadConfig();
  const selected = options?.environment ? [options.environment] : Object.keys(config.environments);
  if (options?.environment && !config.environments[options.environment]) {
    throw new ConfigError(`Environment "${options.environment}" is not configured.`, "environment_missing");
  }
  const credentials = await createCredentialStore();
  return {
    version: 1,
    activeEnvironment: config.activeEnvironment ?? null,
    credentialBackend: credentials.kind,
    environments: await Promise.all(selected.map(async (name) => {
      const environment = config.environments[name];
      const environmentCredentials = await createCredentialStore({ backend: environment.credentialBackend ?? "auto" });
      const available = environment.credentialId ? Boolean(await environmentCredentials.get(environment.credentialId)) : false;
      return {
        name,
        serverUrl: environment.serverUrl,
        active: config.activeEnvironment === name,
        credential: environment.credentialId ? (available ? "available" : "missing") : "none",
        ...(environment.credentialId ? { credentialBackend: environmentCredentials.kind } : {}),
      };
    })),
  };
}

export function useEnvironment(name: string): unknown {
  const config = setActiveEnvironment(name);
  return { activeEnvironment: config.activeEnvironment, serverUrl: config.environments[name].serverUrl };
}

export async function removeAuthEnvironment(name: string): Promise<unknown> {
  const config = loadConfig();
  const environment = config.environments[name];
  if (!environment) throw new ConfigError(`Environment "${name}" is not configured.`, "environment_missing");
  if (environment.credentialId) {
    const credentials = await createCredentialStore({ backend: environment.credentialBackend ?? "auto" });
    await credentials.delete(environment.credentialId);
  }
  removeEnvironment(name);
  return { environment: name, removed: true };
}

export interface PairingTokenResult {
  readonly serverUrl: string;
  readonly environment: string;
  readonly pairingUrl: string;
  readonly credential: string;
  readonly expiresAt: string;
  readonly label?: string;
}

export async function createPairingToken(options: {
  readonly label?: string;
  readonly environment?: string;
}): Promise<PairingTokenResult> {
  const config = loadConfig();
  const envName = options.environment?.trim() || config.activeEnvironment;
  if (!envName) throw new ConfigError("No active environment. Run \"t3ctl auth pair\" or \"t3ctl env use\".", "environment_missing");
  const environment = config.environments[envName];
  if (!environment) throw new ConfigError(`Environment "${envName}" is not configured.`, "environment_missing");
  if (!environment.credentialId) throw new ConfigError(`Environment "${envName}" has no credential.`, "credential_missing");
  const credentials = await createCredentialStore({ backend: environment.credentialBackend ?? "auto" });
  const accessToken = await credentials.get(environment.credentialId);
  if (!accessToken) {
    throw new ConfigError(
      `No credential is available for environment "${envName}". Run "t3ctl auth pair" or "t3ctl auth local".`,
      "credential_missing",
    );
  }
  const body: Record<string, string> = {};
  if (options.label?.trim()) body.label = options.label.trim();
  const response = await fetch(new URL("/api/auth/pairing-token", environment.serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const errorBody = await response.json() as { message?: string; error_description?: string };
      detail = errorBody.message || errorBody.error_description || "";
    } catch {
      // Server returned non-JSON.
    }
    throw new ConfigError(
      `Failed to create pairing token (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
      "pairing_token_failed",
    );
  }
  const result = await response.json() as { id?: string; credential?: string; expiresAt?: string; label?: string };
  if (!result.credential) {
    throw new ConfigError("Server response did not contain a pairing credential.", "pairing_token_failed");
  }
  const pairingUrl = `${environment.serverUrl.replace(/\/$/, "")}/pair#token=${encodeURIComponent(result.credential)}`;
  return {
    serverUrl: environment.serverUrl,
    environment: envName,
    pairingUrl,
    credential: result.credential,
    expiresAt: result.expiresAt ?? "unknown",
    ...(result.label ? { label: result.label } : {}),
  };
}

export function authError(error: unknown): ConfigError {
  return error instanceof ConfigError ? error : new ConfigError(errorMessage(error), "auth_failed");
}
