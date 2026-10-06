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

Thread listing returns `{ "threads": [...] }`, project listing returns `{ "projects": [...] }`, model listing returns `{ "providers": [...] }`, and scheduled-task listing returns `{ "tasks": [...] }`. A scheduled task is the server's own record (the CLI stores nothing locally):

```json
{
  "id": "scheduled-task:...",
  "title": "Nightly triage",
  "prompt": "Summarize new issues",
  "enabled": true,
  "schedule": { "type": "fixed_time", "timeOfDay": "09:30", "weekdays": [1, 2, 3, 4, 5] },
  "projectId": "project_...",
  "threadId": null,
  "workspaceStrategy": { "type": "root" },
  "modelSelection": { "instanceId": "codex_personal", "model": "gpt-5.6-luna" },
  "runtimeMode": "full-access",
  "interactionMode": "default",
  "nextRunAt": "2026-09-04T09:30:00.000Z",
  "lastRunAt": null,
  "lastRunStatus": "never",
  "runCount": 0
}
```

`schedule.type` is `interval` (`everyMs`), `fixed_time` (`timeOfDay`, optional `weekdays`), or `webhook` (with an optional HMAC `signature` and a `webhook` endpoint block). `thread wait` results carry an `errorText` field (the provider failure message observed on the thread) when the turn failed.

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

## Scheduled tasks

Scheduling runs on the T3 Code server, so the CLI keeps no local queue and needs no long-running runner. `t3ctl schedule add` maps to `scheduledTasks.upsert`; `--every` becomes an `interval` trigger, `--at` a `fixed_time` trigger, and `--webhook` a `webhook` trigger. Exactly one is required.

```sh
t3ctl schedule add --project my-project --every 1h --message "Check for new failures"
t3ctl schedule add --thread <id> --at 09:30 --weekdays mon,tue,wed,fri --message "Standup summary"
t3ctl schedule list
t3ctl schedule disable <id>
t3ctl schedule run <id>          # fire once, now
t3ctl schedule deliveries <id>   # webhook delivery log
t3ctl schedule cancel <id>       # delete
```

`t3ctl schedule subscribe` streams the current task list as NDJSON (`schedule.snapshot` records) whenever it changes. Error codes specific to this feature: `schedule_missing`, `schedule_ambiguous`, and `cli_parse_failed` for an invalid trigger.

## Usage and quota

`t3ctl usage` reports token and cost buckets from `server.getUsageSummary`; `--hourly` switches the resolution and `--since`/`--until`/`--timezone` bound the window. `t3ctl usage refresh-rates` refreshes the price table used for cost estimates.

`t3ctl provider limits` lists each provider's subscription windows (`usedPercent`, `resetsAt`) and any banked reset credits, read from `server.getConfig`. `t3ctl provider reset-credit <provider>` redeems one via `provider.consumeResetCredit`.
