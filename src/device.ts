/**
 * Device panel control: iOS simulators and Android emulators on this host or
 * on SSH device hosts. Devices are thread-scoped: opening one attaches it to a
 * thread so the agent and the CLI share the same session.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

function platform(value: string | undefined): "ios" | "android" {
  if (value !== "ios" && value !== "android") {
    throw new ConfigError('--platform must be "ios" or "android".', "cli_parse_failed");
  }
  return value;
}

function parseJson(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ConfigError(`${label} must be a JSON object.`, "cli_parse_failed");
  }
}

export async function deviceList(options: CommandContext & {
  readonly updateTool?: string;
  readonly inspectOnly?: boolean;
  readonly retryHostId?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  if (options.updateTool && !["hub", "agent"].includes(options.updateTool)) {
    throw new ConfigError('--update-tool must be "hub" or "agent".', "cli_parse_failed");
  }
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.deviceList]({
      ...(options.updateTool ? { updateTool: options.updateTool } : {}),
      ...(options.inspectOnly ? { inspectOnly: true } : {}),
      ...(options.retryHostId ? { retryHostId: options.retryHostId } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function deviceOpen(options: CommandContext & {
  readonly threadId: string;
  readonly deviceId: string;
  readonly platform?: string;
  readonly hostId?: string;
  readonly boot?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.deviceOpen]({
      threadId: options.threadId,
      deviceId: options.deviceId,
      platform: platform(options.platform),
      ...(options.hostId ? { hostId: options.hostId } : {}),
      ...(options.boot === false ? { boot: false } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function deviceClose(options: CommandContext & {
  readonly threadId: string;
  readonly deviceId?: string;
  readonly hostId?: string;
  readonly shutdown?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.deviceClose]({
      threadId: options.threadId,
      ...(options.deviceId ? { deviceId: options.deviceId } : {}),
      ...(options.hostId ? { hostId: options.hostId } : {}),
      ...(options.shutdown ? { shutdown: true } : {}),
    });
  }));
  const result = { threadId: options.threadId, closed: true };
  sink.write(result);
  return result;
}

export async function deviceShutdown(options: CommandContext & {
  readonly deviceId: string;
  readonly platform?: string;
  readonly hostId?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.deviceShutdown]({
      deviceId: options.deviceId,
      platform: platform(options.platform),
      ...(options.hostId ? { hostId: options.hostId } : {}),
    });
  }));
  const result = { deviceId: options.deviceId, shutdown: true };
  sink.write(result);
  return result;
}

export async function deviceDetail(options: CommandContext & { readonly deviceId: string; readonly hostId?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.deviceDetail]({
      deviceId: options.deviceId,
      ...(options.hostId ? { hostId: options.hostId } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function deviceConfigure(options: CommandContext & {
  readonly enabled?: boolean;
  readonly agentAccessEnabled?: boolean;
  readonly onboardingCompleted?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  if (options.enabled === undefined && options.agentAccessEnabled === undefined && options.onboardingCompleted === undefined) {
    throw new ConfigError("device configure requires --enable/--disable, --agent-access/--no-agent-access, or --onboarding-complete.", "cli_parse_failed");
  }
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.deviceConfigure]({
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.agentAccessEnabled !== undefined ? { agentAccessEnabled: options.agentAccessEnabled } : {}),
      ...(options.onboardingCompleted !== undefined ? { onboardingCompleted: options.onboardingCompleted } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function deviceTestHost(options: CommandContext & {
  readonly hostId: string;
  readonly label?: string;
  readonly target?: string;
  readonly identityFile?: string;
  readonly port?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  if (!options.target?.trim()) throw new ConfigError("device test-host requires --target user@host.", "cli_parse_failed");
  const port = options.port ? Number(options.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new ConfigError("--port must be an integer between 1 and 65535.", "cli_parse_failed");
  }
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.deviceTestHost]({
      id: options.hostId,
      label: options.label?.trim() || options.hostId,
      target: options.target!.trim(),
      ...(options.identityFile ? { identityFile: options.identityFile } : {}),
      ...(port !== undefined ? { port } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function deviceAction(options: CommandContext & { readonly json: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const payload = parseJson(options.json, "--json");
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.deviceAction](payload);
  }));
  sink.write(result);
  return result;
}
