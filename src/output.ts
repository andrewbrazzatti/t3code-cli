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

function humanize(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => humanize(entry)).join("\n");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${typeof entry === "object" ? JSON.stringify(entry) : String(entry)}`)
      .join("\n");
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
