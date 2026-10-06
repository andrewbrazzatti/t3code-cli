import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ConfigError, loadConfig } from "./config.js";
import { connectClient, errorMessage, generateId, resolveTargetAsync, type TargetOptions } from "./connection.js";
import { createOutputSink, type OutputSink, type OutputFormat, structuredError } from "./output.js";

export interface CommandContext extends TargetOptions {
  readonly format: OutputFormat;
  readonly stream?: boolean;
  readonly sink?: OutputSink;
  readonly silent?: boolean;
  readonly since?: string;
}

type Client = any;

export async function withClient(options: TargetOptions, use: (client: Client, target: Awaited<ReturnType<typeof resolveTargetAsync>>) => any): Promise<any> {
  const target = await resolveTargetAsync(options);
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = yield* connectClient(target.socketUrl, target.token);
    return yield* use(client, target);
  })) as any) as Promise<any>;
}

export function commandContext(options: CommandContext, stream = false): { sink: OutputSink; options: TargetOptions } {
  return {
    sink: options.sink ?? createOutputSink(options.format, { stream, stdoutIsTTY: process.stdout.isTTY }),
    options,
  };
}

function command(commandType: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: commandType, commandId: generateId("cmd"), ...fields };
}

/**
 * Orchestration V2 commands that create threads or dispatch messages require
 * actor/creation-source provenance. The CLI acts as a programmatic client.
 */
const CREATION = { createdBy: "user", creationSource: "mcp" } as const;

/** Run statuses that mean the run has not reached a terminal state yet. */
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function projectMatches(project: any, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return [project.id, project.title, project.workspaceRoot, path.basename(project.workspaceRoot || "")]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase() === needle || value.toLowerCase().includes(needle));
}

export async function loadShell(options: TargetOptions): Promise<{ projects: any[]; threads: any[] }> {
  return withClient(options, (client) => Effect.gen(function* () {
    let live: any;
    const liveStream = client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({});
    yield* liveStream.pipe(Stream.runForEachWhile((item: any) => Effect.sync(() => {
      if (item?.kind === "snapshot") live = item.snapshot;
      return live === undefined;
    })));
    const archived = yield* client[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
    const merge = (values: any[]) => {
      const byId = new Map<string, any>();
      for (const value of values) if (value?.id) byId.set(String(value.id), value);
      return [...byId.values()];
    };
    return {
      projects: merge([...(live?.projects ?? []), ...(archived?.projects ?? [])]),
      threads: merge([
        ...(live?.threads ?? []),
        ...(live?.archivedThreads ?? []),
        ...(archived?.threads ?? []),
      ]),
    };
  }));
}

async function loadThread(options: TargetOptions, threadId: string): Promise<any> {
  return withClient(options, (client) => Effect.gen(function* () {
    const projection: any = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
    if (!projection?.thread) throw new ConfigError(`Thread "${threadId}" was not found.`, "thread_missing");
    return {
      ...projection.thread,
      messages: projection.messages ?? [],
      activities: projection.visibleTurnItems ?? projection.turnItems ?? [],
      runs: projection.runs ?? [],
      runtimeRequests: projection.runtimeRequests ?? [],
    };
  })).catch((error: unknown) => {
    throw describeSchemaMismatch(error) ?? error;
  });
}

/**
 * Resolve a thread and derive the working directory an interactive terminal
 * should open in: the thread's worktree when present, otherwise its project's
 * workspace root. Terminals are thread-scoped on the server, so a target thread
 * is required before a shell can be opened.
 *
 * Resolves against the merged shell snapshot (active + archived) rather than
 * the active-only thread detail projection, so archived threads remain usable
 * as terminal targets.
 */
export async function resolveThreadContext(options: TargetOptions, threadId: string): Promise<{ thread: any; cwd: string; worktreePath: string | null }> {
  const shell = await loadShell(options);
  const thread = shell.threads.find((entry: any) => entry.id === threadId);
  if (!thread) {
    throw new ConfigError(`Thread "${threadId}" was not found. Run "t3ctl thread list" to see available threads.`, "thread_missing");
  }
  const worktreePath = typeof thread.worktreePath === "string" && thread.worktreePath.trim() ? thread.worktreePath : null;
  let cwd = worktreePath;
  if (!cwd && thread.projectId) {
    const project = shell.projects.find((entry: any) => entry.id === thread.projectId);
    cwd = typeof project?.workspaceRoot === "string" && project.workspaceRoot.trim() ? project.workspaceRoot : null;
  }
  if (!cwd) {
    throw new ConfigError(`Could not determine a working directory for thread "${threadId}". Pass --cwd to select one.`, "cwd_missing");
  }
  return { thread, cwd, worktreePath };
}

export async function listProjects(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = { projects: (await loadShell(options)).projects };
  sink.write(result);
  return result;
}

export async function addProject(options: CommandContext & { readonly workspaceRoot: string; readonly title?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const title = options.title?.trim() || path.basename(workspaceRoot) || "Untitled Project";
  const projectId = generateId("proj");
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.projectsMutate]({
      type: "project.create",
      commandId: generateId("cmd"),
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
    });
  }));
  const result = { id: projectId, projectId, title, workspaceRoot };
  sink.write(result);
  return result;
}

