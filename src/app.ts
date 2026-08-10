import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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

async function withClient(options: TargetOptions, use: (client: Client, target: Awaited<ReturnType<typeof resolveTargetAsync>>) => any): Promise<any> {
  const target = await resolveTargetAsync(options);
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = yield* connectClient(target.socketUrl, target.token);
    return yield* use(client, target);
  })) as any) as Promise<any>;
}

function commandContext(options: CommandContext, stream = false): { sink: OutputSink; options: TargetOptions } {
  return {
    sink: options.sink ?? createOutputSink(options.format, { stream, stdoutIsTTY: process.stdout.isTTY }),
    options,
  };
}

function command(commandType: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: commandType, commandId: generateId("cmd"), ...fields };
}

function projectMatches(project: any, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return [project.id, project.title, project.workspaceRoot, path.basename(project.workspaceRoot || "")]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase() === needle || value.toLowerCase().includes(needle));
}

async function loadShell(options: TargetOptions): Promise<{ projects: any[]; threads: any[] }> {
  return withClient(options, (client) => Effect.gen(function* () {
    let live: any;
    const liveStream = client[ORCHESTRATION_WS_METHODS.subscribeShell]({});
    yield* liveStream.pipe(Stream.runForEachWhile((item: any) => Effect.sync(() => {
      if (item?.kind === "snapshot") live = item.snapshot;
      return live === undefined;
    })));
    const archived = yield* client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({});
    const merge = (values: any[]) => {
      const byId = new Map<string, any>();
      for (const value of values) if (value?.id) byId.set(String(value.id), value);
      return [...byId.values()];
    };
    return {
      projects: merge([...(live?.projects ?? []), ...(archived?.projects ?? [])]),
      threads: merge([...(live?.threads ?? []), ...(archived?.threads ?? [])]),
    };
  }));
}

async function loadThread(options: TargetOptions, threadId: string): Promise<any> {
  return withClient(options, (client) => Effect.gen(function* () {
    const stream = client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId });
    let thread: any;
    yield* stream.pipe(Stream.runForEachWhile((item: any) => Effect.sync(() => {
      if (item?.kind === "snapshot") thread = item.snapshot?.thread;
      return thread === undefined;
    })));
    if (!thread) throw new ConfigError(`Thread "${threadId}" was not found.`, "thread_missing");
    return thread;
  }));
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
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command("project.create", {
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
      createdAt: new Date().toISOString(),
    }));
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
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command("project.create", {
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: null,
      createdAt: new Date().toISOString(),
    }));
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
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command("project.delete", { projectId, force: options.force }));
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
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command("project.meta.update", { projectId, ...fields }));
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

function resolveModel(options: ModelOptions, project?: any): { instanceId: string; model: string; options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> } {
  const configured = project?.defaultModelSelection ?? loadConfig().defaultModel;
  return {
    instanceId: options.provider || configured?.instanceId || "codex_personal",
    model: options.model || configured?.model || "gpt-5.6-luna",
    ...(options.options && options.options.length > 0 ? { options: options.options } : {}),
  };
}

async function resolveProject(options: TargetOptions, query: string): Promise<any> {
  const projects = (await loadShell(options)).projects;
  const project = projects.find((entry: any) => projectMatches(entry, query));
  if (!project) throw new ConfigError(`Project "${query}" was not found.`, "project_missing");
  return project;
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
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const project = await resolveProject(options, options.projectId);
  const modelSelection = resolveModel(options, project);
  const threadId = generateId("thread");
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command("thread.create", {
      threadId,
      projectId: project.id,
      title: options.title,
      modelSelection,
      runtimeMode: options.runtimeMode || "full-access",
      interactionMode: options.interactionMode || "default",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    }));
  }));
  const result = { id: threadId, threadId, projectId: project.id, title: options.title, modelSelection };
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
    default: return "image/png";
  }
}

