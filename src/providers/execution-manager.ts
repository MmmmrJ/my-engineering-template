import { resolve } from "node:path";
import { downloadAndArchive } from "./download.js";
import { ManualProviderAdapter } from "./manual.js";
import type { ProviderRegistry } from "./registry.js";
import {
  calculatePricingSnapshotHash,
  ProviderJobStore,
  type AuditedAttemptContext,
  type AttemptContext,
  type PaidSubmitConfirmation,
  type ProviderJobStoreOptions,
  type ProviderPricingSnapshot,
  type StoredProviderAttempt,
  type TrackedJobOptions,
  type TrackedSubmitResult,
} from "./job-store.js";
import type {
  FetchLike,
  Clock,
  ProviderAdapter,
  ProviderEstimate,
  ProviderEstimateRequest,
  ProviderJob,
  ProviderOutput,
  ProviderPrice,
  ProviderSubmitRequest,
} from "./types.js";
import { ProviderConfigurationError, ProviderError, systemClock } from "./types.js";

interface OutputDownloadPolicy {
  readonly allowedMimeTypes: readonly string[];
  readonly maxBytes: number;
}

const OUTPUT_DOWNLOAD_POLICIES: Readonly<
  Record<ProviderOutput["kind"], OutputDownloadPolicy>
> = {
  image: {
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    maxBytes: 32 * 1024 * 1024,
  },
  video: {
    allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime"],
    maxBytes: 512 * 1024 * 1024,
  },
  audio: {
    allowedMimeTypes: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4"],
    maxBytes: 128 * 1024 * 1024,
  },
  subtitle: {
    allowedMimeTypes: ["application/x-subrip", "text/plain"],
    maxBytes: 8 * 1024 * 1024,
  },
  text: {
    allowedMimeTypes: ["text/plain"],
    maxBytes: 8 * 1024 * 1024,
  },
  json: {
    allowedMimeTypes: ["application/json"],
    maxBytes: 8 * 1024 * 1024,
  },
  other: {
    allowedMimeTypes: ["application/octet-stream"],
    maxBytes: 32 * 1024 * 1024,
  },
};

export interface ProviderExecutionManagerOptions extends ProviderJobStoreOptions {
  /** Injectable fetch used only for provider output downloads. */
  readonly downloadFetch?: FetchLike;
  readonly downloadMaxBytesByKind?: Partial<
    Readonly<Record<ProviderOutput["kind"], number>>
  >;
  /**
   * Exact origins explicitly trusted for ComfyUI local output only. Enabling
   * one origin does not permit another host, port, scheme, or redirect origin.
   */
  readonly trustedComfyUiOutputOrigins?: readonly string[];
}

/**
 * Thin task-scoped execution boundary shared by CLI and MCP transports.
 * Workflow code remains responsible for frozen bindings and stage eligibility;
 * this manager guarantees durable paid-job tracking and archives temporary
 * provider URLs before a successful projection reaches the ledger.
 */
export class ProviderExecutionManager {
  readonly #registry: ProviderRegistry;
  readonly #jobs: ProviderJobStore;
  readonly #taskDirectory: string;
  readonly #downloadFetch?: FetchLike;
  readonly #downloadMaxBytesByKind: Partial<
    Readonly<Record<ProviderOutput["kind"], number>>
  >;
  readonly #trustedComfyUiOutputOrigins: ReadonlySet<string>;
  readonly #clock: Clock;
  readonly #taskAdapters = new Map<string, ProviderAdapter>();

  constructor(
    registry: ProviderRegistry,
    taskDirectory: string,
    options: ProviderExecutionManagerOptions = {},
  ) {
    this.#registry = registry;
    this.#taskDirectory = resolve(taskDirectory);
    this.#downloadFetch = options.downloadFetch;
    this.#downloadMaxBytesByKind = options.downloadMaxBytesByKind ?? {};
    this.#clock = options.clock ?? systemClock;
    this.#trustedComfyUiOutputOrigins = new Set(
      (options.trustedComfyUiOutputOrigins ?? []).map(validateExactOrigin),
    );
    validateDownloadLimits(this.#downloadMaxBytesByKind);
    this.#jobs = new ProviderJobStore(this.#taskDirectory, options);
  }

  estimate(providerId: string, request: ProviderEstimateRequest): Promise<ProviderEstimate> {
    return this.#adapter(providerId).estimate(request);
  }