export async function cloneProject(options: CommandContext & {
  readonly repositoryUrl: string;
  readonly destination: string;
  readonly title?: string;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const title = options.title?.trim() || path.basename(options.repositoryUrl, ".git") || "Cloned project";
  const projectId = generateId("proj");
  const cloned = await withClient(options, (client) => Effect.gen(function* () {
    const result = yield* client[WS_METHODS.sourceControlCloneRepository]({
      remoteUrl: options.repositoryUrl,
      destinationPath: options.destination,
    });
    const workspaceRoot = result?.cwd || options.destination;
    yield* client[WS_METHODS.projectsMutate]({
      type: "project.create",
      commandId: generateId("cmd"),
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
    });
    return { workspaceRoot };
  }));
  const output = { id: projectId, projectId, title, workspaceRoot: cloned.workspaceRoot, repositoryUrl: options.repositoryUrl };
  sink.write(output);
  return output;
}

export async function deleteProject(options: CommandContext & { readonly projectId: string; readonly force?: boolean }): Promise<unknown> {
  const { sink } = commandContext(options);
  const shell = (await loadShell(options)).projects;
  const project = shell.find((entry: any) => projectMatches(entry, options.projectId));
  const projectId = project?.id || options.projectId;
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.projectsMutate]({ type: "project.delete", commandId: generateId("cmd"), projectId, force: options.force });
  }));
  const result = { projectId, deleted: true };
  sink.write(result);
  return result;
}

export async function updateProject(options: CommandContext & {
  readonly projectId: string;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const projects = (await loadShell(options)).projects;
  const project = projects.find((entry: any) => projectMatches(entry, options.projectId));
  const projectId = project?.id || options.projectId;
  const fields: Record<string, unknown> = {};
  if (options.title) fields.title = options.title;
  if (options.workspaceRoot) fields.workspaceRoot = path.resolve(options.workspaceRoot);
  if (options.provider || options.model || options.options?.length) fields.defaultModelSelection = resolveModel(options, project);
  if (Object.keys(fields).length === 0) throw new ConfigError("project update requires a metadata option.", "cli_parse_failed");
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.projectsMutate]({ type: "project.update", commandId: generateId("cmd"), projectId, ...fields });
  }));
  const result = { projectId, updated: true, fields };
  sink.write(result);
  return result;
}

/**
 * The server config response is decoded against the contracts schema, which
 * pins closed enums for parts of the desktop app's settings (keybinding
 * commands, for one) that this CLI never reads. When the app is newer than the
 * CLI, decoding fails and the raw Effect message is an unreadable wall of enum
 * members with no hint of what to do. Detect that shape and say what it means.
 */
export function describeSchemaMismatch(error: unknown): ConfigError | undefined {
  const message = errorMessage(error);
  const looksLikeDecodeFailure = /\bExpected\b[\s\S]*\bgot\b/.test(message) && /\bat \[/.test(message);
  if (!looksLikeDecodeFailure) return undefined;
  const unexpected = /got "([^"]+)"/.exec(message)?.[1];
  const field = /at (\[[^\n]*\])/.exec(message)?.[1];
  return new ConfigError(
    `This t3ctl is older than the T3 Code server it is talking to, so it cannot decode the server config` +
      `${unexpected ? ` (unrecognised value "${unexpected}"` : ""}${unexpected && field ? ` at ${field}` : ""}${unexpected ? ")" : ""}.\n\n` +
      `Update t3ctl to match the server, or read the provider and model IDs from ~/.t3/userdata/settings.json in the meantime.`,
    "version_mismatch",
  );
}

export async function listModels(options: CommandContext & { readonly provider?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const config = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.serverGetConfig]({});
  })).catch((error: unknown) => {
    throw describeSchemaMismatch(error) ?? error;
  });
  const providers = (config?.providers ?? []).filter((provider: any) => !options.provider || provider.instanceId === options.provider || provider.id === options.provider || provider.displayName === options.provider);
  const result = { providers };
  sink.write(result);
  return result;
}

export interface ProviderCredentialsGetOptions extends CommandContext {
  readonly provider?: string;
  readonly name?: string;
  readonly positionals?: readonly string[];
}

export interface ProviderCredentialSetOptions extends CommandContext {
  readonly provider?: string;
  readonly name?: string;
  readonly value?: string;
  readonly sensitive?: boolean;
  readonly positionals?: readonly string[];
}

