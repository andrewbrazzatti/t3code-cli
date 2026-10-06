/**
 * Client-side scheduled sends: queue a message now, fire it later.
 *
 * The T3 server has no scheduling or quota API (thread.snooze is purely
 * organizational — nothing fires at wake time), so schedules live in a local
 * store under the config directory and are executed by `t3ctl schedule run`,
 * a long-running loop meant for nohup/tmux/launchd. "When quota becomes
 * available" is approximated by firing at a scheduled time and optionally
 * re-sending on rate-limit failures until a deadline.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { sendMessage, waitForThread, type CommandContext } from "./app.js";
import { ConfigError, getConfigDir, writeSecureJson } from "./config.js";
import { generateId, resolveTarget } from "./connection.js";
import { createOutputSink, type OutputSink } from "./output.js";

export type ScheduleState = "pending" | "running" | "sent" | "failed" | "cancelled";

export const SCHEDULE_STATES: readonly ScheduleState[] = ["pending", "running", "sent", "failed", "cancelled"];

export const DEFAULT_RETRY_INTERVAL_MS = 15 * 60 * 1000;

export interface ScheduledSend {
  readonly id: string;
  /** Environment name resolved and pinned at add time, if one applies. */
  readonly environment?: string;
  /** Server URL pinned at add time when no named environment applies. */
  readonly serverUrl?: string;
  readonly threadId: string;
  readonly message: string;
  readonly images?: ReadonlyArray<string>;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  readonly dueAt: string;
  readonly retryUntil?: string;
  readonly retryIntervalMs?: number;
  readonly state: ScheduleState;
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly sentAt?: string;
}

interface ScheduleStore {
  readonly version: 1;
  readonly entries: ScheduledSend[];
}

export function getSchedulePath(): string {
  return path.join(getConfigDir(), "schedule.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseIsoDateTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`Schedule entry ${label} is missing.`, "schedule_store_invalid");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConfigError(`Schedule entry ${label} is not a valid ISO datetime: "${value}".`, "schedule_store_invalid");
  }
  return parsed.toISOString();
}

