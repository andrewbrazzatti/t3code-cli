/**
 * Single source of truth for the command surface.
 *
 * Drives two things that used to drift apart: which flags a command accepts
 * (so unknown ones are rejected instead of silently ignored) and what
 * `--help` prints for that command.
 */

export interface FlagSpec {
  /** Long flag name without the leading `--`. */
  readonly name: string;
  /** Placeholder for the flag's value; omit for boolean flags. */
  readonly arg?: string;
  readonly description: string;
  /** Accepted but hidden from help — aliases and deprecated spellings. */
  readonly hidden?: boolean;
}

export interface CommandSpec {
  /** Argument shape shown after the command name in help. */
  readonly usage?: string;
  readonly summary: string;
  readonly flags: readonly FlagSpec[];
}

/** Flags accepted by every command. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "format", arg: "auto|human|json|ndjson", description: "Output format (auto selects human for a TTY, JSON otherwise)" },
  { name: "env", arg: "NAME", description: "Select a named environment" },
  { name: "environment", arg: "NAME", description: "Alias of --env", hidden: true },
  { name: "server-url", arg: "URL", description: "Override the environment URL" },
  { name: "token", arg: "TOKEN", description: "Override the stored credential" },
  { name: "help", description: "Show help for this command" },
  { name: "version", description: "Print the CLI version" },
];

/** Model-selection flags shared by the thread/project commands that accept one. */
const MODEL_FLAGS: readonly FlagSpec[] = [
  { name: "provider", arg: "INSTANCE", description: "Provider instance ID (e.g. opencode, codex, claudeAgent)" },
  { name: "model", arg: "MODEL", description: "Model ID (e.g. opencode-go/deepseek-v4-flash)" },
  { name: "option", arg: "id=value,…", description: "Model options, comma separated" },
  { name: "model-option", arg: "id=value,…", description: "Alias of --option", hidden: true },
  { name: "effort", arg: "LEVEL", description: "Shorthand for --option reasoningEffort=LEVEL" },
  { name: "fast-mode", description: "Enable fast mode where the provider supports it" },
];

const MODE_FLAGS: readonly FlagSpec[] = [
  { name: "runtime-mode", arg: "MODE", description: "Runtime mode for the thread (e.g. full-access)" },
  { name: "interaction-mode", arg: "MODE", description: "Interaction mode for the thread" },
];

/** Worktree selection shared by thread create and thread start. */
const WORKTREE_FLAGS: readonly FlagSpec[] = [
  { name: "worktree", description: "Create a fresh git worktree for the thread" },
  { name: "worktree-path", arg: "PATH", description: "Attach an existing directory as the thread's worktree" },
  { name: "base-branch", arg: "NAME", description: "Ref --worktree branches from (default: repo default branch)" },
  { name: "branch", arg: "NAME", description: "Branch to create in the worktree (default: temporary t3code/<hex>)" },
  { name: "from-origin", description: "Base --worktree on origin/<base-branch> (thread start only)" },
];

const THREAD_ID_FLAGS: readonly FlagSpec[] = [
  { name: "thread", arg: "ID", description: "Thread ID (may also be given positionally)" },
  { name: "thread-id", arg: "ID", description: "Alias of --thread", hidden: true },
];

const MESSAGE_FLAGS: readonly FlagSpec[] = [
  { name: "message", arg: "TEXT", description: "Prompt text (also accepted positionally or on stdin)" },
  { name: "prompt", arg: "TEXT", description: "Alias of --message", hidden: true },
  { name: "image", arg: "PATH", description: "Attach an image; repeatable, or comma separated" },
  { name: "wait", description: "Emit NDJSON lifecycle events and wait for completion" },
];

/** Prompt text for a scheduled task; the task stores a plain string, not files. */
const SCHEDULE_MESSAGE_FLAGS: readonly FlagSpec[] = [
  { name: "message", arg: "TEXT", description: "Prompt to run when the task fires (also positional or on stdin)" },
  { name: "prompt", arg: "TEXT", description: "Alias of --message", hidden: true },
];

/** Trigger flags shared by `schedule add`; exactly one is required. */
const SCHEDULE_TRIGGER_FLAGS: readonly FlagSpec[] = [
  { name: "every", arg: "DURATION", description: "Run on an interval (minimum 1m), e.g. 45m, 2h30m" },
  { name: "at", arg: "HH:MM", description: "Run at a local wall-clock time each day (or on --weekdays)" },
  { name: "weekdays", arg: "DAYS", description: "Days for --at: 0-6 (0=Sun) or mon,tue,... (default: every day)" },
  { name: "webhook", description: "Run on each request to the task's webhook URL" },
];

/** Target and identity flags for `schedule add`. */
const SCHEDULE_TARGET_FLAGS: readonly FlagSpec[] = [
  { name: "project", arg: "ID", description: "Project to launch new threads in" },
  { name: "thread", arg: "ID", description: "Send the prompt to an existing thread instead of launching one" },
  { name: "thread-id", arg: "ID", description: "Alias of --thread", hidden: true },
  { name: "id", arg: "ID", description: "Update an existing scheduled task by ID" },
  { name: "title", arg: "TITLE", description: "Task title (default: first line of the prompt)" },
  { name: "disabled", description: "Create the task disabled" },
];

const SCHEDULE_ID_FLAG: readonly FlagSpec[] = [
  { name: "id", arg: "ID", description: "Scheduled task ID (may also be given positionally)" },
];

