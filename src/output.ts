export const OUTPUT_FORMATS = ["auto", "human", "json", "ndjson"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type ResolvedOutputFormat = Exclude<OutputFormat, "auto">;

export interface StructuredError {
  readonly version: 1;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface OutputSink {
  readonly format: ResolvedOutputFormat;
  write(value: unknown): void;
  event(type: string, value: unknown): void;
  error(error: StructuredError): void;
}

export function parseOutputFormat(value: string | undefined): OutputFormat {
  if (!value) return "auto";
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(`Invalid output format "${value}". Expected auto, human, json, or ndjson.`);
}

export function outputFormatFromArgv(argv: readonly string[] = process.argv): OutputFormat {
  const environment = process.env.T3CTL_FORMAT?.trim();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format") {
      if (!argv[index + 1]) throw new Error("Invalid output format: --format requires a value.");
      return parseOutputFormat(argv[index + 1]);
    }
    if (value.startsWith("--format=")) return parseOutputFormat(value.slice("--format=".length));
  }
  return parseOutputFormat(environment);
}

export function resolveOutputFormat(format: OutputFormat, options?: { readonly stdoutIsTTY?: boolean; readonly stream?: boolean }): ResolvedOutputFormat {
  if (format !== "auto") return format;
  if (options?.stream) return "ndjson";
  return options?.stdoutIsTTY ?? process.stdout.isTTY ? "human" : "json";
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, current) => (typeof current === "bigint" ? current.toString() : current));
}