export async function getProviderCredentials(options: ProviderCredentialsGetOptions): Promise<unknown> {
  const { sink } = commandContext(options);
  const pos = (options.positionals ?? []).filter((p) => p !== "get" && p !== "credentials" && p !== "credential");
  let provider = options.provider;
  let name = options.name;

  if (!provider && !name) {
    if (pos.length >= 2) {
      provider = pos[0];
      name = pos[1];
    } else if (pos.length === 1) {
      const candidate = pos[0];
      if (/^[A-Z0-9_]+$/.test(candidate) || candidate.includes("_KEY") || candidate.includes("_TOKEN") || candidate.includes("_SECRET") || candidate.includes("_PASSWORD")) {
        name = candidate;
      } else {
        provider = candidate;
      }
    }
  } else if (!name && pos.length >= 1) {
    name = pos[0];
  } else if (!provider && pos.length >= 1) {
    provider = pos[0];
  }

  const { settings, config } = await withClient(options, (client) => Effect.gen(function* () {
    const settings = yield* client[WS_METHODS.serverGetSettings]({});
    const config = yield* client[WS_METHODS.serverGetConfig]({});
    return { settings, config };
  })).catch((error: unknown) => {
    throw describeSchemaMismatch(error) ?? error;
  });

  const providerInstances = settings?.providerInstances ?? {};

  if (provider) {
    const needle = provider.toLowerCase();
    const matchedKey = Object.keys(providerInstances).find(
      (key) => key.toLowerCase() === needle || providerInstances[key]?.driver?.toLowerCase() === needle
    );
    const instance = matchedKey ? providerInstances[matchedKey] : undefined;
    const configProvider = (config?.providers ?? []).find(
      (p: any) => p.instanceId?.toLowerCase() === needle || p.driver?.toLowerCase() === needle || p.id?.toLowerCase() === needle
    );

    const targetId = matchedKey || configProvider?.instanceId || provider;
    const envVars = instance?.environment ?? [];

    if (name) {
      const targetName = name.trim();
      const match = envVars.find((e: any) => e.name.toLowerCase() === targetName.toLowerCase());
      const result = {
        provider: targetId,
        driver: instance?.driver || configProvider?.driver || targetId,
        name: targetName,
        found: Boolean(match),
        ...(match ? {
          value: match.valueRedacted ? "[redacted]" : match.value,
          sensitive: Boolean(match.sensitive),
          valueRedacted: Boolean(match.valueRedacted),
        } : {}),
      };
      sink.write(result);
      return result;
    }

    const result = {
      provider: targetId,
      driver: instance?.driver || configProvider?.driver || targetId,
      displayName: instance?.displayName || configProvider?.displayName,
      environment: envVars.map((e: any) => ({
        name: e.name,
        value: e.valueRedacted ? "[redacted]" : e.value,
        sensitive: Boolean(e.sensitive),
        valueRedacted: Boolean(e.valueRedacted),
      })),
    };
    sink.write(result);
    return result;
  }

  const allInstances: Record<string, unknown> = {};
  for (const [id, inst] of Object.entries(providerInstances) as [string, any][]) {
    allInstances[id] = {
      driver: inst.driver,
      displayName: inst.displayName,
      environment: (inst.environment ?? []).map((e: any) => ({
        name: e.name,
        value: e.valueRedacted ? "[redacted]" : e.value,
        sensitive: Boolean(e.sensitive),
        valueRedacted: Boolean(e.valueRedacted),
      })),
    };
  }

  const result = { providerInstances: allInstances };
  sink.write(result);
  return result;
}

export async function setProviderCredential(options: ProviderCredentialSetOptions): Promise<unknown> {
  const { sink } = commandContext(options);
  const pos = (options.positionals ?? []).filter((p) => p !== "set" && p !== "credentials" && p !== "credential");
  let provider = options.provider;
  let name = options.name;
  let value = options.value;

  if (!provider && !name && !value) {
    if (pos.length >= 3) {
      provider = pos[0];
      name = pos[1];
      value = pos[2];
    } else if (pos.length === 2) {
      name = pos[0];
      value = pos[1];
    }
  } else if (!name && !value && pos.length >= 2) {
    name = pos[0];
    value = pos[1];
  } else if (!value && pos.length >= 1) {
    value = pos[0];
  }

  if (!name?.trim()) {
    throw new ConfigError("Missing required credential name (--name or positional).", "credential_name_missing");
  }
  if (value === undefined) {
    throw new ConfigError("Missing required credential value (--value or positional).", "credential_value_missing");
  }

  const nameTrimmed = name.trim();
  const valueTrimmed = value.trim();
  const sensitive = options.sensitive !== false;

  const { settings, config } = await withClient(options, (client) => Effect.gen(function* () {
    const settings = yield* client[WS_METHODS.serverGetSettings]({});
    const config = yield* client[WS_METHODS.serverGetConfig]({});
    return { settings, config };
  })).catch((error: unknown) => {
    throw describeSchemaMismatch(error) ?? error;
  });

  const providerInstances = settings?.providerInstances ?? {};
  let targetInstanceId = provider;
  let targetDriver: string | undefined;

  if (targetInstanceId) {
    const needle = targetInstanceId.toLowerCase();
    const matchedKey = Object.keys(providerInstances).find(
      (key) => key.toLowerCase() === needle || providerInstances[key]?.driver?.toLowerCase() === needle
    );
    if (matchedKey) {
      targetInstanceId = matchedKey;
      targetDriver = providerInstances[matchedKey].driver;
    } else {
      const configProvider = (config?.providers ?? []).find(
        (p: any) => p.instanceId?.toLowerCase() === needle || p.driver?.toLowerCase() === needle || p.id?.toLowerCase() === needle
      );
      if (configProvider) {
        targetInstanceId = configProvider.instanceId;
        targetDriver = configProvider.driver;
      }
    }
  }

  if (!targetInstanceId) {
    const defaultSelection = settings?.textGenerationModelSelection?.instanceId || loadConfig().defaultModel?.instanceId;
    targetInstanceId = defaultSelection || "codex_personal";
  }

  const resolvedInstanceId: string = targetInstanceId!;

  if (!targetDriver) {
    targetDriver = providerInstances[resolvedInstanceId]?.driver || resolvedInstanceId;
  }

  const existingInstance = providerInstances[resolvedInstanceId] ?? {};
  const existingEnv: Array<{ name: string; value: string; sensitive?: boolean; valueRedacted?: boolean }> = existingInstance.environment ?? [];

  const updatedEnv = [...existingEnv];
  const existingIdx = updatedEnv.findIndex((e) => e.name.toLowerCase() === nameTrimmed.toLowerCase());
  const newEntry = { name: nameTrimmed, value: valueTrimmed, sensitive };

  if (existingIdx >= 0) {
    updatedEnv[existingIdx] = newEntry;
  } else {
    updatedEnv.push(newEntry);
  }

  const patch = {
    providerInstances: {
      ...providerInstances,
      [resolvedInstanceId]: {
        ...existingInstance,
        driver: targetDriver,
        environment: updatedEnv,
      },
    },
  };

  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.serverUpdateSettings]({ patch });
    yield* client[WS_METHODS.serverRefreshProviders]({ instanceId: resolvedInstanceId });
  })).catch((error: unknown) => {
    throw describeSchemaMismatch(error) ?? error;
  });

  const result = {
    provider: resolvedInstanceId,
    driver: targetDriver,
    name: nameTrimmed,
    sensitive,
    updated: true,
  };
  sink.write(result);
  return result;
}

