# T3 Code CLI

`t3ctl` is a command-line client for T3 Code environments. It supports interactive terminal use and automation through stable JSON and NDJSON output.

## Install and configure

```sh
git clone git@github.com:andrewbrazzatti/t3code-cli.git
cd t3code-cli
git submodule update --init

pnpm install
pnpm build
node bin/t3ctl.js --help
```

The default configuration is `~/.config/t3code-cli/config.json`. Set `T3CTL_CONFIG_DIR` for an isolated profile or tests. Configuration is versioned and contains environment URLs and credential references only; access tokens are never written to `config.json`.

## Authentication

Pair from a T3 Code pairing URL (the token may also be supplied explicitly):

```sh
t3ctl auth pair 'http://127.0.0.1:3000/pair#token=PAIRING_TOKEN' --name local
t3ctl auth pair 'https://server.example/pair#token=PAIRING_TOKEN' --name production
```

For a local or headless environment:

```sh
t3ctl auth local --server-url http://127.0.0.1:3000 --token BOOTSTRAP_TOKEN
t3ctl auth local --server-url http://127.0.0.1:3000 --access-token ACCESS_TOKEN
t3ctl auth status
```

Credentials are stored in the native macOS Keychain or Linux Secret Service when available. If no keyring is available, they are stored in an AES-256-GCM encrypted file with restrictive permissions. Use `T3CTL_CREDENTIAL_BACKEND=encrypted-file` to force the fallback in a controlled environment. The fallback key is kept separately with mode `0600`; `T3CTL_CREDENTIAL_KEY` can supply a deployment-managed key.

Select an environment with `--env NAME` or `T3CTL_ENV`, or change the active environment with `t3ctl env use NAME`.

## Output and automation

Every command accepts `--format auto|human|json|ndjson`. `auto` uses human output on a terminal and JSON for one-shot non-interactive commands. `watch` and `wait` use NDJSON for lifecycle events.

```sh
THREAD_ID=$(t3ctl thread start --format json --project my-project --title automation --message 'Run the tests' | jq -r .threadId)
t3ctl thread wait "$THREAD_ID" --format ndjson
t3ctl thread transcript "$THREAD_ID" --format json
t3ctl thread send "$THREAD_ID" --format json --message 'Now summarize the result'
```

Prompts can be positional, passed with `--message`/`--prompt`, or piped through stdin:

```sh
printf '%s\n' 'Inspect the repository' | t3ctl thread start --format json --project my-project
```

Machine-readable errors have the stable shape:

```json
{
  "version": 1,
  "error": { "code": "credential_missing", "message": "..." }
}
```

NDJSON stream records use `version`, `type`, `timestamp`, and command-specific fields. Important lifecycle types include `thread.snapshot`, `thread.event`, `thread.malformed_event`, and `thread.completed`. A wait can finish with `completed`, `interrupted`, `failed`, or `approval_required`.

## Command reference

```text
auth pair | local | status
env list | use | remove
models [--provider NAME]
provider credentials get | set
provider limits | reset-credit
project list | add | clone | update | delete
thread list | create | start | send | wait | watch | view | transcript
thread archive | unarchive | delete | update | interrupt | settle | unsettle | respond | respond-input
thread search | fork | pin | unpin | visit
terminal attach | list | close
schedule add | list | enable | disable | cancel | run | deliveries | rotate-webhook | subscribe
usage [--since D --until D] | refresh-rates
file list | read | write | search | find
diff turn | thread | review
device list | open | close | shutdown | detail | configure | test-host | action
sessions scan | import
pr list | detail | checks | stack | threads | comment | review | update
preview list | open | navigate | resize | refresh | close
attach upload | delete
acp search | prepare | uninstall | logout | sessions | import-session | delete-session | providers | set-provider | disable-provider
server probe | trace | processes | process-history | host-resources | resource-history | retry-telemetry | signal | background-policy
secret answer
provider auth start | complete | cancel | logout
provider install start | cancel | remove
thread rollback
```

Thread creation and updates support `--provider`, `--model`, `--runtime-mode`, `--interaction-mode`, and provider options such as `--option effort=max` or `--effort high`. Project and thread selectors accept IDs, titles, and workspace-root names where applicable.

## Terminals

Open an interactive shell on a thread's worktree (or its project root):

```sh
t3ctl terminal attach <thread-id>
t3ctl terminal attach <thread-id> --cwd /path/to/dir --env-var FOO=bar
t3ctl terminal list <thread-id>
t3ctl terminal close <thread-id> --terminal-id term-1 --delete-history
```

Terminals are thread-scoped on the server. `attach` requires an existing thread and an interactive TTY; it forwards keystrokes and control sequences, reports resizes, and returns the remote shell's exit code.

## Scheduled tasks

Schedules run on the T3 Code server, so the CLI keeps no local queue and needs no long-running runner. `schedule add` takes exactly one trigger: `--every DURATION` (interval, minimum 1m), `--at HH:MM` with optional `--weekdays`, or `--webhook`.

```sh
t3ctl schedule add --project my-project --every 1h --message "Check for new failures"
t3ctl schedule add --thread <id> --at 09:30 --weekdays mon,tue,wed,fri --message "Standup summary"
t3ctl schedule list
t3ctl schedule run <id>          # fire once, now
t3ctl schedule cancel <id>       # delete
```

## Usage and quota

```sh
t3ctl usage                      # token/cost buckets, last 7 days
t3ctl usage --since 2026-09-01 --until 2026-09-30 --hourly
t3ctl provider limits            # subscription windows and reset times
t3ctl provider reset-credit codex_personal
```

## Files, diffs, and search

```sh
t3ctl file list --project my-project
t3ctl file read --project my-project src/index.ts
t3ctl file search --project my-project "TODO" --regex
t3ctl file write --project my-project notes.md --contents "hello"
t3ctl diff review --project my-project [--base-ref main]
t3ctl diff turn <thread-id> --from 1 --to 3
t3ctl thread search "flaky test" --limit 10
```

`file` and `diff review` operate on a project's workspace (`--project`) or an explicit `--cwd`.

## Devices, sessions, and pull requests

```sh
t3ctl device list --inspect-only
t3ctl device open <device-id> --thread <id> --platform ios
t3ctl sessions scan
t3ctl sessions import my-project
t3ctl pr list --state open --involvement authored
t3ctl pr detail pingdotgg/t3code#123 --project my-project
```

Device commands drive iOS simulators and Android emulators on this host or on SSH device hosts, scoped to a thread. `sessions` imports existing Claude Code / Codex history. `pr` lists and acts on GitHub/Bitbucket change requests; identify one with `owner/name#N` or `--repository`/`--number`.

## Preview, attachments, and secrets

```sh
t3ctl preview list <thread-id>
t3ctl preview open <thread-id> --url http://localhost:5173 --width 1280 --height 800
t3ctl preview navigate <thread-id> --tab-id tab-1 --url http://localhost:5173/settings
t3ctl preview close <thread-id> --tab-id tab-1
t3ctl attach upload ./diagram.pdf              # prints persisted attachment ids
t3ctl attach delete <attachment-id>
t3ctl secret answer <thread-id> --turn-item-id item-1 --secret "$TOKEN"
```

## Provider setup, ACP registry, and diagnostics

```sh
t3ctl provider auth logout codex_personal
t3ctl provider install start codex_personal
t3ctl acp search claude
t3ctl acp providers <instance-id> --project my-project
t3ctl server host-resources
t3ctl server process-history --window 1h --bucket 5m
t3ctl server trace
```

## Verification

```sh
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```