  async submitConfirmed(
    providerId: string,
    request: ProviderSubmitRequest,
    context: AttemptContext,
  ): Promise<TrackedSubmitResult> {
    const adapter = this.#adapter(providerId);
    const estimate = await adapter.estimate({
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      input: request.input,
      ...(request.region ? { region: request.region } : {}),
    });
    const auditedContext: AuditedAttemptContext = {
      ...context,
      pricingSnapshot: bindPricingEstimate(
        adapter,
        request,
        context?.costConfirmation,
        estimate,
        this.#clock.now().toISOString(),
      ),
    };
    return this.#jobs.submitTracked(
      adapter,
      request,
      auditedContext,
      this.#trackedOptions(),
    );
  }

  async poll(attemptId: string): Promise<ProviderJob> {
    const attempt = await this.#jobs.get(attemptId);
    return this.#jobs.pollTracked(
      this.#adapter(attempt.providerId),
      attemptId,
      this.#trackedOptions(),
    );
  }

  async cancel(attemptId: string): Promise<ProviderJob> {
    const attempt = await this.#jobs.get(attemptId);
    return this.#jobs.cancelTracked(this.#adapter(attempt.providerId), attemptId);
  }

  resumeCandidates(): Promise<readonly StoredProviderAttempt[]> {
    return this.#jobs.resumeCandidates();
  }

  /** Return the complete immutable projection of this task's provider attempt ledger. */
  listAttempts(): Promise<readonly StoredProviderAttempt[]> {
    return this.#jobs.list();
  }

  /** Resume only the exact pre-crash request already covered by its ledger confirmation. */
  async resumePrepared(
    attemptId: string,
    request: ProviderSubmitRequest,
  ): Promise<TrackedSubmitResult> {
    const attempt = await this.#jobs.get(attemptId);
    return this.#jobs.resumeSubmitTracked(
      this.#adapter(attempt.providerId),
      attemptId,
      request,
      this.#trackedOptions(),
    );
  }

  #trackedOptions(): TrackedJobOptions {
    return {
      prepareForPersistence: (attempt, job) => this.#archiveRemoteOutputs(attempt, job),
    };
  }

  #adapter(providerId: string): ProviderAdapter {
    const existing = this.#taskAdapters.get(providerId);
    if (existing) return existing;
    const configured = this.#registry.get(providerId);
    if (configured.descriptor.adapter !== "manual") return configured;
    const descriptor = configured.descriptor;
    const scoped = new ManualProviderAdapter({
      id: descriptor.id,
      displayName: descriptor.displayName,
      requestDirectory: resolve(this.#taskDirectory, "manual/requests"),
      resultDirectory: resolve(this.#taskDirectory, "manual/results"),
      capabilities: descriptor.capabilities,
      ...(descriptor.models ? { models: descriptor.models } : {}),
      clock: this.#clock,
      ...(descriptor.dataTransfer ? { dataTransfer: descriptor.dataTransfer } : {}),
      ...(descriptor.termsUrl ? { termsUrl: descriptor.termsUrl } : {}),
      ...(descriptor.privacyUrl ? { privacyUrl: descriptor.privacyUrl } : {}),
    });
    this.#taskAdapters.set(providerId, scoped);
    return scoped;
  }

  async #archiveRemoteOutputs(
    attempt: StoredProviderAttempt,
    job: ProviderJob,
  ): Promise<ProviderJob> {
    if (!job.outputs?.length) return job;
    if (job.state !== "succeeded") {
      return { ...job, outputs: job.outputs.map(persistableOutputProjection) };
    }
    const outputs: ProviderOutput[] = [];
    try {
      for (const [index, output] of job.outputs.entries()) {
        if (!output.uri) {
          outputs.push(persistableOutputProjection(output));
          continue;
        }
        const uri = parseHttpOutputUrl(output.uri);
        const descriptor = this.#registry.descriptor(attempt.providerId);
        const configuredComfyUiOrigin = descriptor.metadata?.outputOrigin;
        const trustedComfyUiOrigin =
          descriptor.adapter === "comfyui" &&
          (this.#trustedComfyUiOutputOrigins.has(uri.origin) ||
            configuredComfyUiOrigin === uri.origin);
        const policy = OUTPUT_DOWNLOAD_POLICIES[output.kind];
        const maxBytes = this.#downloadMaxBytesByKind[output.kind] ?? policy.maxBytes;
        const downloaded = await downloadAndArchive({
          url: uri.toString(),
          destinationRoot: resolve(this.#taskDirectory, "provider-downloads"),
          relativePath: `${attempt.attemptId}/output-${String(index + 1).padStart(3, "0")}`,
          archiveRoot: resolve(this.#taskDirectory, "provider-downloads/archive"),
          allowedMimeTypes: policy.allowedMimeTypes,
          maxBytes,
          deriveExtensionFromMime: true,
          ...(output.sha256 ? { expectedSha256: output.sha256 } : {}),
          ...(trustedComfyUiOrigin
            ? {
                allowHttp: uri.protocol === "http:",
                allowPrivateHosts: true,
                allowedOrigins: [uri.origin],
              }
            : {}),
          ...(this.#downloadFetch ? { fetch: this.#downloadFetch } : {}),
        });
        outputs.push({
          kind: downloaded.kind,
          localPath: downloaded.localPath,
          archivedPath: downloaded.archivedPath,
          mimeType: downloaded.mimeType,
          sizeBytes: downloaded.sizeBytes,
          sha256: downloaded.sha256,
        });
      }
    } catch (error) {
      throw new ProviderError("Provider output could not be archived before success", {
        code: "provider_output_archive_failed",
        retryable: true,
        cause: error,
      });
    }
    return { ...job, outputs };
  }
}

function bindPricingEstimate(
  adapter: ProviderAdapter,
  request: ProviderSubmitRequest,
  confirmation: PaidSubmitConfirmation | undefined,
  estimate: ProviderEstimate,
  estimatedAt: string,
): ProviderPricingSnapshot {
  if (!confirmation || typeof confirmation !== "object") {
    throw new ProviderConfigurationError(
      "A paid-submit confirmation is required before starting a new provider request",
    );
  }
  if (
    estimate.providerId !== adapter.descriptor.id ||
    estimate.capability !== request.capability
  ) {
    throw new ProviderConfigurationError("Provider estimate does not match the requested provider capability");
  }
  if (request.model && estimate.model && request.model !== estimate.model) {
    throw new ProviderConfigurationError("Provider estimate model does not match the submit request");
  }
  const price = estimate.price ? normalizeEstimatePrice(estimate.price) : undefined;
  const estimatedSeconds = normalizeEstimatedSeconds(estimate.estimatedSeconds);
  const calculatedCost = price
    ? calculateEstimateCost(price, estimatedSeconds, request.input)
    : undefined;
  if (price && confirmation.currency !== price.currency) {
    throw new ProviderConfigurationError(
      `User confirmation currency ${confirmation.currency} does not match provider estimate currency ${price.currency}`,
    );
  }
  if (calculatedCost !== undefined) {
    if (confirmation.pricingStatus !== "known") {
      throw new ProviderConfigurationError(
        "Provider returned mechanically calculable pricing; pricingStatus must be known",
      );
    }
    if (
      typeof confirmation.estimatedCost !== "number" ||
      confirmation.estimatedCost !== calculatedCost
    ) {
      throw new ProviderConfigurationError(
        `User-confirmed estimatedCost must exactly match provider estimate ${calculatedCost} ${price?.currency ?? confirmation.currency}`,
      );
    }
    if (calculatedCost > confirmation.maximumCost) {
      throw new ProviderConfigurationError(
        `Provider estimate ${calculatedCost} ${confirmation.currency} exceeds the user-approved maximum ${confirmation.maximumCost} ${confirmation.currency}`,
      );
    }
  } else {
    if (confirmation.pricingStatus !== "unknown") {
      throw new ProviderConfigurationError(
        "Provider pricing cannot be mechanically calculated; pricingStatus must be unknown",
      );
    }
    if (confirmation.unknownPricingAcknowledged !== true) {
      throw new ProviderConfigurationError(
        "Unknown provider pricing requires unknownPricingAcknowledged=true",
      );
    }
    if (confirmation.estimatedCost !== undefined) {
      throw new ProviderConfigurationError(
        "Unknown provider pricing must not include a caller-supplied estimatedCost",
      );
    }
  }
  const snapshotWithoutHash: ProviderPricingSnapshot = {
    schemaVersion: 1,
    providerId: adapter.descriptor.id,
    capability: request.capability,
    ...(estimate.model ?? request.model ? { model: estimate.model ?? request.model } : {}),
    pricingStatus: calculatedCost === undefined ? "unknown" : "known",
    ...(price ? { price } : {}),
    ...(estimatedSeconds === undefined ? {} : { estimatedSeconds }),
    ...(calculatedCost === undefined ? {} : { calculatedCost }),
    currency: confirmation.currency,
    estimatedAt,
    estimateSha256: "",
  };
  return {
    ...snapshotWithoutHash,
    estimateSha256: calculatePricingSnapshotHash(snapshotWithoutHash),
  };
}

function normalizeEstimatePrice(price: ProviderPrice): ProviderPrice {
  const units = [
    "request",
    "image",
    "second",
    "minute",
    "character",
    "token",
    "megapixel",
    "custom",
  ];
  if (
    !/^[A-Z]{3}$/.test(price.currency) ||
    !Number.isFinite(price.amount) ||
    price.amount < 0 ||
    !units.includes(price.unit) ||
    (price.minimumCharge !== undefined &&
      (!Number.isFinite(price.minimumCharge) || price.minimumCharge < 0))
  ) {
    throw new ProviderConfigurationError("Provider returned an invalid price estimate");
  }
  return {
    currency: price.currency,
    amount: price.amount,
    unit: price.unit,
    ...(price.minimumCharge === undefined ? {} : { minimumCharge: price.minimumCharge }),
  };
}

function normalizeEstimatedSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new ProviderConfigurationError("Provider returned invalid estimatedSeconds");
  }
  return value;
}

