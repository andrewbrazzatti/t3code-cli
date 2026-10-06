---
name: t3ctl
description: Control T3 Code environments, manage projects, execute threads, pair/authenticate with T3 Code servers, and automate workflows via the t3ctl CLI. Use when running t3ctl commands, managing T3 Code environments, managing projects/threads, or automating T3 Code tasks.
---

# T3 Code CLI (`t3ctl`)

This document describes how to use `t3ctl` (also named `t3code-cli`).
`t3ctl` is a command-line client for T3 Code environments.
Use `t3ctl` to operate servers, manage projects, run threads, and automate tasks.

---

## Installation and Setup

`bin/t3ctl.js` loads from `dist/`, so the build is a prerequisite, not an
alternative. Running it from a fresh checkout without building fails with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

1. Install dependencies and build:
```sh
pnpm install
pnpm build
```

2. Run the CLI:
```sh
node bin/t3ctl.js --help
```

3. Or, once linked, run the binary directly:
```sh
t3ctl --help
```

---

## Discovering Commands and Flags

`--help` is scoped to the command it follows. Use it rather than guessing flag
names — unknown flags are rejected, and the error lists what the command
accepts.

```sh
t3ctl --help                  # command index
t3ctl thread start --help     # flags for thread start
```

Model selection is `--provider <instanceId> --model <model>`, e.g.
`--provider opencode --model opencode-go/deepseek-v4-flash`.

---

## Configuration and Authentication

`t3ctl` saves settings in `~/.config/t3code-cli/config.json`.
Set `$T3CTL_CONFIG_DIR` to use a custom configuration directory.
`t3ctl` stores credentials in the OS Keychain or in an encrypted fallback file.

### Pair or Authenticate with a Server

1. Pair with a server URL:
```sh
t3ctl auth pair 'http://127.0.0.1:3773/pair#token=PAIRING_TOKEN' --name local
t3ctl auth pair 'https://server.example.com/pair#token=PAIRING_TOKEN' --name production
```

2. Authenticate with a local bootstrap token:
```sh
t3ctl auth local --server-url http://127.0.0.1:3773 --token BOOTSTRAP_TOKEN
```

3. Authenticate with an access token:
```sh
t3ctl auth local --server-url http://127.0.0.1:3773 --access-token ACCESS_TOKEN
```

### Manage Environments

1. Show authentication status and active environments:
```sh
t3ctl auth status
```

2. List all configured environments:
```sh
t3ctl env list
```

3. Set the active environment:
```sh
t3ctl env use production
```

4. Remove an environment and delete its saved credentials:
```sh
t3ctl env remove old-env
```

---

## Output Formats

Every command accepts the `--format` option.
Valid values are `auto`, `human`, `json`, and `ndjson`.

- **`auto`**: Default. Selects `human` format in a terminal. Selects `json` format in non-interactive scripts.
- **`human`**: Displays readable text with bullet points and tables.
- **`json`**: Outputs a single JSON object (`{"version": 1, ...}`).
- **`ndjson`**: Emits line-delimited JSON events. Use for streams.

---

## Manage Projects (`project`)

Use the `project` command to manage code workspaces.

1. List all projects:
```sh
t3ctl project list --format human
```

2. Add a local directory as a project:
```sh
t3ctl project add /path/to/repo --title "My App"
```

3. Clone a repository and register a project:
```sh
t3ctl project clone git@github.com:owner/repo.git /path/to/dest --title "Cloned App"
```

4. Update project settings:
```sh
t3ctl project update <project-id> --title "New Title" --provider anthropic --model claude-3-5-sonnet
```

5. Delete a project:
```sh
t3ctl project delete <project-id> --force
```

---

## Manage Models (`models`)

List AI providers and models on the server.

1. List all providers and models:
```sh
t3ctl models
```

2. Filter models by provider:
```sh
t3ctl models --provider anthropic
```

---

## Manage Threads (`thread`)

Use the `thread` command to run and inspect AI agent threads.

### Start and Run Threads

1. Start a thread and wait for completion:
```sh
t3ctl thread start --project my-project --message "Run tests" --wait
```

2. Start a thread non-interactively:
```sh
t3ctl thread start --project my-project --message "Refactor code" --format json
```