function parseModelOptions(value: unknown): ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: Array<{ id: string; value: string | boolean }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || !item.id.trim()) continue;
    if (typeof item.value !== "string" && typeof item.value !== "boolean") continue;
    parsed.push({ id: item.id.trim(), value: item.value });
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseEntry(value: unknown): ScheduledSend {
  if (!isRecord(value)) throw new ConfigError("Schedule store contains a non-object entry.", "schedule_store_invalid");
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new ConfigError("Schedule store contains an entry without an id.", "schedule_store_invalid");
  }
  if (typeof value.threadId !== "string" || !value.threadId.trim()) {
    throw new ConfigError(`Schedule entry "${value.id}" is missing a thread ID.`, "schedule_store_invalid");
  }
  if (typeof value.message !== "string" || !value.message.trim()) {
    throw new ConfigError(`Schedule entry "${value.id}" is missing a message.`, "schedule_store_invalid");
  }
  const state = value.state;
  if (typeof state !== "string" || !SCHEDULE_STATES.includes(state as ScheduleState)) {
    throw new ConfigError(`Schedule entry "${value.id}" has an unknown state "${String(state)}".`, "schedule_store_invalid");
  }
  if (typeof value.attempts !== "number" || !Number.isInteger(value.attempts) || value.attempts < 0) {
    throw new ConfigError(`Schedule entry "${value.id}" has an invalid attempt count.`, "schedule_store_invalid");
  }
  const retryIntervalMs = value.retryIntervalMs === undefined ? undefined : value.retryIntervalMs;
  if (retryIntervalMs !== undefined && (typeof retryIntervalMs !== "number" || retryIntervalMs <= 0)) {
    throw new ConfigError(`Schedule entry "${value.id}" has an invalid retry interval.`, "schedule_store_invalid");
  }
  return {
    id: value.id,
    ...(optionalString(value.environment) ? { environment: optionalString(value.environment) } : {}),
    ...(optionalString(value.serverUrl) ? { serverUrl: optionalString(value.serverUrl) } : {}),
    threadId: value.threadId,
    message: value.message,
    ...(Array.isArray(value.images) && value.images.length > 0 ? { images: value.images.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(optionalString(value.provider) ? { provider: optionalString(value.provider) } : {}),
    ...(optionalString(value.model) ? { model: optionalString(value.model) } : {}),
    ...(optionalString(value.runtimeMode) ? { runtimeMode: optionalString(value.runtimeMode) } : {}),
    ...(optionalString(value.interactionMode) ? { interactionMode: optionalString(value.interactionMode) } : {}),
    ...(parseModelOptions(value.options) ? { options: parseModelOptions(value.options) } : {}),
    dueAt: parseIsoDateTime(value.dueAt, `"${value.id}" dueAt`),
    ...(value.retryUntil !== undefined ? { retryUntil: parseIsoDateTime(value.retryUntil, `"${value.id}" retryUntil`) } : {}),
    ...(retryIntervalMs !== undefined ? { retryIntervalMs } : {}),
    state: state as ScheduleState,
    attempts: value.attempts,
    ...(optionalString(value.lastError) ? { lastError: optionalString(value.lastError) } : {}),
    createdAt: parseIsoDateTime(value.createdAt, `"${value.id}" createdAt`),
    ...(value.sentAt !== undefined ? { sentAt: parseIsoDateTime(value.sentAt, `"${value.id}" sentAt`) } : {}),
  };
}

export function loadScheduleEntries(): ScheduledSend[] {
  const file = getSchedulePath();
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Cannot read ${file}: ${error instanceof Error ? error.message : "invalid JSON"}. Fix or remove the file, then try again.`,
      "schedule_store_read_failed",
    );
  }
  if (!isRecord(parsed)) throw new ConfigError(`${file} must contain an object with a version and entries.`, "schedule_store_invalid");
  if (parsed.version !== 1) throw new ConfigError(`${file} has an unsupported schedule store version.`, "schedule_store_invalid");
  if (!Array.isArray(parsed.entries)) throw new ConfigError(`${file} must contain an entries array.`, "schedule_store_invalid");
  return parsed.entries.map(parseEntry);
}

export function saveScheduleEntries(entries: ScheduledSend[]): void {
  const store: ScheduleStore = { version: 1, entries };
  writeSecureJson(getSchedulePath(), store);
}

function upsertEntry(entry: ScheduledSend): boolean {
  const entries = loadScheduleEntries();
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return false; // The store was wiped while the send was in flight.
  if (entries[index].state === "cancelled") return false; // Cancelled while firing; keep that decision.
  entries[index] = entry;
  saveScheduleEntries(entries);
  return true;
}

export function claimPendingEntry(entry: ScheduledSend): ScheduledSend | undefined {
  const entries = loadScheduleEntries();
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return undefined;
  if (entries[index].state !== "pending") return undefined;
  const claimed: ScheduledSend = { ...entries[index], state: "running", attempts: entries[index].attempts + 1 };
  entries[index] = claimed;
  saveScheduleEntries(entries);
  return claimed;
}

/**
 * Parse a duration like `90s`, `45m`, `2h30m`, or `1d12h` into milliseconds.
 */
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

/**
 * Resolve `--at` / `--in` (exactly one) to an ISO due time. `--at` must be in
 * the future so a typo does not silently fire immediately.
 */
export function parseScheduleWhen(input: { readonly at?: string; readonly in?: string }, now: Date = new Date()): string {
  const hasAt = Boolean(input.at?.trim());
  const hasIn = Boolean(input.in?.trim());
  if (hasAt && hasIn) throw new ConfigError("Use either --at or --in, not both.", "cli_parse_failed");
  if (hasIn) {
    const dueAt = new Date(now.getTime() + parseDurationMs(input.in!.trim()));
    return dueAt.toISOString();
  }
  if (hasAt) {
    const parsed = new Date(input.at!.trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new ConfigError(`Invalid --at datetime "${input.at}". Use ISO 8601, e.g. 2026-09-03T18:00.`, "cli_parse_failed");
    }
    if (parsed.getTime() <= now.getTime()) {
      throw new ConfigError(`--at datetime "${input.at}" must be in the future. Use --in for relative scheduling.`, "cli_parse_failed");
    }
    return parsed.toISOString();
  }
  throw new ConfigError("schedule add requires either --at TIME or --in DURATION.", "cli_parse_failed");
}

const RATE_LIMIT_PATTERN = /rate[ -]?limit|usage limit|quota|credit|capacity|too many requests/i;

/**
 * Provider quota exhaustion only surfaces as free-form failure text, so the
 * retry decision matches the common phrasings instead of a structured code.
 */
export function looksLikeRateLimit(text: string | undefined): boolean {
  if (!text) return false;
  return RATE_LIMIT_PATTERN.test(text);
}

export function dueEntries(entries: ScheduledSend[], now: Date = new Date()): ScheduledSend[] {
  return entries
    .filter((entry) => entry.state === "pending" && new Date(entry.dueAt).getTime() <= now.getTime())
    .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime());
}

export function retryDeadlinePassed(entry: ScheduledSend, now: Date = new Date()): boolean {
  return entry.retryUntil !== undefined && now.getTime() >= new Date(entry.retryUntil).getTime();
}

export function nextRetryAt(entry: ScheduledSend, now: Date = new Date()): string {
  return new Date(now.getTime() + (entry.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS)).toISOString();
}

/** Entries stuck in `running` (a crashed runner) go back to pending; sends are at-least-once. */
export function resetStaleRunning(entries: ScheduledSend[]): ScheduledSend[] {
  return entries.map((entry) => (entry.state === "running" ? { ...entry, state: "pending" as const } : entry));
}

export interface ScheduleAddOptions extends CommandContext {
  readonly threadId: string;
  readonly message: string;
  readonly images?: ReadonlyArray<string>;
  readonly at?: string;
  readonly in?: string;
  readonly retryUntil?: string;
  readonly retryInterval?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

export async function scheduleAdd(options: ScheduleAddOptions): Promise<ScheduledSend> {
  const dueAt = parseScheduleWhen({ at: options.at, in: options.in });
  const retryUntil = options.retryUntil?.trim()
    ? new Date(new Date(dueAt).getTime() + parseDurationMs(options.retryUntil)).toISOString()
    : undefined;
  // Pin the destination now so later `auth use` switches cannot misroute the
  // send; credentials are still resolved fresh at fire time.
  const target = resolveTarget(options);
  const entry: ScheduledSend = {
    id: generateId("sched"),
    ...(target.environmentName ? { environment: target.environmentName } : { serverUrl: target.httpBaseUrl }),
    threadId: options.threadId,
    message: options.message,
    ...(options.images && options.images.length > 0 ? { images: [...options.images] } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    ...(options.interactionMode ? { interactionMode: options.interactionMode } : {}),
    ...(options.options && options.options.length > 0 ? { options: [...options.options] } : {}),
    dueAt,
    ...(retryUntil ? { retryUntil, retryIntervalMs: options.retryInterval ? parseDurationMs(options.retryInterval) : DEFAULT_RETRY_INTERVAL_MS } : {}),
    state: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  saveScheduleEntries([...loadScheduleEntries(), entry]);
  return entry;
}

export async function scheduleList(options: CommandContext & { readonly all?: boolean }): Promise<unknown> {
  const entries = loadScheduleEntries()
    .filter((entry) => options.all || entry.state === "pending" || entry.state === "running")
    .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime());
  return { schedules: entries };
}

export async function scheduleCancel(options: CommandContext & { readonly scheduleId: string }): Promise<ScheduledSend> {
  const entries = loadScheduleEntries();
  const needle = options.scheduleId.trim();
  const matches = entries.filter((entry) => entry.id === needle || entry.id.startsWith(needle));
  if (matches.length === 0) {
    throw new ConfigError(`Schedule "${needle}" was not found. Run "t3ctl schedule list --all" to see entries.`, "schedule_missing");
  }
  if (matches.length > 1) {
    throw new ConfigError(`Schedule ID "${needle}" is ambiguous; matches: ${matches.map((entry) => entry.id).join(", ")}`, "schedule_ambiguous");
  }
  const entry = matches[0];
  if (entry.state !== "pending" && entry.state !== "running") {
    throw new ConfigError(`Schedule "${entry.id}" is already ${entry.state} and cannot be cancelled.`, "schedule_not_cancellable");
  }
  const cancelled: ScheduledSend = { ...entry, state: "cancelled" };
  upsertEntry(cancelled);
  return cancelled;
}

type FireOutcome = "sent" | "failed" | "rescheduled" | "skipped";

function sendTarget(entry: ScheduledSend): Pick<CommandContext, "environment" | "serverUrl" | "token"> {
  return {
    environment: entry.environment,
    serverUrl: entry.serverUrl,
    token: undefined,
  };
}

/** Fire one due entry: send, and when a retry deadline is configured, watch the turn and possibly reschedule. */
async function fireEntry(options: CommandContext, entry: ScheduledSend, sink: OutputSink): Promise<FireOutcome> {
  const claimed = claimPendingEntry(entry);
  if (!claimed) return "skipped";
  const now = new Date().toISOString();
  sink.event("schedule.fired", { scheduleId: entry.id, threadId: entry.threadId, attempt: claimed.attempts, dueAt: entry.dueAt, firedAt: now });

  const sendOptions: CommandContext = { ...options, ...sendTarget(entry), sink };
  const sendOptionsWithModel = {
    ...sendOptions,
    threadId: entry.threadId,
    message: entry.message,
    ...(entry.images ? { images: entry.images } : {}),
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.runtimeMode ? { runtimeMode: entry.runtimeMode } : {}),
    ...(entry.interactionMode ? { interactionMode: entry.interactionMode } : {}),
    ...(entry.options && entry.options.length > 0 ? { options: entry.options } : {}),
  };
  let result: any;
  try {
    result = await sendMessage(sendOptionsWithModel);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const updated = upsertEntry({ ...claimed, state: "failed", lastError: failure });
    if (!updated) return "skipped";
    sink.event("schedule.failed", { scheduleId: entry.id, threadId: entry.threadId, error: failure });
    return "failed";
  }

  if (!entry.retryUntil) {
    const sentAt = new Date().toISOString();
    const updated = upsertEntry({ ...claimed, state: "sent", sentAt });
    if (!updated) return "skipped";
    sink.event("schedule.sent", { scheduleId: entry.id, threadId: entry.threadId, messageId: result?.messageId });
    return "sent";
  }

  const waited = await waitForThread({ ...sendOptions, threadId: entry.threadId, since: result?.requestedAt });
  const status = (waited as any)?.status;
  const errorText = (waited as any)?.errorText as string | undefined;
  if (status !== "failed") {
    const sentAt = new Date().toISOString();
    const updated = upsertEntry({ ...claimed, state: "sent", sentAt, ...(errorText ? { lastError: errorText } : {}) });
    if (!updated) return "skipped";
    sink.event("schedule.sent", { scheduleId: entry.id, threadId: entry.threadId, status });
    return "sent";
  }
  if (!looksLikeRateLimit(errorText) || retryDeadlinePassed(entry)) {
    const updated = upsertEntry({ ...claimed, state: "failed", lastError: errorText });
    if (!updated) return "skipped";
    sink.event("schedule.failed", { scheduleId: entry.id, threadId: entry.threadId, error: errorText });
    return "failed";
  }
  const dueAt = nextRetryAt(entry);
  const updated = upsertEntry({ ...entry, state: "pending", dueAt, lastError: errorText });
  if (!updated) return "skipped";
  sink.event("schedule.rescheduled", { scheduleId: entry.id, threadId: entry.threadId, error: errorText, nextAttemptAt: dueAt });
  return "rescheduled";
}

export interface ScheduleRunSummary {
  fired: number;
  sent: number;
  failed: number;
  rescheduled: number;
  skipped: number;
}

export async function scheduleRun(options: CommandContext & { readonly interval?: string; readonly once?: boolean }): Promise<ScheduleRunSummary> {
  const sink = options.sink ?? createOutputSink(options.format);
  const intervalMs = options.interval ? Math.max(1000, parseDurationMs(options.interval)) : 15_000;
  const summary: ScheduleRunSummary = { fired: 0, sent: 0, failed: 0, rescheduled: 0, skipped: 0 };

  // A previous runner may have died mid-send; treat those sends as not yet
  // fired. If the message actually went out, the retry adds a duplicate user
  // message — harmless for a resume prompt, and documented.
  const entries = resetStaleRunning(loadScheduleEntries());
  saveScheduleEntries(entries);

  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      for (const entry of dueEntries(loadScheduleEntries())) {
        if (stopped) break;
        const outcome = await fireEntry(options, entry, sink);
        if (outcome === "skipped") { summary.skipped += 1; continue; }
        summary.fired += 1;
        if (outcome === "sent") summary.sent += 1;
        else if (outcome === "failed") summary.failed += 1;
        else summary.rescheduled += 1;
      }
      if (options.once || stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, intervalMs);
        const onStop = () => {
          clearTimeout(timer);
          cleanup();
          resolve();
        };
        const cleanup = () => {
          process.removeListener("SIGINT", onStop);
          process.removeListener("SIGTERM", onStop);
        };
        process.once("SIGINT", onStop);
        process.once("SIGTERM", onStop);
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return summary;
}