async function prepareImageAttachments(imagePaths?: ReadonlyArray<string>): Promise<Array<any>> {
  if (!imagePaths || imagePaths.length === 0) return [];
  const attachments: Array<any> = [];
  for (const item of imagePaths) {
    const fullPath = path.resolve(item);
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        throw new ConfigError(`Image path "${item}" is not a file.`, "cli_parse_failed");
      }
      const buffer = await fs.readFile(fullPath);
      const mimeType = getMimeType(fullPath);
      const name = path.basename(fullPath);
      const base64 = buffer.toString("base64");
      attachments.push({
        type: "image",
        name,
        mimeType,
        sizeBytes: buffer.length,
        dataUrl: `data:${mimeType};base64,${base64}`,
      });
    } catch (err: any) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`Failed to read image file "${item}": ${err.message}`, "cli_parse_failed");
    }
  }
  return attachments;
}

async function startTurn(options: CommandContext & { readonly threadId: string; readonly message: string; readonly images?: ReadonlyArray<string> } & ModelOptions): Promise<unknown> {
  const messageId = generateId("msg");
  const requestedAt = new Date().toISOString();
  const attachments = await prepareImageAttachments(options.images);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command("thread.turn.start", {
      threadId: options.threadId,
      message: { messageId, role: "user", text: options.message, attachments },
      ...(options.provider || options.model || options.options?.length ? { modelSelection: resolveModel(options) } : {}),
      runtimeMode: options.runtimeMode || "full-access",
      interactionMode: options.interactionMode || "default",
      createdAt: requestedAt,
    }));
    return { threadId: options.threadId, messageId, requestedAt, accepted: true };
  }));
  return result;
}

export async function sendMessage(options: CommandContext & { readonly threadId: string; readonly message: string; readonly images?: ReadonlyArray<string>; readonly wait?: boolean } & ModelOptions): Promise<unknown> {
  const sink = options.sink ?? createOutputSink(options.wait ? "ndjson" : options.format, { stream: Boolean(options.wait), stdoutIsTTY: process.stdout.isTTY });
  const result = await startTurn(options);
  if (!options.wait) sink.write(result);
  if (options.wait) {
    const waited = await waitForThread({ ...options, sink, threadId: options.threadId, since: (result as any).requestedAt });
    return { ...result as any, wait: waited };
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
} & ModelOptions): Promise<unknown> {
  let threadId = options.threadId;
  let projectId = options.projectId;
  let title = options.title;
  if (!threadId) {
    if (!projectId) throw new ConfigError("thread start requires --project unless --thread is supplied.", "project_missing");
    const created = await createThread({ ...options, projectId, title: title || "CLI thread", silent: true });
    threadId = String((created as any).threadId);
  }
  const sink = options.sink ?? createOutputSink(options.wait ? "ndjson" : options.format, { stream: Boolean(options.wait), stdoutIsTTY: process.stdout.isTTY });
  const sent = await startTurn({ ...options, threadId, message: options.message, images: options.images });
  const result = { threadId, ...(projectId ? { projectId } : {}), messageId: (sent as any).messageId, started: true };
  if (!options.wait) sink.write(result);
  if (options.wait) return { ...result, wait: await waitForThread({ ...options, sink, threadId, since: (sent as any).requestedAt }) };
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
  if (item?.kind === "snapshot") return { type: "thread.snapshot", threadId, snapshotSequence: item.snapshot?.snapshotSequence, thread: item.snapshot?.thread };
  if (item?.kind === "event") return { type: "thread.event", threadId, event: item.event };
  return { type: "thread.malformed_event", threadId, raw: item };
}

export function terminalStateFrom(value: any): "completed" | "interrupted" | "failed" | "approval_required" | undefined {
  const thread = value?.thread ?? value;
  const latest = thread?.latestTurn;
  if (latest?.state === "completed") return "completed";
  if (latest?.state === "interrupted") return "interrupted";
  if (latest?.state === "error") return "failed";
  if (thread?.hasPendingApprovals || thread?.hasPendingUserInput) return "approval_required";
  const activity = value?.event?.payload?.activity ?? value?.event?.activity;
  const kind = activity?.kind;
  if (kind === "approval.requested" || kind === "user-input.requested") return "approval_required";
  if (kind === "turn.completed") return "completed";
  if (kind === "turn.aborted" || kind === "turn.interrupted") return "interrupted";
  if (kind === "turn.failed" || kind === "runtime.error") return "failed";
  return undefined;
}