3. Pass a prompt from standard input:
```sh
cat prompt.txt | t3ctl thread start --project my-project --format json
```

### Run a Thread in a Git Worktree

1. Start a thread in a fresh server-managed worktree (branched from the repo's
   default branch, project setup script included):
```sh
t3ctl thread start --project my-project --message "Refactor code" --worktree
```

2. Control the base and the branch, optionally starting from `origin`:
```sh
t3ctl thread start --project my-project --message "Run tests" --worktree --base-branch main --from-origin --branch t3code/my-feature
```

3. Attach an existing directory as the thread's worktree instead of creating one:
```sh
t3ctl thread start --project my-project --message "Review it" --worktree-path /path/to/worktree
```

4. Create a thread in a worktree without starting a turn (`--from-origin` is
   not available here; only `thread start` prepares worktrees during turn start):
```sh
t3ctl thread create --project my-project --title "Worktree thread" --worktree --base-branch main
```

The JSON result includes the resolved `worktreePath` and `branch`.
`--worktree` and `--worktree-path` are mutually exclusive.

### Interact with Threads

1. Send a message to an active thread:
```sh
t3ctl thread send <thread-id> --message "Fix the build" --wait
```

2. Wait for thread completion:
```sh
t3ctl thread wait <thread-id> --format ndjson
```

3. Watch thread lifecycle events:
```sh
t3ctl thread watch <thread-id>
```

4. Approve a user request:
```sh
t3ctl thread respond <thread-id> --request-id <req-id> --decision approve
```

5. Submit answers for a user prompt:
```sh
t3ctl thread input <thread-id> --request-id <req-id> --answers '{"choice":"yes"}'
```

6. Interrupt a running turn:
```sh
t3ctl thread interrupt <thread-id>
```

### Inspect and Delete Threads

1. List threads:
```sh
t3ctl thread list [<project-id>]
```

2. View thread details:
```sh
t3ctl thread view <thread-id>
```

3. Show full thread transcript:
```sh
t3ctl thread transcript <thread-id> --format json
```

4. Archive a thread:
```sh
t3ctl thread archive <thread-id>
```

5. Unarchive a thread:
```sh
t3ctl thread unarchive <thread-id>
```

6. Delete a thread:
```sh
t3ctl thread delete <thread-id>
```

---

## Scheduled Tasks (`schedule`)

Schedules run on the T3 Code server, not the CLI: there is no local queue and
no runner process to keep alive. Each task launches a new thread or messages an
existing one on its trigger.

`schedule add` requires exactly one trigger:

- `--every DURATION` — interval, minimum `1m` (`45m`, `2h30m`, `1d12h`).
- `--at HH:MM` — a local wall-clock time, optionally `--weekdays 0,1,2`
  (0=Sunday) or `--weekdays mon,tue,wed,fri`.
- `--webhook` — fires on each request to the task's webhook URL.

1. Launch a new thread on an interval in a project:
```sh
t3ctl schedule add --project my-project --every 1h --message "Check for new failures"
```

2. Message an existing thread on weekday mornings:
```sh
t3ctl schedule add --thread <thread-id> --at 09:30 --weekdays mon,tue,wed,thu,fri --message "Standup summary"
```

3. Create it disabled, then enable it when ready:
```sh
t3ctl schedule add --project my-project --every 1h --message "..." --disabled
t3ctl schedule enable <id>
```

4. Inspect and manage:
```sh
t3ctl schedule list                 # all tasks
t3ctl schedule run <id>             # fire once, now
t3ctl schedule deliveries <id>      # webhook delivery log
t3ctl schedule rotate-webhook <id>  # rotate the secret URL token
t3ctl schedule cancel <id>          # delete (unique id prefix works)
t3ctl schedule subscribe            # stream changes as NDJSON
```

Behavior notes:

- `--project` launches new threads; `--thread` messages an existing thread and
  derives the project from it. Model/mode flags (`--provider`, `--model`,
  `--runtime-mode`, ...) are accepted, as are the thread worktree flags
  (`--worktree`, `--base-branch`, ...) when launching new threads.
- The trigger is server state: tasks fire even when no CLI is running, and
  survive across environments by ID.
