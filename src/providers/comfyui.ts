import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  Clock,
  FetchLike,
  JsonObject,
  JsonValue,
  ProviderAdapter,
  ProviderCancelRequest,
  ProviderCapability,
  ProviderDataTransferMode,
  ProviderDescriptor,
  ProviderEstimate,
  ProviderEstimateRequest,
  ProviderHealth,
  ProviderJob,
  ProviderModelDescriptor,
  ProviderOutput,
  ProviderPollRequest,
  ProviderSubmitRequest,
} from "./types.js";
import {
  ProviderConfigurationError,
  ProviderProtocolError,
  assertProviderCapability,
  systemClock,
} from "./types.js";
import {
  assertNoInlineSecrets,
  fetchJson,
  inferOutputKind,
  joinUrl,
  objectAt,
  readSecretFromEnvironment,
  stringAt,
} from "./utils.js";

const DEFAULT_CAPABILITIES: readonly ProviderCapability[] = [
  "image.generate",
  "image.edit",
  "video.i2v",
  "video.r2v",
  "video.t2v",
];

export interface ComfyUiProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly capabilities?: readonly ProviderCapability[];
  readonly models?: readonly ProviderModelDescriptor[];
  readonly apiKeyEnv?: string;
  readonly apiKeyHeader?: string;
  readonly clientIdEnv?: string;
  readonly workflowDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly requestTimeoutMs?: number;
  readonly dataTransfer?: ProviderDataTransferMode;
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
}