export function createOutputSink(format: OutputFormat, options?: { readonly stream?: boolean; readonly stdoutIsTTY?: boolean }): OutputSink {
  const resolved = resolveOutputFormat(format, options);
  return {
    format: resolved,
    write(value: unknown) {
      if (resolved === "human") {
        if (typeof value === "string") process.stdout.write(`${value}\n`);
        else process.stdout.write(`${humanize(value)}\n`);
        return;
      }
      process.stdout.write(`${json(value)}\n`);
    },
    event(type: string, value: unknown) {
      if (resolved === "human") {
        process.stdout.write(`${humanEvent(type, value)}\n`);
      } else {
        process.stdout.write(`${json({ version: 1, type, timestamp: new Date().toISOString(), ...asRecord(value) })}\n`);
      }
    },
    error(error: StructuredError) {
      if (resolved === "human") {
        process.stderr.write(`Error [${error.error.code}]: ${error.error.message}\n`);
      } else {
        const target = resolved === "ndjson" ? process.stderr : process.stderr;
        target.write(`${json(error)}\n`);
      }
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function humanize(value: unknown, indent = 0): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value);
  }

  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(none)`;
    return value.map((entry) => humanize(entry, indent)).join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if ("projects" in obj && Array.isArray(obj.projects)) {
      const projects = obj.projects as Array<Record<string, unknown>>;
      if (projects.length === 0) return `${pad}No projects found.`;
      return projects.map((p) => {
        const title = p.title || p.name || p.id || "Untitled";
        const idStr = p.id ? ` (${p.id})` : "";
        const lines = [`${pad}• ${title}${idStr}`];
        if (p.workspaceRoot) lines.push(`${pad}  Workspace: ${p.workspaceRoot}`);
        const repoObj = p.repositoryIdentity as Record<string, unknown> | null;
        if (repoObj?.canonicalKey) lines.push(`${pad}  Repo: ${repoObj.canonicalKey}`);
        const modelObj = p.defaultModelSelection as Record<string, unknown> | null;
        if (modelObj?.model) {
          lines.push(`${pad}  Model: ${modelObj.instanceId ? `${modelObj.instanceId} / ` : ""}${modelObj.model}`);
        }
        return lines.join("\n");
      }).join("\n\n");
    }

    if ("threads" in obj && Array.isArray(obj.threads)) {
      const threads = obj.threads as Array<Record<string, unknown>>;
      if (threads.length === 0) return `${pad}No threads found.`;
      return threads.map((t) => {
        const title = t.title || t.id || "Untitled Thread";
        const idStr = t.id ? ` (${t.id})` : "";
        const lines = [`${pad}• ${title}${idStr}`];
        if (t.projectId) lines.push(`${pad}  Project: ${t.projectId}`);
        if (t.status) lines.push(`${pad}  Status: ${t.status}`);
        if (t.runtimeMode) lines.push(`${pad}  Runtime: ${t.runtimeMode}`);
        if (t.interactionMode) lines.push(`${pad}  Interaction: ${t.interactionMode}`);
        return lines.join("\n");
      }).join("\n\n");
    }

    if ("providers" in obj && Array.isArray(obj.providers)) {
      const providers = obj.providers as Array<Record<string, unknown>>;
      if (providers.length === 0) return `${pad}No providers found.`;
      return providers.map((prov) => {
        const pName = prov.displayName || prov.name || prov.instanceId || prov.id || "Provider";
        const models = Array.isArray(prov.models) ? (prov.models as Array<Record<string, unknown>>) : [];
        const modelLines = models.map((m) => {
          const mName = m.displayName || m.name || m.id || "Model";
          const mId = m.id && m.id !== mName ? ` (${m.id})` : "";
          return `${pad}  - ${mName}${mId}`;
        }).join("\n");
        return `${pad}• ${pName}:\n${modelLines || `${pad}  (no models available)`}`;
      }).join("\n\n");
    }

    if ("environments" in obj && Array.isArray(obj.environments)) {
      const envs = obj.environments as Array<Record<string, unknown>>;
      const active = obj.activeEnvironment ? ` (active: ${obj.activeEnvironment})` : "";
      const header = `${pad}ENVIRONMENTS${active}`;
      if (envs.length === 0) return `${header}\n${pad}  No environments configured.`;
      const envLines = envs.map((e) => {
        const name = e.name || "unnamed";
        const url = e.serverUrl || "";
        const isActive = e.active ? " [active]" : "";
        const cred = e.credential ? ` [credential: ${e.credential}]` : "";
        return `${pad}  ${isActive ? "*" : " "} ${name}${isActive} - ${url}${cred}`;
      }).join("\n");
      return `${header}\n${envLines}`;
    }

    if ("schedules" in obj && Array.isArray(obj.schedules)) {
      const schedules = obj.schedules as Array<Record<string, unknown>>;
      if (schedules.length === 0) return `${pad}No scheduled sends.`;
      return schedules.map((s) => {
        const lines = [`${pad}• ${s.id} [${s.state}] → thread ${s.threadId}`];
        if (s.environment || s.serverUrl) lines.push(`${pad}  Server: ${s.environment ?? s.serverUrl}`);
        lines.push(`${pad}  Due: ${s.dueAt}`);
        if (s.retryUntil) lines.push(`${pad}  Retries rate-limit failures until ${s.retryUntil}`);
        if (s.lastError) lines.push(`${pad}  Last error: ${s.lastError}`);
        const message = String(s.message ?? "");
        lines.push(`${pad}  Message: ${message.length > 80 ? `${message.slice(0, 77)}...` : message}`);
        return lines.join("\n");
      }).join("\n\n");
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) return `${pad}{}`;
    return entries.map(([key, val]) => {
      if (typeof val === "object" && val !== null) {
        if (Array.isArray(val)) {
          if (val.length === 0) return `${pad}${key}: (empty)`;
          const arrayStr = val.map((v) => typeof v === "object" ? humanize(v, indent + 2) : `${pad}  ${String(v)}`).join("\n");
          return `${pad}${key}:\n${arrayStr}`;
        }
        return `${pad}${key}:\n${humanize(val, indent + 2)}`;
      }
      return `${pad}${key}: ${String(val)}`;
    }).join("\n");
  }

  return String(value);
}

function humanEvent(type: string, value: unknown): string {
  const record = asRecord(value);
  if (type === "thread.event") {
    const event = asRecord(record.event);
    const kind = String(event.type ?? event.kind ?? "event");
    const summary = asRecord(event.payload).summary ?? asRecord(event.payload).detail;
    return `[${kind}]${summary ? ` ${String(summary)}` : ""}`;
  }
  if (type === "thread.completed") return `Thread completed (${String(record.status ?? "completed")}).`;
  if (type === "thread.started") return `Started thread ${String(record.threadId)}.`;
  return `${type}: ${humanize(value)}`;
}

export function structuredError(code: string, message: string, details?: unknown): StructuredError {
  return { version: 1, error: { code, message, ...(details === undefined ? {} : { details }) } };
}
