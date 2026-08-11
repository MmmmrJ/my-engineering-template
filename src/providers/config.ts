import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ProviderDescriptor as CoreProviderDescriptor,
  ProviderFacade,
  ProviderHealth as CoreProviderHealth,
} from "../contracts/providers.js";
import { AlibabaWanProviderAdapter } from "./alibaba-wan.js";
import type { AlibabaWanProviderConfig, AlibabaWanRouteConfig } from "./alibaba-wan.js";
import { ComfyUiProviderAdapter } from "./comfyui.js";
import { HYPERFRAMES_DESCRIPTOR } from "./hyperframes.js";
import { LocalFfmpegProviderAdapter } from "./local-ffmpeg.js";
import { ManualProviderAdapter } from "./manual.js";
import {
  MANUAL_PLATFORM_ADAPTERS,
  MANUAL_PLATFORM_PROFILES,
  isManualPlatformAdapter,
  type ManualPlatformAdapter,
} from "./platform-manual.js";
import {
  MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR,
  MiniMaxProviderAdapter,
} from "./minimax.js";
import type { MiniMaxProviderConfig, MiniMaxRouteConfig } from "./minimax.js";
import { ProviderRegistry } from "./registry.js";
import type {
  Clock,
  FetchLike,
  JsonObject,
  ProviderCapability,
  ProviderDataTransferMode,
  ProviderDescriptor,
  ProviderModelDescriptor,
  ProviderPrice,
} from "./types.js";
import {
  PROVIDER_CAPABILITIES,
  ProviderConfigurationError,
  isProviderCapability,
} from "./types.js";

interface ProviderConfigCommon {
  readonly id: string;
  readonly displayName?: string;
  readonly adapter:
    | "manual"
    | ManualPlatformAdapter
    | "minimax"
    | "alibaba-wan"
    | "comfyui"
    | "local-ffmpeg";
  readonly enabled?: boolean;
  readonly capabilities?: readonly ProviderCapability[];
  readonly models?: readonly ProviderModelDescriptor[];
  readonly regions?: readonly string[];
  readonly region?: string;
  readonly price?: ProviderPrice;
  readonly dataTransfer?: ProviderDataTransferMode;
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
}

interface ManualFileConfig extends ProviderConfigCommon {
  readonly adapter: "manual" | ManualPlatformAdapter;
  readonly requestDirectory: string;
  readonly resultDirectory: string;
  readonly instructions?: string;
}

interface MiniMaxFileConfig extends ProviderConfigCommon {
  readonly adapter: "minimax";
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly routes?: Readonly<Partial<Record<ProviderCapability, MiniMaxRouteConfig>>>;
}

interface AlibabaFileConfig extends ProviderConfigCommon {
  readonly adapter: "alibaba-wan";
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly routes?: Readonly<Partial<Record<ProviderCapability, AlibabaWanRouteConfig>>>;
}

interface ComfyUiFileConfig extends ProviderConfigCommon {
  readonly adapter: "comfyui";
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly apiKeyHeader?: string;
  readonly clientIdEnv?: string;
  readonly workflowDirectory?: string;
}

interface LocalFfmpegFileConfig extends ProviderConfigCommon {
  readonly adapter: "local-ffmpeg";
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly currency?: string;
}

type ProviderFileConfig =
  | ManualFileConfig
  | MiniMaxFileConfig
  | AlibabaFileConfig
  | ComfyUiFileConfig
  | LocalFfmpegFileConfig;

export interface ProviderConfigFile {
  readonly schemaVersion: 1;
  readonly providers: readonly ProviderFileConfig[];
}

export interface LoadProviderRegistryOptions {
  readonly cwd?: string;
  readonly baseDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly includeHyperFrames?: boolean;
}

export async function resolveProviderConfigPath(cwd = process.cwd()): Promise<string> {
  const local = resolve(cwd, "config/providers.local.json");
  if (await exists(local)) return local;
  return resolve(cwd, "config/providers.example.json");
}