/** Selects a workspace for file and diff commands. */
const FILE_TARGET_FLAGS: readonly FlagSpec[] = [
  { name: "project", arg: "ID", description: "Project whose workspace root to use" },
  { name: "cwd", arg: "PATH", description: "Absolute directory to use (overrides --project)" },
];

/** Identifies one pull request. */
const PR_TARGET_FLAGS: readonly FlagSpec[] = [
  { name: "project", arg: "ID", description: "Project the repository belongs to (required)" },
  { name: "repository", arg: "OWNER/NAME", description: "Repository (owner/name)" },
  { name: "number", arg: "N", description: "Pull request number" },
  { name: "host", arg: "HOST", description: "Git host, e.g. github.com" },
  { name: "reference", arg: "REF", description: "owner/name#N or a pull-request URL (may also be positional)" },
];

/** Selects a provider instance for setup and ACP commands. */
const INSTANCE_FLAGS: readonly FlagSpec[] = [
  { name: "instance", arg: "ID", description: "Provider instance ID (may also be positional)" },
  { name: "provider", arg: "ID", description: "Alias of --instance", hidden: true },
];

/**
 * Keyed by `"<root> <subcommand>"`, or just `"<root>"` for commands without
 * subcommands. Aliases share a spec so `project rename` validates like
 * `project update`.
 */
