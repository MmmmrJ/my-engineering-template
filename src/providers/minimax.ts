import { AsyncHttpProviderAdapter } from "./async-http.js";
import type {
  AsyncHttpCapabilityRoute,
  AsyncHttpResponsePaths,
} from "./async-http.js";
import type {
  Clock,
  FetchLike,
  JsonObject,
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
  ProviderPollRequest,
  ProviderPrice,
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
  firstPath,
  joinUrl,
  numberAt,
  readSecretFromEnvironment,
  stringAt,
} from "./utils.js";

export interface MiniMaxRouteConfig {
  readonly submitPath: string;
  readonly pollPath: string;
  readonly cancelPath?: string;
}

export interface MiniMaxProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  /** Async video routes only. Image and short-form TTS use official synchronous endpoints. */
  readonly routes?: Readonly<Partial<Record<ProviderCapability, MiniMaxRouteConfig>>>;
  readonly models?: readonly ProviderModelDescriptor[];
  readonly regions?: readonly string[];
  readonly price?: ProviderPrice;
  readonly responsePaths?: Partial<AsyncHttpResponsePaths>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly requestTimeoutMs?: number;
  readonly dataTransfer?: ProviderDataTransferMode;
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
}

const MINIMAX_DIRECT_CAPABILITIES = ["image.generate", "image.edit", "audio.tts"] as const;
const MINIMAX_VIDEO_CAPABILITIES = ["video.i2v", "video.r2v", "video.t2v"] as const;

export const DEFAULT_MINIMAX_ROUTES: Readonly<
  Partial<Record<ProviderCapability, MiniMaxRouteConfig>>
> = {
  "video.t2v": {
    submitPath: "/v1/video_generation",
    pollPath: "/v1/query/video_generation?task_id={jobId}",
  },
  "video.i2v": {
    submitPath: "/v1/video_generation",
    pollPath: "/v1/query/video_generation?task_id={jobId}",
  },
  "video.r2v": {
    submitPath: "/v1/video_generation",
    pollPath: "/v1/query/video_generation?task_id={jobId}",
  },
};

/**
 * Auditable discovery metadata for deployments that choose MiniMax's official
 * MCP server instead of the direct adapter. Results must still cross the
 * workflow import boundary; voice-clone is intentionally not advertised.
 */
export const MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR: ProviderDescriptor = {
  id: "minimax-official-mcp",
  displayName: "MiniMax Official MCP (optional overlay)",
  adapter: "mcp-overlay",
  capabilities: [
    "image.generate",
    "video.i2v",
    "video.t2v",
    "audio.tts",
  ],
  optional: true,
  dataTransfer: "external-cloud",
  metadata: {
    transport: "user-configured-official-mcp",
    documentation: "https://platform.minimax.io/docs/guides/mcp-guide",
    tools: [
      "text_to_audio",
      "text_to_image",
      "generate_video",
      "image_to_video",
      "query_video_generation",
    ],
    importRequired: true,
    voiceCloneAdvertised: false,
  },
};

/**
 * MiniMax's current official HTTP surface mixes synchronous image/TTS calls
 * with asynchronous video jobs. This adapter normalizes both without inventing
 * poll endpoints for synchronous operations.
 */
