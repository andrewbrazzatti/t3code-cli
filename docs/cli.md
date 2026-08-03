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

Thread listing returns `{ "threads": [...] }`, project listing returns `{ "projects": [...] }`, and model listing returns `{ "providers": [...] }`.

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
