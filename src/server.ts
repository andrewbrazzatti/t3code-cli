/**
 * Server diagnostics: tracing, process inspection, host and resource telemetry,
 * and background-policy state.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";
import { parseDurationMs } from "./schedule.js";

function windowBucket(options: { readonly window?: string; readonly bucket?: string }): { windowMs: number; bucketMs: number } {
  if (!options.window?.trim()) throw new ConfigError("--window DURATION is required (e.g. 1h).", "cli_parse_failed");
  if (!options.bucket?.trim()) throw new ConfigError("--bucket DURATION is required (e.g. 1m).", "cli_parse_failed");
  return { windowMs: parseDurationMs(options.window.trim()), bucketMs: parseDurationMs(options.bucket.trim()) };
}

export async function serverProbe(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverProbe]({});
  }));
  sink.write({ reachable: true, ...(result as object) });
  return result;
}

export async function serverTrace(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetTraceDiagnostics]({});
  }));
  sink.write(result);
  return result;
}

export async function serverProcesses(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetProcessDiagnostics]({});
  }));
  sink.write(result);
  return result;
}

export async function serverProcessHistory(options: CommandContext & { readonly window?: string; readonly bucket?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const { windowMs, bucketMs } = windowBucket(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetProcessResourceHistory]({ windowMs, bucketMs });
  }));
  sink.write(result);
  return result;
}

export async function serverHostResources(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetHostResources]({});
  }));
  sink.write(result);
  return result;
}

export async function serverResourceHistory(options: CommandContext & { readonly window?: string; readonly bucket?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const { windowMs, bucketMs } = windowBucket(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetResourceTelemetryHistory]({ windowMs, bucketMs });
  }));
  sink.write(result);
  return result;
}

export async function serverRetryTelemetry(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverRetryResourceTelemetry]({});
  }));
  sink.write(result);
  return result;
}

export async function serverSignal(options: CommandContext & { readonly pid: string; readonly startTime?: string; readonly signal: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const pid = Number(options.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new ConfigError("--pid must be a positive integer.", "cli_parse_failed");
  const startTimeMs = options.startTime ? Number(options.startTime) : 0;
  if (!Number.isInteger(startTimeMs) || startTimeMs < 0) throw new ConfigError("--start-time must be a non-negative integer.", "cli_parse_failed");
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverSignalProcess]({ pid, startTimeMs, signal: options.signal });
  }));
  sink.write(result);
  return result;
}

export async function serverBackgroundPolicy(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetBackgroundPolicy]({});
  }));
  sink.write(result);
  return result;
}
