import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function isolatedDirectory() {
  return mkdtempSync(join(tmpdir(), "t3ctl-schedule-test-"));
}

test("durations parse into milliseconds and reject garbage", async () => {
  const { parseDurationMs } = await import("../dist/schedule.js");
  assert.equal(parseDurationMs("90m"), 90 * 60 * 1000);
  assert.equal(parseDurationMs("2h30m"), 150 * 60 * 1000);
  assert.equal(parseDurationMs("1d12h"), 36 * 60 * 60 * 1000);
  assert.equal(parseDurationMs("45s"), 45 * 1000);

  const invalid = ["", "2", "2x", "m", "1h30", "1.5h", "-5m"];
  for (const value of invalid) {
    assert.throws(() => parseDurationMs(value), (error) => error.code === "cli_parse_failed", `expected "${value}" to be rejected`);
  }
  assert.throws(() => parseDurationMs("0m"), (error) => error.code === "cli_parse_failed");
});

test("--at and --in resolve to a due time and are mutually exclusive", async () => {
  const { parseScheduleWhen } = await import("../dist/schedule.js");
  const now = new Date("2026-09-03T12:00:00.000Z");

  const fromIn = parseScheduleWhen({ in: "90m" }, now);
  assert.equal(new Date(fromIn).getTime(), now.getTime() + 90 * 60 * 1000);

  const fromAt = parseScheduleWhen({ at: "2026-09-03T18:00:00.000Z" }, now);
  assert.equal(fromAt, "2026-09-03T18:00:00.000Z"); // Explicit-offset times are honoured as-is.
  // A time without an offset is read in the machine's local timezone, so only
  // assert the ordering (with enough headroom) to stay timezone-independent.
  assert.equal(new Date(parseScheduleWhen({ at: "2026-09-04T23:00" }, now)).getTime() > now.getTime(), true);

  assert.throws(() => parseScheduleWhen({ at: "2026-09-03T13:00", in: "5m" }, now), (error) => error.code === "cli_parse_failed" && /not both/.test(error.message));
  assert.throws(() => parseScheduleWhen({}, now), (error) => error.code === "cli_parse_failed" && /requires either/.test(error.message));
  assert.throws(() => parseScheduleWhen({ at: "not-a-date" }, now), (error) => error.code === "cli_parse_failed" && /Invalid --at/.test(error.message));
  assert.throws(() => parseScheduleWhen({ at: "2026-09-03T11:00" }, now), (error) => error.code === "cli_parse_failed" && /must be in the future/.test(error.message));
});

test("rate-limit matching drives the retry decision", async () => {
  const { looksLikeRateLimit } = await import("../dist/schedule.js");
  for (const text of [
    "Rate limit exceeded. Try again in 2h.",
    "usage limit reached for claude",
    "You've hit your monthly quota",
    "credit balance too low",
    "provider at capacity, retry later",
    "HTTP 429 Too Many Requests",
  ]) {
    assert.equal(looksLikeRateLimit(text), true, `expected "${text}" to look like a rate limit`);
  }
  for (const text of ["File not found", "Schema decode failed for keybindings", "TypeError: undefined is not a function"]) {
    assert.equal(looksLikeRateLimit(text), false, `expected "${text}" NOT to look like a rate limit`);
  }
  assert.equal(looksLikeRateLimit(undefined), false);
});