function calculateEstimateCost(
  price: ProviderPrice,
  estimatedSeconds: number | undefined,
  input: ProviderSubmitRequest["input"],
): number | undefined {
  let quantity: number | undefined;
  switch (price.unit) {
    case "request":
      quantity = 1;
      break;
    case "image":
      quantity = positiveIntegerInput(input.n ?? input.image_count, 1, "image count");
      break;
    case "second":
      quantity = estimatedSeconds;
      break;
    case "minute":
      quantity = estimatedSeconds === undefined ? undefined : estimatedSeconds / 60;
      break;
    case "character": {
      const explicitCount = input.character_count;
      if (explicitCount !== undefined) {
        quantity = nonNegativeIntegerInput(explicitCount, "character count");
      } else if (typeof input.text === "string") {
        quantity = [...input.text].length;
      }
      break;
    }
    case "megapixel": {
      const width = positiveNumberInput(input.width, "image width");
      const height = positiveNumberInput(input.height, "image height");
      if (width !== undefined && height !== undefined) {
        const images = positiveIntegerInput(input.n ?? input.image_count, 1, "image count");
        quantity = (width * height * images) / 1_000_000;
      }
      break;
    }
    case "token":
    case "custom":
      return undefined;
  }
  if (quantity === undefined) return undefined;
  const subtotal = price.amount * quantity;
  const total = Math.max(subtotal, price.minimumCharge ?? 0);
  return normalizeMoney(total);
}