export async function listThreads(options: CommandContext & { readonly projectId?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const shell = await loadShell(options);
  let threads = shell.threads;
  if (options.projectId) {
    const project = shell.projects.find((entry: any) => projectMatches(entry, options.projectId!));
    const id = project?.id || options.projectId;
    threads = threads.filter((thread: any) => thread.projectId === id);
  }
  const result = { threads };
  sink.write(result);
  return result;
}

interface ModelOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

export function resolveModel(options: ModelOptions, project?: any): { instanceId: string; model: string; options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> } {
  const configured = project?.defaultModelSelection ?? loadConfig().defaultModel;
  return {
    instanceId: options.provider || configured?.instanceId || "codex_personal",
    model: options.model || configured?.model || "gpt-5.6-luna",
    ...(options.options && options.options.length > 0 ? { options: options.options } : {}),
  };
}

export async function resolveProject(options: TargetOptions, query: string): Promise<any> {
  const projects = (await loadShell(options)).projects;
  const project = projects.find((entry: any) => projectMatches(entry, query));
  if (!project) throw new ConfigError(`Project "${query}" was not found.`, "project_missing");
  return project;
}

export interface WorktreeSettings {
  /** Create a fresh server-managed git worktree for the thread. */
  readonly worktree?: boolean;
  /** Attach an existing directory on the server as the thread's worktree instead of creating one. */
  readonly worktreePath?: string;
  /** Ref a fresh worktree branches from (default: the repository's default branch). */
  readonly baseBranch?: string;
  /** Branch to create inside the worktree (default: a temporary t3code/<hex> branch). */
  readonly branch?: string;
  /** Base a fresh worktree on origin/<base-branch> instead of the local checkout (thread start only). */
  readonly fromOrigin?: boolean;
}

/**
 * Reject impossible worktree flag combinations before any network traffic:
 * --worktree creates a fresh worktree while --worktree-path attaches an
 * existing directory, and --base-branch/--from-origin only mean something when
 * a worktree is actually being created.
 */
export function validateWorktreeSettings(options: WorktreeSettings): void {
  const hasPath = Boolean(options.worktreePath?.trim());
  if (options.worktree && hasPath) {
    throw new ConfigError(
      "--worktree and --worktree-path are mutually exclusive: use --worktree to create a fresh worktree, or --worktree-path to reuse an existing directory.",
      "cli_parse_failed",
    );
  }
  if (!hasPath && options.branch?.trim() && !options.worktree) {
    throw new ConfigError("--branch requires --worktree or --worktree-path.", "cli_parse_failed");
  }
  if (!options.worktree) {
    for (const [name, value] of [["--base-branch", options.baseBranch?.trim()], ["--from-origin", options.fromOrigin]] as const) {
      if (value !== undefined && value !== false) {
        throw new ConfigError(`${name} requires --worktree.`, "cli_parse_failed");
      }
    }
  }
}

/**
 * Temporary worktree branch names follow the apps' canonical `t3code/<8 hex>`
 * shape so cleanup tooling recognises them.
 */
function temporaryWorktreeBranch(): string {
  return `t3code/${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Pick the ref a fresh worktree branches from: an explicit --base-branch, else
 * the repository's default local branch as reported by the server, else
 * whatever the main checkout currently has checked out.
 */
async function resolveWorktreeBaseBranch(options: TargetOptions & WorktreeSettings, workspaceRoot: string): Promise<string> {
  const requested = options.baseBranch?.trim();
  if (requested) return requested;
  return withClient(options, (client) => Effect.gen(function* () {
    const refs: any = yield* client[WS_METHODS.vcsListRefs]({ cwd: workspaceRoot, refKind: "local", limit: 200 }).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const defaultRef = Array.isArray(refs?.refs)
      ? refs.refs.find((ref: any) => ref.isDefault && !ref.isRemote)?.name
      : undefined;
    if (typeof defaultRef === "string" && defaultRef.trim()) return defaultRef.trim();
    const status: any = yield* client[WS_METHODS.vcsRefreshStatus]({ cwd: workspaceRoot }).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const current = typeof status?.refName === "string" ? status.refName.trim() : "";
    if (current) return current;
    throw new ConfigError(
      `Could not determine which ref the new worktree in "${workspaceRoot}" should branch from. Pass --base-branch explicitly.`,
      "cli_parse_failed",
    );
  }));
}

/** Translate CLI worktree flags into the V2 launch workspace strategy. */
export async function buildWorkspaceStrategy(options: TargetOptions & WorktreeSettings, workspaceRoot: string): Promise<Record<string, unknown>> {
  const branch = options.branch?.trim();
  if (options.worktreePath?.trim()) {
    return { type: "existing_worktree", worktreePath: options.worktreePath.trim(), ...(branch ? { branch } : {}) };
  }
  if (options.worktree) {
    const baseRef = await resolveWorktreeBaseBranch(options, workspaceRoot);
    return {
      type: "worktree",
      baseRef,
      ...(branch ? { branch } : {}),
      ...(options.fromOrigin ? { startFromOrigin: true } : {}),
    };
  }
  return { type: "root" };
}

export async function createThread(options: CommandContext & {
  readonly projectId: string;
  readonly title: string;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  readonly silent?: boolean;
} & WorktreeSettings): Promise<unknown> {
  const { sink } = commandContext(options);
  validateWorktreeSettings(options);
  const project = await resolveProject(options, options.projectId);
  const modelSelection = resolveModel(options, project);
  const workspaceStrategy = await buildWorkspaceStrategy(options, project.workspaceRoot);
  const launched: any = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: generateId("cmd"),
      ...CREATION,
      projectId: project.id,
      title: options.title,
      modelSelection,
      runtimeMode: options.runtimeMode || "full-access",
      interactionMode: options.interactionMode || "default",
      workspaceStrategy,
    });
  }));
  const thread = launched?.projection?.thread ?? {};
  const result = {
    id: launched?.threadId,
    threadId: launched?.threadId,
    projectId: project.id,
    title: options.title,
    modelSelection,
    ...(thread.worktreePath ? { worktreePath: thread.worktreePath, branch: thread.branch } : {}),
  };
  if (!options.silent) sink.write(result);
  return result;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".bmp": return "image/bmp";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".html": return "text/html";
    case ".zip": return "application/zip";
    case ".tar": return "application/x-tar";
    case ".gz": return "application/gzip";
    default: return "application/octet-stream";
  }
}

/**
 * Upload each path through the V2 attachment flow: mint a signed upload URL
 * over the RPC channel, POST the bytes to it, then reference the persisted
 * attachment by id on the message. V2 commands no longer accept inline data
 * URLs, so images and files both go through the same two steps.
 */
const uploadAttachments = (
  client: any,
  target: { readonly httpBaseUrl: string; readonly token?: string },
  paths?: ReadonlyArray<string>,
) => Effect.gen(function* () {
  if (!paths || paths.length === 0) return [] as Array<Record<string, unknown>>;
  const attachments: Array<Record<string, unknown>> = [];
  for (const item of paths) {
    const fullPath = path.resolve(item);
    const stats = yield* Effect.tryPromise({
      try: () => fs.stat(fullPath),
      catch: (err: any) => new ConfigError(`Failed to read file "${item}": ${err?.message ?? err}`, "cli_parse_failed"),
    });
    if (!stats.isFile()) throw new ConfigError(`Attachment path "${item}" is not a file.`, "cli_parse_failed");
    const buffer = yield* Effect.tryPromise({
      try: () => fs.readFile(fullPath),
      catch: (err: any) => new ConfigError(`Failed to read file "${item}": ${err?.message ?? err}`, "cli_parse_failed"),
    });
    const mimeType = getMimeType(fullPath);
    const name = path.basename(fullPath);
    const type = mimeType.startsWith("image/") ? "image" : "file";
    const created: any = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
      type,
      name,
      mimeType,
      sizeBytes: buffer.length,
    });
    const uploadUrl = new URL(created.relativeUrl, target.httpBaseUrl).toString();
    const response = yield* Effect.tryPromise({
      try: () => fetch(uploadUrl, {
        method: "POST",
        body: buffer,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(buffer.length),
          ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
        },
      }),
      catch: (err: any) => new ConfigError(`Failed to upload "${name}": ${err?.message ?? err}`, "command_failed"),
    });
    if (!response.ok) {
      throw new ConfigError(`Failed to upload "${name}": server returned ${response.status}.`, "command_failed");
    }
    attachments.push({ type, id: created.attachmentId, name, mimeType, sizeBytes: buffer.length });
  }
  return attachments;
});

/** The newest run in a projection by ordinal. */
function newestRun(projection: any): any {
  const runs: any[] = projection?.runs ?? [];
  return runs.reduce((latest: any, run: any) => (!latest || run.ordinal >= latest.ordinal ? run : latest), undefined);
}

/** The most recent run that has not reached a terminal state. */
function activeRun(projection: any): any {
  const runs: any[] = (projection?.runs ?? []).filter((run: any) => ACTIVE_RUN_STATUSES.has(run.status));
  return runs.length > 0 ? runs[runs.length - 1] : undefined;
}

async function dispatchMessage(options: CommandContext & { readonly threadId: string; readonly message: string; readonly images?: ReadonlyArray<string>; readonly titleSeed?: string } & ModelOptions): Promise<{ threadId: string; messageId: string; requestedAt: string; accepted: boolean }> {
  const messageId = generateId("msg");
  const requestedAt = new Date().toISOString();
  return withClient(options, (client, target) => Effect.gen(function* () {
    const attachments = yield* uploadAttachments(client, target, options.images);
    const projection: any = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: options.threadId }).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const running = activeRun(projection);
    yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command("message.dispatch", {
      ...CREATION,
      threadId: options.threadId,
      messageId,
      text: options.message,
      attachments,
      ...(options.titleSeed ? { titleSeed: options.titleSeed } : {}),
      ...(options.provider || options.model || options.options?.length ? { modelSelection: resolveModel(options) } : {}),
      dispatchMode: running ? { type: "queue_after_active" } : { type: "start_immediately" },
    }));
    return { threadId: options.threadId, messageId, requestedAt, accepted: true };
  }));
}

export async function sendMessage(options: CommandContext & { readonly threadId: string; readonly message: string; readonly images?: ReadonlyArray<string>; readonly wait?: boolean } & ModelOptions): Promise<unknown> {
  const sink = options.sink ?? createOutputSink(options.wait ? "ndjson" : options.format, { stream: Boolean(options.wait), stdoutIsTTY: process.stdout.isTTY });
  const result = await dispatchMessage(options);
  if (!options.wait) sink.write(result);
  if (options.wait) {
    const waited = await waitForThread({ ...options, sink, threadId: options.threadId, since: result.requestedAt });
    return { ...result, wait: waited };
  }
  return result;
}

export async function startThread(options: CommandContext & {
  readonly projectId?: string;
  readonly title?: string;
  readonly threadId?: string;
  readonly message: string;
  readonly images?: ReadonlyArray<string>;
  readonly wait?: boolean;
} & ModelOptions & WorktreeSettings): Promise<unknown> {
  validateWorktreeSettings(options);
  const attachedWorktreePath = options.worktreePath?.trim();
  const sink = options.sink ?? createOutputSink(options.wait ? "ndjson" : options.format, { stream: Boolean(options.wait), stdoutIsTTY: process.stdout.isTTY });

  if (options.threadId) {
    // Existing thread: optionally re-home it, then dispatch the message.
    if (attachedWorktreePath) {
      await dispatchThreadCommand({ ...options, threadId: options.threadId }, "thread.metadata.update", { worktreePath: attachedWorktreePath, ...(options.branch?.trim() ? { branch: options.branch.trim() } : {}) }, true);
    } else if (options.worktree) {
      const shell = await loadShell(options);
      const thread = shell.threads.find((entry: any) => entry.id === options.threadId);
      if (!thread) throw new ConfigError(`Thread "${options.threadId}" was not found. Run "t3ctl thread list" to see available threads.`, "thread_missing");
      const project = shell.projects.find((entry: any) => entry.id === thread.projectId);
      const workspaceRoot = typeof project?.workspaceRoot === "string" ? project.workspaceRoot : "";
      if (!workspaceRoot) {
        throw new ConfigError(`Could not determine the project workspace root for thread "${options.threadId}". Use --worktree-path to point at an existing directory instead.`, "project_missing");
      }
      const strategy: any = await buildWorkspaceStrategy(options, workspaceRoot);
      const newBranch = options.branch?.trim() || temporaryWorktreeBranch();
      const prepared: any = await withClient(options, (client) => Effect.gen(function* () {
        return yield* client[WS_METHODS.vcsCreateWorktree]({
          cwd: workspaceRoot,
          refName: strategy.baseRef,
          newRefName: newBranch,
          baseRefName: strategy.baseRef,
          path: null,
        });
      }));
      const worktreePath = typeof prepared?.worktree?.path === "string" ? prepared.worktree.path : null;
      if (!worktreePath) throw new ConfigError("The server did not return a worktree path.", "command_failed");
      const branch = typeof prepared?.worktree?.refName === "string" ? prepared.worktree.refName : newBranch;
      await dispatchThreadCommand({ ...options, threadId: options.threadId }, "thread.metadata.update", { worktreePath, branch }, true);
    }
    const sent = await dispatchMessage({ ...options, threadId: options.threadId, message: options.message, images: options.images });
    const result: Record<string, unknown> = { threadId: options.threadId, messageId: sent.messageId, started: true };
    if (attachedWorktreePath) {
      result.worktreePath = attachedWorktreePath;
      if (options.branch?.trim()) result.branch = options.branch.trim();
    }
    if (!options.wait) sink.write(result);
    if (options.wait) return { ...result, wait: await waitForThread({ ...options, sink, threadId: options.threadId, since: sent.requestedAt }) };
    return result;
  }

  // New thread: one V2 launch creates the thread, prepares the workspace, and
  // dispatches the initial message as a run.
  if (!options.projectId) throw new ConfigError("thread start requires --project unless --thread is supplied.", "project_missing");
  const project = await resolveProject(options, options.projectId);
  const workspaceStrategy = await buildWorkspaceStrategy(options, project.workspaceRoot);
  const launched: any = await withClient(options, (client, target) => Effect.gen(function* () {
    const attachments = yield* uploadAttachments(client, target, options.images);
    return yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: generateId("cmd"),
      ...CREATION,
      projectId: project.id,
      title: options.title?.trim() || "CLI thread",
      modelSelection: resolveModel(options, project),
      runtimeMode: options.runtimeMode || "full-access",
      interactionMode: options.interactionMode || "default",
      workspaceStrategy,
      initialMessage: { text: options.message, attachments },
    });
  }));
  const thread = launched?.projection?.thread ?? {};
  const run = newestRun(launched?.projection);
  const result: Record<string, unknown> = {
    threadId: launched?.threadId,
    projectId: project.id,
    started: true,
    ...(thread.worktreePath ? { worktreePath: thread.worktreePath, branch: thread.branch } : {}),
    ...(attachedWorktreePath ? { worktreePath: attachedWorktreePath } : {}),
  };
  if (!options.wait) sink.write(result);
  if (options.wait) return { ...result, wait: await waitForThread({ ...options, sink, threadId: String(launched?.threadId), since: new Date().toISOString(), runId: run?.id }) };
  return result;
}

export async function viewThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const thread = await loadThread(options, options.threadId);
  const result = { threadId: options.threadId, thread };
  sink.write(options.sink ? thread : result);
  return result;
}

export async function transcript(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const thread = await loadThread(options, options.threadId);
  const result = { threadId: options.threadId, messages: thread.messages ?? [], activities: thread.activities ?? [] };
  sink.write(result);
  return result;
}

export function normalizeThreadStreamItem(threadId: string, item: any): { type: string; threadId: string; [key: string]: unknown } {
  if (item?.kind === "synchronized") return { type: "thread.synchronized", threadId };
  if (item?.kind === "snapshot") return { type: "thread.snapshot", threadId, snapshotSequence: item.snapshotSequence, thread: item.projection?.thread, projection: item.projection };
  if (item?.kind === "event") return { type: "thread.event", threadId, event: item.event };
  return { type: "thread.malformed_event", threadId, raw: item };
}

function terminalStatusForRun(run: any): "completed" | "interrupted" | "failed" | undefined {
  if (!run) return undefined;
  if (run.status === "completed") return "completed";
  if (run.status === "interrupted" || run.status === "cancelled") return "interrupted";
  if (run.status === "failed") return "failed";
  return undefined;
}

function projectionRun(projection: any, runId?: string): any {
  const runs: any[] = projection?.runs ?? [];
  if (runId) return runs.find((run: any) => run.id === runId) ?? newestRun(projection);
  return newestRun(projection);
}

function projectionHasPendingRequest(projection: any): boolean {
  return (projection?.runtimeRequests ?? []).some((request: any) => request.status === "pending");
}

export function terminalStateFrom(value: any): "completed" | "interrupted" | "failed" | "approval_required" | undefined {
  const projection = value?.projection ?? (Array.isArray(value?.runs) ? value : undefined);
  if (projection) {
    if (projectionHasPendingRequest(projection)) return "approval_required";
    return terminalStatusForRun(projectionRun(projection));
  }
  const event = value?.event;
  if (event?.type === "run.updated") return terminalStatusForRun(event.payload);
  if (event?.type === "runtime-request.updated" && event.payload?.status === "pending") return "approval_required";
  return undefined;
}

/**
 * Best-effort failure reason from a projection, for callers that need to act on
 * *why* a turn failed (e.g. the schedule runner's rate-limit retry). V2 surfaces
 * provider failures as `error` turn items carrying a `failure` payload.
 */
function errorTextFromProjection(projection: any): string | undefined {
  const items: any[] = projection?.visibleTurnItems ?? projection?.turnItems ?? [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const payload = items[index]?.item ?? items[index];
    if (payload?.type === "error" && typeof payload?.failure?.message === "string" && payload.failure.message.trim()) {
      return payload.failure.message.trim();
    }
  }
  return undefined;
}

async function streamThread(options: CommandContext & { readonly threadId: string; readonly runId?: string }, stopOnTerminal: boolean): Promise<{ status: string; threadId: string; errorText?: string }> {
  const sink = options.sink ?? createOutputSink(options.format, { stream: true, stdoutIsTTY: process.stdout.isTTY });
  let status = "running";
  let errorText: string | undefined;
  let watchedRunId = options.runId;
  await withClient(options, (client) => Effect.gen(function* () {
    const stream = client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: options.threadId });
    yield* stream.pipe(
      Stream.runForEachWhile((item: any) => Effect.sync(() => {
        const event = normalizeThreadStreamItem(options.threadId, item);
        sink.event(event.type, event);
        let next: string | undefined;
        if (item?.kind === "snapshot") {
          const projection = item.projection;
          const newest = newestRun(projection);
          const stale = !options.runId && options.since && newest?.requestedAt && newest.requestedAt < options.since;
          if (!stale) {
            if (!watchedRunId) watchedRunId = newest?.id;
            if (projectionHasPendingRequest(projection)) next = "approval_required";
            else next = terminalStatusForRun(projectionRun(projection, watchedRunId));
            errorText = errorTextFromProjection(projection) ?? errorText;
          }
        } else if (item?.kind === "event") {
          const domainEvent = item.event;
          if (domainEvent?.type === "run.created" || domainEvent?.type === "run.updated") {
            const run = domainEvent.payload;
            if (domainEvent.type === "run.created" && !watchedRunId) watchedRunId = run?.id;
            if (run?.id === watchedRunId) next = terminalStatusForRun(run);
          } else if (domainEvent?.type === "runtime-request.updated" && domainEvent.payload?.status === "pending") {
            next = "approval_required";
          } else if (domainEvent?.type === "turn-item.updated" && domainEvent.payload?.type === "error") {
            const message = domainEvent.payload?.failure?.message;
            if (typeof message === "string" && message.trim()) errorText = message.trim();
          }
        }
        if (next) status = next;
        return !(stopOnTerminal && Boolean(next));
      })),
      Effect.catch((error: unknown) => Effect.sync(() => {
        sink.event("thread.malformed_event", { threadId: options.threadId, error: errorMessage(error) });
        status = "failed";
      })),
    );
  }));
  return { status, threadId: options.threadId, errorText };
}

export async function watchThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  const result = await streamThread({ ...options, format: "ndjson" }, false);
  return result;
}

export async function waitForThread(options: CommandContext & { readonly threadId: string; readonly runId?: string }): Promise<unknown> {
  const result = await streamThread({ ...options, format: "ndjson" }, true);
  const sink = options.sink ?? createOutputSink("ndjson", { stream: true, stdoutIsTTY: process.stdout.isTTY });
  sink.event("thread.completed", result);
  return result;
}

async function dispatchThreadCommand(options: CommandContext & { readonly threadId: string }, type: string, fields: Record<string, unknown> = {}, silent = false): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command(type, { threadId: options.threadId, ...fields, ...(type !== "thread.unsettle" ? {} : { reason: "user" }) }));
  }));
  const result = { threadId: options.threadId, operation: type, accepted: true };
  if (!silent) sink.write(result);
  return result;
}

export async function archiveThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> { return dispatchThreadCommand(options, "thread.archive"); }
export async function unarchiveThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> { return dispatchThreadCommand(options, "thread.unarchive"); }
export async function deleteThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> { return dispatchThreadCommand(options, "thread.delete"); }
export async function settleThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> { return dispatchThreadCommand(options, "thread.settle"); }
export async function unsettleThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> { return dispatchThreadCommand(options, "thread.unsettle"); }

export async function updateThread(options: CommandContext & { readonly threadId: string; readonly title?: string; readonly provider?: string; readonly model?: string; readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>; readonly branch?: string; readonly worktreePath?: string; readonly runtimeMode?: string; readonly interactionMode?: string }): Promise<unknown> {
  const fields: Record<string, unknown> = {};
  if (options.title) fields.title = options.title;
  if (options.branch !== undefined) fields.branch = options.branch || null;
  if (options.worktreePath !== undefined) fields.worktreePath = options.worktreePath || null;
  const hasModel = Boolean(options.provider || options.model || options.options?.length);
  if (Object.keys(fields).length === 0 && !hasModel && !options.runtimeMode && !options.interactionMode) {
    throw new ConfigError("thread update requires a metadata or mode option.", "cli_parse_failed");
  }
  if (Object.keys(fields).length > 0) await dispatchThreadCommand({ ...options, sink: undefined }, "thread.metadata.update", fields, true);
  if (hasModel) await dispatchThreadCommand({ ...options, sink: undefined }, "thread.model-selection.set", { modelSelection: resolveModel(options) }, true);
  if (options.runtimeMode) await dispatchThreadCommand({ ...options, sink: undefined }, "thread.runtime-mode.set", { runtimeMode: options.runtimeMode }, true);
  if (options.interactionMode) await dispatchThreadCommand({ ...options, sink: undefined }, "thread.interaction-mode.set", { interactionMode: options.interactionMode }, true);
  const result = { threadId: options.threadId, updated: true, fields };
  commandContext(options).sink.write(result);
  return result;
}

export async function respondToApproval(options: CommandContext & { readonly threadId: string; readonly requestId: string; readonly decision: string }): Promise<unknown> {
  return dispatchThreadCommand(options, "runtime-request.respond", { requestId: options.requestId, decision: options.decision });
}

export async function respondToUserInput(options: CommandContext & { readonly threadId: string; readonly requestId: string; readonly answers: Record<string, unknown> }): Promise<unknown> {
  return dispatchThreadCommand(options, "runtime-request.respond", { requestId: options.requestId, answers: options.answers });
}

export async function interruptThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const projection: any = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: options.threadId }).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
  }));
  const run = activeRun(projection) ?? newestRun(projection);
  if (!run?.id) throw new ConfigError(`Thread "${options.threadId}" has no run to interrupt.`, "command_failed");
  await dispatchThreadCommand({ ...options, sink: undefined }, "run.interrupt", { runId: run.id }, true);
  const result = { threadId: options.threadId, operation: "run.interrupt", accepted: true };
  sink.write(result);
  return result;
}

export function toCommandError(error: unknown): { readonly exitCode: number; readonly output: ReturnType<typeof structuredError> } {
  const message = errorMessage(error);
  const code = error instanceof ConfigError
    ? error.code
    : message.startsWith("Invalid output format")
      ? "cli_parse_failed"
      : "command_failed";
  const exitCode = code === "credential_missing" || code === "environment_missing" ? 3 : 1;
  return { exitCode, output: structuredError(code, message) };
}

export function lifecycleExitCode(status: unknown): number {
  switch (status) {
    case "approval_required": return 10;
    case "interrupted": return 130;
    case "failed": return 1;
    default: return 0;
  }
}
