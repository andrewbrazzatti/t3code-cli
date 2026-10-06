/**
 * Server-side scheduled tasks.
 *
 * T3 Code runs schedules on the server with interval, fixed wall-clock, and
 * webhook triggers; each firing launches a new thread or messages an existing
 * one. The CLI is a thin client over the `scheduledTasks.*` RPCs — there is no
 * local store and no runner daemon to keep alive.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { buildWorkspaceStrategy, commandContext, loadShell, resolveModel, resolveProject, withClient, type CommandContext, type WorktreeSettings } from "./app.js";
import { ConfigError } from "./config.js";
import { generateId } from "./connection.js";
import { createOutputSink } from "./output.js";

export interface ModelOption {
  readonly id: string;
  readonly value: string | boolean;
}

export interface ScheduleTriggerFlags {
  /** Interval between runs, e.g. `45m`, `2h30m`. */
  readonly every?: string;
  /** Wall-clock time of day, `HH:MM`. */
  readonly at?: string;
  /** Comma-separated weekdays for `--at` (0=Sun..6=Sat, or names). */
  readonly weekdays?: string;
  /** Run on each request to the task's webhook URL. */
  readonly webhook?: boolean;
}

export type ScheduleTrigger =
  | { readonly type: "interval"; readonly everyMs: number }
  | { readonly type: "fixed_time"; readonly timeOfDay: string; readonly weekdays?: ReadonlyArray<number> }
  | { readonly type: "webhook" };

export function parseDurationMs(text: string): number {
  const raw = text.trim().toLowerCase();
  if (!raw) throw new ConfigError("A duration is required (e.g. 45m, 2h30m, 1d12h).", "cli_parse_failed");
  const pattern = /(\d+)(s|m|h|d)/g;
  let total = 0;
  let matched = false;
  let consumed = 0;
  for (const match of raw.matchAll(pattern)) {
    matched = true;
    consumed += match[0].length;
    const amount = Number(match[1]);
    const unitMs = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2] as "s" | "m" | "h" | "d"];
    total += amount * unitMs;
  }
  if (!matched || consumed !== raw.length) {
    throw new ConfigError(`Invalid duration "${text}". Use a sequence like 45m, 2h30m, or 1d12h.`, "cli_parse_failed");
  }
  if (total <= 0) throw new ConfigError(`Duration "${text}" must be positive.`, "cli_parse_failed");
  return total;
}

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

export function parseWeekdays(text: string): number[] {
  const parts = text.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new ConfigError("--weekdays requires at least one day (0-6 or mon,tue,...).", "cli_parse_failed");
  const days = new Set<number>();
  for (const part of parts) {
    if (/^[0-6]$/.test(part)) {
      days.add(Number(part));
      continue;
    }
    const named = WEEKDAY_NAMES[part];
    if (named === undefined) {
      throw new ConfigError(`Unknown weekday "${part}". Use 0-6 (0=Sunday) or names like mon,tue.`, "cli_parse_failed");
    }
    days.add(named);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Resolve exactly one of --every / --at / --webhook into a server trigger.
 * `--at` takes a wall-clock `HH:MM`; `--weekdays` only applies to `--at`.
 */
export function parseScheduleTrigger(flags: ScheduleTriggerFlags): ScheduleTrigger {
  const hasEvery = Boolean(flags.every?.trim());
  const hasAt = Boolean(flags.at?.trim());
  const hasWebhook = flags.webhook === true;
  const selected = [hasEvery, hasAt, hasWebhook].filter(Boolean).length;
  if (selected !== 1) {
    throw new ConfigError("schedule add requires exactly one of --every DURATION, --at HH:MM, or --webhook.", "cli_parse_failed");
  }
  if (hasEvery) {
    const everyMs = parseDurationMs(flags.every!.trim());
    if (everyMs < 60_000) throw new ConfigError("--every must be at least 1 minute (the server minimum).", "cli_parse_failed");
    if (flags.weekdays?.trim()) throw new ConfigError("--weekdays only applies to --at.", "cli_parse_failed");
    return { type: "interval", everyMs };
  }
  if (hasAt) {
    const raw = flags.at!.trim();
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(raw)) {
      throw new ConfigError(`Invalid --at "${raw}". Use a 24-hour wall-clock time like 09:30.`, "cli_parse_failed");
    }
    const [hours, minutes] = raw.split(":");
    const timeOfDay = `${hours.padStart(2, "0")}:${minutes}`;
    const weekdays = flags.weekdays?.trim() ? parseWeekdays(flags.weekdays.trim()) : undefined;
    return { type: "fixed_time", timeOfDay, ...(weekdays ? { weekdays } : {}) };
  }
  if (flags.weekdays?.trim()) throw new ConfigError("--weekdays only applies to --at.", "cli_parse_failed");
  return { type: "webhook" };
}

function defaultTitle(message: string): string {
  const firstLine = message.split("\n").find((line) => line.trim()) ?? "Scheduled task";
  const trimmed = firstLine.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

async function resolveScheduleId(options: CommandContext, query: string): Promise<string> {
  const { tasks } = await scheduleList({ ...options, sink: undefined, silent: true }) as { tasks: Array<{ id: string }> };
  const needle = query.trim();
  const exact = tasks.find((task) => task.id === needle);
  if (exact) return exact.id;
  const matches = tasks.filter((task) => task.id.startsWith(needle));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new ConfigError(`Schedule id "${needle}" is ambiguous; it matches ${matches.length} tasks.`, "schedule_ambiguous");
  }
  throw new ConfigError(`No scheduled task matches "${needle}". Run "t3ctl schedule list" to see them.`, "schedule_missing");
}

export async function scheduleAdd(options: CommandContext & ScheduleTriggerFlags & WorktreeSettings & {
  readonly scheduleId?: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly title?: string;
  readonly message: string;
  readonly enabled?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly options?: ReadonlyArray<ModelOption>;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const trigger = parseScheduleTrigger(options);

  let projectId: string;
  let workspaceStrategy: Record<string, unknown>;
  let project: any;

  if (options.threadId) {
    const shell = await loadShell(options);
    const thread = shell.threads.find((entry: any) => entry.id === options.threadId);
    if (!thread) throw new ConfigError(`Thread "${options.threadId}" was not found. Run "t3ctl thread list" to see available threads.`, "thread_missing");
    projectId = thread.projectId;
    project = shell.projects.find((entry: any) => entry.id === projectId);
    workspaceStrategy = { type: "root" };
  } else {
    if (!options.projectId) throw new ConfigError("schedule add requires --project, or --thread to target an existing thread.", "project_missing");
    project = await resolveProject(options, options.projectId);
    projectId = project.id;
    workspaceStrategy = await buildWorkspaceStrategy(options, project.workspaceRoot);
  }

  const modelSelection = resolveModel(options, project);
  const task = await withClient(options, (client) => Effect.gen(function* () {
    const result: any = yield* client[WS_METHODS.scheduledTasksUpsert]({
      ...(options.scheduleId ? { id: options.scheduleId, requireExisting: true } : {}),
      commandId: generateId("cmd"),
      title: options.title?.trim() || defaultTitle(options.message),
      prompt: options.message,
      enabled: options.enabled !== false,
      schedule: trigger,
      projectId,
      ...(options.threadId ? { threadId: options.threadId } : {}),
      workspaceStrategy,
      modelSelection,
      runtimeMode: options.runtimeMode || "full-access",
      interactionMode: options.interactionMode || "default",
      createdBy: "user",
      creationSource: "mcp",
    });
    return result?.task;
  }));
  const result = { task };
  sink.write(result);
  return result;
}

export async function scheduleList(options: CommandContext & { readonly all?: boolean }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.scheduledTasksList]({});
  }));
  const tasks = (result as any)?.tasks ?? [];
  const output = { tasks };
  if (!options.silent) sink.write(output);
  return output;
}

