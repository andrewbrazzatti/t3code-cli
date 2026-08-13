import {
  authenticateLocal,
  authenticatePair,
  authStatus,
  createPairingToken,
  removeAuthEnvironment,
  useEnvironment,
} from "./auth.js";
import {
  addProject,
  archiveThread,
  createThread,
  cloneProject,
  deleteProject,
  deleteThread,
  getProviderCredentials,
  interruptThread,
  listModels,
  listProjects,
  listThreads,
  lifecycleExitCode,
  respondToApproval,
  respondToUserInput,
  sendMessage,
  setProviderCredential,
  settleThread,
  startThread,
  transcript,
  unarchiveThread,
  unsettleThread,
  updateThread,
  updateProject,
  viewThread,
  waitForThread,
  watchThread,
  toCommandError,
} from "./app.js";
import {
  BOOLEAN_FLAGS,
  commandHelp,
  knownFlagsFor,
  ROOTS_WITH_SUBCOMMANDS,
  specFor,
  topLevelHelp,
} from "./commands.js";
import { ConfigError } from "./config.js";
import { outputFormatFromArgv, createOutputSink, type OutputFormat } from "./output.js";
import { attachTerminal, closeTerminal, listTerminals } from "./terminal.js";

interface ParsedArgs {
  readonly command: string[];
  readonly flags: Map<string, string | boolean>;
  readonly positionals: string[];
  readonly rawArgv: readonly string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let endFlags = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!endFlags && token === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags && token.startsWith("--")) {
      const equals = token.indexOf("=");
      if (equals >= 0) {
        flags.set(token.slice(2, equals), token.slice(equals + 1));
        continue;
      }
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
        continue;
      }
      if (name.startsWith("no-") && BOOLEAN_FLAGS.has(name.slice(3))) {
        flags.set(name.slice(3), false);
        flags.set(name, true);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (!endFlags && token.startsWith("-") && token.length === 2) {
      const alias = token.slice(1);
      if (alias === "h") flags.set("help", true);
      else if (alias === "v") flags.set("version", true);
      else throw new ConfigError(`Unknown option "${token}".`, "cli_parse_failed");
      continue;
    }
    if (command.length < 2 && !endFlags) command.push(token);
    else positionals.push(token);
  }
  if (command.length === 2 && !ROOTS_WITH_SUBCOMMANDS.has(command[0])) {
    positionals.unshift(command[1]);
    command.pop();
  }
  return { command, flags, positionals, rawArgv: argv };
}

function imageFlags(args: ParsedArgs): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.rawArgv.length; i++) {
    const token = args.rawArgv[i];
    if (token === "--image" || token.startsWith("--image=")) {
      let val = "";
      if (token.startsWith("--image=")) {
        val = token.slice("--image=".length);
      } else if (i + 1 < args.rawArgv.length && !args.rawArgv[i + 1].startsWith("-")) {
        val = args.rawArgv[i + 1];
        i++;
      }
      if (val) {
        for (const item of val.split(",")) {
          const trimmed = item.trim();
          if (trimmed && !paths.includes(trimmed)) paths.push(trimmed);
        }
      }
    }
  }
  return paths;
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

function modelOptions(args: ParsedArgs): ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined {
  const raw = flag(args, "option") || flag(args, "model-option");
  const values: Array<{ id: string; value: string | boolean }> = [];
  if (raw) {
    for (const entry of raw.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new ConfigError(`Invalid model option "${entry}"; expected id=value.`, "cli_parse_failed");
      const id = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (!id || !value) throw new ConfigError(`Invalid model option "${entry}"; expected id=value.`, "cli_parse_failed");
      values.push({ id: id === "effort" ? "reasoningEffort" : id, value: value === "true" ? true : value === "false" ? false : value });
    }
  }
  const effort = flag(args, "effort");
  if (effort) values.push({ id: "reasoningEffort", value: effort });
  if (args.flags.has("fast-mode")) values.push({ id: "fastMode", value: boolFlag(args, "fast-mode") });
  return values.length > 0 ? values : undefined;
}

