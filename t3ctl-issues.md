# t3ctl — issues and interface notes

Found while driving `t3ctl` to launch an implementation thread on 2026-08-06.
Environment: macOS, `t3ctl` v0.2.0.

**Status:** §2, §3, §4, §6, and §7 are fixed in `~/source/personal/t3code-ctl` (the checkout
`t3ctl` is linked to). §4 is also applied to the deployed skill copy at
`~/.agents/skills/t3ctl/SKILL.md`. §1 is mitigated but not cured — the root cause
is upstream. A fifth issue turned up while fixing the others and is recorded as §5.

---

## 1. `models` is unusable — config schema mismatch

`t3ctl models` and `t3ctl models --provider <name>` both fail, on **every** environment
(`local`, `agentv`), with:

```json
{"version":1,"error":{"code":"command_failed","message":"Expected \"sidebar.toggle\" | ... | \"thread.jump.9\", got \"filePicker.toggle\"\n  at [\"value\"][\"keybindings\"][42][\"command\"]"}}
```

The CLI validates the fetched app settings against a keybinding-command enum that does not
include `filePicker.toggle`, which is present at index 42 of `~/.t3/userdata/keybindings.json`.
The installed CLI's contract schema is older than the app config it reads.

**Impact:** there is no way to discover valid provider instance IDs or model names through the
CLI. Both had to be sourced out-of-band from `~/.t3/userdata/settings.json` and `opencode models`.

**Fix applied (mitigation only):** `listModels` now recognises a decode failure and reports it as
`version_mismatch` with an actionable message, instead of dumping the enum:

> This t3ctl is older than the T3 Code server it is talking to, so it cannot decode the server
> config (unrecognised value "filePicker.toggle" at ["value"]["keybindings"][42]["command"]).
> Update t3ctl to match the server, or read the provider and model IDs from
> ~/.t3/userdata/settings.json in the meantime.

**Still outstanding upstream.** The real fix belongs in
`vendor/t3code/packages/contracts/src/keybindings.ts`, which is a submodule of
`pingdotgg/t3code` — not ours to patch. A closed enum over the desktop app's keybinding commands
will break the CLI every time the app adds a command, and the CLI never reads that field. Making
it a plain string (or making `serverGetConfig` decode leniently) is the durable fix.

## 2. Unknown flags are silently accepted

`thread update --instance opencode --model X` reports `"updated":true` and returns a
`modelSelection` with an `instanceId` that was never requested:

```json
{"threadId":"...","updated":true,"fields":{"modelSelection":{"instanceId":"codex_personal","model":"opencode-go/deepseek-v4-flash"}}}
```

`--instance` is not part of the documented interface (`--provider` is), but instead of being
rejected it passes silently and the command reports success. The same happened with
`--instance-id`. A scripted job would run on the wrong provider with no error.

**Fixed.** `src/commands.ts` now declares the accepted flags per command, and `assertKnownFlags`
rejects anything else with `cli_parse_failed`, listing what the command does accept:

```
Unknown flag "--instance" for "t3ctl thread update".

Accepted: --branch, --effort, --env, --fast-mode, --format, --help, --interaction-mode, --model,
--option, --provider, --runtime-mode, --server-url, --thread, --title, --token, --version,
--worktree-path

Run "t3ctl thread update --help" for details.
```

## 3. `--help` is incomplete

The top-level `--help` output is identical for every subcommand — `t3ctl thread start --help`,
`t3ctl project add --help`, and `t3ctl thread create --help` all print the same global summary
rather than per-command flags. Required arguments are only discoverable by running the command
and reading the error (`Missing required argument --project`, then `--title`, and so on).

`env list` / `env use` / `env remove` are documented in the skill's SKILL.md but appear nowhere
in `--help`.

**Fixed.** The same `src/commands.ts` table drives help, so it cannot drift from what's actually
accepted. `t3ctl <command> --help` now prints that command's flags with descriptions, and the
top-level help gained the `env` group, the `auth use`/`auth remove` subcommands, and a pointer to
per-command help.

## 4. The skill copy can't run as shipped

