import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_VERSION = 2 as const;

export interface EnvironmentConfig {
  readonly name: string;
  readonly serverUrl: string;
  /** Identifier in the credential store. The secret is never stored here. */
  readonly credentialId?: string;
  readonly credentialBackend?: "keyring" | "encrypted-file";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface T3CodeCliConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly activeEnvironment?: string;
  readonly environments: Record<string, EnvironmentConfig>;
  readonly defaultProjectId?: string;
  readonly defaultModel?: {
    readonly instanceId: string;
    readonly model: string;
  };
}

export class ConfigError extends Error {
  readonly code: string;

  constructor(message: string, code = "config_invalid") {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

function configDirectory(): string {
  return process.env.T3CTL_CONFIG_DIR?.trim() || path.join(os.homedir(), ".config", "t3code-cli");
}

export function getConfigDir(): string {
  return configDirectory();
}

export function getConfigPath(): string {
  return process.env.T3CTL_CONFIG_FILE?.trim() || path.join(configDirectory(), "config.json");
}

export function getCredentialFilePath(): string {
  return path.join(configDirectory(), "credentials.enc");
}

export function getCredentialKeyPath(): string {
  return path.join(configDirectory(), "credentials.key");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvironment(name: string, value: unknown): EnvironmentConfig {
  if (!isRecord(value) || typeof value.serverUrl !== "string" || value.serverUrl.trim() === "") {
    throw new ConfigError(`Environment "${name}" is missing a valid serverUrl.`);
  }
  let url: URL;
  try {
    url = new URL(value.serverUrl);
  } catch {
    throw new ConfigError(`Environment "${name}" has an invalid server URL.`, "server_url_invalid");
  }
  if (!("http:" === url.protocol || "https:" === url.protocol || "ws:" === url.protocol || "wss:" === url.protocol)) {
    throw new ConfigError(`Environment "${name}" uses unsupported server URL protocol "${url.protocol}".`, "server_url_invalid");
  }
  if ("token" in value || "accessToken" in value || "credential" in value) {
    throw new ConfigError(
      `Environment "${name}" contains a plaintext credential. This clean-break configuration no longer supports plaintext tokens; run "t3ctl auth pair" or "t3ctl auth local" again.`,
      "plaintext_credential_rejected",
    );
  }
  const now = new Date().toISOString();
  return {
    name,
    serverUrl: value.serverUrl.trim(),
    ...(typeof value.credentialId === "string" && value.credentialId.trim().length > 0
      ? { credentialId: value.credentialId.trim() }
      : {}),
    ...(value.credentialBackend === "keyring" || value.credentialBackend === "encrypted-file"
      ? { credentialBackend: value.credentialBackend }
      : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

export function validateConfig(value: unknown): T3CodeCliConfig {
  if (!isRecord(value)) {
    throw new ConfigError("Configuration must be a JSON object.");
  }
  if (value.version !== CONFIG_VERSION) {
    if ("token" in value || "serverUrl" in value) {
      throw new ConfigError(
        `Unsupported legacy configuration format. Plaintext tokens are not migrated; run "t3ctl auth pair" or "t3ctl auth local" to create the v${CONFIG_VERSION} configuration.`,
        "legacy_config_rejected",
      );
    }
    throw new ConfigError(
      `Unsupported configuration version ${String(value.version)}; expected ${CONFIG_VERSION}.`,
      "config_version_unsupported",
    );
  }
  if (!isRecord(value.environments)) {
    throw new ConfigError("Configuration field environments must be an object.");
  }
  const environments: Record<string, EnvironmentConfig> = {};
  for (const [name, environment] of Object.entries(value.environments)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      throw new ConfigError(`Invalid environment name "${name}".`);
    }
    environments[name] = parseEnvironment(name, environment);
  }
  if (value.activeEnvironment !== undefined && typeof value.activeEnvironment !== "string") {
    throw new ConfigError("Configuration field activeEnvironment must be a string.");
  }
  if (value.activeEnvironment !== undefined && !environments[value.activeEnvironment]) {
    throw new ConfigError(
      `Active environment "${value.activeEnvironment}" is not configured. Run "t3ctl env list" or select another environment.`,
      "active_environment_missing",
    );
  }
  return {
    version: CONFIG_VERSION,
    ...(value.activeEnvironment ? { activeEnvironment: value.activeEnvironment } : {}),
    environments,
    ...(typeof value.defaultProjectId === "string" ? { defaultProjectId: value.defaultProjectId } : {}),
    ...(isRecord(value.defaultModel) &&
    typeof value.defaultModel.instanceId === "string" &&
    typeof value.defaultModel.model === "string"
      ? { defaultModel: { instanceId: value.defaultModel.instanceId, model: value.defaultModel.model } }
      : {}),
  };
}

const emptyConfig = (): T3CodeCliConfig => ({ version: CONFIG_VERSION, environments: {} });

export function loadConfig(): T3CodeCliConfig {
  const file = getConfigPath();
  if (!fs.existsSync(file)) return emptyConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Cannot read ${file}: ${error instanceof Error ? error.message : "invalid JSON"}. Fix or remove the file, then authenticate again.`,
      "config_read_failed",
    );
  }
  return validateConfig(parsed);
}

export function writeSecureJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is not available on every supported filesystem.
  }
}

export function saveConfig(config: T3CodeCliConfig): T3CodeCliConfig {
  const validated = validateConfig(config);
  writeSecureJson(getConfigPath(), validated);
  return validated;
}

export function updateConfig(patch: Partial<Omit<T3CodeCliConfig, "version" | "environments">> & {
  readonly environments?: Record<string, EnvironmentConfig>;
}): T3CodeCliConfig {
  const current = loadConfig();
  return saveConfig({
    ...current,
    ...patch,
    version: CONFIG_VERSION,
    environments: patch.environments ?? current.environments,
  });
}

export function upsertEnvironment(input: {
  readonly name: string;
  readonly serverUrl: string;
  readonly credentialId?: string;
  readonly credentialBackend?: "keyring" | "encrypted-file";
  readonly setActive?: boolean;
}): T3CodeCliConfig {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new ConfigError(`Invalid environment name "${name}".`);
  }
  let url: URL;
  try {
    url = new URL(input.serverUrl);
  } catch {
    throw new ConfigError("Invalid server URL.", "server_url_invalid");
  }
  if (!(["http:", "https:", "ws:", "wss:"].includes(url.protocol))) {
    throw new ConfigError(`Unsupported server URL protocol "${url.protocol}".`, "server_url_invalid");
  }
  const current = loadConfig();
  const old = current.environments[name];
  const now = new Date().toISOString();
  const environment: EnvironmentConfig = {
    name,
    serverUrl: input.serverUrl,
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    ...(input.credentialBackend ? { credentialBackend: input.credentialBackend } : {}),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
  return saveConfig({
    ...current,
    environments: { ...current.environments, [name]: environment },
    ...(input.setActive || !current.activeEnvironment ? { activeEnvironment: name } : {}),
  });
}

export function removeEnvironment(name: string): T3CodeCliConfig {
  const current = loadConfig();
  if (!current.environments[name]) {
    throw new ConfigError(`Environment "${name}" is not configured.`, "environment_missing");
  }
  const environments = { ...current.environments };
  delete environments[name];
  const activeEnvironment = current.activeEnvironment === name ? Object.keys(environments)[0] : current.activeEnvironment;
  return saveConfig({
    ...current,
    environments,
    activeEnvironment,
  });
}

export function setActiveEnvironment(name: string): T3CodeCliConfig {
  const current = loadConfig();
  if (!current.environments[name]) {
    throw new ConfigError(`Environment "${name}" is not configured.`, "environment_missing");
  }
  return saveConfig({ ...current, activeEnvironment: name });
}
