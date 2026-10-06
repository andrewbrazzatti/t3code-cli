/**
 * Provider authentication and install flows. These are the non-interactive
 * steps of provider setup: start/cancel/logout for auth and
 * start/cancel/remove for managed binaries. Interactive prompts are driven by
 * the apps, not the CLI.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";

export async function providerAuthStart(options: CommandContext & { readonly instanceId: string; readonly methodId?: string; readonly returnUrl?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerAuthStart]({
      instanceId: options.instanceId,
      ...(options.methodId ? { methodId: options.methodId } : {}),
      ...(options.returnUrl ? { returnUrl: options.returnUrl } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function providerAuthComplete(options: CommandContext & { readonly instanceId: string; readonly flowId: string; readonly callbackUrl: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerAuthComplete]({
      instanceId: options.instanceId,
      flowId: options.flowId,
      callbackUrl: options.callbackUrl,
    });
  }));
  sink.write(result);
  return result;
}

export async function providerAuthCancel(options: CommandContext & { readonly instanceId: string; readonly flowId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerAuthCancel]({ instanceId: options.instanceId, flowId: options.flowId });
  }));
  sink.write(result);
  return result;
}

export async function providerAuthLogout(options: CommandContext & { readonly instanceId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerAuthLogout]({ instanceId: options.instanceId });
  }));
  sink.write(result);
  return result;
}

export async function providerInstallStart(options: CommandContext & { readonly instanceId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerInstallStart]({ instanceId: options.instanceId });
  }));
  sink.write(result);
  return result;
}

export async function providerInstallCancel(options: CommandContext & { readonly instanceId: string; readonly operationId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerInstallCancel]({ instanceId: options.instanceId, operationId: options.operationId });
  }));
  sink.write(result);
  return result;
}

export async function providerInstallRemove(options: CommandContext & { readonly instanceId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerInstallRemove]({ instanceId: options.instanceId });
  }));
  sink.write(result);
  return result;
}
