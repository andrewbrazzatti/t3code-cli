/**
 * Diffs: a thread's turn-range or full-history diff, and a working-tree or
 * branch-range review diff for a project's checkout.
 */

import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as path from "node:path";

import { commandContext, resolveProject, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

function integer(value: string | undefined, flagName: string): number {
  if (value === undefined) throw new ConfigError(`${flagName} is required.`, "cli_parse_failed");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ConfigError(`${flagName} must be a non-negative integer.`, "cli_parse_failed");
  return parsed;
}

export async function diffTurn(options: CommandContext & {
  readonly threadId: string;
  readonly from?: string;
  readonly to?: string;
  readonly ignoreWhitespace?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const fromTurnCount = integer(options.from, "--from");
  const toTurnCount = integer(options.to, "--to");
  if (fromTurnCount > toTurnCount) throw new ConfigError("--from must be less than or equal to --to.", "cli_parse_failed");
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
      threadId: options.threadId,
      fromTurnCount,
      toTurnCount,
      ...(options.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function diffThread(options: CommandContext & {
  readonly threadId: string;
  readonly to?: string;
  readonly ignoreWhitespace?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const toTurnCount = integer(options.to, "--to");
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]({
      threadId: options.threadId,
      toTurnCount,
      ...(options.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    });
  }));
  sink.write(result);
  return result;
}

async function resolveCwd(options: CommandContext & { readonly projectId?: string; readonly cwd?: string }): Promise<string> {
  if (options.cwd?.trim()) return path.resolve(options.cwd.trim());
  if (options.projectId) {
    const project = await resolveProject(options, options.projectId);
    return project.workspaceRoot;
  }
  throw new ConfigError("Provide --project ID or --cwd PATH.", "cli_parse_failed");
}

export async function diffReview(options: CommandContext & {
  readonly projectId?: string;
  readonly cwd?: string;
  readonly baseRef?: string;
  readonly ignoreWhitespace?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const cwd = await resolveCwd(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.reviewGetDiffPreview]({
      cwd,
      ...(options.baseRef ? { baseRef: options.baseRef } : {}),
      ...(options.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    });
  }));
  sink.write(result);
  return result;
}
