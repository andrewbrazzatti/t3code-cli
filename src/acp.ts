/**
 * The Agent Client Protocol registry: search and prepare registry agents, and
 * manage the providers and sessions an ACP provider instance knows about.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

export async function acpSearch(options: CommandContext & { readonly query: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverSearchAcpRegistry]({ query: options.query });
  }));
  sink.write(result);
  return result;
}

export async function acpPrepare(options: CommandContext & { readonly agentId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverPrepareAcpRegistryAgent]({ agentId: options.agentId });
  }));
  sink.write(result);
  return result;
}

export async function acpUninstall(options: CommandContext & { readonly agentId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverUninstallAcpRegistryManagedBinary]({ agentId: options.agentId });
  }));
  sink.write(result);
  return result;
}

export async function acpLogout(options: CommandContext & { readonly instanceId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverLogoutAcpRegistry]({ instanceId: options.instanceId });
  }));
  sink.write(result);
  return result;
}

export async function acpAcceptUrlAuth(options: CommandContext & { readonly instanceId: string; readonly elicitationId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverAcceptAcpRegistryUrlAuth]({ instanceId: options.instanceId, elicitationId: options.elicitationId });
  }));
  sink.write(result);
  return result;
}

export async function acpSessions(options: CommandContext & { readonly instanceId: string; readonly projectId: string; readonly cursor?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverListAcpRegistrySessions]({
      instanceId: options.instanceId,
      projectId: options.projectId,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function acpImportSession(options: CommandContext & {
  readonly instanceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly title?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverImportAcpRegistrySession]({
      instanceId: options.instanceId,
      projectId: options.projectId,
      sessionId: options.sessionId,
      ...(options.title ? { title: options.title } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function acpDeleteSession(options: CommandContext & { readonly instanceId: string; readonly projectId: string; readonly sessionId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverDeleteAcpRegistrySession]({
      instanceId: options.instanceId,
      projectId: options.projectId,
      sessionId: options.sessionId,
    });
  }));
  sink.write(result);
  return result;
}

export async function acpProviders(options: CommandContext & { readonly instanceId: string; readonly projectId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverListAcpRegistryProviders]({ instanceId: options.instanceId, projectId: options.projectId });
  }));
  sink.write(result);
  return result;
}

function parseHeaders(pairs?: ReadonlyArray<string>): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) throw new ConfigError(`--header expects KEY=VALUE, got "${pair}".`, "cli_parse_failed");
    headers[pair.slice(0, equals).trim()] = pair.slice(equals + 1);
  }
  return headers;
}

export async function acpSetProvider(options: CommandContext & {
  readonly instanceId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly apiType: string;
  readonly baseUrl: string;
  readonly headers?: ReadonlyArray<string>;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const headers = parseHeaders(options.headers);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverSetAcpRegistryProvider]({
      instanceId: options.instanceId,
      projectId: options.projectId,
      providerId: options.providerId,
      apiType: options.apiType,
      baseUrl: options.baseUrl,
      ...(headers ? { headers } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function acpDisableProvider(options: CommandContext & { readonly instanceId: string; readonly projectId: string; readonly providerId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverDisableAcpRegistryProvider]({
      instanceId: options.instanceId,
      projectId: options.projectId,
      providerId: options.providerId,
    });
  }));
  sink.write(result);
  return result;
}
