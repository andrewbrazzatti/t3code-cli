/**
 * In-app preview tabs. Preview sessions are thread-scoped browser tabs; the CLI
 * can open, navigate, resize, refresh, and close them, and list what a thread
 * has open.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

function viewport(options: { readonly width?: string; readonly height?: string }): Record<string, unknown> {
  const hasWidth = Boolean(options.width?.trim());
  const hasHeight = Boolean(options.height?.trim());
  if (!hasWidth && !hasHeight) return { _tag: "fill" };
  const width = Number(options.width);
  const height = Number(options.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new ConfigError("--width and --height must both be positive integers.", "cli_parse_failed");
  }
  return { _tag: "freeform", width, height };
}

export async function previewList(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.previewList]({ threadId: options.threadId });
  }));
  sink.write(result);
  return result;
}

export async function previewOpen(options: CommandContext & {
  readonly threadId: string;
  readonly url?: string;
  readonly width?: string;
  readonly height?: string;
  readonly profileId?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.previewOpen]({
      threadId: options.threadId,
      ...(options.url ? { url: options.url } : {}),
      ...(options.width || options.height ? { viewport: viewport(options) } : {}),
      ...(options.profileId ? { profileId: options.profileId } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function previewNavigate(options: CommandContext & { readonly threadId: string; readonly tabId: string; readonly url: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.previewNavigate]({ threadId: options.threadId, tabId: options.tabId, url: options.url });
  }));
  sink.write(result);
  return result;
}

export async function previewResize(options: CommandContext & { readonly threadId: string; readonly tabId: string; readonly width?: string; readonly height?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.previewResize]({ threadId: options.threadId, tabId: options.tabId, viewport: viewport(options) });
  }));
  sink.write(result);
  return result;
}

export async function previewRefresh(options: CommandContext & { readonly threadId: string; readonly tabId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.previewRefresh]({ threadId: options.threadId, tabId: options.tabId });
  }));
  const result = { threadId: options.threadId, tabId: options.tabId, refreshed: true };
  sink.write(result);
  return result;
}

export async function previewClose(options: CommandContext & { readonly threadId: string; readonly tabId?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.previewClose]({ threadId: options.threadId, ...(options.tabId ? { tabId: options.tabId } : {}) });
  }));
  const result = { threadId: options.threadId, closed: true };
  sink.write(result);
  return result;
}