`~/.agents/skills/t3ctl/SKILL.md` says to run `node bin/t3ctl.js`, but doing so fails:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported
for files under node_modules, for ".../node_modules/@t3tools/contracts/src/index.ts"
```

It needs `pnpm build` first (which SKILL.md did list as step 1, but the "run directly" step read
as an alternative rather than a dependency).

**Fixed** in `skills/SKILL.md`: the build is now stated as a prerequisite with the exact error you
get without it, and a "Discovering Commands and Flags" section documents scoped `--help` and the
`--provider`/`--model` pair.

## 5. `pnpm test` ran the entire vendored monorepo

Found while fixing the above. `package.json` had `"test": "pnpm build && node --test"` with no
path, so Node's test discovery walked the whole working tree — **2233 test files, 2228 of them in
`vendor/t3code`** (including the bundled `effect-smol` checkout). The suite never terminated; it
had been silently broken since the vendor submodule landed in `f14d6b3`.

**Fixed:** scoped to `node --test test/*.test.js`. Full suite now runs in ~0.25s, 14 passing.

Note that `node --test test/` (bare directory) does *not* work on Node 24 — it resolves the path
as a module and fails with `MODULE_NOT_FOUND`. The glob is required.

## 6. Threads could not be started in a worktree

The server fully supports worktree threads — `thread.turn.start` accepts a `bootstrap` payload
(`createThread` + `prepareWorktree` + `runSetupScript`) that atomically creates the thread, runs
`git worktree add`, records `branch`/`worktreePath`, runs the project setup script, and deletes
the thread again if preparation fails (see `dispatchBootstrapTurnStart` in the server's `ws.ts`).
There is also a plain `vcs.createWorktree` RPC. The CLI used none of this: `thread start` and
`thread create` hardcoded `branch: null, worktreePath: null`, so every job edited the main
checkout in place. The only knob was `thread update --worktree-path`, which rewrites metadata
after the fact — it creates nothing and runs no setup script.

**Fixed.** New flags on `thread create` and `thread start`:

- `--worktree` — fresh server-managed worktree. `thread start` sends the same atomic bootstrap
  the apps' draft flow uses; `thread create` calls `vcs.createWorktree` directly (no turn to
  attach a bootstrap to, so no setup script).
- `--worktree-path PATH` — attach an existing directory as the thread's worktree instead.
- `--base-branch NAME` — ref to branch from; defaults to the repo's default local branch
  (`vcs.listRefs`), falling back to the current checkout (`vcs.refreshStatus`).
- `--branch NAME` — branch created inside the worktree; defaults to a temporary
  `t3code/<8 hex>` branch like the apps generate.
- `--from-origin` — base on `origin/<base-branch>` (`thread start` only; the raw RPC cannot fetch).

`--worktree` also works with an existing thread (`--thread`): the turn re-homes the thread into
a fresh worktree before running. Verified end-to-end against the `local` environment: both
creation paths produced real worktrees under `.t3/worktrees/`, turns completed inside them, and
the JSON result reports the resolved `worktreePath` and `branch`.

## 7. Thread view fails deserialization on PDF and non-image attachments

`t3ctl thread view --format json` (and `loadThread`) failed when viewing a thread that contains
non-image file attachments (such as a PDF document), throwing a client deserialization error:

```
Expected "image", got "file"
  at ["snapshot"]["thread"]["messages"][...]["attachments"][0]["type"]
```

**Root cause:** `@t3tools/contracts` (`packages/contracts/src/orchestration.ts`) defined
`ChatAttachment = Schema.Union([ChatImageAttachment])`, strictly requiring `type: "image"`
and `mimeType: /^image\//i`. When the server persisted file attachments (e.g. PDFs uploaded
via the web composer or delivered by plugins) as `type: "file"`, Effect RPC failed schema
validation when decoding the thread snapshot stream item.

**Fixed:**
1. Upstream contract updated in `packages/contracts/src/orchestration.ts`:
   - Added `ChatFileAttachment` (`type: "file"`, max 25MB persisted ceiling) and `UploadChatFileAttachment` (max 10MB upload bound).
   - Added `ChatGenericAttachment` fallback for open/future attachment variants.
   - Expanded `ChatAttachment` union to include `ChatImageAttachment`, `ChatFileAttachment`, and `ChatGenericAttachment`.
   - Used `ForwardCompatibleArray(ChatAttachment)` on message and turn attachment lists so any unrecognised/corrupted attachment variant is dropped rather than failing the entire thread decode.
2. Updated `attachmentStore.ts` to handle non-image relative path resolution cleanly.
3. Updated `src/app.ts`:
   - `loadThread` now routes schema decode errors through `describeSchemaMismatch`.
   - `getMimeType` and `prepareImageAttachments` support `.pdf` and generic non-image files, assigning `type: "file"` instead of hardcoding `type: "image"`.
4. Added comprehensive test coverage in `test/cli.test.js`.

---

## Interface notes (correct usage, for reference)

- One-shot thread launch: `t3ctl thread start --project <id> --message "..." --wait`.
  No need for `thread create` → `thread update` → `thread start`.
- Model selection is `--provider <instanceId> --model <model>`, e.g.
  `--provider opencode --model opencode-go/deepseek-v4-flash`.
- Thread IDs work both positionally (`thread view <id>`, as documented) and via `--thread <id>`.
  Verified equivalent.
- `thread create` requires `--project` **and** `--title`.
- `--format` is `auto|human|json|ndjson`; non-TTY defaults to `json`, so piped output is
  machine-readable without the flag.
- Threads default to `runtimeMode: full-access` with `branch: null` and `worktreePath: null` —
  i.e. the agent edits the working tree in place, with no branch or worktree isolation. Commit a
  checkpoint before launching a job, or pass `--worktree` (see §6) for isolation.