function required(args: ParsedArgs, name: string, positional?: string): string {
  const value = positional || flag(args, name);
  if (!value?.trim()) throw new ConfigError(`Missing required argument --${name}.`, "cli_parse_failed");
  return value.trim();
}

function parseIntFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ConfigError(`--${name} must be a positive integer.`, "cli_parse_failed");
  return parsed;
}

function parseEnvList(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const env: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new ConfigError(`Invalid environment variable "${trimmed}"; expected KEY=VALUE.`, "cli_parse_failed");
    const key = trimmed.slice(0, separator).trim();
    const val = trimmed.slice(separator + 1);
    if (!key) throw new ConfigError(`Invalid environment variable "${trimmed}"; expected KEY=VALUE.`, "cli_parse_failed");
    env[key] = val;
  }
  return env;
}

async function readMessage(args: ParsedArgs, positionalIndex = 0): Promise<string> {
  const fromFlag = flag(args, "message") || flag(args, "prompt");
  const fromPositionals = args.positionals.slice(positionalIndex).join(" ").trim();
  if (fromFlag?.trim()) return fromFlag.trim();
  if (fromPositionals) return fromPositionals;
  if (process.stdin.isTTY) throw new ConfigError("A prompt is required as an argument, --message, or non-interactive stdin.", "prompt_missing");
  const text = await new Promise<string>((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value.trim()));
    process.stdin.on("error", reject);
  });
  if (!text) throw new ConfigError("Stdin did not contain a prompt.", "prompt_missing");
  return text;
}

function commonContext(args: ParsedArgs, format: OutputFormat, stream = false) {
  return {
    format,
    stream,
    serverUrl: flag(args, "server-url"),
    token: flag(args, "token"),
    environment: flag(args, "env") || flag(args, "environment"),
  };
}

/**
 * Reject flags the resolved command does not accept.
 *
 * Unknown flags used to be collected and ignored, so a typo (or a plausible
 * guess like `--instance` instead of `--provider`) silently did nothing while
 * the command reported success.
 */
export function assertKnownFlags(command: readonly string[], flags: Iterable<string>): void {
  const known = knownFlagsFor(command);
  if (!known) return; // Unknown command; the dispatcher reports that with better context.
  const unknown = [...flags].filter((name) => !known.has(name));
  if (unknown.length === 0) return;
  const label = command.join(" ");
  const accepted = [...known].sort().map((name) => `--${name}`).join(", ");
  throw new ConfigError(
    `Unknown ${unknown.length > 1 ? "flags" : "flag"} ${unknown.map((name) => `"--${name}"`).join(", ")} for "t3ctl ${label}".\n\n` +
      `Accepted: ${accepted}\n\nRun "t3ctl ${label} --help" for details.`,
    "cli_parse_failed",
  );
}

