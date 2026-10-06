/**
 * Usage and subscription quota reporting.
 *
 * `server.getUsageSummary` aggregates token/cost buckets scanned from provider
 * session files; `server.getConfig` carries each provider's live subscription
 * windows (with reset times) and any banked reset credits, which
 * `provider.consumeResetCredit` can redeem.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultWindow(): { sinceDay: string; untilDay: string } {
  const until = new Date();
  const since = new Date(until.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { sinceDay: isoDay(since), untilDay: isoDay(until) };
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export async function getUsage(options: CommandContext & {
  readonly since?: string;
  readonly until?: string;
  readonly timezone?: string;
  readonly hourly?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const fallback = defaultWindow();
  const sinceDay = options.since?.trim() || fallback.sinceDay;
  const untilDay = options.until?.trim() || fallback.untilDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDay) || !/^\d{4}-\d{2}-\d{2}$/.test(untilDay)) {
    throw new ConfigError("--since and --until must be YYYY-MM-DD dates.", "cli_parse_failed");
  }
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetUsageSummary]({
      sinceDay,
      untilDay,
      timeZone: options.timezone?.trim() || localTimeZone(),
      ...(options.hourly ? { resolution: "hour" } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function refreshUsageRates(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverRefreshUsageRates]({});
  }));
  sink.write(result);
  return result;
}

async function loadProviders(options: CommandContext): Promise<any[]> {
  const config: any = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetConfig]({});
  }));
  return config?.providers ?? [];
}

function matchesProvider(provider: any, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return [provider.instanceId, provider.driver, provider.displayName]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase() === needle || value.toLowerCase().includes(needle));
}

export async function listProviderLimits(options: CommandContext & { readonly provider?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const providers = await loadProviders(options);
  const selected = options.provider?.trim()
    ? providers.filter((provider) => matchesProvider(provider, options.provider!))
    : providers;
  const withLimits = selected
    .filter((provider) => provider.usageLimits)
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName,
      usageLimits: provider.usageLimits,
    }));
  const result = { providers: withLimits };
  sink.write(result);
  return result;
}

export async function consumeResetCredit(options: CommandContext & { readonly provider: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const providers = await loadProviders(options);
  const matches = providers.filter((provider) => matchesProvider(provider, options.provider));
  if (matches.length === 0) {
    throw new ConfigError(`No configured provider matches "${options.provider}".`, "provider_missing");
  }
  if (matches.length > 1) {
    throw new ConfigError(`Provider "${options.provider}" is ambiguous; it matches ${matches.length} instances.`, "provider_ambiguous");
  }
  const instanceId = matches[0].instanceId;
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.providerConsumeResetCredit]({ instanceId });
  }));
  sink.write({ instanceId, ...(result as object) });
  return result;
}
