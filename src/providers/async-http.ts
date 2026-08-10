import type {
  Clock,
  FetchLike,
  JsonObject,
  ProviderAdapter,
  ProviderCancelRequest,
  ProviderCapability,
  ProviderDescriptor,
  ProviderEstimate,
  ProviderEstimateRequest,
  ProviderHealth,
  ProviderJob,
  ProviderJobState,
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
  assertSafeEnvironmentVariableName,
  fetchJson,
  firstPath,
  joinUrl,
  normalizeError,
  normalizeOutputs,
  normalizeState,
  numberAt,
  readSecretFromEnvironment,
  replacePathTokens,
  stringAt,
} from "./utils.js";

export interface AsyncHttpRequestSpec {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AsyncHttpCapabilityRoute {
  readonly submit: AsyncHttpRequestSpec;
  readonly poll: AsyncHttpRequestSpec;
  readonly cancel?: AsyncHttpRequestSpec;
}

export interface SecretHeaderReference {
  readonly header: string;
  readonly env: string;
  readonly prefix?: string;
}

export interface AsyncHttpResponsePaths {
  readonly jobId: readonly string[];
  readonly state: readonly string[];
  readonly progress: readonly string[];
  readonly outputs: readonly string[];
  readonly error: readonly string[];
  readonly submittedAt: readonly string[];
  readonly updatedAt: readonly string[];
  readonly retryAfterMs: readonly string[];
}

export interface AsyncHttpAdapterConfig {
  readonly descriptor: ProviderDescriptor;
  readonly baseUrl: string;
  readonly routes: Readonly<Partial<Record<ProviderCapability, AsyncHttpCapabilityRoute>>>;
  readonly secretHeaders?: readonly SecretHeaderReference[];
  readonly staticHeaders?: Readonly<Record<string, string>>;
  readonly health?: AsyncHttpRequestSpec;
  readonly responsePaths?: Partial<AsyncHttpResponsePaths>;
  readonly stateMap?: Readonly<Record<string, ProviderJobState>>;
  readonly requestTimeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly buildSubmitBody?: (request: ProviderSubmitRequest) => JsonObject;
  readonly buildPollBody?: (request: ProviderPollRequest) => JsonObject | undefined;
  readonly buildCancelBody?: (request: ProviderCancelRequest) => JsonObject | undefined;
  readonly estimateSeconds?: (request: ProviderEstimateRequest) => number | undefined;
}

const DEFAULT_STATE_MAP: Readonly<Record<string, ProviderJobState>> = {
  created: "queued",
  pending: "queued",
  queued: "queued",
  submitted: "queued",
  preparing: "queued",
  running: "running",
  processing: "running",
  in_progress: "running",
  success: "succeeded",
  succeeded: "succeeded",
  completed: "succeeded",
  done: "succeeded",
  retry: "failed_retryable",
  retryable: "failed_retryable",
  throttled: "failed_retryable",
  failed_retryable: "failed_retryable",
  failed: "failed_terminal",
  error: "failed_terminal",
  rejected: "failed_terminal",
  failed_terminal: "failed_terminal",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const DEFAULT_PATHS: AsyncHttpResponsePaths = {
  jobId: ["task_id", "job_id", "id", "data.task_id", "data.job_id", "data.id", "output.task_id"],
  state: ["status", "state", "task_status", "data.status", "data.state", "output.task_status"],
  progress: ["progress", "data.progress", "output.progress"],
  outputs: [
    "outputs",
    "results",
    "data.outputs",
    "data.results",
    "output.results",
    "output.video_url",
    "output.audio_url",
    "output.image_url",
  ],
  error: ["error", "data.error", "output.error", "message", "error_message"],
  submittedAt: ["submitted_at", "created_at", "data.submitted_at", "data.created_at"],
  updatedAt: ["updated_at", "completed_at", "data.updated_at", "data.completed_at"],
  retryAfterMs: ["retry_after_ms", "data.retry_after_ms"],
};

const FORBIDDEN_STATIC_HEADER =
  /(?:authorization|api[-_]?key|token|secret|credential|password|signature)/i;

/** Generic normalized adapter for JSON-over-HTTP asynchronous providers. */
export class AsyncHttpProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #baseUrl: string;
  readonly #routes: AsyncHttpAdapterConfig["routes"];
  readonly #secretHeaders: readonly SecretHeaderReference[];
  readonly #staticHeaders: Readonly<Record<string, string>>;
  readonly #healthRequest?: AsyncHttpRequestSpec;
  readonly #paths: AsyncHttpResponsePaths;
  readonly #stateMap: Readonly<Record<string, ProviderJobState>>;
  readonly #requestTimeoutMs: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #buildSubmitBody: (request: ProviderSubmitRequest) => JsonObject;
  readonly #buildPollBody?: (request: ProviderPollRequest) => JsonObject | undefined;
  readonly #buildCancelBody?: (request: ProviderCancelRequest) => JsonObject | undefined;
  readonly #estimateSeconds?: (request: ProviderEstimateRequest) => number | undefined;

  constructor(config: AsyncHttpAdapterConfig) {
    this.descriptor = config.descriptor;
    this.#baseUrl = validateBaseUrl(config.baseUrl);
    this.#routes = config.routes;
    this.#secretHeaders = config.secretHeaders ?? [];
    this.#staticHeaders = config.staticHeaders ?? {};
    this.#healthRequest = config.health;
    this.#paths = { ...DEFAULT_PATHS, ...config.responsePaths };
    this.#stateMap = { ...DEFAULT_STATE_MAP, ...lowerCaseKeys(config.stateMap ?? {}) };
    this.#requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.#environment = config.environment ?? process.env;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#clock = config.clock ?? systemClock;
    this.#buildSubmitBody =
      config.buildSubmitBody ??
      ((request) => ({
        ...(request.model ? { model: request.model } : {}),
        input: request.input,
        ...(request.region ? { region: request.region } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }));
    this.#buildPollBody = config.buildPollBody;
    this.#buildCancelBody = config.buildCancelBody;
    this.#estimateSeconds = config.estimateSeconds;
    this.#validateConfiguration();
  }

  capabilities(): Promise<readonly ProviderCapability[]> {
    return Promise.resolve([...this.descriptor.capabilities]);
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = performance.now();
    const checkedAt = this.#clock.now().toISOString();
    try {
      this.#headers();
    } catch (error) {
      return {
        providerId: this.descriptor.id,
        status: "unconfigured",
        checkedAt,
        message: error instanceof Error ? error.message : "Provider is not configured",
      };
    }
    if (!this.#healthRequest) {
      return {
        providerId: this.descriptor.id,
        status: "healthy",
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
        message: "Configuration is present; no remote health endpoint is configured",
      };
    }
    try {
      const response = await this.#fetch(
        joinUrl(this.#baseUrl, this.#healthRequest.path),
        this.#requestInit(this.#healthRequest),
      );
      return {
        providerId: this.descriptor.id,
        status: response.ok ? "healthy" : response.status >= 500 ? "unavailable" : "degraded",
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
        message: response.ok ? undefined : `Health endpoint returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        providerId: this.descriptor.id,
        status: "unavailable",
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : "Health request failed",
      };
    }
  }

  estimate(request: ProviderEstimateRequest): Promise<ProviderEstimate> {
    assertProviderCapability(this.descriptor, request.capability);
    const model = request.model
      ? this.descriptor.models?.find((candidate) => candidate.id === request.model)
      : undefined;
    if (request.model && !model) {
      throw new ProviderConfigurationError(
        `Provider ${this.descriptor.id} does not describe model ${request.model}`,
      );
    }
    return Promise.resolve({
      providerId: this.descriptor.id,
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      ...(model?.price ?? this.descriptor.price
        ? { price: model?.price ?? this.descriptor.price }
        : {}),
      ...(this.#estimateSeconds
        ? { estimatedSeconds: this.#estimateSeconds(request) }
        : {}),
    });
  }

  async submit(request: ProviderSubmitRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertNoInlineSecrets(request.input);
    if (request.metadata) assertNoInlineSecrets(request.metadata, "metadata");
    const route = this.#route(request.capability);
    const body = this.#buildSubmitBody(request);
    assertNoInlineSecrets(body, "requestBody");
    const { body: responseBody } = await fetchJson(
      this.#fetch,
      joinUrl(this.#baseUrl, route.submit.path),
      this.#requestInit(route.submit, body, request.idempotencyKey),
    );
    const remoteJobId = stringAt(responseBody, this.#paths.jobId);
    if (!remoteJobId) {
      throw new ProviderProtocolError(
        `Provider ${this.descriptor.id} submit response did not contain a job id`,
      );
    }
    return this.#normalizeJob(responseBody, {
      capability: request.capability,
      model: request.model,
      remoteJobId,
      fallbackState: "queued",
    });
  }

  async poll(request: ProviderPollRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    const route = this.#route(request.capability);
    const spec = this.#resolveJobSpec(route.poll, request.remoteJobId);
    const body = this.#buildPollBody?.(request);
    const { body: responseBody } = await fetchJson(
      this.#fetch,
      joinUrl(this.#baseUrl, spec.path),
      this.#requestInit(spec, body),
    );
    return this.#normalizeJob(responseBody, {
      capability: request.capability,
      model: request.model,
      remoteJobId: request.remoteJobId,
      fallbackState: "running",
    });
  }

  async cancel(request: ProviderCancelRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    const cancel = this.#route(request.capability).cancel;
    if (!cancel) {
      throw new ProviderConfigurationError(
        `Provider ${this.descriptor.id} does not configure cancellation for ${request.capability}`,
      );
    }
    const spec = this.#resolveJobSpec(cancel, request.remoteJobId);
    const body = this.#buildCancelBody?.(request);
    const { body: responseBody } = await fetchJson(
      this.#fetch,
      joinUrl(this.#baseUrl, spec.path),
      this.#requestInit(spec, body),
    );
    return this.#normalizeJob(responseBody, {
      capability: request.capability,
      model: request.model,
      remoteJobId: request.remoteJobId,
      fallbackState: "cancelled",
    });
  }

  #route(capability: ProviderCapability): AsyncHttpCapabilityRoute {
    const route = this.#routes[capability];
    if (!route) {
      throw new ProviderConfigurationError(
        `Provider ${this.descriptor.id} has no HTTP route for ${capability}`,
      );
    }
    return route;
  }

  #resolveJobSpec(spec: AsyncHttpRequestSpec, jobId: string): AsyncHttpRequestSpec {
    return { ...spec, path: replacePathTokens(spec.path, { jobId }) };
  }

  #headers(spec?: AsyncHttpRequestSpec, idempotencyKey?: string): Headers {
    const headers = new Headers({ Accept: "application/json", ...this.#staticHeaders, ...spec?.headers });
    for (const reference of this.#secretHeaders) {
      const secret = readSecretFromEnvironment(reference.env, this.#environment);
      headers.set(reference.header, `${reference.prefix ?? ""}${secret}`);
    }
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    return headers;
  }

  #requestInit(
    spec: AsyncHttpRequestSpec,
    body?: JsonObject,
    idempotencyKey?: string,
  ): RequestInit {
    const headers = this.#headers(spec, idempotencyKey);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return {
      method: spec.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    };
  }

  #normalizeJob(
    body: unknown,
    context: {
      capability: ProviderCapability;
      model?: string;
      remoteJobId: string;
      fallbackState: ProviderJobState;
    },
  ): ProviderJob {
    const now = this.#clock.now().toISOString();
    const state = normalizeState(firstPath(body, this.#paths.state), this.#stateMap, context.fallbackState);
    const progressValue = numberAt(body, this.#paths.progress);
    const progress = progressValue === undefined
      ? undefined
      : Math.max(0, Math.min(1, progressValue > 1 ? progressValue / 100 : progressValue));
    const outputs = normalizeOutputs(firstPath(body, this.#paths.outputs));
    const isFailure = state === "failed_retryable" || state === "failed_terminal";
    const error = isFailure
      ? normalizeError(firstPath(body, this.#paths.error), state === "failed_retryable")
      : undefined;
    const submittedAt = stringAt(body, this.#paths.submittedAt) ?? now;
    const updatedAt = stringAt(body, this.#paths.updatedAt) ?? now;
    const retryAfterMs = numberAt(body, this.#paths.retryAfterMs);
    return {
      id: `${this.descriptor.id}:${context.remoteJobId}`,
      remoteJobId: context.remoteJobId,
      providerId: this.descriptor.id,
      capability: context.capability,
      state,
      ...(context.model ? { model: context.model } : {}),
      submittedAt,
      updatedAt,
      ...(progress === undefined ? {} : { progress }),
      ...(outputs.length ? { outputs } : {}),
      ...(error ? { error } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  #validateConfiguration(): void {
    if (!this.descriptor.capabilities.length) {
      throw new ProviderConfigurationError(`Provider ${this.descriptor.id} declares no capabilities`);
    }
    for (const capability of this.descriptor.capabilities) {
      if (!this.#routes[capability]) {
        throw new ProviderConfigurationError(
          `Provider ${this.descriptor.id} declares ${capability} without an HTTP route`,
        );
      }
    }
    for (const header of Object.keys(this.#staticHeaders)) {
      if (FORBIDDEN_STATIC_HEADER.test(header)) {
        throw new ProviderConfigurationError(
          `Static credential header ${header} is forbidden; use secretHeaders with an env name`,
        );
      }
    }
    for (const reference of this.#secretHeaders) {
      if (!reference.header.trim()) {
        throw new ProviderConfigurationError("Secret header name must not be empty");
      }
      assertSafeEnvironmentVariableName(reference.env);
      if (!this.descriptor.secretEnvVars?.includes(reference.env)) {
        throw new ProviderConfigurationError(
          `Provider ${this.descriptor.id} descriptor must disclose secret env name ${reference.env}`,
        );
      }
    }
    for (const route of Object.values(this.#routes)) {
      if (!route) continue;
      for (const spec of [route.submit, route.poll, route.cancel]) {
        for (const header of Object.keys(spec?.headers ?? {})) {
          if (FORBIDDEN_STATIC_HEADER.test(header)) {
            throw new ProviderConfigurationError(
              `Static credential header ${header} is forbidden; use secretHeaders with an env name`,
            );
          }
        }
      }
    }
  }
}

function lowerCaseKeys(
  input: Readonly<Record<string, ProviderJobState>>,
): Record<string, ProviderJobState> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]));
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderConfigurationError(`Invalid provider base URL ${JSON.stringify(value)}`, { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderConfigurationError("Provider base URL must use http or https");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}