export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  "auth pair": {
    usage: "<pairing-url>",
    summary: "Pair with a server using a pairing URL",
    flags: [
      { name: "url", arg: "URL", description: "Pairing URL (may also be given positionally)" },
      { name: "name", arg: "NAME", description: "Name to save the environment under" },
    ],
  },
  "auth local": {
    usage: "--server-url URL",
    summary: "Authenticate against a local server with a bootstrap or access token",
    flags: [
      { name: "name", arg: "NAME", description: "Name to save the environment under" },
      { name: "access-token", arg: "TOKEN", description: "Use an existing access token" },
    ],
  },
  "auth status": { summary: "Show authentication status and configured environments", flags: [] },
  "auth pairing-token": {
    summary: "Issue a pairing token for another client to connect to this server",
    flags: [
      { name: "label", arg: "LABEL", description: "Optional label describing the client being paired" },
    ],
  },
  "auth use": {
    usage: "<name>",
    summary: "Set the active environment",
    flags: [{ name: "name", arg: "NAME", description: "Environment name (may also be given positionally)" }],
  },
  "auth remove": {
    usage: "<name>",
    summary: "Remove an environment and delete its saved credential",
    flags: [{ name: "name", arg: "NAME", description: "Environment name (may also be given positionally)" }],
  },

  "env list": { summary: "List configured environments", flags: [] },
  "env use": {
    usage: "<name>",
    summary: "Set the active environment",
    flags: [{ name: "name", arg: "NAME", description: "Environment name (may also be given positionally)" }],
  },
  "env remove": {
    usage: "<name>",
    summary: "Remove an environment and delete its saved credential",
    flags: [{ name: "name", arg: "NAME", description: "Environment name (may also be given positionally)" }],
  },

  models: {
    summary: "List providers and their models",
    flags: [{ name: "provider", arg: "NAME", description: "Filter to one provider instance" }],
  },
  status: { summary: "Alias of `models`", flags: [] },

  "provider credentials get": {
    usage: "[provider] [name]",
    summary: "Get configured provider credentials and environment variables",
    flags: [
      { name: "provider", arg: "ID", description: "Provider instance ID or driver name" },
      { name: "instance", arg: "ID", description: "Alias of --provider", hidden: true },
      { name: "instance-id", arg: "ID", description: "Alias of --provider", hidden: true },
      { name: "name", arg: "NAME", description: "Credential or environment variable name" },
      { name: "key", arg: "NAME", description: "Alias of --name", hidden: true },
    ],
  },
  "provider credentials set": {
    usage: "[provider] <name> <value>",
    summary: "Set a provider credential or environment variable on the server",
    flags: [
      { name: "provider", arg: "ID", description: "Provider instance ID or driver name" },
      { name: "instance", arg: "ID", description: "Alias of --provider", hidden: true },
      { name: "instance-id", arg: "ID", description: "Alias of --provider", hidden: true },
      { name: "name", arg: "NAME", description: "Credential or environment variable name" },
      { name: "key", arg: "NAME", description: "Alias of --name", hidden: true },
      { name: "value", arg: "VALUE", description: "Credential value" },
      { name: "val", arg: "VALUE", description: "Alias of --value", hidden: true },
      { name: "sensitive", description: "Mark credential as sensitive (default: true)" },
      { name: "non-sensitive", description: "Mark credential as non-sensitive" },
    ],
  },
  "provider limits": {
    summary: "Show subscription usage windows and banked reset credits",
    flags: [{ name: "provider", arg: "NAME", description: "Filter to one provider instance" }],
  },
  "provider reset-credit": {
    usage: "<provider>",
    summary: "Redeem a banked provider reset credit",
    flags: [
      { name: "provider", arg: "ID", description: "Provider instance ID or driver name" },
      { name: "instance", arg: "ID", description: "Alias of --provider", hidden: true },
      { name: "instance-id", arg: "ID", description: "Alias of --provider", hidden: true },
    ],
  },
  "provider auth start": {
    usage: "<instance-id>",
    summary: "Begin a provider authentication flow",
    flags: [...INSTANCE_FLAGS, { name: "method-id", arg: "ID", description: "Auth method ID" }, { name: "return-url", arg: "URL", description: "URL to return to after auth" }],
  },
  "provider auth complete": {
    usage: "<instance-id>",
    summary: "Complete a provider authentication flow with a callback URL",
    flags: [...INSTANCE_FLAGS, { name: "flow-id", arg: "ID", description: "Flow ID (required)" }, { name: "callback-url", arg: "URL", description: "OAuth callback URL (required)" }],
  },
  "provider auth cancel": {
    usage: "<instance-id>",
    summary: "Cancel a provider authentication flow",
    flags: [...INSTANCE_FLAGS, { name: "flow-id", arg: "ID", description: "Flow ID (required)" }],
  },
  "provider auth logout": { usage: "<instance-id>", summary: "Log out of a provider instance", flags: [...INSTANCE_FLAGS] },
  "provider install start": { usage: "<instance-id>", summary: "Install a provider's managed binary", flags: [...INSTANCE_FLAGS] },
  "provider install cancel": {
    usage: "<instance-id>",
    summary: "Cancel an in-progress provider install",
    flags: [...INSTANCE_FLAGS, { name: "operation-id", arg: "ID", description: "Install operation ID (required)" }],
  },
  "provider install remove": { usage: "<instance-id>", summary: "Remove a provider's managed binary", flags: [...INSTANCE_FLAGS] },

  usage: {
    summary: "Show token and cost usage over a date range",
    flags: [
      { name: "since", arg: "YYYY-MM-DD", description: "First day of the window (default: 6 days ago)" },
      { name: "until", arg: "YYYY-MM-DD", description: "Last day of the window (default: today)" },
      { name: "timezone", arg: "TZ", description: "IANA time zone to bucket days in (default: local)" },
      { name: "tz", arg: "TZ", description: "Alias of --timezone", hidden: true },
      { name: "hourly", description: "Bucket by hour instead of by day" },
    ],
  },
  "usage refresh-rates": { summary: "Refresh the model price table used for cost estimates", flags: [] },

  "project list": { summary: "List projects", flags: [] },
  "project add": {
    usage: "<workspace-root>",
    summary: "Register a local directory as a project",
    flags: [
      { name: "workspace-root", arg: "PATH", description: "Directory to register (may also be given positionally)" },
      { name: "title", arg: "TITLE", description: "Project title" },
    ],
  },
  "project clone": {
    usage: "<repository-url> <destination>",
    summary: "Clone a repository and register it as a project",
    flags: [
      { name: "url", arg: "URL", description: "Repository URL (may also be given positionally)" },
      { name: "destination", arg: "PATH", description: "Clone destination (may also be given positionally)" },
      { name: "title", arg: "TITLE", description: "Project title" },
    ],
  },
  "project update": {
    usage: "<project-id>",
    summary: "Update a project's title, workspace root, or default model",
    flags: [
      { name: "project", arg: "ID", description: "Project ID (may also be given positionally)" },
      { name: "title", arg: "TITLE", description: "New project title" },
      { name: "workspace-root", arg: "PATH", description: "New workspace root" },
      ...MODEL_FLAGS,
    ],
  },
  "project delete": {
    usage: "<project-id>",
    summary: "Delete a project",
    flags: [
      { name: "project", arg: "ID", description: "Project ID (may also be given positionally)" },
      { name: "force", description: "Skip confirmation" },
    ],
  },

  "thread list": {
    summary: "List threads, optionally filtered to one project",
    flags: [{ name: "project", arg: "ID", description: "Only list threads in this project" }],
  },
  "thread create": {
    summary: "Create a thread without starting a turn",
    flags: [
      { name: "project", arg: "ID", description: "Project to create the thread in (required)" },
      { name: "title", arg: "TITLE", description: "Thread title (required)" },
      ...MODEL_FLAGS,
      ...MODE_FLAGS,
      ...WORKTREE_FLAGS,
    ],
  },
  "thread start": {
    usage: "[prompt]",
    summary: "Start a new thread, or a new turn on an existing one",
    flags: [
      { name: "project", arg: "ID", description: "Project to start a new thread in" },
      ...THREAD_ID_FLAGS,
      { name: "title", arg: "TITLE", description: "Title for a newly created thread" },
      ...MESSAGE_FLAGS,
      ...MODEL_FLAGS,
      ...MODE_FLAGS,
      ...WORKTREE_FLAGS,
    ],
  },
  "thread send": {
    usage: "<thread-id> [prompt]",
    summary: "Send a message to an existing thread",
    flags: [...THREAD_ID_FLAGS, ...MESSAGE_FLAGS, ...MODEL_FLAGS, ...MODE_FLAGS],
  },
  "thread wait": {
    usage: "<thread-id>",
    summary: "Block until the current turn finishes (exit 0/10/130/1)",
    flags: [...THREAD_ID_FLAGS],
  },
  "thread watch": {
    usage: "<thread-id>",
    summary: "Stream NDJSON lifecycle events for a thread",
    flags: [...THREAD_ID_FLAGS],
  },
  "thread view": { usage: "<thread-id>", summary: "Show thread details", flags: [...THREAD_ID_FLAGS] },
  "thread transcript": { usage: "<thread-id>", summary: "Show the full thread transcript", flags: [...THREAD_ID_FLAGS] },
  "thread archive": { usage: "<thread-id>", summary: "Archive a thread", flags: [...THREAD_ID_FLAGS] },
  "thread unarchive": { usage: "<thread-id>", summary: "Unarchive a thread", flags: [...THREAD_ID_FLAGS] },
  "thread delete": { usage: "<thread-id>", summary: "Delete a thread", flags: [...THREAD_ID_FLAGS] },
  "thread interrupt": { usage: "<thread-id>", summary: "Interrupt the running turn", flags: [...THREAD_ID_FLAGS] },
  "thread settle": { usage: "<thread-id>", summary: "Mark a thread settled", flags: [...THREAD_ID_FLAGS] },
  "thread unsettle": { usage: "<thread-id>", summary: "Mark a thread unsettled", flags: [...THREAD_ID_FLAGS] },
  "thread update": {
    usage: "<thread-id>",
    summary: "Update a thread's title, model, branch, or worktree",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "title", arg: "TITLE", description: "New thread title" },
      { name: "branch", arg: "NAME", description: "Git branch for the thread" },
      { name: "worktree-path", arg: "PATH", description: "Worktree path for the thread" },
      ...MODEL_FLAGS,
      ...MODE_FLAGS,
    ],
  },
  "thread respond": {
    usage: "<thread-id>",
    summary: "Approve or deny a pending approval request",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "request-id", arg: "ID", description: "Approval request ID (required)" },
      { name: "decision", arg: "approve|deny", description: "Decision (required)" },
    ],
  },
  "thread respond-input": {
    usage: "<thread-id>",
    summary: "Answer a pending user-input request",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "request-id", arg: "ID", description: "Input request ID (required)" },
      { name: "answers", arg: "JSON", description: "JSON object of answers (required)" },
    ],
  },
  "thread search": {
    usage: "<query>",
    summary: "Search thread history for a query",
    flags: [
      { name: "query", arg: "TEXT", description: "Search text, at least 2 characters (may also be positional)" },
      { name: "limit", arg: "N", description: "Maximum matches to return (1-50)" },
    ],
  },
  "thread fork": {
    usage: "<thread-id>",
    summary: "Fork a thread from its latest stable point",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "title", arg: "TITLE", description: "Title for the forked thread" },
      { name: "target-thread-id", arg: "ID", description: "Explicit id for the fork (default: generated)" },
    ],
  },
  "thread pin": { usage: "<thread-id>", summary: "Pin a thread to the top of the list", flags: [...THREAD_ID_FLAGS] },
  "thread unpin": { usage: "<thread-id>", summary: "Unpin a thread", flags: [...THREAD_ID_FLAGS] },
  "thread visit": { usage: "<thread-id>", summary: "Mark a thread as read up to now", flags: [...THREAD_ID_FLAGS] },
  "thread rollback": {
    usage: "<thread-id>",
    summary: "Roll a thread back to a checkpoint",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "scope-id", arg: "ID", description: "Checkpoint scope ID (required)" },
      { name: "checkpoint-id", arg: "ID", description: "Checkpoint ID (required)" },
      { name: "no-restore-files", description: "Roll back the conversation only, not files" },
    ],
  },

  "schedule add": {
    usage: "[prompt]",
    summary: "Create or update a server-side scheduled task (requires exactly one of --every, --at, --webhook)",
    flags: [...SCHEDULE_TARGET_FLAGS, ...SCHEDULE_MESSAGE_FLAGS, ...MODEL_FLAGS, ...MODE_FLAGS, ...WORKTREE_FLAGS, ...SCHEDULE_TRIGGER_FLAGS],
  },
  "schedule list": { summary: "List scheduled tasks", flags: [] },
  "schedule enable": {
    usage: "<id>",
    summary: "Enable a scheduled task",
    flags: [...SCHEDULE_ID_FLAG],
  },
  "schedule disable": {
    usage: "<id>",
    summary: "Disable a scheduled task without deleting it",
    flags: [...SCHEDULE_ID_FLAG],
  },
  "schedule cancel": {
    usage: "<id>",
    summary: "Delete a scheduled task",
    flags: [...SCHEDULE_ID_FLAG],
  },
  "schedule run": {
    usage: "<id>",
    summary: "Run a scheduled task immediately",
    flags: [...SCHEDULE_ID_FLAG],
  },
  "schedule deliveries": {
    usage: "<id>",
    summary: "List webhook deliveries for a task (or one with --delivery-id)",
    flags: [...SCHEDULE_ID_FLAG, { name: "delivery-id", arg: "ID", description: "Show a single delivery's full detail" }],
  },
  "schedule rotate-webhook": {
    usage: "<id>",
    summary: "Rotate a webhook task's secret URL token",
    flags: [...SCHEDULE_ID_FLAG],
  },
  "schedule subscribe": { summary: "Stream scheduled-task changes as NDJSON", flags: [] },

  "terminal attach": {
    usage: "<thread-id>",
    summary: "Open an interactive terminal for a thread",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "terminal-id", arg: "ID", description: "Terminal session ID (default: term-1)" },
      { name: "cwd", arg: "PATH", description: "Working directory (default: thread worktree or project root)" },
      { name: "cols", arg: "N", description: "Initial terminal columns (default: current TTY width)" },
      { name: "rows", arg: "N", description: "Initial terminal rows (default: current TTY height)" },
      { name: "env-var", arg: "KEY=VALUE,…", description: "Environment variables for the shell, comma separated" },
    ],
  },
  "terminal list": {
    usage: "<thread-id>",
    summary: "List terminal sessions for a thread",
    flags: [...THREAD_ID_FLAGS],
  },
  "terminal close": {
    usage: "<thread-id>",
    summary: "Close a terminal session",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "terminal-id", arg: "ID", description: "Terminal session ID (default: close all for the thread)" },
      { name: "delete-history", description: "Also delete the terminal's persisted history" },
    ],
  },

  "file list": {
    usage: "[--project ID | --cwd PATH]",
    summary: "List files in a project's workspace root (or one directory of it)",
    flags: [...FILE_TARGET_FLAGS, { name: "directory", arg: "PATH", description: "List one directory's immediate children" }],
  },
  "file read": {
    usage: "<relative-path>",
    summary: "Read a workspace file",
    flags: [...FILE_TARGET_FLAGS, { name: "relative-path", arg: "PATH", description: "Workspace-relative path (may also be positional)" }],
  },
  "file write": {
    usage: "<relative-path>",
    summary: "Write a workspace file (contents from --contents or stdin)",
    flags: [
      ...FILE_TARGET_FLAGS,
      { name: "relative-path", arg: "PATH", description: "Workspace-relative path (may also be positional)" },
      { name: "contents", arg: "TEXT", description: "File contents; read from stdin when omitted" },
    ],
  },
  "file search": {
    usage: "<query>",
    summary: "Search file contents in a project's workspace",
    flags: [
      ...FILE_TARGET_FLAGS,
      { name: "query", arg: "TEXT", description: "Search text (may also be positional)" },
      { name: "limit", arg: "N", description: "Maximum matches (default 100)" },
      { name: "case-sensitive", description: "Match case" },
      { name: "whole-word", description: "Match whole words only" },
      { name: "regex", description: "Treat the query as a regular expression" },
    ],
  },
  "file find": {
    usage: "[query]",
    summary: "Find files by name/path in a project's workspace",
    flags: [...FILE_TARGET_FLAGS, { name: "limit", arg: "N", description: "Maximum results (default 100)" }, { name: "kind", arg: "file|directory", description: "Restrict to files or directories" }],
  },

  "sessions scan": { summary: "List directories the Claude Code and Codex CLIs have run in", flags: [] },
  "sessions import": {
    usage: "<project-id>",
    summary: "Import native session history for a project",
    flags: [{ name: "project", arg: "ID", description: "Project to import history into (may also be positional)" }],
  },

  "diff turn": {
    usage: "<thread-id>",
    summary: "Show a thread's diff between two turn counts",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "from", arg: "N", description: "First turn count (required)" },
      { name: "to", arg: "N", description: "Last turn count (required)" },
      { name: "ignore-whitespace", description: "Ignore whitespace changes" },
    ],
  },
  "diff thread": {
    usage: "<thread-id>",
    summary: "Show a thread's full-history diff up to a turn count",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "to", arg: "N", description: "Turn count to diff up to (required)" },
      { name: "ignore-whitespace", description: "Ignore whitespace changes" },
    ],
  },
  "diff review": {
    usage: "[--project ID | --cwd PATH]",
    summary: "Show the working-tree or branch-range diff for a checkout",
    flags: [...FILE_TARGET_FLAGS, { name: "base-ref", arg: "REF", description: "Base ref for a branch-range diff" }, { name: "ignore-whitespace", description: "Ignore whitespace changes" }],
  },

  "device list": {
    summary: "List simulators, emulators, and device hosts",
    flags: [
      { name: "update-tool", arg: "hub|agent", description: "Install the pinned device tool" },
      { name: "inspect-only", description: "Read inventory without installing tools or starting helpers" },
      { name: "retry-host-id", arg: "ID", description: "Retry one host only" },
    ],
  },
  "device open": {
    usage: "<device-id>",
    summary: "Open a simulator/emulator and attach it to a thread",
    flags: [
      { name: "device-id", arg: "ID", description: "Device ID (may also be positional)" },
      ...THREAD_ID_FLAGS,
      { name: "platform", arg: "ios|android", description: "Device platform (required)" },
      { name: "host-id", arg: "ID", description: "Device host ID (default: local)" },
      { name: "no-boot", description: "Do not boot the device if it is not running" },
    ],
  },
  "device close": {
    usage: "[device-id]",
    summary: "Close a thread's device session",
    flags: [
      ...THREAD_ID_FLAGS,
      { name: "device-id", arg: "ID", description: "Device ID (default: close all for the thread)" },
      { name: "host-id", arg: "ID", description: "Device host ID" },
      { name: "shutdown", description: "Also shut the simulator/emulator down" },
    ],
  },
  "device shutdown": {
    usage: "<device-id>",
    summary: "Shut down a simulator or emulator",
    flags: [
      { name: "device-id", arg: "ID", description: "Device ID (may also be positional)" },
      { name: "platform", arg: "ios|android", description: "Device platform (required)" },
      { name: "host-id", arg: "ID", description: "Device host ID" },
    ],
  },
  "device detail": {
    usage: "<device-id>",
    summary: "Show a device's settings and foreground app",
    flags: [{ name: "device-id", arg: "ID", description: "Device ID (may also be positional)" }, { name: "host-id", arg: "ID", description: "Device host ID" }],
  },
  "device configure": {
    summary: "Enable or disable the device panel",
    flags: [
      { name: "enable", description: "Enable device access" },
      { name: "disable", description: "Disable device access" },
      { name: "agent-access", description: "Allow the agent to drive devices" },
      { name: "no-agent-access", description: "Disallow agent device access" },
      { name: "onboarding-complete", description: "Mark device onboarding complete" },
    ],
  },
  "device test-host": {
    usage: "<host-id>",
    summary: "Test an SSH device host connection",
    flags: [
      { name: "host-id", arg: "ID", description: "Host ID (may also be positional)" },
      { name: "label", arg: "LABEL", description: "Human-readable host label" },
      { name: "target", arg: "USER@HOST", description: "SSH target (required)" },
      { name: "identity-file", arg: "PATH", description: "SSH identity file" },
      { name: "port", arg: "N", description: "SSH port" },
    ],
  },
  "device action": {
    summary: "Send a raw device action (JSON)",
    flags: [{ name: "json", arg: "JSON", description: "DeviceActionInput JSON object (required)" }],
  },

  "pr list": {
    summary: "List pull requests across projects",
    flags: [
      { name: "state", arg: "all|open|closed|merged", description: "Filter by state (default: open)" },
      { name: "involvement", arg: "all|reviewing|authored", description: "Filter by your involvement" },
      { name: "project", arg: "ID", description: "Limit to one project" },
      { name: "host", arg: "HOST", description: "Limit to one git host" },
      { name: "limit", arg: "N", description: "Rows per repository (1-500)" },
    ],
  },
  "pr detail": { usage: "[reference]", summary: "Show a pull request", flags: [...PR_TARGET_FLAGS] },
  "pr checks": { usage: "[reference]", summary: "Show a pull request's CI checks", flags: [...PR_TARGET_FLAGS] },
  "pr stack": { usage: "[reference]", summary: "Show the stack a pull request belongs to", flags: [...PR_TARGET_FLAGS] },
  "pr threads": { usage: "[reference]", summary: "List threads linked to a pull request", flags: [...PR_TARGET_FLAGS] },
  "pr comment": {
    usage: "[reference]",
    summary: "Post a comment on a pull request",
    flags: [...PR_TARGET_FLAGS, { name: "body", arg: "TEXT", description: "Comment body (required)" }],
  },
  "pr review": {
    usage: "[reference]",
    summary: "Submit a review on a pull request",
    flags: [...PR_TARGET_FLAGS, { name: "verdict", arg: "comment|approve|request-changes", description: "Review verdict (required)" }, { name: "body", arg: "TEXT", description: "Review body" }],
  },
  "pr update": {
    usage: "[reference]",
    summary: "Update a pull request's title or body",
    flags: [...PR_TARGET_FLAGS, { name: "title", arg: "TITLE", description: "New title" }, { name: "body", arg: "TEXT", description: "New body" }],
  },

  "preview list": { usage: "<thread-id>", summary: "List a thread's preview tabs", flags: [...THREAD_ID_FLAGS] },
  "preview open": {
    usage: "<thread-id>",
    summary: "Open a preview tab for a thread",
    flags: [...THREAD_ID_FLAGS, { name: "url", arg: "URL", description: "Initial URL (omit for a blank tab)" }, { name: "width", arg: "PX", description: "Freeform viewport width" }, { name: "height", arg: "PX", description: "Freeform viewport height" }, { name: "profile-id", arg: "ID", description: "Browser profile ID" }],
  },
  "preview navigate": { usage: "<thread-id>", summary: "Navigate a preview tab", flags: [...THREAD_ID_FLAGS, { name: "tab-id", arg: "ID", description: "Preview tab ID (required)" }, { name: "url", arg: "URL", description: "URL to open (required)" }] },
  "preview resize": { usage: "<thread-id>", summary: "Resize a preview tab's viewport", flags: [...THREAD_ID_FLAGS, { name: "tab-id", arg: "ID", description: "Preview tab ID (required)" }, { name: "width", arg: "PX", description: "Viewport width" }, { name: "height", arg: "PX", description: "Viewport height" }] },
  "preview refresh": { usage: "<thread-id>", summary: "Reload a preview tab", flags: [...THREAD_ID_FLAGS, { name: "tab-id", arg: "ID", description: "Preview tab ID (required)" }] },
  "preview close": { usage: "<thread-id>", summary: "Close a preview tab (or all of a thread's tabs)", flags: [...THREAD_ID_FLAGS, { name: "tab-id", arg: "ID", description: "Preview tab ID (default: all)" }] },

  "attach upload": {
    usage: "<path>...",
    summary: "Upload files as chat attachments and print their ids",
    flags: [{ name: "file", arg: "PATH", description: "File to upload (repeatable); paths may also be positional" }],
  },
  "attach delete": {
    usage: "<attachment-id>",
    summary: "Delete a pending attachment upload",
    flags: [{ name: "attachment-id", arg: "ID", description: "Attachment ID (may also be positional)" }],
  },

  "acp search": { usage: "<query>", summary: "Search the Agent Client Protocol registry", flags: [{ name: "query", arg: "TEXT", description: "Search text (may also be positional)" }] },
  "acp prepare": { usage: "<agent-id>", summary: "Prepare (install) a registry agent", flags: [{ name: "agent-id", arg: "ID", description: "Registry agent ID (may also be positional)" }] },
  "acp uninstall": { usage: "<agent-id>", summary: "Uninstall a managed registry agent binary", flags: [{ name: "agent-id", arg: "ID", description: "Registry agent ID (may also be positional)" }] },
  "acp logout": { usage: "<instance-id>", summary: "Log out of an ACP provider instance", flags: [...INSTANCE_FLAGS] },
  "acp accept-url-auth": { usage: "<instance-id>", summary: "Accept a URL-auth elicitation", flags: [...INSTANCE_FLAGS, { name: "elicitation-id", arg: "ID", description: "Elicitation ID (required)" }] },
  "acp sessions": { usage: "<instance-id>", summary: "List an ACP provider's sessions for a project", flags: [...INSTANCE_FLAGS, { name: "project", arg: "ID", description: "Project ID (required)" }, { name: "cursor", arg: "CURSOR", description: "Pagination cursor" }] },
  "acp import-session": { usage: "<instance-id>", summary: "Import an ACP provider session as a thread", flags: [...INSTANCE_FLAGS, { name: "project", arg: "ID", description: "Project ID (required)" }, { name: "session-id", arg: "ID", description: "Session ID (required)" }, { name: "title", arg: "TITLE", description: "Thread title" }] },
  "acp delete-session": { usage: "<instance-id>", summary: "Delete an ACP provider session", flags: [...INSTANCE_FLAGS, { name: "project", arg: "ID", description: "Project ID (required)" }, { name: "session-id", arg: "ID", description: "Session ID (required)" }] },
  "acp providers": { usage: "<instance-id>", summary: "List an ACP provider instance's providers", flags: [...INSTANCE_FLAGS, { name: "project", arg: "ID", description: "Project ID (required)" }] },
  "acp set-provider": { usage: "<instance-id>", summary: "Create or update an ACP provider", flags: [...INSTANCE_FLAGS, { name: "project", arg: "ID", description: "Project ID (required)" }, { name: "provider-id", arg: "ID", description: "Provider ID (required)" }, { name: "api-type", arg: "TYPE", description: "Provider protocol (required)" }, { name: "base-url", arg: "URL", description: "Base URL (required)" }, { name: "header", arg: "KEY=VALUE", description: "Request header; repeatable" }] },
  "acp disable-provider": { usage: "<instance-id>", summary: "Disable an ACP provider", flags: [...INSTANCE_FLAGS, { name: "project", arg: "ID", description: "Project ID (required)" }, { name: "provider-id", arg: "ID", description: "Provider ID (required)" }] },

  "server probe": { summary: "Check that the server answers", flags: [] },
  "server trace": { summary: "Show server trace diagnostics", flags: [] },
  "server processes": { summary: "Show server process diagnostics", flags: [] },
  "server process-history": { summary: "Show process resource history", flags: [{ name: "window", arg: "DURATION", description: "Window length, e.g. 1h (required)" }, { name: "bucket", arg: "DURATION", description: "Bucket size, e.g. 1m (required)" }] },
  "server host-resources": { summary: "Show host resource usage", flags: [] },
  "server resource-history": { summary: "Show resource telemetry history", flags: [{ name: "window", arg: "DURATION", description: "Window length, e.g. 1h (required)" }, { name: "bucket", arg: "DURATION", description: "Bucket size, e.g. 1m (required)" }] },
  "server retry-telemetry": { summary: "Retry resource telemetry", flags: [] },
  "server signal": { usage: "<pid>", summary: "Send a signal to a server process", flags: [{ name: "pid", arg: "N", description: "Process ID (may also be positional)" }, { name: "start-time", arg: "MS", description: "Process start time in ms" }, { name: "signal", arg: "NAME", description: "Signal name (required)" }] },
  "server background-policy": { summary: "Show the background activity policy", flags: [] },

  "secret answer": {
    usage: "<thread-id>",
    summary: "Answer an agent's secret request (save or decline)",
    flags: [...THREAD_ID_FLAGS, { name: "turn-item-id", arg: "ID", description: "Turn item ID (required)" }, { name: "secret", arg: "VALUE", description: "Secret value to save" }, { name: "decline", description: "Decline the request" }],
  },

  "connect": {
    usage: "<pairing-url>",
    summary: "Alias of `auth pair`, kept as a migration path",
    flags: [
      { name: "url", arg: "URL", description: "Pairing URL (may also be given positionally)" },
      { name: "name", arg: "NAME", description: "Name to save the environment under" },
    ],
  },
};