export async function loadProviderRegistry(
  configPath?: string,
  options: LoadProviderRegistryOptions = {},
): Promise<ProviderRegistry> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const resolvedConfigPath = configPath
    ? resolve(cwd, configPath)
    : await resolveProviderConfigPath(cwd);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as unknown;
  } catch (error) {
    throw new ProviderConfigurationError(
      `Could not read provider configuration ${resolvedConfigPath}`,
      { cause: error },
    );
  }
  const config = validateConfigFile(raw);
  const baseDirectory = resolve(options.baseDirectory ?? cwd);
  const registry = new ProviderRegistry();
  for (const entry of config.providers) {
    if (entry.enabled === false) {
      registry.registerDescriptor(disabledDescriptor(entry));
      continue;
    }
    switch (entry.adapter) {
      case "manual":
      case "jimeng-manual":
      case "kling-manual":
      case "liblib-manual":
      case "jianying-manual": {
        const profile = isManualPlatformAdapter(entry.adapter)
          ? MANUAL_PLATFORM_PROFILES[entry.adapter]
          : undefined;
        registry.register(
          new ManualProviderAdapter({
            id: entry.id,
            displayName: entry.displayName ?? profile?.displayName ?? "Manual Import",
            requestDirectory: resolve(baseDirectory, entry.requestDirectory),
            resultDirectory: resolve(baseDirectory, entry.resultDirectory),
            capabilities: entry.capabilities ?? profile?.capabilities ?? PROVIDER_CAPABILITIES,
            ...(entry.models ? { models: entry.models } : {}),
            ...(entry.dataTransfer ? { dataTransfer: entry.dataTransfer } : {}),
            ...(entry.termsUrl ? { termsUrl: entry.termsUrl } : {}),
            ...(entry.privacyUrl ? { privacyUrl: entry.privacyUrl } : {}),
            ...(options.clock ? { clock: options.clock } : {}),
            adapter: entry.adapter,
            ...(entry.instructions ?? profile?.instructions
              ? { instructions: entry.instructions ?? profile?.instructions }
              : {}),
            metadata: {
              ...(profile?.metadata ?? {}),
              ...(entry.instructions ?? profile?.instructions
                ? { instructions: entry.instructions ?? profile?.instructions }
                : {}),
            },
          }),
        );
        break;
      }
      case "minimax":
        registry.register(new MiniMaxProviderAdapter(miniMaxOptions(entry, options)));
        break;
      case "alibaba-wan":
        registry.register(new AlibabaWanProviderAdapter(alibabaOptions(entry, options)));
        break;
      case "comfyui":
        registry.register(
          new ComfyUiProviderAdapter({
            id: entry.id,
            displayName: entry.displayName ?? "ComfyUI",
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
            ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
            ...(entry.models ? { models: entry.models } : {}),
            ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
            ...(entry.apiKeyHeader ? { apiKeyHeader: entry.apiKeyHeader } : {}),
            ...(entry.clientIdEnv ? { clientIdEnv: entry.clientIdEnv } : {}),
            ...(entry.workflowDirectory
              ? { workflowDirectory: resolve(baseDirectory, entry.workflowDirectory) }
              : {}),
            ...(entry.dataTransfer ? { dataTransfer: entry.dataTransfer } : {}),
            ...(entry.termsUrl ? { termsUrl: entry.termsUrl } : {}),
            ...(entry.privacyUrl ? { privacyUrl: entry.privacyUrl } : {}),
            ...(options.environment ? { environment: options.environment } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.clock ? { clock: options.clock } : {}),
          }),
        );
        break;
      case "local-ffmpeg":
        registry.register(
          new LocalFfmpegProviderAdapter({
            id: entry.id,
            displayName: entry.displayName ?? "Local FFmpeg",
            ...(entry.ffmpegPath ? { ffmpegPath: entry.ffmpegPath } : {}),
            ...(entry.ffprobePath ? { ffprobePath: entry.ffprobePath } : {}),
            ...(entry.currency ? { currency: entry.currency } : {}),
            ...(options.clock ? { clock: options.clock } : {}),
          }),
        );
        break;
    }
  }
  if (options.includeHyperFrames ?? true) {
    if (!registry.descriptors().some((descriptor) => descriptor.id === HYPERFRAMES_DESCRIPTOR.id)) {
      registry.registerDescriptor(HYPERFRAMES_DESCRIPTOR);
    }
  }
  if (!registry.descriptors().some(
    (descriptor) => descriptor.id === MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR.id,
  )) {
    registry.registerDescriptor(MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR);
  }
  return registry;
}

/** Adapter from the rich registry to the intentionally small core CLI contract. */
export class ProviderRegistryFacade implements ProviderFacade {
  readonly #registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.#registry = registry;
  }

  list(): Promise<readonly CoreProviderDescriptor[]> {
    return Promise.resolve(this.#registry.descriptors().map((descriptor) => ({
      id: descriptor.id,
      name: descriptor.displayName,
      capabilities: descriptor.capabilities,
      configured: this.#registry.hasAdapter(descriptor.id),
      metadata: {
        ...(descriptor.metadata ?? {}),
        adapter: descriptor.adapter,
        optional: descriptor.optional ?? false,
        models: (descriptor.models ?? []) as unknown as JsonObject["models"],
        regions: (descriptor.regions ?? []) as unknown as JsonObject["regions"],
        price: (descriptor.price ?? null) as unknown as JsonObject["price"],
        dataTransfer: descriptor.dataTransfer ?? "unspecified",
        termsUrl: descriptor.termsUrl ?? null,
        privacyUrl: descriptor.privacyUrl ?? null,
      },
    })));
  }

  async check(providerId?: string): Promise<readonly CoreProviderHealth[]> {
    const health = providerId
      ? [await this.#registry.health(providerId)]
      : await this.#registry.health();
    return health.map((entry) => ({
      providerId: entry.providerId,
      ok: entry.status === "healthy",
      ...(entry.message ? { message: entry.message } : {}),
      metadata: {
        status: entry.status,
        checkedAt: entry.checkedAt,
        ...(entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs }),
      },
    }));
  }
}