export class MiniMaxProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #videoAdapter: AsyncHttpProviderAdapter;
  readonly #videoCapabilities: ReadonlySet<ProviderCapability>;
  readonly #baseUrl: string;
  readonly #apiKeyEnv: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #requestTimeoutMs: number;

  constructor(config: MiniMaxProviderConfig = {}) {
    const routes = config.routes ?? DEFAULT_MINIMAX_ROUTES;
    validateVideoRoutes(routes);
    const videoCapabilities = Object.keys(routes).sort() as ProviderCapability[];
    const apiKeyEnv = config.apiKeyEnv ?? "MINIMAX_API_KEY";
    const id = config.id ?? "minimax";
    const capabilities = [
      ...new Set<ProviderCapability>([...MINIMAX_DIRECT_CAPABILITIES, ...videoCapabilities]),
    ].sort();
    this.#baseUrl = validateBaseUrl(config.baseUrl ?? "https://api.minimax.io");
    this.#apiKeyEnv = apiKeyEnv;
    this.#environment = config.environment ?? process.env;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#clock = config.clock ?? systemClock;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.#videoCapabilities = new Set(videoCapabilities);
    this.descriptor = {
      id,
      displayName: config.displayName ?? "MiniMax",
      adapter: "minimax",
      capabilities,
      ...(config.models ? { models: config.models } : {}),
      ...(config.regions ? { regions: config.regions } : {}),
      ...(config.price ? { price: config.price } : {}),
      secretEnvVars: [apiKeyEnv],
      dataTransfer: config.dataTransfer ?? "external-cloud",
      ...(config.termsUrl ? { termsUrl: config.termsUrl } : {}),
      ...(config.privacyUrl ? { privacyUrl: config.privacyUrl } : {}),
      metadata: {
        adapterScope: "official synchronous image/TTS and asynchronous video HTTP APIs",
        officialDirectEndpoints: {
          image: "/v1/image_generation",
          speech: "/v1/t2a_v2",
          videoSubmit: "/v1/video_generation",
          videoPoll: "/v1/query/video_generation",
          fileRetrieve: "/v1/files/retrieve",
        },
        officialDocumentation: {
          image: "https://platform.minimax.io/docs/guides/image-generation",
          speech: "https://platform.minimax.io/docs/api-reference/speech-t2a-http",
          video: "https://platform.minimax.io/docs/guides/video-generation",
          mcp: "https://platform.minimax.io/docs/guides/mcp-guide",
        },
        synchronousCapabilities: [...MINIMAX_DIRECT_CAPABILITIES],
        voiceCloneEnabled: false,
      },
    };
    this.#videoAdapter = new AsyncHttpProviderAdapter({
      descriptor: {
        ...this.descriptor,
        capabilities: videoCapabilities,
      },
      baseUrl: this.#baseUrl,
      routes: toAsyncRoutes(routes),
      secretHeaders: [{ header: "Authorization", env: apiKeyEnv, prefix: "Bearer " }],
      responsePaths: {
        jobId: ["task_id", "data.task_id", "id"],
        state: ["status", "data.status", "state"],
        outputs: [
          "file_url",
          "video_url",
          "data.file_url",
          "data.outputs",
          "outputs",
          "file_id",
          "data.file_id",
        ],
        error: ["base_resp.status_msg", "error_message", "message", "error"],
        ...config.responsePaths,
      },
      stateMap: {
        queueing: "queued",
        preparing: "queued",
        processing: "running",
        success: "succeeded",
        fail: "failed_terminal",
      },
      environment: this.#environment,
      fetch: this.#fetch,
      clock: this.#clock,
      requestTimeoutMs: this.#requestTimeoutMs,
      buildSubmitBody: miniMaxSubmitBody,
      estimateSeconds: estimateDuration,
    });
  }

  capabilities(): Promise<readonly ProviderCapability[]> {
    return Promise.resolve([...this.descriptor.capabilities]);
  }

  health(): Promise<ProviderHealth> {
    return this.#videoAdapter.health();
  }

  estimate(request: ProviderEstimateRequest): Promise<ProviderEstimate> {
    assertProviderCapability(this.descriptor, request.capability);
    if (this.#videoCapabilities.has(request.capability)) {
      return this.#videoAdapter.estimate(request);
    }
    const model = this.descriptor.models?.find((candidate) => candidate.id === request.model);
    return Promise.resolve({
      providerId: this.descriptor.id,
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      ...(model?.price ?? this.descriptor.price
        ? { price: model?.price ?? this.descriptor.price }
        : {}),
      notes: ["Official synchronous API; each submit is a new potentially billable request"],
    });
  }

  async submit(request: ProviderSubmitRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertNoInlineSecrets(request.input);
    if (request.metadata) assertNoInlineSecrets(request.metadata, "metadata");
    if (this.#videoCapabilities.has(request.capability)) {
      return this.#videoAdapter.submit(request);
    }
    if (request.capability === "image.generate" || request.capability === "image.edit") {
      return this.#submitSynchronous(request, "/v1/image_generation", "image");
    }
    if (request.capability === "audio.tts") {
      return this.#submitSynchronous(request, "/v1/t2a_v2", "audio");
    }
    throw new ProviderConfigurationError(
      `MiniMax direct adapter does not implement ${request.capability}`,
    );
  }

  async poll(request: ProviderPollRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    if (!this.#videoCapabilities.has(request.capability)) {
      throw new ProviderConfigurationError(
        `MiniMax ${request.capability} is synchronous and has no poll endpoint`,
      );
    }
    const job = await this.#videoAdapter.poll(request);
    if (job.state !== "succeeded") return job;
    const existingUrl = job.outputs?.find((output) => isHttpUrl(output.uri));
    if (existingUrl) return job;
    const fileId = job.outputs?.find((output) => output.uri && !isHttpUrl(output.uri))?.uri;
    if (!fileId) return job;
    const { body } = await fetchJson(
      this.#fetch,
      joinUrl(this.#baseUrl, `/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`),
      this.#requestInit("GET"),
    );
    assertMiniMaxSuccess(body);
    const downloadUrl = stringAt(body, ["file.download_url"]);
    if (!isHttpUrl(downloadUrl)) {
      throw new ProviderProtocolError("MiniMax file retrieval did not return a download URL");
    }
    return {
      ...job,
      outputs: [{ kind: "video", uri: downloadUrl }],
      metadata: { fileId, temporaryUrl: true },
    };
  }

  cancel(request: ProviderCancelRequest): Promise<ProviderJob> {
    if (!this.#videoCapabilities.has(request.capability)) {
      throw new ProviderConfigurationError(
        `MiniMax ${request.capability} is synchronous and cannot be cancelled after submit`,
      );
    }
    return this.#videoAdapter.cancel(request);
  }

  async #submitSynchronous(
    request: ProviderSubmitRequest,
    path: string,
    kind: "image" | "audio",
  ): Promise<ProviderJob> {
    const body: JsonObject = kind === "image"
      ? {
          ...(request.model ? { model: request.model } : {}),
          ...request.input,
          response_format: "url",
        }
      : {
          ...(request.model ? { model: request.model } : {}),
          ...request.input,
          stream: false,
          output_format: "url",
        };
    assertNoInlineSecrets(body, "requestBody");
    const { body: responseBody } = await fetchJson(
      this.#fetch,
      joinUrl(this.#baseUrl, path),
      this.#requestInit("POST", body),
    );
    assertMiniMaxSuccess(responseBody);
    const remoteJobId = stringAt(responseBody, ["id", "trace_id"]);
    if (!remoteJobId) {
      throw new ProviderProtocolError("MiniMax synchronous response did not contain a trace id");
    }
    const rawOutputs = kind === "image"
      ? firstPath(responseBody, ["data.image_urls"])
      : firstPath(responseBody, ["data.audio"]);
    const urls = (Array.isArray(rawOutputs) ? rawOutputs : [rawOutputs]).filter(
      (value): value is string => typeof value === "string" && isHttpUrl(value),
    );
    if (!urls.length) {
      throw new ProviderProtocolError(
        `MiniMax synchronous ${kind} response did not contain a temporary output URL`,
      );
    }
    const now = this.#clock.now().toISOString();
    return {
      id: `${this.descriptor.id}:${remoteJobId}`,
      remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      state: "succeeded",
      ...(request.model ? { model: request.model } : {}),
      submittedAt: now,
      updatedAt: now,
      outputs: urls.map((uri) => ({ kind, uri, metadata: { temporaryUrl: true } })),
      metadata: { synchronous: true, temporaryUrlExpiresAfterSeconds: 86_400 },
    };
  }

  #requestInit(method: "GET" | "POST", body?: JsonObject): RequestInit {
    const apiKey = readSecretFromEnvironment(this.#apiKeyEnv, this.#environment);
    return {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    };
  }
}

