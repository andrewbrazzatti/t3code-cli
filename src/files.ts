/**
 * Project file operations: list, read, write, and search inside a project's
 * workspace. The server resolves paths against the workspace root, so the CLI
 * works with workspace-relative paths (or absolute host paths for reads).
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { commandContext, resolveProject, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

interface FileTarget {
  readonly projectId?: string;
  readonly cwd?: string;
}

async function resolveCwd(options: CommandContext & FileTarget): Promise<string> {
  if (options.cwd?.trim()) return path.resolve(options.cwd.trim());
  if (options.projectId) {
    const project = await resolveProject(options, options.projectId);
    return project.workspaceRoot;
  }
  throw new ConfigError("Provide --project ID or --cwd PATH.", "cli_parse_failed");
}

export async function fileList(options: CommandContext & FileTarget & { readonly directory?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const cwd = await resolveCwd(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.projectsListEntries]({
      cwd,
      ...(options.directory ? { directoryPath: options.directory } : {}),
    });
  }));
  sink.write(result);
  return result;
}

export async function fileRead(options: CommandContext & FileTarget & { readonly relativePath: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const cwd = await resolveCwd(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.projectsReadFile]({ cwd, relativePath: options.relativePath });
  }));
  sink.write(result);
  return result;
}

export async function fileWrite(options: CommandContext & FileTarget & {
  readonly relativePath: string;
  readonly contents?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const cwd = await resolveCwd(options);
  let contents = options.contents;
  if (contents === undefined) {
    contents = await new Promise<string>((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });
  }
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.projectsWriteFile]({ cwd, relativePath: options.relativePath, contents });
  }));
  sink.write({ ...(result as object), written: true });
  return result;
}

export async function fileSearch(options: CommandContext & FileTarget & {
  readonly query: string;
  readonly limit?: string;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly regex?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const cwd = await resolveCwd(options);
  const limit = options.limit ? Number(options.limit) : 100;
  if (!Number.isInteger(limit) || limit < 1) throw new ConfigError("--limit must be a positive integer.", "cli_parse_failed");
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.projectsSearchContents]({
      cwd,
      query: options.query,
      limit,
      caseSensitive: Boolean(options.caseSensitive),
      wholeWord: Boolean(options.wholeWord),
      useRegex: Boolean(options.regex),
    });
  }));
  sink.write(result);
  return result;
}

export async function fileFind(options: CommandContext & FileTarget & {
  readonly query?: string;
  readonly limit?: string;
  readonly kind?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const cwd = await resolveCwd(options);
  const limit = options.limit ? Number(options.limit) : 100;
  if (!Number.isInteger(limit) || limit < 1) throw new ConfigError("--limit must be a positive integer.", "cli_parse_failed");
  if (options.kind && !["file", "directory"].includes(options.kind)) {
    throw new ConfigError('--kind must be "file" or "directory".', "cli_parse_failed");
  }
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.projectsSearchEntries]({
      cwd,
      query: options.query ?? "",
      limit,
      ...(options.kind ? { kind: options.kind } : {}),
    });
  }));
  sink.write(result);
  return result;
}
