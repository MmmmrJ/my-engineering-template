import { AsyncHttpProviderAdapter } from "./async-http.js";
import type {
  AsyncHttpCapabilityRoute,
  AsyncHttpResponsePaths,
} from "./async-http.js";
import type {
  Clock,
  FetchLike,
  JsonObject,
  ProviderCapability,
  ProviderDataTransferMode,
  ProviderModelDescriptor,
  ProviderPrice,
  ProviderSubmitRequest,
} from "./types.js";

export interface AlibabaWanRouteConfig {
  readonly submitPath: string;
  readonly pollPath?: string;
  readonly cancelPath?: string;
}

export interface AlibabaWanProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly routes?: Readonly<Partial<Record<ProviderCapability, AlibabaWanRouteConfig>>>;
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

export const DEFAULT_ALIBABA_WAN_ROUTES: Readonly<
  Partial<Record<ProviderCapability, AlibabaWanRouteConfig>>
> = {
  "image.generate": {
    submitPath: "/services/aigc/multimodal-generation/generation",
    pollPath: "/tasks/{jobId}",
    cancelPath: "/tasks/{jobId}/cancel",
  },
  "image.edit": {
    submitPath: "/services/aigc/multimodal-generation/generation",
    pollPath: "/tasks/{jobId}",
    cancelPath: "/tasks/{jobId}/cancel",
  },
  "video.t2v": {
    submitPath: "/services/aigc/video-generation/video-synthesis",
    pollPath: "/tasks/{jobId}",
    cancelPath: "/tasks/{jobId}/cancel",
  },
  "video.i2v": {
    submitPath: "/services/aigc/video-generation/video-synthesis",
    pollPath: "/tasks/{jobId}",
    cancelPath: "/tasks/{jobId}/cancel",
  },
  "video.r2v": {
    submitPath: "/services/aigc/video-generation/video-synthesis",
    pollPath: "/tasks/{jobId}",
    cancelPath: "/tasks/{jobId}/cancel",
  },
};

export class AlibabaWanProviderAdapter extends AsyncHttpProviderAdapter {
  constructor(config: AlibabaWanProviderConfig = {}) {
    const routes = config.routes ?? DEFAULT_ALIBABA_WAN_ROUTES;
    const capabilities = Object.keys(routes).sort() as ProviderCapability[];
    const apiKeyEnv = config.apiKeyEnv ?? "DASHSCOPE_API_KEY";
    super({
      descriptor: {
        id: config.id ?? "alibaba-wan",
        displayName: config.displayName ?? "Alibaba Wan",
        adapter: "alibaba-wan",
        capabilities,
        ...(config.models ? { models: config.models } : {}),
        regions: config.regions ?? ["cn-beijing"],
        ...(config.price ? { price: config.price } : {}),
        secretEnvVars: [apiKeyEnv],
        dataTransfer: config.dataTransfer ?? "external-cloud",
        ...(config.termsUrl ? { termsUrl: config.termsUrl } : {}),
        ...(config.privacyUrl ? { privacyUrl: config.privacyUrl } : {}),
      },
      baseUrl: config.baseUrl ?? "https://dashscope.aliyuncs.com/api/v1",
      routes: toAsyncRoutes(routes),
      secretHeaders: [{ header: "Authorization", env: apiKeyEnv, prefix: "Bearer " }],
      staticHeaders: { "X-DashScope-Async": "enable" },
      responsePaths: {
        jobId: ["output.task_id", "task_id", "request_id"],
        state: ["output.task_status", "task_status", "status"],
        progress: ["output.task_metrics.progress", "output.progress", "progress"],
        outputs: [
          "output.results",
          "output.video_url",
          "output.audio_url",
          "output.image_url",
          "outputs",
        ],
        error: ["output.message", "message", "error"],
        ...config.responsePaths,
      },
      stateMap: {
        pending: "queued",
        running: "running",
        suspended: "failed_retryable",
        succeeded: "succeeded",
        failed: "failed_terminal",
        unknown: "failed_retryable",
        canceled: "cancelled",
        cancelled: "cancelled",
      },
      environment: config.environment,
      fetch: config.fetch,
      clock: config.clock,
      requestTimeoutMs: config.requestTimeoutMs,
      buildSubmitBody: alibabaSubmitBody,
      estimateSeconds: estimateDuration,
    });
  }
}

function toAsyncRoutes(
  routes: Readonly<Partial<Record<ProviderCapability, AlibabaWanRouteConfig>>>,
): Readonly<Partial<Record<ProviderCapability, AsyncHttpCapabilityRoute>>> {
  return Object.fromEntries(
    Object.entries(routes).map(([capability, route]) => [
      capability,
      {
        submit: { path: route.submitPath, method: "POST" },
        poll: { path: route.pollPath ?? "/tasks/{jobId}", method: "GET" },
        ...(route.cancelPath
          ? { cancel: { path: route.cancelPath, method: "POST" as const } }
          : {}),
      },
    ]),
  );
}

function alibabaSubmitBody(request: ProviderSubmitRequest): JsonObject {
  const nestedInput = request.input.input;
  const parameters = request.input.parameters;
  const input =
    nestedInput !== null && typeof nestedInput === "object" && !Array.isArray(nestedInput)
      ? nestedInput
      : request.input;
  return {
    ...(request.model ? { model: request.model } : {}),
    input,
    ...(parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)
      ? { parameters }
      : {}),
  };
}

function estimateDuration(request: { readonly input: JsonObject }): number | undefined {
  const value = request.input.duration_seconds ?? request.input.duration;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}
