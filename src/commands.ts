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
  "provider get": "provider credentials get",
  "provider set": "provider credentials set",
  "provider list": "models",
  "models credentials get": "provider credentials get",
  "models credentials set": "provider credentials set",
};

/** Roots whose second token is a subcommand rather than a positional. */
export const ROOTS_WITH_SUBCOMMANDS: ReadonlySet<string> = new Set(["auth", "env", "project", "thread", "provider"]);

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

Provider credentials:
  provider credentials get [provider] [name]
  provider credentials set [provider] <name> <value> [--sensitive|--non-sensitive]

Threads:
  thread create|start|send|wait|watch|view|transcript|list
  thread archive|unarchive|delete|update|interrupt|settle|unsettle|respond|respond-input

Automation:
  Prompts may be positional, passed with --message/--prompt, or read from stdin.
  --image <path> attaches an image file to thread start / thread send.
  --wait on start/send emits NDJSON lifecycle events and waits for completion.`;
}
