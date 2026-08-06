# T3 Code CLI

`t3ctl` is a command-line client for T3 Code environments. It supports interactive terminal use and automation through stable JSON and NDJSON output.

## Install and configure

```sh
git clone --recursive git@github.com:andrewbrazzatti/t3code-cli.git
# or if already cloned: git submodule update --init --recursive

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
project list | add | clone | update | delete
thread list | create | start | send | wait | watch | view | transcript
thread archive | unarchive | delete | update | interrupt | settle | unsettle | respond | respond-input
```

Thread creation and updates support `--provider`, `--model`, `--runtime-mode`, `--interaction-mode`, and provider options such as `--option effort=max` or `--effort high`. Project and thread selectors accept IDs, titles, and workspace-root names where applicable.

## Verification

```sh
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```
