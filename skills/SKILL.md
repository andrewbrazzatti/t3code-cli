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
