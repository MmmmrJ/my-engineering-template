import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { archiveLocalFile, downloadAndArchive } from "./download.js";
import { LocalFfmpegProviderAdapter } from "./local-ffmpeg.js";
import { ManualProviderAdapter, type ManualResultPackage } from "./manual.js";
import { isManualPlatformAdapter } from "./platform-manual.js";
import {
  playbookForProvider,
  type HandoffRecordInput,
  type HandoffSpendConfirmation,
  type HandoffUploadFile,
  type ProviderHandoffManifest,
} from "./handoff.js";
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

export interface ManualCompletionOutput {
  readonly kind: ProviderOutput["kind"];
  readonly sourcePath: string;
  readonly expectedSha256?: string;
}

export interface ManualCompletionInput {
  readonly outputs: readonly ManualCompletionOutput[];
}

export interface HandoffPrepareContext {
  readonly stage: string;
  readonly stageRevision: number;
  readonly uploadPaths: readonly string[];
}

export interface PreparedProviderHandoff {
  readonly attempt: StoredProviderAttempt;
  readonly manifest: ProviderHandoffManifest;
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

  async prepareHandoff(
    providerId: string,
    request: ProviderSubmitRequest,
    context: HandoffPrepareContext,
  ): Promise<PreparedProviderHandoff> {
    if (!isManualPlatformAdapter(providerId)) {
      throw new ProviderConfigurationError(
        `Provider ${providerId} does not support Codex UI handoff`,
      );
    }
    const playbook = playbookForProvider(providerId);
    if (!playbook || !playbook.capabilities.includes(request.capability)) {
      throw new ProviderConfigurationError(
        `Provider ${providerId} playbook does not support ${request.capability}`,
      );
    }
    const adapter = this.#adapter(providerId);
    if (!(adapter instanceof ManualProviderAdapter)) {
      throw new ProviderConfigurationError(
        `Provider ${providerId} is not configured as a manual platform adapter`,
      );
    }
    const active = (await this.#jobs.resumeCandidates()).find((attempt) =>
      ["prepared", "queued", "running", "failed_retryable"].includes(attempt.state),
    );
    if (active) {
      throw new ProviderConfigurationError(
        `Provider concurrency limit 1 blocks a new handoff while attempt ${active.attemptId} is ${active.state}`,
      );
    }
    const uploads = await Promise.all(
      [...new Set(context.uploadPaths.map((path) => resolve(path)))].map((path) =>
        inspectTaskLocalUpload(this.#taskDirectory, path),
      ),
    );
    const attemptId = randomUUID();
    const idempotencyKey = request.idempotencyKey ?? `cartoon-handoff-${attemptId}`;
    const job = await adapter.submit({ ...request, idempotencyKey });
    if (job.state !== "queued" && job.state !== "running") {
      throw new ProviderConfigurationError(
        `Manual platform handoff must prepare a queued or running job, not ${job.state}`,
      );
    }
    const requestPackagePath = adapter.requestPath(job.remoteJobId);
    const requestSha256 = await sha256File(requestPackagePath);
    const manifest: ProviderHandoffManifest = {
      schemaVersion: 1,
      attemptId,
      providerId,
      capability: request.capability,
      stage: context.stage,
      stageRevision: context.stageRevision,
      playbookVersion: playbook.version,
      surface: playbook.surface,
      officialOrigins: [...playbook.officialOrigins],
      ...(playbook.allowedApplications
        ? { allowedApplications: [...playbook.allowedApplications] }
        : {}),
      requestPackagePath,
      requestSha256,
      ...(request.model ? { model: request.model } : {}),
      uploads,
      createdAt: this.#clock.now().toISOString(),
    };
    const manifestDirectory = resolve(
      this.#taskDirectory,
      "manual",
      providerId,
      "handoffs",
    );
    await mkdir(manifestDirectory, { recursive: true });
    const manifestPath = resolve(manifestDirectory, `${attemptId}.handoff.json`);
    const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, serializedManifest, { encoding: "utf8", flag: "wx" });
    const manifestSha256 = createHash("sha256").update(serializedManifest).digest("hex");
    const attempt = await this.#jobs.prepareHandoff({
      attemptId,
      providerId,
      request,
      stage: context.stage,
      stageRevision: context.stageRevision,
      idempotencyKey,
      job,
      handoff: {
        state: "prepared",
        manifestPath,
        manifestSha256,
        playbookVersion: playbook.version,
        surface: playbook.surface,
        officialOrigins: [...playbook.officialOrigins],
        ...(playbook.allowedApplications
          ? { allowedApplications: [...playbook.allowedApplications] }
          : {}),
        uploads,
      },
    });
    return { attempt, manifest };
  }

  async confirmHandoff(
    attemptId: string,
    confirmation: HandoffSpendConfirmation,
  ): Promise<StoredProviderAttempt> {
    const attempt = await this.#jobs.get(attemptId);
    await this.#verifyHandoffManifest(attempt);
    await this.#verifyHandoffUploads(attempt);
    return this.#jobs.confirmHandoff(attemptId, confirmation);
  }

  async recordHandoff(
    attemptId: string,
    input: HandoffRecordInput,
  ): Promise<StoredProviderAttempt> {
    const attempt = await this.#jobs.get(attemptId);
    if (!attempt.handoff) {
      throw new ProviderConfigurationError(`Provider attempt ${attemptId} has no handoff`);
    }
    if (input.state === "submitted") {
      await this.#verifyHandoffManifest(attempt);
      await this.#verifyHandoffUploads(attempt);
      validateObservedSpend(attempt, input);
    }
    if (input.state === "cancelled" && !["cancelled", "succeeded"].includes(attempt.state)) {
      await this.cancel(attemptId);
    }
    return this.#jobs.recordHandoff(attemptId, input.state, {
      ...(input.receipt ? { receipt: input.receipt } : {}),
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    });
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

  /** Safely archives user-exported files and completes the matching durable manual attempt. */
  async completeManual(attemptId: string, input: ManualCompletionInput): Promise<ProviderJob> {
    if (!input.outputs.length) {
      throw new ProviderConfigurationError("Manual completion requires at least one output file");
    }
    const attempt = await this.#jobs.get(attemptId);
    if (!attempt.externalJobId) {
      throw new ProviderConfigurationError(
        `Provider attempt ${attemptId} has no submitted manual job to complete`,
      );
    }
    if (
      attempt.state === "succeeded" &&
      attempt.handoff?.state === "download_ready" &&
      attempt.externalJobId &&
      attempt.outputs?.length
    ) {
      await this.#jobs.recordHandoff(attemptId, "completed");
      return providerJobFromAttempt(attempt);
    }
    if (attempt.state !== "queued" && attempt.state !== "running") {
      throw new ProviderConfigurationError(
        `Provider attempt ${attemptId} cannot be completed while it is ${attempt.state}`,
      );
    }
    if (attempt.handoff && attempt.handoff.state !== "download_ready") {
      throw new ProviderConfigurationError(
        `Provider handoff ${attemptId} must be download_ready before downloaded files are completed`,
      );
    }
    const adapter = this.#adapter(attempt.providerId);
    if (!(adapter instanceof ManualProviderAdapter)) {
      throw new ProviderConfigurationError(
        `Provider attempt ${attemptId} is not a manual platform handoff`,
      );
    }
    const outputs: ProviderOutput[] = [];
    for (const [index, output] of input.outputs.entries()) {
      if (attempt.handoff) {
        await inspectTaskLocalUpload(this.#taskDirectory, output.sourcePath);
      }
      const policy = OUTPUT_DOWNLOAD_POLICIES[output.kind];
      const archived = await archiveLocalFile({
        sourcePath: output.sourcePath,
        destinationRoot: resolve(
          this.#taskDirectory,
          "manual",
          attempt.providerId === "manual" ? "" : attempt.providerId,
          "completed",
          attempt.externalJobId,
        ),
        relativePath: `output-${String(index + 1).padStart(3, "0")}`,
        archiveRoot: resolve(this.#taskDirectory, "provider-downloads", "archive"),
        kind: output.kind,
        allowedMimeTypes: policy.allowedMimeTypes,
        maxBytes: this.#downloadMaxBytesByKind[output.kind] ?? policy.maxBytes,
        ...(output.expectedSha256 ? { expectedSha256: output.expectedSha256 } : {}),
      });
      outputs.push(persistableOutputProjection(archived));
    }
    const result: ManualResultPackage = {
      schemaVersion: 1,
      jobId: attempt.externalJobId,
      state: "succeeded",
      outputs,
      completedAt: this.#clock.now().toISOString(),
    };
    try {
      await adapter.importResult(result);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const job = await this.poll(attemptId);
    if (attempt.handoff) await this.#jobs.recordHandoff(attemptId, "completed");
    return job;
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
    if (configured instanceof LocalFfmpegProviderAdapter) {
      const scoped = configured.forTask(this.#taskDirectory);
      this.#taskAdapters.set(providerId, scoped);
      return scoped;
    }
    if (!(configured instanceof ManualProviderAdapter)) return configured;
    const descriptor = configured.descriptor;
    const providerSubdirectory = descriptor.id === "manual" ? "" : descriptor.id;
    const manualRoot = resolve(this.#taskDirectory, "manual", providerSubdirectory);
    const scoped = new ManualProviderAdapter({
      id: descriptor.id,
      displayName: descriptor.displayName,
      requestDirectory: resolve(manualRoot, "requests"),
      resultDirectory: resolve(manualRoot, "results"),
      capabilities: descriptor.capabilities,
      ...(descriptor.models ? { models: descriptor.models } : {}),
      clock: this.#clock,
      ...(descriptor.dataTransfer ? { dataTransfer: descriptor.dataTransfer } : {}),
      ...(descriptor.termsUrl ? { termsUrl: descriptor.termsUrl } : {}),
      ...(descriptor.privacyUrl ? { privacyUrl: descriptor.privacyUrl } : {}),
      adapter: descriptor.adapter,
      ...(typeof descriptor.metadata?.instructions === "string"
        ? { instructions: descriptor.metadata.instructions }
        : {}),
      metadata: {
        ...(descriptor.metadata ?? {}),
        taskScoped: true,
      },
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
          ...(output.metadata ? { metadata: output.metadata } : {}),
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

  async #verifyHandoffUploads(attempt: StoredProviderAttempt): Promise<void> {
    if (!attempt.handoff) {
      throw new ProviderConfigurationError(
        `Provider attempt ${attempt.attemptId} has no handoff upload manifest`,
      );
    }
    for (const expected of attempt.handoff.uploads) {
      const actual = await inspectTaskLocalUpload(this.#taskDirectory, expected.path);
      if (
        actual.relativePath !== expected.relativePath ||
        actual.sizeBytes !== expected.sizeBytes ||
        actual.sha256 !== expected.sha256
      ) {
        throw new ProviderConfigurationError(
          `Handoff upload changed after preparation: ${expected.relativePath}`,
        );
      }
    }
  }

  async #verifyHandoffManifest(attempt: StoredProviderAttempt): Promise<void> {
    if (!attempt.handoff) {
      throw new ProviderConfigurationError(
        `Provider attempt ${attempt.attemptId} has no handoff manifest`,
      );
    }
    await assertTaskLocalPath(this.#taskDirectory, attempt.handoff.manifestPath);
    if ((await sha256File(attempt.handoff.manifestPath)) !== attempt.handoff.manifestSha256) {
      throw new ProviderConfigurationError(
        `Provider handoff manifest changed after preparation: ${attempt.attemptId}`,
      );
    }
    let manifest: ProviderHandoffManifest;
    try {
      manifest = JSON.parse(
        await readFile(attempt.handoff.manifestPath, "utf8"),
      ) as ProviderHandoffManifest;
    } catch (error) {
      throw new ProviderConfigurationError("Provider handoff manifest is unreadable", {
        cause: error,
      });
    }
    if (
      manifest.schemaVersion !== 1 ||
      manifest.attemptId !== attempt.attemptId ||
      manifest.providerId !== attempt.providerId ||
      manifest.capability !== attempt.capability ||
      manifest.stage !== attempt.stage ||
      manifest.stageRevision !== attempt.stageRevision ||
      manifest.playbookVersion !== attempt.handoff.playbookVersion ||
      JSON.stringify(manifest.uploads) !== JSON.stringify(attempt.handoff.uploads)
    ) {
      throw new ProviderConfigurationError(
        `Provider handoff manifest does not match attempt ${attempt.attemptId}`,
      );
    }
    await assertTaskLocalPath(this.#taskDirectory, manifest.requestPackagePath);
    if ((await sha256File(manifest.requestPackagePath)) !== manifest.requestSha256) {
      throw new ProviderConfigurationError(
        `Provider handoff request package changed after preparation: ${attempt.attemptId}`,
      );
    }
  }
}

function validateObservedSpend(
  attempt: StoredProviderAttempt,
  input: HandoffRecordInput,
): void {
  const confirmation = attempt.handoff?.spendConfirmation;
  if (!confirmation) {
    throw new ProviderConfigurationError(
      `Provider handoff ${attempt.attemptId} has no spend confirmation`,
    );
  }
  const observedCredits = input.receipt?.observedCredits;
  const observedUnit = input.receipt?.creditUnit;
  if (observedCredits === undefined || observedUnit !== confirmation.creditUnit) {
    throw new ProviderConfigurationError(
      "Submitted handoff receipt must record the observed credit amount and matching unit",
    );
  }
  if (
    confirmation.pricingStatus === "known" &&
    observedCredits !== confirmation.estimatedCredits
  ) {
    throw new ProviderConfigurationError(
      `Observed quote ${observedCredits} ${observedUnit} does not match confirmed estimate ${confirmation.estimatedCredits}`,
    );
  }
  if (observedCredits > confirmation.maximumCredits) {
    throw new ProviderConfigurationError(
      `Observed quote ${observedCredits} ${observedUnit} exceeds confirmed maximum ${confirmation.maximumCredits}`,
    );
  }
  if (attempt.model && input.receipt?.observedModel !== attempt.model) {
    throw new ProviderConfigurationError(
      `Observed model ${input.receipt?.observedModel ?? "not recorded"} does not match frozen model ${attempt.model}`,
    );
  }
}

async function inspectTaskLocalUpload(
  taskDirectory: string,
  candidate: string,
): Promise<HandoffUploadFile> {
  const taskRoot = await realpath(taskDirectory);
  const canonical = await realpath(resolve(candidate));
  const relation = relative(taskRoot, canonical);
  if (!relation || relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) {
    throw new ProviderConfigurationError(
      `Handoff upload is outside the task workspace: ${candidate}`,
    );
  }
  const details = await stat(canonical);
  if (!details.isFile() || details.size <= 0) {
    throw new ProviderConfigurationError(`Handoff upload must be a non-empty file: ${candidate}`);
  }
  return {
    path: canonical,
    relativePath: relation.split(sep).join("/"),
    sha256: await sha256File(canonical),
    sizeBytes: details.size,
  };
}

async function assertTaskLocalPath(taskDirectory: string, candidate: string): Promise<void> {
  const taskRoot = await realpath(taskDirectory);
  const canonical = await realpath(resolve(candidate));
  const relation = relative(taskRoot, canonical);
  if (!relation || relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) {
    throw new ProviderConfigurationError(`Path is outside the task workspace: ${candidate}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function providerJobFromAttempt(attempt: StoredProviderAttempt): ProviderJob {
  if (!attempt.externalJobId || attempt.state === "prepared") {
    throw new ProviderConfigurationError(
      `Provider attempt ${attempt.attemptId} has no completed external job`,
    );
  }
  const model = attempt.observedModel ?? attempt.model;
  return {
    id: `${attempt.providerId}:${attempt.externalJobId}`,
    remoteJobId: attempt.externalJobId,
    providerId: attempt.providerId,
    capability: attempt.capability,
    state: attempt.state,
    ...(model ? { model } : {}),
    submittedAt: attempt.preparedAt,
    updatedAt: attempt.updatedAt,
    ...(attempt.progress === undefined ? {} : { progress: attempt.progress }),
    ...(attempt.outputs ? { outputs: attempt.outputs } : {}),
    ...(attempt.error ? { error: attempt.error } : {}),
    ...(attempt.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: attempt.retryAfterMs }),
    ...(attempt.jobMetadata ? { metadata: attempt.jobMetadata } : {}),
  };
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
    ...(output.metadata ? { metadata: output.metadata } : {}),
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

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