/** Set of flag names that take no value argument (boolean flags). */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(
  [
    ...GLOBAL_FLAGS,
    ...MODEL_FLAGS,
    ...MODE_FLAGS,
    ...THREAD_ID_FLAGS,
    ...MESSAGE_FLAGS,
    ...Object.values(COMMANDS).flatMap((c) => c.flags),
  ]
    .filter((f) => !f.arg)
    .map((f) => f.name)
);

/** Subcommand spellings that resolve to another spec. */
const ALIASES: Readonly<Record<string, string>> = {
  "project rename": "project update",
  "project remove": "project delete",
  "thread input": "thread respond-input",
  "schedule rm": "schedule cancel",
  "schedule remove": "schedule cancel",
  "schedule run-now": "schedule run",
  "schedule watch": "schedule subscribe",
  "provider get": "provider credentials get",
  "provider set": "provider credentials set",
  "provider list": "models",
  "provider reset": "provider reset-credit",
  "models credentials get": "provider credentials get",
  "models credentials set": "provider credentials set",
  "usage refresh": "usage refresh-rates",
};

/** Roots whose second token is a subcommand rather than a positional. */
export const ROOTS_WITH_SUBCOMMANDS: ReadonlySet<string> = new Set(["auth", "env", "project", "thread", "provider", "terminal", "schedule", "usage", "file", "sessions", "diff", "device", "pr", "preview", "attach", "acp", "server", "secret"]);