function validateVideoRoutes(
  routes: Readonly<Partial<Record<ProviderCapability, MiniMaxRouteConfig>>>,
): void {
  const allowed = new Set<ProviderCapability>(MINIMAX_VIDEO_CAPABILITIES);
  for (const capability of Object.keys(routes) as ProviderCapability[]) {
    if (!allowed.has(capability)) {
      throw new ProviderConfigurationError(
        `MiniMax custom async route ${capability} is unsupported; image and TTS use their official synchronous endpoints`,
      );
    }
  }
}

function toAsyncRoutes(
  routes: Readonly<Partial<Record<ProviderCapability, MiniMaxRouteConfig>>>,
): Readonly<Partial<Record<ProviderCapability, AsyncHttpCapabilityRoute>>> {
  return Object.fromEntries(
    Object.entries(routes).map(([capability, route]) => [
      capability,
      {
        submit: { path: route.submitPath, method: "POST" },
        poll: { path: route.pollPath, method: "GET" },
        ...(route.cancelPath
          ? { cancel: { path: route.cancelPath, method: "POST" as const } }
          : {}),
      },
    ]),
  );
}

function miniMaxSubmitBody(request: ProviderSubmitRequest): JsonObject {
  return {
    ...(request.model ? { model: request.model } : {}),
    ...request.input,
  };
}

function estimateDuration(request: { readonly input: JsonObject }): number | undefined {
  const value = request.input.duration_seconds ?? request.input.duration;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function assertMiniMaxSuccess(body: unknown): void {
  const statusCode = numberAt(body, ["base_resp.status_code"]);
  if (statusCode !== undefined && statusCode !== 0) {
    const message = stringAt(body, ["base_resp.status_msg", "message"]);
    throw new ProviderProtocolError(message ?? `MiniMax returned status code ${statusCode}`);
  }
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderConfigurationError(`Invalid MiniMax base URL ${JSON.stringify(value)}`, {
      cause: error,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderConfigurationError("MiniMax base URL must use http or https");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}
