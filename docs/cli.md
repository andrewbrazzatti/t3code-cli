# CLI machine-readable contract

The CLI uses JSON objects for one-shot commands and one JSON object per line for live streams. Fields below are stable v1 fields; command-specific payloads may add fields.

## Result envelope

Successful one-shot results are command objects. Common identifiers use the following shape:

```json
{
  "id": "thread_...",
  "threadId": "thread_...",
  "projectId": "project_..."
}
```

Thread listing returns `{ "threads": [...] }`, project listing returns `{ "projects": [...] }`, model listing returns `{ "providers": [...] }`, and schedule listing returns `{ "schedules": [...] }` with entries shaped as:

```json
{
  "id": "sched_...",
  "environment": "production",
  "threadId": "thread_...",
  "message": "Resume the task",
  "dueAt": "2026-09-03T18:00:00.000Z",
  "retryUntil": "2026-09-03T20:00:00.000Z",
  "retryIntervalMs": 900000,
  "state": "pending",
  "attempts": 0,
  "createdAt": "2026-09-03T12:00:00.000Z"
}
```

`environment` is set when the entry is pinned to a named environment; otherwise `serverUrl` is pinned instead. States are `pending`, `running`, `sent`, `failed`, and `cancelled`. `thread wait` results also carry an `errorText` field (the last failure reason observed on the thread) when the turn failed, which `schedule run` uses to decide rate-limit retries.

## Error envelope

Errors are written to stderr and never include credentials:

```json
{
  "version": 1,
  "error": {
    "code": "credential_missing",
    "message": "No credential is available for environment \"production\"."
  }
}
```

Useful codes include `config_invalid`, `legacy_config_rejected`, `credential_missing`, `environment_missing`, `server_url_invalid`, `auth_exchange_failed`, `thread_missing`, and `command_failed`.

## NDJSON lifecycle records

`thread wait` and `thread watch` emit records such as:

```json
{"version":1,"type":"thread.snapshot","timestamp":"2026-08-03T00:00:00.000Z","threadId":"thread_1","thread":{}}
{"version":1,"type":"thread.event","timestamp":"2026-08-03T00:00:01.000Z","threadId":"thread_1","event":{"type":"thread.activity-appended"}}
{"version":1,"type":"thread.completed","timestamp":"2026-08-03T00:00:02.000Z","threadId":"thread_1","status":"completed"}
```

The terminal `status` values are `completed`, `interrupted`, `failed`, and `approval_required`. Malformed server stream items are surfaced as `thread.malformed_event` records instead of being silently discarded.

Wait exit codes are `0` for completed, `10` when approval or user input is required, `130` when interrupted, and `1` for a failed turn or transport failure.

## Scheduled send events

`t3ctl schedule run` emits one record per state transition:

```json
{"version":1,"type":"schedule.fired","timestamp":"2026-09-03T18:00:00.000Z","scheduleId":"sched_1","threadId":"thread_1","attempt":1,"dueAt":"2026-09-03T18:00:00.000Z","firedAt":"2026-09-03T18:00:00.100Z"}
{"version":1,"type":"schedule.sent","timestamp":"2026-09-03T18:05:00.000Z","scheduleId":"sched_1","threadId":"thread_1","status":"completed"}
{"version":1,"type":"schedule.rescheduled","timestamp":"2026-09-03T18:02:00.000Z","scheduleId":"sched_2","threadId":"thread_2","error":"usage limit reached","nextAttemptAt":"2026-09-03T18:17:00.000Z"}
{"version":1,"type":"schedule.failed","timestamp":"2026-09-03T18:03:00.000Z","scheduleId":"sched_3","threadId":"thread_3","error":"File not found"}
```

`schedule run --once` exits `0` when every fired entry ended `sent` (or was rescheduled for a later retry) and `1` when any entry ended `failed`. Error codes specific to this feature: `schedule_missing`, `schedule_ambiguous`, `schedule_not_cancellable`, `schedule_store_read_failed`, and `schedule_store_invalid`.