- `--id <id>` updates an existing task in place instead of creating one.
- Trigger parse errors surface as `cli_parse_failed`; unknown/ambiguous ids as
  `schedule_missing`/`schedule_ambiguous`.

---

## Usage and Quota (`usage`, `provider`)

```sh
t3ctl usage                       # token/cost buckets, last 7 days
t3ctl usage --since 2026-09-01 --until 2026-09-30 --hourly
t3ctl usage refresh-rates         # refresh the model price table
t3ctl provider limits             # subscription windows (usedPercent, resetsAt) and reset credits
t3ctl provider reset-credit codex_personal
```

`usage` reads `server.getUsageSummary`; `provider limits` reads the provider
snapshots from `server.getConfig`, and `provider reset-credit` redeems a banked
reset credit via `provider.consumeResetCredit`.

---

## Files and Diffs (`file`, `diff`)

`file` and `diff review` operate on a project's workspace (`--project`) or an
explicit absolute `--cwd`.

```sh
t3ctl file list --project my-project
t3ctl file list --project my-project --directory src
t3ctl file read --project my-project src/index.ts
t3ctl file write --project my-project notes.md --contents "hello"   # or pipe stdin
t3ctl file search --project my-project "TODO" --regex --limit 50
t3ctl file find --project my-project --kind file --limit 50
t3ctl diff review --project my-project [--base-ref main] [--ignore-whitespace]
t3ctl diff turn <thread-id> --from 1 --to 3
t3ctl diff thread <thread-id> --to 5
```

`file write` contents come from `--contents` or stdin. `diff review` returns the
working-tree and branch-range sources with per-file stats; `diff turn`/`diff
thread` return a thread's checkpoint diff.

## Thread Search and Organization (`thread`)

```sh
t3ctl thread search "flaky test" --limit 10   # searches user + assistant history
t3ctl thread fork <thread-id> [--title "Fork"] # fork from the latest stable point
t3ctl thread pin <thread-id> | thread unpin <thread-id>
t3ctl thread visit <thread-id>                 # mark read up to now
```

## Devices (`device`)

Drives iOS simulators and Android emulators on this host or on SSH device
hosts. Devices are thread-scoped: `open` attaches one to a thread.

```sh
t3ctl device list [--inspect-only]
t3ctl device open <device-id> --thread <id> --platform ios [--host-id H] [--no-boot]
t3ctl device detail <device-id> [--host-id H]
t3ctl device close <device-id> --thread <id> [--shutdown]
t3ctl device shutdown <device-id> --platform android
t3ctl device configure --enable --agent-access
t3ctl device test-host <host-id> --target user@host [--port 22]
t3ctl device action --json '{"deviceId":"...","type":"setAppearance","value":"dark"}'
```

## Import Agent Sessions (`sessions`)

```sh
t3ctl sessions scan              # directories the Claude Code / Codex CLIs ran in
t3ctl sessions import my-project # fold native history into the thread list
```

## Pull Requests (`pr`)

Identify a pull request with `owner/name#N`, a PR URL, or
`--repository owner/name --number N`; `--project` is required.

```sh
t3ctl pr list [--state open|closed|merged|all] [--involvement authored|reviewing|all] [--limit N]
t3ctl pr detail pingdotgg/t3code#123 --project my-project
t3ctl pr checks|stack|threads <ref> --project my-project
t3ctl pr comment <ref> --project my-project --body "Nice work"
t3ctl pr review  <ref> --project my-project --verdict approve --body "LGTM"
t3ctl pr update  <ref> --project my-project --title "New title"
```

---

## Automation Examples

### Shell Script Example

```sh
#!/usr/bin/env bash
set -euo pipefail

# Start a thread and get the thread ID
THREAD_ID=$(t3ctl thread start --format json --project my-project --message "Run tests" | jq -r .threadId)

# Wait for thread completion
t3ctl thread wait "$THREAD_ID" --format ndjson

# Get the transcript
t3ctl thread transcript "$THREAD_ID" --format json > transcript.json
```

### Environment Overrides

1. Override server URL for one command:
```sh
t3ctl project list --server-url http://192.168.1.100:3773 --token MY_TOKEN
```

2. Override target environment with an environment variable:
```sh
T3CTL_ENV=production t3ctl project list
```