async function runCommand(args: ParsedArgs, format: OutputFormat): Promise<number> {
  let [root, subcommand] = args.command;
  const topLevelThreadCommand = new Set(["create", "start", "send", "wait", "watch", "view", "transcript", "archive", "unarchive", "delete", "update", "interrupt", "settle", "unsettle", "respond", "respond-input", "input"]);
  if (root && topLevelThreadCommand.has(root)) {
    subcommand = root;
    root = "thread";
  }
  const context = commonContext(args, format);
  if (boolFlag(args, "version")) {
    process.stdout.write("0.2.0\n");
    return 0;
  }
  // Help resolves against the specific command when there is one, so
  // `t3ctl thread start --help` documents thread start rather than everything.
  if (!root || boolFlag(args, "help")) {
    const resolved = root ? [root, subcommand].filter(Boolean) as string[] : [];
    const text = resolved.length > 0 && specFor(resolved) ? commandHelp(resolved) : topLevelHelp();
    process.stdout.write(`${text}\n`);
    return 0;
  }
  assertKnownFlags([root, subcommand].filter(Boolean) as string[], args.flags.keys());

  if (root === "auth") {
    if (subcommand === "pair") {
      const input = required(args, "url", args.positionals[0]);
      const result = await authenticatePair({ input, name: flag(args, "name"), credential: flag(args, "token") });
      createOutputSink(format).write(result);
      return 0;
    }
    if (subcommand === "local") {
      const result = await authenticateLocal({
        serverUrl: required(args, "server-url", args.positionals[0]),
        name: flag(args, "name"),
        bootstrapToken: flag(args, "token"),
        accessToken: flag(args, "access-token"),
      });
      createOutputSink(format).write(result);
      return 0;
    }
    if (subcommand === "status") {
      const result = await authStatus({ environment: context.environment });
      createOutputSink(format).write(result);
      return 0;
    }
    if (subcommand === "pairing-token") {
      const result = await createPairingToken({ label: flag(args, "label"), environment: context.environment });
      createOutputSink(format).write(result);
      return 0;
    }
    if (subcommand === "use") {
      const result = useEnvironment(required(args, "name", args.positionals[0]));
      createOutputSink(format).write(result);
      return 0;
    }
    if (subcommand === "remove") {
      const result = await removeAuthEnvironment(required(args, "name", args.positionals[0]));
      createOutputSink(format).write(result);
      return 0;
    }
    throw new ConfigError("Unknown auth command. Use auth pair, auth local, or auth status.", "cli_parse_failed");
  }

  if (root === "env") {
    if (subcommand === "list" || !subcommand) {
      const result = await authStatus();
      createOutputSink(format).write(result);
      return 0;
    }
    if (subcommand === "use") {
      createOutputSink(format).write(useEnvironment(required(args, "name", args.positionals[0])));
      return 0;
    }
    if (subcommand === "remove") {
      createOutputSink(format).write(await removeAuthEnvironment(required(args, "name", args.positionals[0])));
      return 0;
    }
    throw new ConfigError("Unknown env command.", "cli_parse_failed");
  }

  if (root === "models") {
    await listModels({ ...context, provider: flag(args, "provider") });
    return 0;
  }
  if (root === "provider") {
    if (subcommand === "credentials" || subcommand === "credential" || subcommand === "get" || subcommand === "set") {
      const isSet = subcommand === "set" || args.positionals[0] === "set";
      const isGet = subcommand === "get" || args.positionals[0] === "get" || (!isSet && subcommand === "credentials");
      if (isSet) {
        const result = await setProviderCredential({
          ...context,
          provider: flag(args, "provider") || flag(args, "instance") || flag(args, "instance-id"),
          name: flag(args, "name") || flag(args, "key"),
          value: flag(args, "value") || flag(args, "val"),
          sensitive: boolFlag(args, "non-sensitive") ? false : true,
          positionals: args.positionals,
        });
        createOutputSink(format).write(result);
        return 0;
      }
      if (isGet) {
        const result = await getProviderCredentials({
          ...context,
          provider: flag(args, "provider") || flag(args, "instance") || flag(args, "instance-id"),
          name: flag(args, "name") || flag(args, "key"),
          positionals: args.positionals,
        });
        createOutputSink(format).write(result);
        return 0;
      }
    }
    if (subcommand === "list" || !subcommand) {
      await listModels({ ...context, provider: flag(args, "provider") });
      return 0;
    }
    throw new ConfigError("Unknown provider command. Use provider credentials get or provider credentials set.", "cli_parse_failed");
  }
  if (root === "status") {
    await listModels(context);
    return 0;
  }
  if (root === "project") {
    if (subcommand === "list") { await listProjects(context); return 0; }
    if (subcommand === "add") { await addProject({ ...context, workspaceRoot: required(args, "workspace-root", args.positionals[0]), title: flag(args, "title") }); return 0; }
    if (subcommand === "delete" || subcommand === "remove") { await deleteProject({ ...context, projectId: required(args, "project", args.positionals[0] || process.env.T3_PROJECT_ID || process.env.T3CTL_PROJECT_ID), force: boolFlag(args, "force") }); return 0; }
    if (subcommand === "update" || subcommand === "rename") { await updateProject({ ...context, projectId: required(args, "project", args.positionals[0] || process.env.T3_PROJECT_ID || process.env.T3CTL_PROJECT_ID), title: flag(args, "title") || (subcommand === "rename" ? args.positionals[1] : undefined), workspaceRoot: flag(args, "workspace-root"), provider: flag(args, "provider"), model: flag(args, "model"), options: modelOptions(args) }); return 0; }
    if (subcommand === "clone") { await cloneProject({ ...context, repositoryUrl: required(args, "url", args.positionals[0]), destination: required(args, "destination", args.positionals[1]), title: flag(args, "title") }); return 0; }
    throw new ConfigError("Unknown project command.", "cli_parse_failed");
  }
  if (root === "thread") {
    const threadId = flag(args, "thread") || flag(args, "thread-id") || process.env.T3_THREAD_ID || process.env.T3CTL_THREAD_ID || args.positionals[0];
    if (subcommand === "list") { await listThreads({ ...context, projectId: flag(args, "project") || process.env.T3_PROJECT_ID || process.env.T3CTL_PROJECT_ID || args.positionals[0] }); return 0; }
    if (subcommand === "create") {
      await createThread({ ...context, projectId: required(args, "project", process.env.T3_PROJECT_ID || process.env.T3CTL_PROJECT_ID), title: required(args, "title"), provider: flag(args, "provider"), model: flag(args, "model"), runtimeMode: flag(args, "runtime-mode"), interactionMode: flag(args, "interaction-mode"), options: modelOptions(args) });
      return 0;
    }
    if (subcommand === "start") {
      const projectSelection = flag(args, "project") || process.env.T3_PROJECT_ID || process.env.T3CTL_PROJECT_ID;
      const positionalThreadId = !projectSelection && args.positionals.length > 1 ? args.positionals[0] : undefined;
      const startThreadId = flag(args, "thread") || process.env.T3_THREAD_ID || process.env.T3CTL_THREAD_ID || positionalThreadId;
      const message = await readMessage(args, startThreadId ? 1 : 0);
      const wait = boolFlag(args, "wait");
      const images = imageFlags(args);
      const result = await startThread({ ...context, threadId: startThreadId, projectId: projectSelection, title: flag(args, "title"), message, images, wait, provider: flag(args, "provider"), model: flag(args, "model"), runtimeMode: flag(args, "runtime-mode"), interactionMode: flag(args, "interaction-mode"), options: modelOptions(args) });
      return lifecycleExitCode((result as any)?.wait?.status);
    }
    if (subcommand === "send") {
      if (!threadId) throw new ConfigError("thread send requires a thread ID.", "thread_missing");
      const message = await readMessage(args, 1);
      const images = imageFlags(args);
      const result = await sendMessage({ ...context, threadId, message, images, wait: boolFlag(args, "wait"), provider: flag(args, "provider"), model: flag(args, "model"), runtimeMode: flag(args, "runtime-mode"), interactionMode: flag(args, "interaction-mode"), options: modelOptions(args) });
      return lifecycleExitCode((result as any)?.wait?.status);
    }
    if (["wait", "watch"].includes(subcommand || "")) {
      if (!threadId) throw new ConfigError(`thread ${subcommand} requires a thread ID.`, "thread_missing");
      const streamContext = { ...context, format: subcommand === "watch" ? "ndjson" as const : format, stream: true };
      if (subcommand === "wait") return lifecycleExitCode((await waitForThread({ ...streamContext, threadId }) as any)?.status);
      return lifecycleExitCode((await watchThread({ ...streamContext, threadId }) as any)?.status);
    }
    if (subcommand === "view") { if (!threadId) throw new ConfigError("thread view requires a thread ID.", "thread_missing"); await viewThread({ ...context, threadId }); return 0; }
    if (subcommand === "transcript") { if (!threadId) throw new ConfigError("thread transcript requires a thread ID.", "thread_missing"); await transcript({ ...context, threadId }); return 0; }
    if (["archive", "unarchive", "delete", "interrupt", "settle", "unsettle"].includes(subcommand || "")) {
      if (!threadId) throw new ConfigError(`thread ${subcommand} requires a thread ID.`, "thread_missing");
      const operation = { archive: archiveThread, unarchive: unarchiveThread, delete: deleteThread, interrupt: interruptThread, settle: settleThread, unsettle: unsettleThread }[subcommand!];
      if (!operation) throw new ConfigError(`Unsupported thread operation "${subcommand}".`, "cli_parse_failed");
      await operation({ ...context, threadId });
      return 0;
    }
    if (subcommand === "update") {
      if (!threadId) throw new ConfigError("thread update requires a thread ID.", "thread_missing");
      await updateThread({ ...context, threadId, title: flag(args, "title"), provider: flag(args, "provider"), model: flag(args, "model"), branch: flag(args, "branch"), worktreePath: flag(args, "worktree-path"), runtimeMode: flag(args, "runtime-mode"), interactionMode: flag(args, "interaction-mode"), options: modelOptions(args) });
      return 0;
    }
    if (subcommand === "respond") {
      if (!threadId) throw new ConfigError("thread respond requires a thread ID.", "thread_missing");
      await respondToApproval({ ...context, threadId, requestId: required(args, "request-id"), decision: required(args, "decision") });
      return 0;
    }
    if (subcommand === "respond-input" || subcommand === "input") {
      if (!threadId) throw new ConfigError("thread input requires a thread ID.", "thread_missing");
      const rawAnswers = required(args, "answers");
      let answers: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawAnswers) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("answers must be an object");
        answers = parsed as Record<string, unknown>;
      } catch {
        throw new ConfigError("--answers must be a JSON object.", "cli_parse_failed");
      }
      await respondToUserInput({ ...context, threadId, requestId: required(args, "request-id"), answers });
      return 0;
    }
    throw new ConfigError("Unknown thread command.", "cli_parse_failed");
  }
  if (root === "terminal") {
    const threadId = flag(args, "thread") || flag(args, "thread-id") || process.env.T3_THREAD_ID || process.env.T3CTL_THREAD_ID || args.positionals[0];
    if (subcommand === "attach" || !subcommand) {
      if (!threadId) throw new ConfigError("terminal attach requires a thread ID.", "thread_missing");
      const exitCode = await attachTerminal({
        ...context,
        threadId,
        terminalId: flag(args, "terminal-id"),
        cwd: flag(args, "cwd"),
        cols: parseIntFlag(flag(args, "cols"), "cols"),
        rows: parseIntFlag(flag(args, "rows"), "rows"),
        env: parseEnvList(flag(args, "env-var")),
      });
      return exitCode;
    }
    if (subcommand === "list") {
      if (!threadId) throw new ConfigError("terminal list requires a thread ID.", "thread_missing");
      await listTerminals({ ...context, threadId });
      return 0;
    }
    if (subcommand === "close") {
      if (!threadId) throw new ConfigError("terminal close requires a thread ID.", "thread_missing");
      await closeTerminal({ ...context, threadId, terminalId: flag(args, "terminal-id"), deleteHistory: boolFlag(args, "delete-history") });
      return 0;
    }
    throw new ConfigError("Unknown terminal command. Use terminal attach, terminal list, or terminal close.", "cli_parse_failed");
  }
  if (root === "connect") {
    // Clean-break alias retained as a discoverable migration path.
    const input = required(args, "url", args.positionals[0]);
    const result = await authenticatePair({ input, name: flag(args, "name"), credential: flag(args, "token") });
    createOutputSink(format).write(result);
    return 0;
  }
  throw new ConfigError(`Unknown command "${root}".\n\n${topLevelHelp()}`, "cli_parse_failed");
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  let format: OutputFormat = "auto";
  try {
    format = outputFormatFromArgv(argv);
    const startsWithExecutable = argv[0] === "t3ctl" || argv[0] === "t3code-cli" || argv[0]?.endsWith("/t3ctl.js");
    const args = parseArgs(startsWithExecutable ? argv.slice(1) : argv.slice(2));
    const code = await runCommand(args, format);
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    const parsed = toCommandError(error);
    const sink = createOutputSink(format, { stream: format === "ndjson" });
    sink.error(parsed.output);
    process.exitCode = parsed.exitCode;
  }
}

export { parseArgs, readMessage };