export function commandKey(command: readonly string[]): string {
  const raw = command.join(" ");
  return ALIASES[raw] ?? raw;
}

export function specFor(command: readonly string[]): CommandSpec | undefined {
  const key = commandKey(command);
  if (COMMANDS[key]) return COMMANDS[key];
  // `env` with no subcommand lists environments.
  if (key === "env") return COMMANDS["env list"];
  return undefined;
}

export function knownFlagsFor(command: readonly string[]): Set<string> | undefined {
  const spec = specFor(command);
  if (!spec) return undefined;
  const names = new Set<string>();
  for (const flag of GLOBAL_FLAGS) names.add(flag.name);
  for (const flag of spec.flags) names.add(flag.name);
  return names;
}

function renderFlags(flags: readonly FlagSpec[], indent = "  "): string {
  const visible = flags.filter((flag) => !flag.hidden);
  if (visible.length === 0) return "";
  const left = visible.map((flag) => `--${flag.name}${flag.arg ? ` ${flag.arg}` : ""}`);
  const width = Math.max(...left.map((entry) => entry.length));
  return visible
    .map((flag, index) => `${indent}${left[index].padEnd(width)}  ${flag.description}`)
    .join("\n");
}

/** Help for a single command, used by `<command> --help`. */
export function commandHelp(command: readonly string[]): string {
  const spec = specFor(command);
  const key = commandKey(command);
  if (!spec) return topLevelHelp();
  const lines = [
    `t3ctl ${key} — ${spec.summary}`,
    "",
    `Usage: t3ctl [global options] ${key}${spec.usage ? ` ${spec.usage}` : ""}`,
  ];
  const own = renderFlags(spec.flags);
  if (own) lines.push("", "Flags:", own);
  lines.push("", "Global options:", renderFlags(GLOBAL_FLAGS));
  return lines.join("\n");
}

