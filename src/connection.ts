import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import WebSocket from "ws";

import { ConfigError, loadConfig } from "./config.js";
import { createCredentialStore } from "./credentials.js";

export interface ResolvedTarget {
  readonly environmentName?: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly socketUrl: string;
  readonly token?: string;
  readonly credentialId?: string;
}

export interface TargetOptions {
  readonly serverUrl?: string;
  readonly token?: string;
  readonly environment?: string;
}

function normalizeHttpUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError("Invalid server URL.", "server_url_invalid");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!(["http:", "https:"].includes(url.protocol))) {
    throw new ConfigError(`Unsupported server URL protocol "${url.protocol}".`, "server_url_invalid");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function makeTarget(input: {
  readonly rawUrl: string;
  readonly token?: string;
  readonly environmentName?: string;
  readonly credentialId?: string;
}): ResolvedTarget {
  const httpBaseUrl = normalizeHttpUrl(input.rawUrl);
  const wsUrl = new URL(httpBaseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/ws";
  // The current server accepts the bearer in the handshake. The token is also
  // sent as an Authorization header by connectClient; the query parameter is
  // retained for older T3 Code server versions.
  if (input.token) wsUrl.searchParams.set("token", input.token);
  return {
    environmentName: input.environmentName,
    httpBaseUrl,
    wsBaseUrl: wsUrl.origin,
    socketUrl: wsUrl.toString(),
    token: input.token,
    credentialId: input.credentialId,
  };
}

function selectEnvironment(options: TargetOptions) {
  const config = loadConfig();
  const explicitName = options.environment?.trim() || process.env.T3CTL_ENV?.trim();
  if (explicitName) {
    const environment = config.environments[explicitName];
    if (!environment) throw new ConfigError(`Environment "${explicitName}" is not configured.`, "environment_missing");
    return { config, environment, environmentName: explicitName };
  }
  if (options.serverUrl) return { config, environment: undefined, environmentName: undefined };
  if (config.activeEnvironment) {
    const environment = config.environments[config.activeEnvironment];
    if (!environment) throw new ConfigError(`Active environment "${config.activeEnvironment}" is not configured.`, "active_environment_missing");
    return { config, environment, environmentName: config.activeEnvironment };
  }
  return { config, environment: undefined, environmentName: undefined };
}

/** Resolve URL and explicit/environment variables without performing I/O. */
export function resolveTarget(options: TargetOptions = {}): ResolvedTarget {
  const selected = selectEnvironment(options);
  const rawUrl = options.serverUrl || selected.environment?.serverUrl || process.env.T3_SERVER_URL || "http://127.0.0.1:3000";
  const token = options.token || process.env.T3_TOKEN;
  return makeTarget({
    rawUrl,
    token,
    environmentName: selected.environmentName,
    credentialId: selected.environment?.credentialId,
  });
}

/** Resolve a target and load its secret only at the point a connection is made. */
export async function resolveTargetAsync(options: TargetOptions = {}): Promise<ResolvedTarget> {
  const selected = selectEnvironment(options);
  const rawUrl = options.serverUrl || selected.environment?.serverUrl || process.env.T3_SERVER_URL || "http://127.0.0.1:3000";
  let token = options.token || process.env.T3_TOKEN;
  if (!token && selected.environment?.credentialId) {
    const credentials = await createCredentialStore({ backend: selected.environment.credentialBackend ?? "auto" });
    token = await credentials.get(selected.environment.credentialId);
    if (!token) {
      throw new ConfigError(
        `No credential is available for environment "${selected.environmentName}". Run "t3ctl auth pair" or "t3ctl auth local".`,
        "credential_missing",
      );
    }
  }
  return makeTarget({
    rawUrl,
    token,
    environmentName: selected.environmentName,
    credentialId: selected.environment?.credentialId,
  });
}

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

export const connectClient = Effect.fnUntraced(function* (socketUrl: string, token?: string) {
  const wsConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (url: string, protocols?: string | string[]) =>
      new WebSocket(url, protocols, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }) as any,
  );

  const socketLayer = Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" }).pipe(
    Layer.provide(wsConstructorLayer),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
  ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
  const protocolContext = yield* Layer.build(protocolLayer);
  return yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
});

export function generateId(prefix = "cmd"): string {
  const randomHex = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${randomHex}`;
}

export function errorMessage(error: unknown): string {
  const sanitize = (value: string) => value
    .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+|DPoP\s+)[^\s]+/gi, "$1[redacted]");
  if (error instanceof Error) return sanitize(error.message);
  if (typeof error === "string") return sanitize(error);
  const candidate = error as { message?: unknown; issue?: { message?: unknown } } | null;
  if (typeof candidate?.message === "string") return sanitize(candidate.message);
  if (typeof candidate?.issue?.message === "string") return sanitize(candidate.issue.message);
  return "The T3 Code server returned an unknown error.";
}