async function streamThread(options: CommandContext & { readonly threadId: string }, stopOnTerminal: boolean): Promise<{ status: string; threadId: string }> {
  const sink = options.sink ?? createOutputSink(options.format, { stream: true, stdoutIsTTY: process.stdout.isTTY });
  let status = "running";
  await withClient(options, (client) => Effect.gen(function* () {
    const stream = client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId: options.threadId });
    yield* stream.pipe(
      Stream.runForEachWhile((item: any) => Effect.sync(() => {
        const event = normalizeThreadStreamItem(options.threadId, item);
        sink.event(event.type, event);
        const snapshotIsBeforeRequestedTurn = item?.kind === "snapshot" && options.since && item.snapshot?.thread?.latestTurn?.requestedAt && item.snapshot.thread.latestTurn.requestedAt < options.since;
        const next = snapshotIsBeforeRequestedTurn ? undefined : terminalStateFrom(item?.kind === "snapshot" ? item.snapshot : item?.kind === "event" ? { event: item.event } : item);
        if (next) status = next;
        return !(stopOnTerminal && Boolean(next));
      })),
      Effect.catch((error: unknown) => Effect.sync(() => {
        sink.event("thread.malformed_event", { threadId: options.threadId, error: errorMessage(error) });
        status = "failed";
      })),
    );
  }));
  return { status, threadId: options.threadId };
}

export async function watchThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  const result = await streamThread({ ...options, format: "ndjson" }, false);
  return result;
}

export async function waitForThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  const result = await streamThread({ ...options, format: "ndjson" }, true);
  const sink = options.sink ?? createOutputSink("ndjson", { stream: true, stdoutIsTTY: process.stdout.isTTY });
  sink.event("thread.completed", result);
  return result;
}

async function dispatchThreadCommand(options: CommandContext & { readonly threadId: string }, type: string, fields: Record<string, unknown> = {}, silent = false): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](command(type, { threadId: options.threadId, ...fields, ...(type !== "thread.unsettle" ? {} : { reason: "user" }) }));
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
  if (options.provider || options.model || options.options?.length) fields.modelSelection = resolveModel(options);
  if (options.branch !== undefined) fields.branch = options.branch || null;
  if (options.worktreePath !== undefined) fields.worktreePath = options.worktreePath || null;
  if (Object.keys(fields).length === 0 && !options.runtimeMode && !options.interactionMode) {
    throw new ConfigError("thread update requires a metadata or mode option.", "cli_parse_failed");
  }
  if (Object.keys(fields).length > 0) await dispatchThreadCommand({ ...options, sink: undefined }, "thread.meta.update", fields, true);
  if (options.runtimeMode) await dispatchThreadCommand({ ...options, sink: undefined }, "thread.runtime-mode.set", { runtimeMode: options.runtimeMode, createdAt: new Date().toISOString() }, true);
  if (options.interactionMode) await dispatchThreadCommand({ ...options, sink: undefined }, "thread.interaction-mode.set", { interactionMode: options.interactionMode, createdAt: new Date().toISOString() }, true);
  const result = { threadId: options.threadId, updated: true, fields };
  commandContext(options).sink.write(result);
  return result;
}

export async function respondToApproval(options: CommandContext & { readonly threadId: string; readonly requestId: string; readonly decision: string }): Promise<unknown> {
  return dispatchThreadCommand(options, "thread.approval.respond", { requestId: options.requestId, decision: options.decision, createdAt: new Date().toISOString() });
}

export async function respondToUserInput(options: CommandContext & { readonly threadId: string; readonly requestId: string; readonly answers: Record<string, unknown> }): Promise<unknown> {
  return dispatchThreadCommand(options, "thread.user-input.respond", { requestId: options.requestId, answers: options.answers, createdAt: new Date().toISOString() });
}

export async function interruptThread(options: CommandContext & { readonly threadId: string }): Promise<unknown> {
  return dispatchThreadCommand(options, "thread.turn.interrupt", { createdAt: new Date().toISOString() });
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