export class ComfyUiProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #baseUrl: string;
  readonly #apiKeyEnv?: string;
  readonly #apiKeyHeader: string;
  readonly #clientIdEnv?: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #requestTimeoutMs: number;
  readonly #workflowDirectory?: string;

  constructor(config: ComfyUiProviderConfig = {}) {
    this.#baseUrl = normalizeBaseUrl(config.baseUrl ?? "http://127.0.0.1:8188");
    this.#apiKeyEnv = config.apiKeyEnv;
    this.#apiKeyHeader = config.apiKeyHeader ?? "Authorization";
    this.#clientIdEnv = config.clientIdEnv;
    this.#environment = config.environment ?? process.env;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#clock = config.clock ?? systemClock;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.#workflowDirectory = config.workflowDirectory
      ? resolve(config.workflowDirectory)
      : undefined;
    const secretEnvVars = [config.apiKeyEnv, config.clientIdEnv].filter(
      (value): value is string => Boolean(value),
    );
    this.descriptor = {
      id: config.id ?? "comfyui",
      displayName: config.displayName ?? "ComfyUI",
      adapter: "comfyui",
      capabilities: config.capabilities ?? DEFAULT_CAPABILITIES,
      ...(config.models ? { models: config.models } : {}),
      ...(secretEnvVars.length ? { secretEnvVars } : {}),
      dataTransfer: config.dataTransfer ?? "local-or-configured-remote",
      ...(config.termsUrl ? { termsUrl: config.termsUrl } : {}),
      ...(config.privacyUrl ? { privacyUrl: config.privacyUrl } : {}),
      metadata: {
        advancedLocalWorkflow: true,
        transport: "local-http",
        submitPath: "/prompt",
        historyPath: "/history",
        outputOrigin: new URL(this.#baseUrl).origin,
        workflowVersionPolicy:
          "inline metadata.workflowVersion; file *.vNNN.json or JSON schemaVersion/workflowVersion",
        ...(this.#workflowDirectory ? { workflowDirectory: this.#workflowDirectory } : {}),
      },
    };
  }

  capabilities(): Promise<readonly ProviderCapability[]> {
    return Promise.resolve([...this.descriptor.capabilities]);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = this.#clock.now().toISOString();
    const startedAt = performance.now();
    try {
      const response = await this.#fetch(joinUrl(this.#baseUrl, "/system_stats"), {
        method: "GET",
        headers: this.#headers(),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      return {
        providerId: this.descriptor.id,
        status: response.ok ? "healthy" : response.status >= 500 ? "unavailable" : "degraded",
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
        ...(response.ok ? {} : { message: `ComfyUI returned HTTP ${response.status}` }),
      };
    } catch (error) {
      const missingConfiguration = error instanceof ProviderConfigurationError;
      return {
        providerId: this.descriptor.id,
        status: missingConfiguration ? "unconfigured" : "unavailable",
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : "ComfyUI health request failed",
      };
    }
  }

  estimate(request: ProviderEstimateRequest): Promise<ProviderEstimate> {
    assertProviderCapability(this.descriptor, request.capability);
    return Promise.resolve({
      providerId: this.descriptor.id,
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      notes: ["Local ComfyUI cost and runtime depend on the configured workflow and hardware"],
    });
  }

  async submit(request: ProviderSubmitRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertNoInlineSecrets(request.input);
    if (request.metadata) assertNoInlineSecrets(request.metadata, "metadata");
    const workflow = await workflowFromInput(
      request.input,
      this.#workflowDirectory,
      request.metadata,
    );
    const clientId = this.#clientIdEnv
      ? readSecretFromEnvironment(this.#clientIdEnv, this.#environment)
      : undefined;
    const requestBody: JsonObject = {
      prompt: workflow,
      ...(clientId ? { client_id: clientId } : {}),
      ...(request.metadata ? { extra_data: request.metadata } : {}),
    };
    const { body } = await fetchJson(this.#fetch, joinUrl(this.#baseUrl, "/prompt"), {
      method: "POST",
      headers: this.#jsonHeaders(),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    const remoteJobId = stringAt(body, ["prompt_id"]);
    if (!remoteJobId) throw new ProviderProtocolError("ComfyUI /prompt response omitted prompt_id");
    const nodeErrors = objectAt(body, ["node_errors"]);
    const now = this.#clock.now().toISOString();
    const failed = nodeErrors !== undefined && Object.keys(nodeErrors).length > 0;
    return {
      id: `${this.descriptor.id}:${remoteJobId}`,
      remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      state: failed ? "failed_terminal" : "queued",
      ...(request.model ? { model: request.model } : {}),
      submittedAt: now,
      updatedAt: now,
      ...(failed
        ? {
            error: {
              code: "comfyui_node_validation",
              message: "ComfyUI rejected one or more workflow nodes",
              retryable: false,
            },
          }
        : {}),
    };
  }

  async poll(request: ProviderPollRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    const { body } = await fetchJson(
      this.#fetch,
      joinUrl(this.#baseUrl, `/history/${encodeURIComponent(request.remoteJobId)}`),
      {
        method: "GET",
        headers: this.#headers(),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      },
    );
    const root = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const history = root[request.remoteJobId];
    const now = this.#clock.now().toISOString();
    if (history === undefined) {
      return this.#job(request, "queued", now);
    }
    if (history === null || typeof history !== "object") {
      throw new ProviderProtocolError("ComfyUI history entry is not an object");
    }
    const record = history as Record<string, unknown>;
    const status = record.status;
    const statusRecord =
      status !== null && typeof status === "object" ? (status as Record<string, unknown>) : {};
    const statusText =
      typeof statusRecord.status_str === "string" ? statusRecord.status_str.toLowerCase() : "";
    const completed = statusRecord.completed === true;
    const messages = Array.isArray(statusRecord.messages) ? statusRecord.messages : [];
    const errorMessage = findComfyError(messages);
    if (errorMessage || statusText === "error" || statusText === "failed") {
      return this.#job(request, "failed_terminal", now, [], {
        code: "comfyui_execution_failed",
        message: errorMessage ?? "ComfyUI workflow execution failed",
        retryable: false,
      });
    }
    if (!completed && statusText !== "success") return this.#job(request, "running", now);
    return this.#job(request, "succeeded", now, collectComfyOutputs(record.outputs, this.#baseUrl));
  }

  async cancel(request: ProviderCancelRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    await fetchJson(this.#fetch, joinUrl(this.#baseUrl, "/queue"), {
      method: "POST",
      headers: this.#jsonHeaders(),
      body: JSON.stringify({ delete: [request.remoteJobId] }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    const now = this.#clock.now().toISOString();
    return this.#job(request, "cancelled", now);
  }

  #job(
    request: ProviderPollRequest,
    state: ProviderJob["state"],
    now: string,
    outputs: readonly ProviderOutput[] = [],
    error?: ProviderJob["error"],
  ): ProviderJob {
    return {
      id: `${this.descriptor.id}:${request.remoteJobId}`,
      remoteJobId: request.remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      state,
      ...(request.model ? { model: request.model } : {}),
      submittedAt: now,
      updatedAt: now,
      ...(outputs.length ? { outputs } : {}),
      ...(error ? { error } : {}),
    };
  }

  #headers(): Headers {
    const headers = new Headers({ Accept: "application/json" });
    if (this.#apiKeyEnv) {
      headers.set(
        this.#apiKeyHeader,
        `Bearer ${readSecretFromEnvironment(this.#apiKeyEnv, this.#environment)}`,
      );
    }
    return headers;
  }

  #jsonHeaders(): Headers {
    const headers = this.#headers();
    headers.set("Content-Type", "application/json");
    return headers;
  }
}

async function workflowFromInput(
  input: JsonObject,
  workflowDirectory?: string,
  metadata?: JsonObject,
): Promise<JsonObject> {
  const value = input.workflow ?? input.prompt;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (!isWorkflowVersion(metadata?.workflowVersion)) {
      throw new ProviderConfigurationError(
        "Inline ComfyUI workflow requires metadata.workflowVersion",
      );
    }
    return value;
  }
  const workflowFile = input.workflowFile;
  if (typeof workflowFile === "string" && workflowDirectory) {
    if (!workflowFile.endsWith(".json") || isAbsolute(workflowFile)) {
      throw new ProviderConfigurationError("ComfyUI workflowFile must be a relative .json path");
    }
    const path = resolve(workflowDirectory, workflowFile);
    const relation = relative(workflowDirectory, path);
    if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
      throw new ProviderConfigurationError("ComfyUI workflowFile escapes workflowDirectory");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      throw new ProviderConfigurationError(`Could not load ComfyUI workflow ${path}`, { cause: error });
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const document = parsed as JsonObject;
      const fileNameIsVersioned = /\.v\d{3}\.json$/i.test(workflowFile);
      if (
        !fileNameIsVersioned &&
        !isWorkflowVersion(document.workflowVersion) &&
        !isWorkflowVersion(document.schemaVersion)
      ) {
        throw new ProviderConfigurationError(
          "ComfyUI workflowFile must use a *.vNNN.json name or declare schemaVersion/workflowVersion",
        );
      }
      const nestedWorkflow = document.workflow;
      if (
        nestedWorkflow !== null &&
        typeof nestedWorkflow === "object" &&
        !Array.isArray(nestedWorkflow)
      ) {
        return nestedWorkflow;
      }
      const workflow = { ...document };
      delete workflow.schemaVersion;
      delete workflow.workflowVersion;
      return workflow;
    }
    throw new ProviderConfigurationError(`ComfyUI workflow ${path} must contain a JSON object`);
  }
  throw new ProviderConfigurationError(
    "ComfyUI submit input must include a JSON object in `workflow`/`prompt`, or a configured workflowFile",
  );
}