export function topLevelHelp(): string {
  return `T3 Code CLI

Usage: t3ctl [global options] <command>

Run "t3ctl <command> --help" for the flags a specific command accepts.

Global options:
${renderFlags(GLOBAL_FLAGS)}

Authentication:
  auth pair <pairing-url> [--name NAME] [--token TOKEN]
  auth local --server-url URL [--token BOOTSTRAP] [--access-token TOKEN]
  auth status
  auth pairing-token [--label LABEL]
  auth use|remove <name>

Environments:
  env list|use|remove

Projects and models:
  project list|add|clone|update|delete
  models [--provider NAME]

Provider credentials and quota:
  provider credentials get [provider] [name]
  provider credentials set [provider] <name> <value> [--sensitive|--non-sensitive]
  provider limits [--provider NAME]
  provider reset-credit <provider>

Threads:
  thread create|start|send|wait|watch|view|transcript|list
  thread archive|unarchive|delete|update|interrupt|settle|unsettle|respond|respond-input

Terminals:
  terminal attach <thread-id> [--terminal-id ID] [--cwd PATH] [--env-var KEY=VALUE,...]
  terminal list|close <thread-id>

Scheduled tasks (server-side; no local runner):
  schedule add [prompt] (--every DURATION | --at HH:MM [--weekdays DAYS] | --webhook)
      [--project ID | --thread ID] [--title T] [--disabled] [--worktree ...]
  schedule list
  schedule enable|disable|cancel <id>
  schedule run <id>            # fire once, now
  schedule deliveries <id>     # webhook delivery log
  schedule rotate-webhook <id>
  schedule subscribe

Usage and cost:
  usage [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--timezone TZ] [--hourly]
  usage refresh-rates

Files and diffs:
  file list|read|write|search|find [--project ID | --cwd PATH]
  diff turn <thread-id> --from N --to N | diff thread <thread-id> --to N
  diff review [--project ID | --cwd PATH] [--base-ref REF]

Devices (simulators/emulators):
  device list [--inspect-only]
  device open <device-id> --thread <id> --platform ios|android
  device close|shutdown|detail|configure|test-host|action

Agent session import:
  sessions scan
  sessions import <project-id>

Pull requests:
  pr list [--state open|closed|merged|all] [--involvement authored|reviewing|all]
  pr detail|checks|stack|threads|comment|review|update [owner/name#N] --project ID

Preview tabs, attachments, and secrets:
  preview list|open|navigate|resize|refresh|close <thread-id>
  attach upload <path>... | attach delete <attachment-id>
  secret answer <thread-id> --turn-item-id ID (--secret VALUE | --decline)

Provider setup and ACP registry:
  provider auth start|complete|cancel|logout <instance-id>
  provider install start|cancel|remove <instance-id>
  acp search|prepare|uninstall|logout|sessions|import-session|delete-session|providers|set-provider|disable-provider

Server diagnostics:
  server probe|trace|processes|host-resources|resource-history|process-history|retry-telemetry|signal|background-policy

Automation:
  Prompts may be positional, passed with --message/--prompt, or read from stdin.
  --image <path> attaches a file to thread start / thread send.
  --wait on start/send emits NDJSON lifecycle events and waits for completion.

Worktrees:
  thread start --project P --message M --worktree [--base-branch B] [--from-origin] [--branch N]
  --worktree-path PATH attaches an existing directory as the thread's worktree.`;
}