test("schedule add persists an entry and cancel keeps a decision by unique prefix", async () => {
  const directory = isolatedDirectory();
  process.env.T3CTL_CONFIG_DIR = directory;
  const { scheduleAdd, scheduleCancel, scheduleList } = await import("../dist/schedule.js");

  const entry = await scheduleAdd({
    format: "json",
    threadId: "thr_test",
    message: "Resume the task",
    in: "90m",
    retryUntil: "2h",
    retryInterval: "30m",
    provider: "codex_personal",
    model: "gpt-5.6-luna",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ],
  });
  assert.equal(entry.state, "pending");
  assert.equal(entry.attempts, 0);
  assert.ok(entry.serverUrl, "the resolved server URL is pinned at add time");
  assert.equal(new Date(entry.retryUntil).getTime() - new Date(entry.dueAt).getTime(), 2 * 60 * 60 * 1000);
  assert.equal(entry.retryIntervalMs, 30 * 60 * 1000);
  assert.deepEqual(entry.options, [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ]);

  const stored = JSON.parse(readFileSync(join(directory, "schedule.json"), "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0].threadId, "thr_test");
  assert.deepEqual(stored.entries[0].options, [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ]);

  const second = await scheduleAdd({ format: "json", threadId: "thr_other", message: "Follow up", in: "5h" });
  const listed = await scheduleList({ format: "json" });
  assert.equal(listed.schedules.length, 2);

  // Cancel by a unique prefix (all but the last character, since both entries
  // share the same timestamp segment), as printed by schedule add/list.
  const cancelled = await scheduleCancel({ format: "json", scheduleId: second.id.slice(0, -1) });
  assert.equal(cancelled.id, second.id);
  assert.equal(cancelled.state, "cancelled");

  const afterCancel = await scheduleList({ format: "json" });
  assert.equal(afterCancel.schedules.length, 1);
  assert.equal(afterCancel.schedules[0].id, entry.id);
  const withAll = await scheduleList({ format: "json", all: true });
  assert.equal(withAll.schedules.length, 2);

  // An ambiguous prefix reports the matches instead of guessing.
  await assert.rejects(
    scheduleCancel({ format: "json", scheduleId: "sched" }),
    (error) => error.code === "schedule_ambiguous",
  );
  // Terminal states cannot be cancelled twice.
  await assert.rejects(
    scheduleCancel({ format: "json", scheduleId: second.id }),
    (error) => error.code === "schedule_not_cancellable",
  );
  await assert.rejects(
    scheduleCancel({ format: "json", scheduleId: "sched_does_not_exist" }),
    (error) => error.code === "schedule_missing",
  );
});

test("a corrupt schedule store surfaces a structured error instead of crashing", async () => {
  const directory = isolatedDirectory();
  process.env.T3CTL_CONFIG_DIR = directory;
  const { loadScheduleEntries } = await import("../dist/schedule.js");
  const { ConfigError } = await import("../dist/config.js");

  assert.deepEqual(loadScheduleEntries(), []); // Missing file means an empty schedule.

  writeFileSync(join(directory, "schedule.json"), "{not json");
  assert.throws(() => loadScheduleEntries(), (error) => error instanceof ConfigError && error.code === "schedule_store_read_failed");

  writeFileSync(join(directory, "schedule.json"), JSON.stringify({ version: 1, entries: [{ id: "x" }] }));
  assert.throws(() => loadScheduleEntries(), (error) => error.code === "schedule_store_invalid");

  writeFileSync(join(directory, "schedule.json"), JSON.stringify({ version: 1, entries: [{ id: "x", threadId: "t", message: "m", dueAt: "nope", state: "pending", attempts: 0, createdAt: "2026-09-03T00:00:00.000Z" }] }));
  assert.throws(() => loadScheduleEntries(), (error) => error.code === "schedule_store_invalid");
});

test("due selection, retry deadlines, and stale-running reset are pure decisions", async () => {
  const { dueEntries, resetStaleRunning, retryDeadlinePassed, nextRetryAt, DEFAULT_RETRY_INTERVAL_MS } = await import("../dist/schedule.js");
  const now = new Date("2026-09-03T12:00:00.000Z");
  const iso = (offsetMinutes) => new Date(now.getTime() + offsetMinutes * 60 * 1000).toISOString();
  const entry = (overrides) => ({
    id: "sched_x",
    threadId: "thr_x",
    message: "Resume",
    dueAt: iso(0),
    state: "pending",
    attempts: 0,
    createdAt: iso(-10),
    ...overrides,
  });

  const entries = [
    entry({ id: "past", dueAt: iso(-5) }),
    entry({ id: "future", dueAt: iso(5) }),
    entry({ id: "sent-but-past", dueAt: iso(-9), state: "sent" }),
  ];
  assert.deepEqual(dueEntries(entries, now).map((candidate) => candidate.id), ["past"]);
  // Sorted by due time when several are due.
  const several = [entry({ id: "later", dueAt: iso(-1) }), entry({ id: "earlier", dueAt: iso(-2) })];
  assert.deepEqual(dueEntries(several, now).map((candidate) => candidate.id), ["earlier", "later"]);

  assert.equal(retryDeadlinePassed(entry({ retryUntil: iso(-1) }), now), true);
  assert.equal(retryDeadlinePassed(entry({ retryUntil: iso(1) }), now), false);
  assert.equal(retryDeadlinePassed(entry({}), now), false);

  assert.equal(new Date(nextRetryAt(entry({}), now)).getTime(), now.getTime() + DEFAULT_RETRY_INTERVAL_MS);
  assert.equal(new Date(nextRetryAt(entry({ retryIntervalMs: 60_000 }), now)).getTime(), now.getTime() + 60_000);

  // A crashed runner leaves `running` entries behind; they go back to pending.
  const stale = [entry({ id: "stuck", state: "running" }), entry({ id: "done", state: "sent" })];
  const reset = resetStaleRunning(stale);
  assert.equal(reset.find((candidate) => candidate.id === "stuck").state, "pending");
  assert.equal(reset.find((candidate) => candidate.id === "done").state, "sent");
});

test("claimPendingEntry claims pending entries and rejects cancelled, running, or missing entries", async () => {
  const directory = isolatedDirectory();
  process.env.T3CTL_CONFIG_DIR = directory;
  const { scheduleAdd, scheduleCancel, claimPendingEntry } = await import("../dist/schedule.js");

  const entry = await scheduleAdd({ format: "json", threadId: "thr_claim", message: "Claim test", in: "10m" });
  const claimed = claimPendingEntry(entry);
  assert.ok(claimed);
  assert.equal(claimed.state, "running");
  assert.equal(claimed.attempts, 1);

  // Cannot claim an entry that is already running
  assert.equal(claimPendingEntry(entry), undefined);

  // Cancelled entry cannot be claimed
  const second = await scheduleAdd({ format: "json", threadId: "thr_claim_2", message: "Cancel claim test", in: "10m" });
  await scheduleCancel({ format: "json", scheduleId: second.id });
  assert.equal(claimPendingEntry(second), undefined);

  // Missing entry returns undefined
  assert.equal(claimPendingEntry({ id: "sched_missing" }), undefined);
});