function positiveIntegerInput(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ProviderConfigurationError(`Provider estimate ${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeIntegerInput(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderConfigurationError(`Provider estimate ${label} must be a non-negative integer`);
  }
  return value as number;
}

function positiveNumberInput(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ProviderConfigurationError(`Provider estimate ${label} must be a positive number`);
  }
  return value;
}

function normalizeMoney(value: number): number {
  return Number(value.toFixed(8));
}

function persistableOutputProjection(output: ProviderOutput): ProviderOutput {
  return {
    kind: output.kind,
    ...(output.localPath ? { localPath: output.localPath } : {}),
    ...(output.archivedPath ? { archivedPath: output.archivedPath } : {}),
    ...(output.mimeType ? { mimeType: output.mimeType } : {}),
    ...(output.sizeBytes === undefined ? {} : { sizeBytes: output.sizeBytes }),
    ...(output.sha256 ? { sha256: output.sha256 } : {}),
  };
}

function parseHttpOutputUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderConfigurationError("Provider output URI is invalid", { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderConfigurationError("Provider output URI must use HTTP(S)");
  }
  return url;
}

function validateExactOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderConfigurationError(`Invalid trusted ComfyUI origin ${JSON.stringify(value)}`, {
      cause: error,
    });
  }
  if (
    url.origin !== value ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new ProviderConfigurationError(
      `Trusted ComfyUI output origin must be an exact HTTP(S) origin: ${JSON.stringify(value)}`,
    );
  }
  return url.origin;
}

function validateDownloadLimits(
  limits: Partial<Readonly<Record<ProviderOutput["kind"], number>>>,
): void {
  for (const [kind, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ProviderConfigurationError(
        `Download limit for ${kind} must be a positive safe integer`,
      );
    }
  }
}