function isWorkflowVersion(value: JsonValue | undefined): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0 && value.length <= 64) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function findComfyError(messages: unknown[]): string | undefined {
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const tuple = entry as unknown[];
    const kindValue: unknown = tuple[0];
    const kind = typeof kindValue === "string" ? kindValue.toLowerCase() : "";
    if (!kind.includes("error")) continue;
    const detail: unknown = tuple[1];
    if (typeof detail === "string") return detail;
    if (detail !== null && typeof detail === "object") {
      const record = detail as Record<string, unknown>;
      const message = record.exception_message ?? record.message;
      return typeof message === "string" ? message : "ComfyUI execution failed";
    }
  }
  return undefined;
}

function collectComfyOutputs(raw: unknown, baseUrl: string): ProviderOutput[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const outputs: ProviderOutput[] = [];
  for (const nodeOutput of Object.values(raw as Record<string, unknown>)) {
    if (nodeOutput === null || typeof nodeOutput !== "object" || Array.isArray(nodeOutput)) continue;
    for (const [group, files] of Object.entries(nodeOutput as Record<string, unknown>)) {
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        if (file === null || typeof file !== "object" || Array.isArray(file)) continue;
        const record = file as Record<string, unknown>;
        if (typeof record.filename !== "string") continue;
        const uri = new URL("view", baseUrl);
        uri.searchParams.set("filename", record.filename);
        if (typeof record.subfolder === "string") uri.searchParams.set("subfolder", record.subfolder);
        if (typeof record.type === "string") uri.searchParams.set("type", record.type);
        outputs.push({
          kind: outputKindForGroup(group, record.filename),
          uri: uri.toString(),
          metadata: { nodeOutput: group as JsonValue },
        });
      }
    }
  }
  return outputs;
}

function outputKindForGroup(group: string, filename: string): ProviderOutput["kind"] {
  const normalized = group.toLowerCase();
  if (normalized.includes("image")) return "image";
  if (normalized.includes("video") || normalized.includes("gif")) return "video";
  if (normalized.includes("audio")) return "audio";
  return inferOutputKind(undefined, filename);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderConfigurationError("ComfyUI base URL must use http or https");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}
