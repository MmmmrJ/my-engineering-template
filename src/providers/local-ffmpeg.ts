import { createHash, createReadStream } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import {
  validateFinalDelivery as validateFinalDeliveryDefault,
  type FinalDeliveryValidationInput,
  type FinalDeliveryValidationResult,
  type FinalDeliveryValidatorDependencies,
} from "../media/delivery.js";
import {
  executeMediaPlan as executeMediaPlanDefault,
  type ExecutedMediaPlan,
  type ExecuteMediaPlanOptions,
} from "../media/executor.js";
import {
  createTimelineRenderPlan,
  type MediaCommandPlan,
  type TimelineRenderSpec,
} from "../media/plans.js";
import { runProcess, type ProcessRunner } from "../media/process.js";
import type {
  Clock,
  IdGenerator,
  JsonValue,
  ProviderAdapter,
  ProviderCapability,
  ProviderDescriptor,
  ProviderEstimate,
  ProviderEstimateRequest,
  ProviderHealth,
  ProviderJob,
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
import { assertNoInlineSecrets, uuidGenerator } from "./utils.js";

const LOCAL_CAPABILITIES = ["render.timeline", "quality.inspect"] as const satisfies readonly ProviderCapability[];
const INTERNAL_DIRECTORY = "provider-local-ffmpeg";

const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeRelativePath, "must be a safe task-relative path");
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeNumberSchema = z.number().finite().nonnegative();
const positiveNumberSchema = z.number().finite().positive();

const timelineClipSchema = z.strictObject({
  sourcePath: safeRelativePathSchema,
  inMs: nonNegativeNumberSchema.optional(),
  durationMs: positiveNumberSchema,
  hasAudio: z.boolean().optional(),
});

const timelineAudioTrackSchema = z.strictObject({
  sourcePath: safeRelativePathSchema,
  inMs: nonNegativeNumberSchema.optional(),
  durationMs: positiveNumberSchema.optional(),
  offsetMs: nonNegativeNumberSchema.optional(),
  gainDb: z.number().finite().min(-96).max(24).optional(),
});

const renderRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  timeline: z.strictObject({
    clips: z.array(timelineClipSchema).min(1).max(100),
    audioTracks: z.array(timelineAudioTrackSchema).max(100).optional(),
    subtitlePath: safeRelativePathSchema.optional(),
    subtitleFormat: z.enum(["srt", "ass"]).optional(),
    subtitleSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    subtitleFontDirectory: safeRelativePathSchema.optional(),
    subtitleFontName: z.string().trim().min(1).max(128).optional(),
    aiLabelText: z.string().trim().min(1).max(120).optional(),
    width: positiveIntegerSchema.optional(),
    height: positiveIntegerSchema.optional(),
    fps: positiveIntegerSchema.optional(),
    sampleRate: positiveIntegerSchema.optional(),
    outputPath: safeRelativePathSchema.refine(
      (value) => extname(value).toLowerCase() === ".mp4",
      "must end in .mp4",
    ),
  }),
});

const qcExpectationsSchema = z.strictObject({
  requireVideo: z.boolean().optional(),
  requireAudio: z.boolean().optional(),
  minDurationSeconds: nonNegativeNumberSchema.optional(),
  maxDurationSeconds: positiveNumberSchema.optional(),
  width: positiveIntegerSchema.optional(),
  height: positiveIntegerSchema.optional(),
  frameRate: positiveNumberSchema.optional(),
  frameRateTolerance: nonNegativeNumberSchema.optional(),
  minFrameRate: positiveNumberSchema.optional(),
  maxFrameRate: positiveNumberSchema.optional(),
  videoCodec: z.string().trim().min(1).max(64).optional(),
  pixelFormat: z.string().trim().min(1).max(64).optional(),
  audioCodec: z.string().trim().min(1).max(64).optional(),
  audioSampleRate: positiveIntegerSchema.optional(),
  audioChannels: positiveIntegerSchema.optional(),
  maxBlackSeconds: nonNegativeNumberSchema.optional(),
  maxSilenceSeconds: nonNegativeNumberSchema.optional(),
  maxFreezeSeconds: nonNegativeNumberSchema.optional(),
  integratedLoudnessTargetLufs: z.number().finite().optional(),
  integratedLoudnessToleranceLufs: nonNegativeNumberSchema.optional(),
  maxTruePeakDbfs: z.number().finite().optional(),
  maxSamplePeakDbfs: z.number().finite().optional(),
  maxClippedSamples: nonNegativeNumberSchema.optional(),
  subtitleTimingToleranceMs: nonNegativeNumberSchema.optional(),
});

const qualityRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  delivery: z.strictObject({
    videoPath: safeRelativePathSchema,
    srtPath: safeRelativePathSchema,
    assPath: safeRelativePathSchema,
    qcReportPath: safeRelativePathSchema.optional(),
    expectations: qcExpectationsSchema.optional(),
    aiLabel: z
      .strictObject({
        visible: z.boolean(),
        evidence: z.string().trim().min(1).max(1_000),
      })
      .optional(),
  }),
  reportPath: safeRelativePathSchema.refine(
    (value) => extname(value).toLowerCase() === ".json",
    "must end in .json",
  ),
});

type ExecuteMediaPlan = (
  plan: MediaCommandPlan,
  options: ExecuteMediaPlanOptions,
) => Promise<ExecutedMediaPlan>;
type ValidateFinalDelivery = (
  input: FinalDeliveryValidationInput,
  dependencies?: FinalDeliveryValidatorDependencies,
) => Promise<FinalDeliveryValidationResult>;

export interface LocalFfmpegProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  /** Omit in the global registry; ProviderExecutionManager supplies this per task. */
  readonly taskDirectory?: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly runner?: ProcessRunner;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly executeMediaPlan?: ExecuteMediaPlan;
  readonly validateFinalDelivery?: ValidateFinalDelivery;
  readonly currency?: string;
}

interface LocalIntent {
  readonly schemaVersion: 1;
  readonly remoteJobId: string;
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly requestSha256: string;
  readonly createdAt: string;
}

/**
 * Task-scoped deterministic FFmpeg renderer and final-delivery inspector.
 * User inputs contain versioned timeline/QC data only; they can never select
 * an executable, pass raw command arguments, or address a path outside task output.
 */