export async function scheduleSetEnabled(options: CommandContext & { readonly scheduleId: string; readonly enabled: boolean }): Promise<unknown> {
  const { sink } = commandContext(options);
  const id = await resolveScheduleId(options, options.scheduleId);
  const task = await withClient(options, (client) => Effect.gen(function* () {
    const result: any = yield* client[WS_METHODS.scheduledTasksSetEnabled]({ id, enabled: options.enabled });
    return result?.task;
  }));
  const result = { task };
  sink.write(result);
  return result;
}

export async function scheduleCancel(options: CommandContext & { readonly scheduleId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const id = await resolveScheduleId(options, options.scheduleId);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.scheduledTasksDelete]({ id });
  }));
  sink.write(result);
  return result;
}

export async function scheduleRunNow(options: CommandContext & { readonly scheduleId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const id = await resolveScheduleId(options, options.scheduleId);
  const task = await withClient(options, (client) => Effect.gen(function* () {
    const result: any = yield* client[WS_METHODS.scheduledTasksRunNow]({ id });
    return result?.task;
  }));
  const result = { task };
  sink.write(result);
  return result;
}

export async function scheduleRotateWebhook(options: CommandContext & { readonly scheduleId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const id = await resolveScheduleId(options, options.scheduleId);
  const task = await withClient(options, (client) => Effect.gen(function* () {
    const result: any = yield* client[WS_METHODS.scheduledTasksRotateWebhookToken]({ id });
    return result?.task;
  }));
  const result = { task };
  sink.write(result);
  return result;
}

export async function scheduleDeliveries(options: CommandContext & { readonly scheduleId: string; readonly deliveryId?: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const id = await resolveScheduleId(options, options.scheduleId);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    if (options.deliveryId) {
      return yield* client[WS_METHODS.scheduledTasksGetWebhookDelivery]({ id, deliveryId: options.deliveryId });
    }
    return yield* client[WS_METHODS.scheduledTasksListWebhookDeliveries]({ id });
  }));
  sink.write(result);
  return result;
}

export async function scheduleSubscribe(options: CommandContext): Promise<unknown> {
  const sink = options.sink ?? createOutputSink("ndjson", { stream: true, stdoutIsTTY: process.stdout.isTTY });
  let latest: unknown;
  await withClient(options, (client) => Effect.gen(function* () {
    const stream = client[WS_METHODS.scheduledTasksSubscribe]({});
    yield* stream.pipe(Stream.runForEach((event: any) => Effect.sync(() => {
      latest = event;
      sink.event("schedule.snapshot", { tasks: event?.tasks ?? [] });
    })));
  }));
  return latest;
}
