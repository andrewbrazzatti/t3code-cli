/**
 * Pull requests: list, inspect, and act on change requests across the
 * projects' GitHub/GitLab repositories.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

interface PrTarget {
  readonly projectId?: string;
  readonly repository?: string;
  readonly number?: string;
  readonly host?: string;
  readonly reference?: string;
}

/** Resolve `owner/name#123`, a pull-request URL, or --repository/--number. */
function resolvePrRef(options: CommandContext & PrTarget): { projectId: string; repository: string; number: number; host?: string } {
  if (!options.projectId) throw new ConfigError("Provide --project ID.", "cli_parse_failed");
  let repository = options.repository?.trim();
  let number = options.number?.trim() ? Number(options.number.trim()) : undefined;

  const reference = options.reference?.trim();
  if (reference) {
    const hash = reference.match(/^([^#\s]+\/[^#\s]+)#(\d+)$/);
    const url = reference.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (hash) {
      repository = repository ?? hash[1];
      number = number ?? Number(hash[2]);
    } else if (url) {
      repository = repository ?? url[1];
      number = number ?? Number(url[2]);
    } else {
      throw new ConfigError(`Could not parse "${reference}". Use owner/name#123 or a pull-request URL.`, "cli_parse_failed");
    }
  }

  if (!repository) throw new ConfigError("Provide --repository owner/name (or a PR reference).", "cli_parse_failed");
  if (number === undefined || !Number.isInteger(number) || number < 1) {
    throw new ConfigError("Provide --number N (or a PR reference).", "cli_parse_failed");
  }
  return { projectId: options.projectId, repository, number, ...(options.host ? { host: options.host } : {}) };
}

export async function prList(options: CommandContext & {
  readonly state?: string;
  readonly involvement?: string;
  readonly projectId?: string;
  readonly host?: string;
  readonly limit?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const state = options.state?.trim() || "open";
  if (!["all", "open", "closed", "merged"].includes(state)) {
    throw new ConfigError('--state must be one of all, open, closed, merged.', "cli_parse_failed");
  }
  const involvement = options.involvement?.trim();
  if (involvement && !["all", "reviewing", "authored"].includes(involvement)) {
    throw new ConfigError('--involvement must be one of all, reviewing, authored.', "cli_parse_failed");
  }
  const limit = options.limit ? Number(options.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    throw new ConfigError("--limit must be an integer between 1 and 500.", "cli_parse_failed");
  }
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.pullRequestsList]({
      state,
      ...(involvement ? { involvement } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function prDetail(options: CommandContext & PrTarget): Promise<unknown> {
  const { sink } = commandContext(options);
  const ref = resolvePrRef(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.pullRequestsDetail](ref);
  }));
  sink.write(result);
  return result;
}

export async function prChecks(options: CommandContext & PrTarget): Promise<unknown> {
  const { sink } = commandContext(options);
  const ref = resolvePrRef(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.pullRequestsChecks](ref);
  }));
  sink.write(result);
  return result;
}

export async function prStack(options: CommandContext & PrTarget): Promise<unknown> {
  const { sink } = commandContext(options);
  const ref = resolvePrRef(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.pullRequestsStack](ref);
  }));
  sink.write(result);
  return result;
}

export async function prLinkedThreads(options: CommandContext & PrTarget): Promise<unknown> {
  const { sink } = commandContext(options);
  const ref = resolvePrRef(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.pullRequestsLinkedThreads](ref);
  }));
  sink.write(result);
  return result;
}

export async function prComment(options: CommandContext & PrTarget & { readonly body: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const ref = resolvePrRef(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.pullRequestsComment]({ ...ref, body: options.body });
  }));
  const result = { ...ref, commented: true };
  sink.write(result);
  return result;
}

export async function prReview(options: CommandContext & PrTarget & { readonly verdict: string; readonly body?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const ref = resolvePrRef(options);
  const verdict = options.verdict?.trim();
  if (!verdict || !["comment", "approve", "request-changes"].includes(verdict)) {
    throw new ConfigError("--verdict must be one of comment, approve, request-changes.", "cli_parse_failed");
  }
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.pullRequestsSubmitReview]({ ...ref, verdict, body: options.body ?? "", comments: [] });
  }));
  const result = { ...ref, reviewed: true, verdict };
  sink.write(result);
  return result;
}

export async function prUpdate(options: CommandContext & PrTarget & { readonly title?: string; readonly body?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const ref = resolvePrRef(options);
  if (options.title === undefined && options.body === undefined) {
    throw new ConfigError("pr update requires --title and/or --body.", "cli_parse_failed");
  }
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.pullRequestsUpdate]({
      ...ref,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
  }));
  const result = { ...ref, updated: true };
  sink.write(result);
  return result;
}