export class LocalFfmpegProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #taskDirectory?: string;
  readonly #ffmpegPath: string;
  readonly #ffprobePath: string;
  readonly #runner: ProcessRunner;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #executeMediaPlan: ExecuteMediaPlan;
  readonly #validateFinalDelivery: ValidateFinalDelivery;
  readonly #factoryConfig: Omit<LocalFfmpegProviderConfig, "taskDirectory">;

  constructor(config: LocalFfmpegProviderConfig = {}) {
    const currency = config.currency ?? "CNY";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ProviderConfigurationError("Local FFmpeg currency must be a three-letter upper-case code");
    }
    this.#taskDirectory = config.taskDirectory ? resolve(config.taskDirectory) : undefined;
    this.#ffmpegPath = config.ffmpegPath ?? "ffmpeg";
    this.#ffprobePath = config.ffprobePath ?? "ffprobe";
    this.#runner = config.runner ?? runProcess;
    this.#clock = config.clock ?? systemClock;
    this.#ids = config.ids ?? uuidGenerator;
    this.#executeMediaPlan = config.executeMediaPlan ?? executeMediaPlanDefault;
    this.#validateFinalDelivery = config.validateFinalDelivery ?? validateFinalDeliveryDefault;
    this.#factoryConfig = {
      id: config.id,
      displayName: config.displayName,
      ffmpegPath: this.#ffmpegPath,
      ffprobePath: this.#ffprobePath,
      runner: this.#runner,
      clock: this.#clock,
      ids: this.#ids,
      executeMediaPlan: this.#executeMediaPlan,
      validateFinalDelivery: this.#validateFinalDelivery,
      currency,
    };
    this.descriptor = {
      id: config.id ?? "local-ffmpeg",
      displayName: config.displayName ?? "Local FFmpeg",
      adapter: "local-ffmpeg",
      capabilities: LOCAL_CAPABILITIES,
      price: { currency, amount: 0, unit: "request" },
      dataTransfer: "local-only",
      metadata: {
        transport: "local-process",
        taskScoped: true,
        timelineSchemaVersion: 1,
        qualitySchemaVersion: 1,
        executableNames: [this.#ffmpegPath, this.#ffprobePath],
      },
    };
  }

  forTask(taskDirectory: string): LocalFfmpegProviderAdapter {
    return new LocalFfmpegProviderAdapter({ ...this.#factoryConfig, taskDirectory });
  }

  capabilities(): Promise<readonly ProviderCapability[]> {
    return Promise.resolve([...this.descriptor.capabilities]);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = this.#clock.now().toISOString();
    const startedAt = performance.now();
    try {
      const results = await Promise.all([
        this.#runner(this.#ffmpegPath, ["-version"], {
          timeoutMs: 10_000,
          maxOutputBytes: 1_024 * 1_024,
        }),
        this.#runner(this.#ffprobePath, ["-version"], {
          timeoutMs: 10_000,
          maxOutputBytes: 1_024 * 1_024,
        }),
      ]);
      if (results.some((result) => result.exitCode !== 0)) {
        throw new Error("ffmpeg or ffprobe returned a non-zero exit code");
      }
      return {
        providerId: this.descriptor.id,
        status: "healthy",
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        providerId: this.descriptor.id,
        status: "unavailable",
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : "FFmpeg toolchain is unavailable",
      };
    }
  }

  estimate(request: ProviderEstimateRequest): Promise<ProviderEstimate> {
    assertProviderCapability(this.descriptor, request.capability);
    return Promise.resolve({
      providerId: this.descriptor.id,
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      price: this.descriptor.price,
      notes: ["Local deterministic execution has zero provider charge"],
    });
  }

  async submit(request: ProviderSubmitRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertNoInlineSecrets(request.input);
    if (request.metadata) assertNoInlineSecrets(request.metadata, "metadata");
    const workspaceRoot = await this.#workspaceRoot();
    const requestSha256 = hashRequest(request);
    const idempotencySource = request.idempotencyKey ?? this.#ids.next();
    const remoteJobId = `local-${createHash("sha256")
      .update(`${this.descriptor.id}:${idempotencySource}`)
      .digest("hex")
      .slice(0, 32)}`;
    const intentWasCreated = await this.#ensureIntent({
      schemaVersion: 1,
      remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      requestSha256,
      createdAt: this.#clock.now().toISOString(),
    });
    const existing = await this.#readResult(remoteJobId, request.capability);
    if (existing) {
      if (intentWasCreated) {
        throw new ProviderProtocolError("Local FFmpeg result exists without a matching prior intent");
      }
      return existing;
    }
    const job =
      request.capability === "render.timeline"
        ? await this.#renderTimeline(request, remoteJobId, workspaceRoot)
        : await this.#inspectQuality(request, remoteJobId, workspaceRoot);
    return this.#persistResult(job);
  }

  async poll(request: ProviderPollRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertRemoteJobId(request.remoteJobId);
    await this.#workspaceRoot();
    const result = await this.#readResult(request.remoteJobId, request.capability);
    if (result) return result;
    const intent = await this.#readIntent(request.remoteJobId);
    if (!intent || intent.capability !== request.capability) {
      throw new ProviderConfigurationError(`Unknown local FFmpeg job ${request.remoteJobId}`);
    }
    return {
      id: `${this.descriptor.id}:${request.remoteJobId}`,
      remoteJobId: request.remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      state: "running",
      submittedAt: intent.createdAt,
      updatedAt: this.#clock.now().toISOString(),
    };
  }

  async #renderTimeline(
    request: ProviderSubmitRequest,
    remoteJobId: string,
    workspaceRoot: string,
  ): Promise<ProviderJob> {
    const parsed = parseInput(renderRequestSchema, request.input, "render.timeline");
    const timeline = parsed.timeline;
    const clips = await Promise.all(
      timeline.clips.map(async (clip) => ({
        ...clip,
        sourcePath: await existingWorkspaceFile(workspaceRoot, clip.sourcePath, "timeline clip"),
      })),
    );
    const audioTracks = timeline.audioTracks
      ? await Promise.all(
          timeline.audioTracks.map(async (track) => ({
            ...track,
            sourcePath: await existingWorkspaceFile(
              workspaceRoot,
              track.sourcePath,
              "timeline audio track",
            ),
          })),
        )
      : undefined;
    const subtitlePath = timeline.subtitlePath
      ? await existingWorkspaceFile(workspaceRoot, timeline.subtitlePath, "timeline subtitle")
      : undefined;
    const subtitleFontDirectory = timeline.subtitleFontDirectory
      ? await existingWorkspaceDirectory(
          workspaceRoot,
          timeline.subtitleFontDirectory,
          "timeline subtitle font directory",
        )
      : undefined;
    const outputPath = await newWorkspaceFile(
      workspaceRoot,
      timeline.outputPath,
      "timeline output",
    );
    const spec: TimelineRenderSpec = {
      clips,
      ...(audioTracks ? { audioTracks } : {}),
      ...(subtitlePath ? { subtitlePath } : {}),
      ...(timeline.subtitleFormat ? { subtitleFormat: timeline.subtitleFormat } : {}),
      ...(timeline.subtitleSha256 ? { subtitleSha256: timeline.subtitleSha256 } : {}),
      ...(subtitleFontDirectory ? { subtitleFontDirectory } : {}),
      ...(timeline.subtitleFontName ? { subtitleFontName: timeline.subtitleFontName } : {}),
      ...(timeline.aiLabelText ? { aiLabelText: timeline.aiLabelText } : {}),
      ...(timeline.width ? { width: timeline.width } : {}),
      ...(timeline.height ? { height: timeline.height } : {}),
      ...(timeline.fps ? { fps: timeline.fps } : {}),
      ...(timeline.sampleRate ? { sampleRate: timeline.sampleRate } : {}),
      outputPath,
    };
    const executed = await this.#executeMediaPlan(
      createTimelineRenderPlan(spec, { ffmpegPath: this.#ffmpegPath }),
      { workspaceRoot, runner: this.#runner },
    );
    const output = await verifiedOutput(
      workspaceRoot,
      executed.outputPath,
      "video",
      "video/mp4",
    );
    if (output.sizeBytes !== executed.sizeBytes || output.sha256 !== executed.sha256) {
      throw new ProviderProtocolError("Media executor receipt does not match the rendered output");
    }
    return this.#job(remoteJobId, request, "succeeded", output);
  }

  async #inspectQuality(
    request: ProviderSubmitRequest,
    remoteJobId: string,
    workspaceRoot: string,
  ): Promise<ProviderJob> {
    const parsed = parseInput(qualityRequestSchema, request.input, "quality.inspect");
    const reportPath = await newWorkspaceFile(
      workspaceRoot,
      parsed.reportPath,
      "quality report",
    );
    const delivery: FinalDeliveryValidationInput = {
      videoPath: await existingWorkspaceFile(
        workspaceRoot,
        parsed.delivery.videoPath,
        "delivery video",
      ),
      srtPath: await existingWorkspaceFile(
        workspaceRoot,
        parsed.delivery.srtPath,
        "delivery SRT",
      ),
      assPath: await existingWorkspaceFile(
        workspaceRoot,
        parsed.delivery.assPath,
        "delivery ASS",
      ),
      ...(parsed.delivery.qcReportPath
        ? {
            qcReportPath: await existingWorkspaceFile(
              workspaceRoot,
              parsed.delivery.qcReportPath,
              "prior QC report",
            ),
          }
        : {}),
      ...(parsed.delivery.expectations
        ? { expectations: parsed.delivery.expectations }
        : {}),
      ...(parsed.delivery.aiLabel ? { aiLabel: parsed.delivery.aiLabel } : {}),
    };
    const result = await this.#validateFinalDelivery(delivery, {
      runner: this.#runner,
      ffmpegPath: this.#ffmpegPath,
      ffprobePath: this.#ffprobePath,
      now: () => this.#clock.now().toISOString(),
    });
    await writeFile(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    const output = await verifiedOutput(workspaceRoot, reportPath, "json", "application/json");
    return this.#job(
      remoteJobId,
      request,
      result.ok ? "succeeded" : "failed_terminal",
      output,
      result.ok
        ? undefined
        : {
            code: "quality_inspection_failed",
            message: "Final delivery validation reported one or more failed checks",
            retryable: false,
          },
    );
  }

  #job(
    remoteJobId: string,
    request: ProviderSubmitRequest,
    state: "succeeded" | "failed_terminal",
    output: ProviderOutput,
    error?: ProviderJob["error"],
  ): ProviderJob {
    const now = this.#clock.now().toISOString();
    return {
      id: `${this.descriptor.id}:${remoteJobId}`,
      remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      state,
      ...(request.model ? { model: request.model } : {}),
      submittedAt: now,
      updatedAt: now,
      outputs: [output],
      ...(error ? { error } : {}),
    };
  }

  async #workspaceRoot(): Promise<string> {
    if (!this.#taskDirectory) {
      throw new ProviderConfigurationError(
        "Local FFmpeg execution requires a task-scoped ProviderExecutionManager",
      );
    }
    await mkdir(this.#taskDirectory, { recursive: true });
    const root = await realpath(this.#taskDirectory);
    await safeWorkspaceDirectory(root, INTERNAL_DIRECTORY);
    await safeWorkspaceDirectory(root, `${INTERNAL_DIRECTORY}/intents`);
    await safeWorkspaceDirectory(root, `${INTERNAL_DIRECTORY}/results`);
    return root;
  }

  async #ensureIntent(intent: LocalIntent): Promise<boolean> {
    const path = this.#intentPath(intent.remoteJobId);
    try {
      await writeFile(path, `${JSON.stringify(intent)}\n`, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const existing = parseIntent(await readFile(path, "utf8"));
    if (
      existing.remoteJobId !== intent.remoteJobId ||
      existing.providerId !== intent.providerId ||
      existing.capability !== intent.capability ||
      existing.requestSha256 !== intent.requestSha256
    ) {
      throw new ProviderConfigurationError(
        `Local FFmpeg idempotency key was already used for a different request`,
      );
    }
    return false;
  }

  async #readIntent(remoteJobId: string): Promise<LocalIntent | undefined> {
    try {
      return parseIntent(await readFile(this.#intentPath(remoteJobId), "utf8"));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async #persistResult(job: ProviderJob): Promise<ProviderJob> {
    const path = this.#resultPath(job.remoteJobId);
    try {
      await writeFile(path, `${JSON.stringify(job)}\n`, { encoding: "utf8", flag: "wx" });
      return job;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await this.#readResult(job.remoteJobId, job.capability);
      if (!existing) throw error;
      return existing;
    }
  }

  async #readResult(
    remoteJobId: string,
    capability: ProviderCapability,
  ): Promise<ProviderJob | undefined> {
    assertRemoteJobId(remoteJobId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#resultPath(remoteJobId), "utf8")) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw new ProviderProtocolError(`Local FFmpeg result ${remoteJobId} is unreadable`, {
        cause: error,
      });
    }
    const job = validatePersistedJob(parsed, this.descriptor.id, remoteJobId, capability);
    const output = job.outputs?.[0];
    if (!output?.localPath || !output.mimeType || !output.sha256 || output.sizeBytes === undefined) {
      throw new ProviderProtocolError(`Local FFmpeg result ${remoteJobId} has no verified output`);
    }
    const expectedKind = capability === "render.timeline" ? "video" : "json";
    const expectedMimeType = capability === "render.timeline" ? "video/mp4" : "application/json";
    const verified = await verifiedOutput(
      await this.#workspaceRoot(),
      output.localPath,
      expectedKind,
      expectedMimeType,
    );
    if (verified.sizeBytes !== output.sizeBytes || verified.sha256 !== output.sha256) {
      throw new ProviderProtocolError(`Local FFmpeg result ${remoteJobId} output changed after validation`);
    }
    return job;
  }

  #intentPath(remoteJobId: string): string {
    assertRemoteJobId(remoteJobId);
    return resolve(this.#taskDirectory ?? "", INTERNAL_DIRECTORY, "intents", `${remoteJobId}.json`);
  }

  #resultPath(remoteJobId: string): string {
    assertRemoteJobId(remoteJobId);
    return resolve(this.#taskDirectory ?? "", INTERNAL_DIRECTORY, "results", `${remoteJobId}.json`);
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, capability: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "input"}:${issue.code}`)
    .join(", ");
  throw new ProviderConfigurationError(`Invalid versioned ${capability} request (${issues})`);
}

function isSafeRelativePath(value: string): boolean {
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value) || /[\0\r\n]/.test(value)) return false;
  const segments = value.replace(/\\/g, "/").split("/");
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function existingWorkspaceFile(root: string, path: string, label: string): Promise<string> {
  const candidate = workspaceChild(root, path, label);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    throw new ProviderConfigurationError(`${label} does not exist in the task workspace`, {
      cause: error,
    });
  }
  assertCanonicalChild(root, canonical, label);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new ProviderConfigurationError(`${label} must be a file`);
  return candidate;
}

async function existingWorkspaceDirectory(root: string, path: string, label: string): Promise<string> {
  const candidate = workspaceChild(root, path, label);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    throw new ProviderConfigurationError(`${label} does not exist in the task workspace`, {
      cause: error,
    });
  }
  assertCanonicalChild(root, canonical, label);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new ProviderConfigurationError(`${label} must be a directory`);
  return candidate;
}

async function newWorkspaceFile(root: string, path: string, label: string): Promise<string> {
  const candidate = workspaceChild(root, path, label);
  await safeWorkspaceDirectory(root, relative(root, dirname(candidate)).replace(/\\/g, "/"));
  try {
    await lstat(candidate);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return candidate;
    throw error;
  }
  throw new ProviderConfigurationError(`${label} already exists and is immutable`);
}

async function safeWorkspaceDirectory(root: string, relativeDirectory: string): Promise<string> {
  if (!relativeDirectory || relativeDirectory === ".") return root;
  if (!isSafeRelativePath(relativeDirectory)) {
    throw new ProviderConfigurationError("Workspace directory must be a safe relative path");
  }
  let current = root;
  for (const segment of relativeDirectory.replace(/\\/g, "/").split("/")) {
    current = resolve(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
        throw new ProviderConfigurationError("Workspace path component must be a directory");
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await mkdir(current);
    }
    const canonical = await realpath(current);
    assertCanonicalChild(root, canonical, "workspace directory");
    if (!(await stat(canonical)).isDirectory()) {
      throw new ProviderConfigurationError("Workspace path component must resolve to a directory");
    }
  }
  return current;
}

function workspaceChild(root: string, path: string, label: string): string {
  if (!isSafeRelativePath(path)) {
    throw new ProviderConfigurationError(`${label} must use a safe task-relative path`);
  }
  const candidate = resolve(root, path);
  assertCanonicalChild(root, candidate, label);
  return candidate;
}

function assertCanonicalChild(root: string, candidate: string, label: string): void {
  const relation = relative(root, candidate);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new ProviderConfigurationError(`${label} escapes the task workspace`);
  }
}

async function verifiedOutput(
  root: string,
  localPath: string,
  kind: ProviderOutput["kind"],
  mimeType: string,
): Promise<ProviderOutput & { readonly sizeBytes: number; readonly sha256: string }> {
  const candidate = resolve(localPath);
  assertCanonicalChild(root, candidate, "local provider output");
  const canonical = await realpath(candidate);
  assertCanonicalChild(root, canonical, "local provider output");
  const metadata = await stat(canonical);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new ProviderProtocolError("Local provider output must be a non-empty regular file");
  }
  return {
    kind,
    localPath: candidate,
    mimeType,
    sizeBytes: metadata.size,
    sha256: await sha256File(canonical),
  };
}

function validatePersistedJob(
  value: unknown,
  providerId: string,
  remoteJobId: string,
  capability: ProviderCapability,
): ProviderJob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError("Local FFmpeg result is not an object");
  }
  const job = value as Record<string, unknown>;
  if (
    job.id !== `${providerId}:${remoteJobId}` ||
    job.remoteJobId !== remoteJobId ||
    job.providerId !== providerId ||
    job.capability !== capability ||
    !["succeeded", "failed_terminal"].includes(String(job.state)) ||
    typeof job.submittedAt !== "string" ||
    !Number.isFinite(Date.parse(job.submittedAt)) ||
    typeof job.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(job.updatedAt)) ||
    !Array.isArray(job.outputs) ||
    job.outputs.length !== 1
  ) {
    throw new ProviderProtocolError("Local FFmpeg result envelope is invalid");
  }
  const output = job.outputs[0];
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    throw new ProviderProtocolError("Local FFmpeg result output is invalid");
  }
  const record = output as Record<string, unknown>;
  if (
    typeof record.localPath !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes <= 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    record.uri !== undefined ||
    record.archivedPath !== undefined
  ) {
    throw new ProviderProtocolError("Local FFmpeg result output verification is invalid");
  }
  return value as ProviderJob;
}

function parseIntent(value: string): LocalIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new ProviderProtocolError("Local FFmpeg intent is corrupt", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderProtocolError("Local FFmpeg intent is invalid");
  }
  const intent = parsed as Record<string, unknown>;
  if (
    intent.schemaVersion !== 1 ||
    typeof intent.remoteJobId !== "string" ||
    typeof intent.providerId !== "string" ||
    !LOCAL_CAPABILITIES.includes(intent.capability as (typeof LOCAL_CAPABILITIES)[number]) ||
    typeof intent.requestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(intent.requestSha256) ||
    typeof intent.createdAt !== "string" ||
    !Number.isFinite(Date.parse(intent.createdAt))
  ) {
    throw new ProviderProtocolError("Local FFmpeg intent fields are invalid");
  }
  assertRemoteJobId(intent.remoteJobId);
  return parsed as LocalIntent;
}

function hashRequest(request: ProviderSubmitRequest): string {
  return createHash("sha256")
    .update(
      stableJson({
        capability: request.capability,
        model: request.model ?? null,
        input: request.input,
        metadata: request.metadata ?? null,
      }),
    )
    .digest("hex");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
    .join(",")}}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function assertRemoteJobId(value: string): void {
  if (!/^local-[a-f0-9]{32}$/.test(value)) {
    throw new ProviderConfigurationError("Local FFmpeg job id is invalid");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