export async function loadProviderFacade(
  configPath?: string,
  options: LoadProviderRegistryOptions = {},
): Promise<ProviderFacade> {
  return new ProviderRegistryFacade(await loadProviderRegistry(configPath, options));
}

export async function createDefaultProviderRegistry(
  options: LoadProviderRegistryOptions = {},
): Promise<ProviderRegistry> {
  return loadProviderRegistry(undefined, options);
}

function miniMaxOptions(
  entry: MiniMaxFileConfig,
  options: LoadProviderRegistryOptions,
): MiniMaxProviderConfig {
  return {
    id: entry.id,
    displayName: entry.displayName ?? "MiniMax",
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
    ...(entry.routes ? { routes: entry.routes } : {}),
    ...(entry.models ? { models: entry.models } : {}),
    ...(entry.regions ? { regions: entry.regions } : {}),
    ...(entry.price ? { price: entry.price } : {}),
    ...(entry.dataTransfer ? { dataTransfer: entry.dataTransfer } : {}),
    ...(entry.termsUrl ? { termsUrl: entry.termsUrl } : {}),
    ...(entry.privacyUrl ? { privacyUrl: entry.privacyUrl } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  };
}

function alibabaOptions(
  entry: AlibabaFileConfig,
  options: LoadProviderRegistryOptions,
): AlibabaWanProviderConfig {
  return {
    id: entry.id,
    displayName: entry.displayName ?? "Alibaba Wan",
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
    ...(entry.routes ? { routes: entry.routes } : {}),
    ...(entry.models ? { models: entry.models } : {}),
    regions: entry.regions ?? (entry.region ? [entry.region] : ["cn-beijing"]),
    ...(entry.price ? { price: entry.price } : {}),
    ...(entry.dataTransfer ? { dataTransfer: entry.dataTransfer } : {}),
    ...(entry.termsUrl ? { termsUrl: entry.termsUrl } : {}),
    ...(entry.privacyUrl ? { privacyUrl: entry.privacyUrl } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  };
}

function disabledDescriptor(entry: ProviderFileConfig): ProviderDescriptor {
  const capabilities = entry.capabilities ?? inferCapabilities(entry);
  const secretEnvVars = [
    "apiKeyEnv" in entry ? entry.apiKeyEnv : undefined,
    "clientIdEnv" in entry ? entry.clientIdEnv : undefined,
  ].filter((value): value is string => Boolean(value));
  return {
    id: entry.id,
    displayName: entry.displayName ?? entry.id,
    adapter: entry.adapter,
    capabilities,
    ...(entry.models ? { models: entry.models } : {}),
    ...((entry.regions ?? (entry.region ? [entry.region] : undefined))
      ? { regions: entry.regions ?? [entry.region as string] }
      : {}),
    ...(entry.price ? { price: entry.price } : {}),
    dataTransfer: entry.dataTransfer ?? defaultDataTransfer(entry.adapter),
    ...(entry.termsUrl ? { termsUrl: entry.termsUrl } : {}),
    ...(entry.privacyUrl ? { privacyUrl: entry.privacyUrl } : {}),
    ...(secretEnvVars.length ? { secretEnvVars } : {}),
    optional: true,
    metadata: {
      enabled: false,
      ...(entry.adapter === "comfyui" && entry.workflowDirectory
        ? {
            advancedLocalWorkflow: true,
            workflowDirectory: entry.workflowDirectory,
            workflowVersionPolicy:
              "inline metadata.workflowVersion; file *.vNNN.json or JSON schemaVersion/workflowVersion",
          }
        : {}),
    },
  };
}

function inferCapabilities(entry: ProviderFileConfig): readonly ProviderCapability[] {
  if (entry.adapter === "manual") return PROVIDER_CAPABILITIES;
  if (
    entry.adapter === "jimeng-manual" ||
    entry.adapter === "kling-manual" ||
    entry.adapter === "liblib-manual" ||
    entry.adapter === "jianying-manual"
  ) {
    return MANUAL_PLATFORM_PROFILES[entry.adapter].capabilities;
  }
  if (entry.adapter === "local-ffmpeg") return ["render.timeline", "quality.inspect"];
  if (entry.adapter === "comfyui") {
    return ["image.generate", "image.edit", "video.i2v", "video.r2v", "video.t2v"];
  }
  return "routes" in entry
    ? Object.keys(entry.routes ?? {}) as ProviderCapability[]
    : [];
}

function validateConfigFile(value: unknown): ProviderConfigFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderConfigurationError("Provider configuration must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.providers)) {
    throw new ProviderConfigurationError("Provider configuration needs schemaVersion 1 and providers[]");
  }
  const ids = new Set<string>();
  for (const [index, raw] of record.providers.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ProviderConfigurationError(`Provider configuration entry ${index} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(entry.id)) {
      throw new ProviderConfigurationError(`Provider configuration entry ${index} has an invalid id`);
    }
    if (ids.has(entry.id)) throw new ProviderConfigurationError(`Duplicate provider id ${entry.id}`);
    ids.add(entry.id);
    if (![
      "manual",
      ...MANUAL_PLATFORM_ADAPTERS,
      "minimax",
      "alibaba-wan",
      "comfyui",
      "local-ffmpeg",
    ].includes(String(entry.adapter))) {
      throw new ProviderConfigurationError(
        `Provider ${entry.id} has unsupported adapter ${String(entry.adapter)}`,
      );
    }
    if (entry.capabilities !== undefined) validateCapabilityList(entry.capabilities, entry.id);
    if (entry.routes !== undefined) validateRoutes(entry.routes, entry.id);
    validateTransferFields(entry, entry.id);
    if (entry.adapter === "manual" || isManualPlatformAdapter(String(entry.adapter))) {
      if (typeof entry.requestDirectory !== "string" || typeof entry.resultDirectory !== "string") {
        throw new ProviderConfigurationError(
          `Manual provider ${entry.id} needs requestDirectory and resultDirectory`,
        );
      }
    }
    if (entry.adapter === "comfyui" &&
      entry.workflowDirectory !== undefined &&
      typeof entry.workflowDirectory !== "string") {
      throw new ProviderConfigurationError(`ComfyUI provider ${entry.id} has invalid workflowDirectory`);
    }
    if (entry.adapter === "local-ffmpeg") {
      for (const field of ["ffmpegPath", "ffprobePath"] as const) {
        if (entry[field] !== undefined &&
          (typeof entry[field] !== "string" || !String(entry[field]).trim())) {
          throw new ProviderConfigurationError(
            `Local FFmpeg provider ${entry.id} has invalid ${field}`,
          );
        }
      }
      if (entry.currency !== undefined &&
        (typeof entry.currency !== "string" || !/^[A-Z]{3}$/.test(entry.currency))) {
        throw new ProviderConfigurationError(
          `Local FFmpeg provider ${entry.id} currency must be a three-letter upper-case code`,
        );
      }
    }
  }
  return value as ProviderConfigFile;
}

function validateCapabilityList(value: unknown, providerId: string): void {
  if (
    !Array.isArray(value) ||
    value.some((capability) => typeof capability !== "string" || !isProviderCapability(capability))
  ) {
    throw new ProviderConfigurationError(`Provider ${providerId} has an invalid capability list`);
  }
}

function validateRoutes(value: unknown, providerId: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderConfigurationError(`Provider ${providerId} routes must be an object`);
  }
  for (const [capability, route] of Object.entries(value as Record<string, unknown>)) {
    if (!isProviderCapability(capability) || route === null || typeof route !== "object") {
      throw new ProviderConfigurationError(`Provider ${providerId} has an invalid route for ${capability}`);
    }
    const record = route as Record<string, unknown>;
    if (typeof record.submitPath !== "string" ||
      (record.pollPath !== undefined && typeof record.pollPath !== "string")) {
      throw new ProviderConfigurationError(`Provider ${providerId} route ${capability} is incomplete`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultDataTransfer(adapter: ProviderFileConfig["adapter"]): ProviderDataTransferMode {
  if (adapter === "manual" || isManualPlatformAdapter(adapter)) return "user-managed";
  if (adapter === "comfyui") return "local-or-configured-remote";
  if (adapter === "local-ffmpeg") return "local-only";
  return "external-cloud";
}

function validateTransferFields(entry: Record<string, unknown>, providerId: string): void {
  if (entry.dataTransfer !== undefined) {
    if (typeof entry.dataTransfer !== "string" ||
      !entry.dataTransfer.trim() ||
      entry.dataTransfer.length > 200) {
      throw new ProviderConfigurationError(
        `Provider ${providerId} dataTransfer must be a non-empty description of at most 200 characters`,
      );
    }
  }
  for (const field of ["termsUrl", "privacyUrl"] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isHttpsUrl(value)) {
      throw new ProviderConfigurationError(`Provider ${providerId} ${field} must be an HTTPS URL`);
    }
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
