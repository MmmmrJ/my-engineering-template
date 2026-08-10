import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, truncate, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Clock,
  JsonValue,
  ProviderAdapter,
  ProviderCapability,
  ProviderJob,
  ProviderJobError,
  ProviderJobState,
  ProviderOutput,
  ProviderPrice,
  ProviderSubmitRequest,
} from "./types.js";
import {
  ProviderConfigurationError,
  ProviderError,
  isProviderCapability,
  systemClock,
} from "./types.js";
import { assertNoInlineSecrets } from "./utils.js";

export type StoredAttemptState = "prepared" | ProviderJobState;

export interface StoredProviderAttempt {
  readonly attemptId: string;
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly model?: string;
  readonly requestSha256: string;
  readonly idempotencyKey: string;
  readonly stage?: string;
  readonly stageRevision?: number;
  readonly costConfirmation: PaidSubmitConfirmation;
  readonly pricingSnapshot: ProviderPricingSnapshot;
  readonly preparedAt: string;
  readonly updatedAt: string;
  readonly state: StoredAttemptState;
  readonly externalJobId?: string;
  readonly progress?: number;
  readonly retryAfterMs?: number;
  readonly outputs?: readonly ProviderOutput[];
  readonly error?: ProviderJobError;
  readonly revision: number;
}

interface LedgerEventBase {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly at: string;
  readonly attemptId: string;
}

interface PreparedEvent extends LedgerEventBase {
  readonly type: "prepared";
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly model?: string;
  readonly requestSha256: string;
  readonly idempotencyKey: string;
  readonly stage?: string;
  readonly stageRevision?: number;
  readonly costConfirmation: PaidSubmitConfirmation;
  readonly pricingSnapshot: ProviderPricingSnapshot;
}

interface JobEvent extends LedgerEventBase {
  readonly type: "submitted" | "polled" | "cancelled";
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly externalJobId: string;
  readonly state: ProviderJobState;
  readonly progress?: number;
  readonly retryAfterMs?: number;
  readonly outputs?: readonly ProviderOutput[];
  readonly error?: ProviderJobError;
}

interface CallFailedEvent extends LedgerEventBase {
  readonly type: "call_failed";
  readonly state: "failed_retryable" | "failed_terminal";
  readonly error: ProviderJobError;
  readonly retryAfterMs?: number;
}

type LedgerEvent = PreparedEvent | JobEvent | CallFailedEvent;

export interface ProviderJobStoreOptions {
  readonly fileName?: string;
  readonly clock?: Clock;
  readonly environment?: NodeJS.ProcessEnv;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
  readonly staleLockMs?: number;
}

interface PaidSubmitConfirmationBase {
  /** ISO-8601 time at which the user approved this new paid generation request. */
  readonly confirmedAt: string;
  readonly confirmedBy: "user";
  /** Durable review/event reference, not free-form confirmation text. */
  readonly confirmationReference: string;
  /** Hard user-approved ceiling for this one submit attempt. */
  readonly maximumCost: number;
  readonly currency: string;
}

export type PaidSubmitConfirmation =
  | (PaidSubmitConfirmationBase & {
      readonly pricingStatus: "known";
      readonly estimatedCost: number;
      readonly unknownPricingAcknowledged?: never;
    })
  | (PaidSubmitConfirmationBase & {
      readonly pricingStatus: "unknown";
      readonly unknownPricingAcknowledged: true;
      readonly estimatedCost?: never;
    });

export interface ProviderPricingSnapshot {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly model?: string;
  readonly pricingStatus: "known" | "unknown";
  readonly price?: ProviderPrice;
  readonly estimatedSeconds?: number;
  readonly calculatedCost?: number;
  readonly currency: string;
  readonly estimatedAt: string;
  readonly estimateSha256: string;
}

export interface AttemptContext {
  readonly stage: string;
  readonly stageRevision: number;
  readonly costConfirmation: PaidSubmitConfirmation;
}

export interface AuditedAttemptContext extends AttemptContext {
  readonly pricingSnapshot: ProviderPricingSnapshot;
}

export interface TrackedSubmitResult {
  readonly attempt: StoredProviderAttempt;
  readonly job: ProviderJob;
}

export interface TrackedJobOptions {
  /** Transform/validate remote outputs before any successful projection is appended. */
  readonly prepareForPersistence?: (
    attempt: StoredProviderAttempt,
    job: ProviderJob,
  ) => Promise<ProviderJob>;
}

/**
 * Per-task append-only provider attempt ledger. It stores request hashes and
 * normalized local projections only—never request bodies, headers, raw provider
 * responses, signed output URLs, or resolved environment-variable values.
 */
export class ProviderJobStore {
  readonly path: string;
  readonly lockPath: string;
  readonly #clock: Clock;
  readonly #secretValues: readonly string[];
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #staleLockMs: number;
  #attempts: Map<string, StoredProviderAttempt> | undefined;
  #appendQueue: Promise<void> = Promise.resolve();

  constructor(taskDirectory: string, options: ProviderJobStoreOptions = {}) {
    if (!taskDirectory.trim()) throw new ProviderConfigurationError("Task directory must not be empty");
    const fileName = options.fileName ?? "provider-jobs.jsonl";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.jsonl$/.test(fileName)) {
      throw new ProviderConfigurationError("Provider job ledger fileName must be a safe .jsonl name");
    }
    this.path = resolve(taskDirectory, fileName);
    this.lockPath = `${this.path}.lock`;
    this.#clock = options.clock ?? systemClock;
    this.#secretValues = Object.values(options.environment ?? process.env).filter(
      (value): value is string => typeof value === "string" && value.length >= 8,
    );
    this.#lockTimeoutMs = positiveLockOption(options.lockTimeoutMs, 5_000, "lockTimeoutMs");
    this.#lockRetryMs = positiveLockOption(options.lockRetryMs, 10, "lockRetryMs");
    this.#staleLockMs = positiveLockOption(options.staleLockMs, 30_000, "staleLockMs");
  }

  async prepareSubmit(
    providerId: string,
    request: ProviderSubmitRequest,
    context: AuditedAttemptContext,
  ): Promise<StoredProviderAttempt> {
    assertNoInlineSecrets(request.input);
    if (request.metadata) assertNoInlineSecrets(request.metadata, "metadata");
    const attemptId = randomUUID();
    const idempotencyKey = request.idempotencyKey ?? `cartoon-${attemptId}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(idempotencyKey)) {
      throw new ProviderConfigurationError(
        "Provider idempotencyKey must be a safe identifier of at most 128 characters",
      );
    }
    validateAttemptContext(context);
    validatePricingBinding(providerId, request, context);
    const event: PreparedEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      type: "prepared",
      at: this.#clock.now().toISOString(),
      attemptId,
      providerId,
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      requestSha256: hashRequest(request),
      idempotencyKey,
      stage: context.stage,
      stageRevision: context.stageRevision,
      costConfirmation: { ...context.costConfirmation },
      pricingSnapshot: clonePricingSnapshot(context.pricingSnapshot),
    };
    await this.#append(event);
    return this.get(attemptId);
  }

  async markSubmitted(attemptId: string, job: ProviderJob): Promise<StoredProviderAttempt> {
    return this.#recordJob("submitted", attemptId, job);
  }

  async recordPoll(attemptId: string, job: ProviderJob): Promise<StoredProviderAttempt> {
    return this.#recordJob("polled", attemptId, job);
  }

  async recordCancel(attemptId: string, job: ProviderJob): Promise<StoredProviderAttempt> {
    return this.#recordJob("cancelled", attemptId, job);
  }

  async recordCallFailure(attemptId: string, error: unknown): Promise<StoredProviderAttempt> {
    const existing = await this.get(attemptId);
    const retryable = error instanceof ProviderError ? error.retryable : true;
    const event: CallFailedEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      type: "call_failed",
      at: this.#clock.now().toISOString(),
      attemptId,
      state: retryable ? "failed_retryable" : "failed_terminal",
      error: {
        code: error instanceof ProviderError ? error.code : "provider_call_failed",
        message: this.#redact(error instanceof Error ? error.message : "Provider call failed"),
        retryable,
      },
      ...(error instanceof ProviderError && error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    };
    if (["succeeded", "failed_terminal", "cancelled"].includes(existing.state)) {
      throw new ProviderConfigurationError(
        `Cannot record a call failure after attempt ${attemptId} reached ${existing.state}`,
      );
    }
    await this.#append(event);
    return this.get(attemptId);
  }

  async submitTracked(
    adapter: ProviderAdapter,
    request: ProviderSubmitRequest,
    context: AuditedAttemptContext,
    options: TrackedJobOptions = {},
  ): Promise<TrackedSubmitResult> {
    const prepared = await this.prepareSubmit(adapter.descriptor.id, request, context);
    let projection: ProviderJob;
    try {
      const job = await adapter.submit({ ...request, idempotencyKey: prepared.idempotencyKey });
      projection = options.prepareForPersistence
        ? await options.prepareForPersistence(prepared, job)
        : job;
    } catch (error) {
      await this.recordCallFailure(prepared.attemptId, error);
      throw error;
    }
    const attempt = await this.markSubmitted(prepared.attemptId, projection);
    return { attempt, job: projection };
  }

  /**
   * Resume the exact prepared request after a crash without asking the user to
   * approve the same charge again. The request hash and persisted idempotency
   * key bind this call to the original confirmation.
   */
  async resumeSubmitTracked(
    adapter: ProviderAdapter,
    attemptId: string,
    request: ProviderSubmitRequest,
    options: TrackedJobOptions = {},
  ): Promise<TrackedSubmitResult> {
    const prepared = await this.get(attemptId);
    if (prepared.providerId !== adapter.descriptor.id) {
      throw new ProviderConfigurationError(
        `Provider ${adapter.descriptor.id} does not match prepared attempt ${attemptId}`,
      );
    }
    if (prepared.externalJobId) {
      throw new ProviderConfigurationError(
        `Attempt ${attemptId} already has external job ${prepared.externalJobId}; resume it with pollTracked`,
      );
    }
    if (!["prepared", "failed_retryable"].includes(prepared.state)) {
      throw new ProviderConfigurationError(
        `Attempt ${attemptId} in state ${prepared.state} cannot be submitted again`,
      );
    }
    if (hashRequest(request) !== prepared.requestSha256) {
      throw new ProviderConfigurationError(
        `Request does not match the paid confirmation recorded for attempt ${attemptId}`,
      );
    }
    let projection: ProviderJob;
    try {
      const job = await adapter.submit({ ...request, idempotencyKey: prepared.idempotencyKey });
      projection = options.prepareForPersistence
        ? await options.prepareForPersistence(prepared, job)
        : job;
    } catch (error) {
      await this.recordCallFailure(attemptId, error);
      throw error;
    }
    const attempt = await this.markSubmitted(attemptId, projection);
    return { attempt, job: projection };
  }

  async pollTracked(
    adapter: ProviderAdapter,
    attemptId: string,
    options: TrackedJobOptions = {},
  ): Promise<ProviderJob> {
    const attempt = await this.get(attemptId);
    if (!attempt.externalJobId) {
      throw new ProviderConfigurationError(
        `Attempt ${attemptId} has no external job id; safely retry submit with idempotency key ${attempt.idempotencyKey}`,
      );
    }
    let projection: ProviderJob;
    try {
      const job = await adapter.poll({
        remoteJobId: attempt.externalJobId,
        capability: attempt.capability,
        ...(attempt.model ? { model: attempt.model } : {}),
      });
      projection = options.prepareForPersistence
        ? await options.prepareForPersistence(attempt, job)
        : job;
    } catch (error) {
      await this.recordCallFailure(attemptId, error);
      throw error;
    }
    await this.recordPoll(attemptId, projection);
    return projection;
  }

  async cancelTracked(adapter: ProviderAdapter, attemptId: string): Promise<ProviderJob> {
    if (!adapter.cancel) {
      throw new ProviderConfigurationError(`Provider ${adapter.descriptor.id} does not support cancellation`);
    }
    const attempt = await this.get(attemptId);
    if (!attempt.externalJobId) {
      throw new ProviderConfigurationError(`Attempt ${attemptId} has no external job id to cancel`);
    }
    let job: ProviderJob;
    try {
      job = await adapter.cancel({
        remoteJobId: attempt.externalJobId,
        capability: attempt.capability,
        ...(attempt.model ? { model: attempt.model } : {}),
      });
    } catch (error) {
      await this.recordCallFailure(attemptId, error);
      throw error;
    }
    await this.recordCancel(attemptId, job);
    return job;
  }

  async get(attemptId: string): Promise<StoredProviderAttempt> {
    return this.#withFileLock(async () => {
      await this.#reload();
      const attempt = this.#attempts?.get(attemptId);
      if (!attempt) throw new ProviderConfigurationError(`Unknown provider attempt ${attemptId}`);
      return cloneAttempt(attempt);
    });
  }

  async list(): Promise<readonly StoredProviderAttempt[]> {
    return this.#withFileLock(async () => {
      await this.#reload();
      return [...(this.#attempts?.values() ?? [])]
        .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt))
        .map(cloneAttempt);
    });
  }

  async resumeCandidates(): Promise<readonly StoredProviderAttempt[]> {
    return (await this.list()).filter((attempt) =>
      ["prepared", "queued", "running", "failed_retryable"].includes(attempt.state),
    );
  }

  async #recordJob(
    type: JobEvent["type"],
    attemptId: string,
    job: ProviderJob,
  ): Promise<StoredProviderAttempt> {
    const existing = await this.get(attemptId);
    if (existing.providerId !== job.providerId || existing.capability !== job.capability) {
      throw new ProviderConfigurationError(
        `Provider job does not match prepared attempt ${attemptId}`,
      );
    }
    if (existing.externalJobId && existing.externalJobId !== job.remoteJobId) {
      throw new ProviderConfigurationError(
        `Provider job id ${job.remoteJobId} does not match durable job ${existing.externalJobId}`,
      );
    }
    const event: JobEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      type,
      at: this.#clock.now().toISOString(),
      attemptId,
      providerId: job.providerId,
      capability: job.capability,
      externalJobId: job.remoteJobId,
      state: job.state,
      ...(job.progress === undefined ? {} : { progress: job.progress }),
      ...(job.retryAfterMs === undefined ? {} : { retryAfterMs: job.retryAfterMs }),
      ...(job.outputs?.length ? { outputs: job.outputs.map(sanitizeOutput) } : {}),
      ...(job.error ? { error: sanitizeError(job.error, (text) => this.#redact(text)) } : {}),
    };
    if (sameJobProjection(existing, event)) return existing;
    if (["succeeded", "failed_terminal", "cancelled"].includes(existing.state)) {
      throw new ProviderConfigurationError(
        `Cannot change terminal attempt ${attemptId} from ${existing.state} to ${event.state}`,
      );
    }
    await this.#append(event);
    return this.get(attemptId);
  }

  async #append(event: LedgerEvent): Promise<void> {
    const operation = this.#appendQueue.then(async () => {
      await this.#withFileLock(async () => {
        await this.#reload();
        if (!this.#validateFreshTransition(event)) return;
        await mkdir(resolve(this.path, ".."), { recursive: true });
        const handle = await open(this.path, "a", 0o600);
        try {
          await handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.#apply(event);
      });
    });
    this.#appendQueue = operation.catch(() => undefined);
    return operation;
  }

  async #reload(): Promise<void> {
    const attempts = new Map<string, StoredProviderAttempt>();
    let contents = "";
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    this.#attempts = attempts;
    if (!contents) return;
    const hasTrailingNewline = contents.endsWith("\n");
    const lastNewlineIndex = contents.lastIndexOf("\n");
    const completePortion = hasTrailingNewline
      ? contents
      : lastNewlineIndex >= 0
        ? contents.slice(0, lastNewlineIndex + 1)
        : "";
    const tail = hasTrailingNewline
      ? ""
      : lastNewlineIndex >= 0
        ? contents.slice(lastNewlineIndex + 1)
        : contents;
    const completeLines = completePortion.split(/\r?\n/).filter(Boolean);
    for (const [index, line] of completeLines.entries()) {
      this.#apply(this.#parseLedgerLine(line, index + 1));
    }
    if (hasTrailingNewline || !tail.trim()) return;
    const tailLine = completeLines.length + 1;
    let parsedTail: LedgerEvent;
    try {
      parsedTail = this.#parseLedgerLine(tail, tailLine);
    } catch (error) {
      if (completeLines.length > 0 && looksLikeIncompleteLedgerJson(tail)) {
        await truncate(this.path, Buffer.byteLength(completePortion, "utf8"));
        return;
      }
      throw error;
    }
    this.#apply(parsedTail);
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write("\n", undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #parseLedgerLine(line: string, lineNumber: number): LedgerEvent {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new ProviderConfigurationError(
          `Provider job ledger is corrupt at line ${lineNumber}`,
          { cause: error },
        );
      }
      return validateLedgerEvent(parsed, lineNumber);
  }

  #validateFreshTransition(event: LedgerEvent): boolean {
    if (!this.#attempts) throw new Error("Provider job ledger was not initialized");
    if (event.type === "prepared") {
      if (this.#attempts.has(event.attemptId)) {
        throw new ProviderConfigurationError(`Duplicate prepared attempt ${event.attemptId}`);
      }
      const active = [...this.#attempts.values()].find((attempt) =>
        ["prepared", "queued", "running", "failed_retryable"].includes(attempt.state),
      );
      if (active) {
        throw new ProviderConfigurationError(
          `Provider concurrency limit 1 blocks a new submit while attempt ${active.attemptId} is ${active.state}`,
        );
      }
      return true;
    }
    const existing = this.#attempts.get(event.attemptId);
    if (!existing) {
      throw new ProviderConfigurationError(
        `Ledger transition precedes prepared attempt ${event.attemptId}`,
      );
    }
    if (event.type === "call_failed") {
      if (["succeeded", "failed_terminal", "cancelled"].includes(existing.state)) {
        throw new ProviderConfigurationError(
          `Cannot record a call failure after attempt ${event.attemptId} reached ${existing.state}`,
        );
      }
      return true;
    }
    if (existing.providerId !== event.providerId || existing.capability !== event.capability) {
      throw new ProviderConfigurationError(
        `Provider job does not match prepared attempt ${event.attemptId}`,
      );
    }
    if (existing.externalJobId && existing.externalJobId !== event.externalJobId) {
      throw new ProviderConfigurationError(
        `Provider job id ${event.externalJobId} does not match durable job ${existing.externalJobId}`,
      );
    }
    if (sameJobProjection(existing, event)) return false;
    if (["succeeded", "failed_terminal", "cancelled"].includes(existing.state)) {
      throw new ProviderConfigurationError(
        `Cannot change terminal attempt ${event.attemptId} from ${existing.state} to ${event.state}`,
      );
    }
    return true;
  }

  async #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + this.#lockTimeoutMs;
    await mkdir(resolve(this.lockPath, ".."), { recursive: true });
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.write(
            JSON.stringify({
              schemaVersion: 1,
              token,
              pid: process.pid,
              createdAt: new Date().toISOString(),
            }),
            undefined,
            "utf8",
          );
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
        await handle.close();
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (await this.#recoverAbandonedLock()) continue;
        if (Date.now() >= deadline) {
          throw new ProviderConfigurationError(
            `Timed out waiting ${this.#lockTimeoutMs}ms for provider job ledger lock`,
          );
        }
        await delay(this.#lockRetryMs);
      }
    }
    try {
      return await operation();
    } finally {
      await this.#releaseLock(token);
    }
  }

  async #recoverAbandonedLock(): Promise<boolean> {
    let raw: string;
    let modifiedAt: number;
    try {
      [raw, modifiedAt] = await Promise.all([
        readFile(this.lockPath, "utf8"),
        stat(this.lockPath).then((entry) => entry.mtimeMs),
      ]);
    } catch (error) {
      return isMissingFile(error);
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(raw) as unknown;
    } catch {
      metadata = undefined;
    }
    if (isLedgerLockMetadata(metadata)) {
      if (isProcessAlive(metadata.pid)) return false;
      return unlink(this.lockPath).then(
        () => true,
        (error: unknown) => isMissingFile(error),
      );
    }
    if (Date.now() - modifiedAt < this.#staleLockMs) return false;
    return unlink(this.lockPath).then(
      () => true,
      (error: unknown) => isMissingFile(error),
    );
  }

  async #releaseLock(token: string): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.lockPath, "utf8")) as unknown;
      if (!isLedgerLockMetadata(raw) || raw.token !== token) return;
      await unlink(this.lockPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  #apply(event: LedgerEvent): void {
    if (!this.#attempts) throw new Error("Provider job ledger was not initialized");
    if (event.type === "prepared") {
      if (this.#attempts.has(event.attemptId)) {
        throw new ProviderConfigurationError(`Duplicate prepared attempt ${event.attemptId}`);
      }
      this.#attempts.set(event.attemptId, {
        attemptId: event.attemptId,
        providerId: event.providerId,
        capability: event.capability,
        ...(event.model ? { model: event.model } : {}),
        requestSha256: event.requestSha256,
        idempotencyKey: event.idempotencyKey,
        ...(event.stage ? { stage: event.stage } : {}),
        ...(event.stageRevision === undefined ? {} : { stageRevision: event.stageRevision }),
        costConfirmation: { ...event.costConfirmation },
        pricingSnapshot: clonePricingSnapshot(event.pricingSnapshot),
        preparedAt: event.at,
        updatedAt: event.at,
        state: "prepared",
        revision: 1,
      });
      return;
    }
    const existing = this.#attempts.get(event.attemptId);
    if (!existing) {
      throw new ProviderConfigurationError(`Ledger transition precedes prepared attempt ${event.attemptId}`);
    }
    if (event.type === "call_failed") {
      this.#attempts.set(event.attemptId, {
        ...existing,
        updatedAt: event.at,
        state: event.state,
        error: event.error,
        retryAfterMs: event.retryAfterMs,
        revision: existing.revision + 1,
      });
      return;
    }
    this.#attempts.set(event.attemptId, {
      ...existing,
      updatedAt: event.at,
      state: event.state,
      externalJobId: event.externalJobId,
      ...(event.progress === undefined ? {} : { progress: event.progress }),
      retryAfterMs: event.retryAfterMs,
      ...(event.outputs ? { outputs: event.outputs } : {}),
      error: event.error,
      revision: existing.revision + 1,
    });
  }

  #redact(value: string): string {
    let redacted = value;
    for (const secret of this.#secretValues) redacted = redacted.split(secret).join("[REDACTED]");
    return redacted
      .replace(/(?:bearer\s+)[a-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:token|sig|signature|key)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 2_000);
  }
}

function hashRequest(request: ProviderSubmitRequest): string {
  const canonical = stableJson({
    capability: request.capability,
    model: request.model ?? null,
    region: request.region ?? null,
    input: request.input,
    metadata: request.metadata ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function stableJson(value: JsonValue | undefined): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function sanitizeOutput(output: ProviderOutput): ProviderOutput {
  return {
    kind: output.kind,
    ...(output.localPath ? { localPath: output.localPath } : {}),
    ...(output.archivedPath ? { archivedPath: output.archivedPath } : {}),
    ...(output.mimeType ? { mimeType: output.mimeType } : {}),
    ...(output.sizeBytes === undefined ? {} : { sizeBytes: output.sizeBytes }),
    ...(output.sha256 ? { sha256: output.sha256 } : {}),
  };
}

function sanitizeError(
  error: ProviderJobError,
  redact: (value: string) => string,
): ProviderJobError {
  return { code: error.code, message: redact(error.message), retryable: error.retryable };
}

function cloneAttempt(attempt: StoredProviderAttempt): StoredProviderAttempt {
  return JSON.parse(JSON.stringify(attempt)) as StoredProviderAttempt;
}

function sameJobProjection(attempt: StoredProviderAttempt, event: JobEvent): boolean {
  return (
    attempt.externalJobId === event.externalJobId &&
    attempt.state === event.state &&
    attempt.progress === event.progress &&
    attempt.retryAfterMs === event.retryAfterMs &&
    JSON.stringify(attempt.outputs ?? []) === JSON.stringify(event.outputs ?? []) &&
    JSON.stringify(attempt.error ?? null) === JSON.stringify(event.error ?? null)
  );
}

function validateLedgerEvent(value: unknown, line: number): LedgerEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderConfigurationError(`Provider job ledger line ${line} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.eventId !== "string" ||
    typeof record.at !== "string" ||
    typeof record.attemptId !== "string" ||
    !["prepared", "submitted", "polled", "cancelled", "call_failed"].includes(
      String(record.type),
    )
  ) {
    throw new ProviderConfigurationError(`Provider job ledger line ${line} has invalid envelope fields`);
  }
  if (record.type === "prepared") {
    const costConfirmation = record.costConfirmation;
    try {
      validatePaidSubmitConfirmation(costConfirmation);
    } catch (error) {
      throw new ProviderConfigurationError(
        `Provider job ledger line ${line} has invalid paid-submit confirmation`,
        { cause: error },
      );
    }
    try {
      validatePricingSnapshot(record.pricingSnapshot);
    } catch (error) {
      throw new ProviderConfigurationError(
        `Provider job ledger line ${line} has invalid pricing snapshot`,
        { cause: error },
      );
    }
  }
  return value as LedgerEvent;
}

function validateAttemptContext(context: AuditedAttemptContext): void {
  if (context === null || typeof context !== "object") {
    throw new ProviderConfigurationError(
      "A paid-submit confirmation is required before starting a new provider request",
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(context.stage)) {
    throw new ProviderConfigurationError("Attempt stage must be a safe identifier of at most 64 characters");
  }
  if (!Number.isSafeInteger(context.stageRevision) || context.stageRevision < 0) {
    throw new ProviderConfigurationError("Attempt stageRevision must be a non-negative safe integer");
  }
  validatePaidSubmitConfirmation(context.costConfirmation);
  validatePricingSnapshot(context.pricingSnapshot);
}

function validatePaidSubmitConfirmation(value: unknown): asserts value is PaidSubmitConfirmation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderConfigurationError(
      "A paid-submit confirmation is required before starting a new provider request",
    );
  }
  const confirmation = value as Record<string, unknown>;
  if (confirmation.confirmedBy !== "user") {
    throw new ProviderConfigurationError("Paid submit must be explicitly confirmed by the user");
  }
  if (
    typeof confirmation.confirmedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      confirmation.confirmedAt,
    ) ||
    !Number.isFinite(Date.parse(confirmation.confirmedAt))
  ) {
    throw new ProviderConfigurationError("Paid submit confirmedAt must be a valid ISO-8601 timestamp");
  }
  if (
    typeof confirmation.confirmationReference !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,255}$/.test(confirmation.confirmationReference)
  ) {
    throw new ProviderConfigurationError(
      "Paid submit confirmationReference must be a durable audit identifier",
    );
  }
  if (
    typeof confirmation.maximumCost !== "number" ||
    !Number.isFinite(confirmation.maximumCost) ||
    confirmation.maximumCost < 0
  ) {
    throw new ProviderConfigurationError("Paid submit maximumCost must be a non-negative finite number");
  }
  if (typeof confirmation.currency !== "string" || !/^[A-Z]{3}$/.test(confirmation.currency)) {
    throw new ProviderConfigurationError("Paid submit currency must be a three-letter upper-case code");
  }
  if (!["known", "unknown"].includes(String(confirmation.pricingStatus))) {
    throw new ProviderConfigurationError("Paid submit pricingStatus must be known or unknown");
  }
  if (confirmation.pricingStatus === "known") {
    if (
      typeof confirmation.estimatedCost !== "number" ||
      !Number.isFinite(confirmation.estimatedCost) ||
      confirmation.estimatedCost < 0
    ) {
      throw new ProviderConfigurationError(
        "Paid submit estimatedCost must be a non-negative finite number when known",
      );
    }
    if (confirmation.estimatedCost > confirmation.maximumCost) {
      throw new ProviderConfigurationError(
        `Estimated cost ${confirmation.estimatedCost} ${confirmation.currency} exceeds the user-approved maximum ${confirmation.maximumCost} ${confirmation.currency}`,
      );
    }
    if (confirmation.unknownPricingAcknowledged !== undefined) {
      throw new ProviderConfigurationError(
        "Known pricing confirmation must not include unknownPricingAcknowledged",
      );
    }
  } else {
    if (confirmation.unknownPricingAcknowledged !== true) {
      throw new ProviderConfigurationError(
        "Unknown pricing requires explicit unknownPricingAcknowledged=true",
      );
    }
    if (confirmation.estimatedCost !== undefined) {
      throw new ProviderConfigurationError(
        "Unknown pricing confirmation must not provide an estimatedCost",
      );
    }
  }
}

function validatePricingBinding(
  providerId: string,
  request: ProviderSubmitRequest,
  context: AuditedAttemptContext,
): void {
  const snapshot = context.pricingSnapshot;
  const confirmation = context.costConfirmation;
  if (snapshot.providerId !== providerId || snapshot.capability !== request.capability) {
    throw new ProviderConfigurationError("Pricing snapshot does not match the provider request");
  }
  if (request.model && snapshot.model !== request.model) {
    throw new ProviderConfigurationError("Pricing snapshot model does not match the provider request");
  }
  if (
    snapshot.pricingStatus !== confirmation.pricingStatus ||
    snapshot.currency !== confirmation.currency
  ) {
    throw new ProviderConfigurationError("Pricing snapshot does not match the user confirmation");
  }
  if (
    confirmation.pricingStatus === "known" &&
    snapshot.calculatedCost !== confirmation.estimatedCost
  ) {
    throw new ProviderConfigurationError(
      "Pricing snapshot calculated cost does not match the user-confirmed estimate",
    );
  }
  if (snapshot.calculatedCost !== undefined && snapshot.calculatedCost > confirmation.maximumCost) {
    throw new ProviderConfigurationError("Pricing snapshot exceeds the user-approved maximum cost");
  }
}

function validatePricingSnapshot(value: unknown): asserts value is ProviderPricingSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderConfigurationError("Provider pricing snapshot is required");
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.providerId !== "string" ||
    typeof snapshot.capability !== "string" ||
    !isProviderCapability(snapshot.capability) ||
    !["known", "unknown"].includes(String(snapshot.pricingStatus)) ||
    typeof snapshot.currency !== "string" ||
    !/^[A-Z]{3}$/.test(snapshot.currency) ||
    typeof snapshot.estimatedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.estimatedAt)) ||
    typeof snapshot.estimateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.estimateSha256)
  ) {
    throw new ProviderConfigurationError("Provider pricing snapshot has invalid fields");
  }
  if (snapshot.estimatedSeconds !== undefined &&
    (typeof snapshot.estimatedSeconds !== "number" ||
      !Number.isFinite(snapshot.estimatedSeconds) || snapshot.estimatedSeconds < 0)) {
    throw new ProviderConfigurationError("Provider estimatedSeconds must be non-negative");
  }
  if (snapshot.calculatedCost !== undefined &&
    (typeof snapshot.calculatedCost !== "number" ||
      !Number.isFinite(snapshot.calculatedCost) || snapshot.calculatedCost < 0)) {
    throw new ProviderConfigurationError("Provider calculatedCost must be non-negative");
  }
  if (snapshot.pricingStatus === "known" && snapshot.calculatedCost === undefined) {
    throw new ProviderConfigurationError("Known provider pricing requires calculatedCost");
  }
  if (snapshot.pricingStatus === "known" && snapshot.price === undefined) {
    throw new ProviderConfigurationError("Known provider pricing requires a source price");
  }
  if (snapshot.pricingStatus === "unknown" && snapshot.calculatedCost !== undefined) {
    throw new ProviderConfigurationError("Unknown provider pricing cannot contain calculatedCost");
  }
  if (snapshot.price !== undefined) {
    validateSnapshotPrice(snapshot.price);
    const price = snapshot.price;
    if (price.currency !== snapshot.currency) {
      throw new ProviderConfigurationError("Provider snapshot price currency does not match snapshot currency");
    }
  }
  if (calculatePricingSnapshotHash(value as ProviderPricingSnapshot) !== snapshot.estimateSha256) {
    throw new ProviderConfigurationError("Provider pricing snapshot hash does not match its contents");
  }
}

function validateSnapshotPrice(value: unknown): asserts value is ProviderPrice {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderConfigurationError("Provider snapshot price must be an object");
  }
  const price = value as Record<string, unknown>;
  const units = ["request", "image", "second", "minute", "character", "token", "megapixel", "custom"];
  if (
    typeof price.currency !== "string" ||
    !/^[A-Z]{3}$/.test(price.currency) ||
    typeof price.amount !== "number" ||
    !Number.isFinite(price.amount) ||
    price.amount < 0 ||
    !units.includes(String(price.unit))
  ) {
    throw new ProviderConfigurationError("Provider snapshot price has invalid fields");
  }
  if (price.minimumCharge !== undefined &&
    (typeof price.minimumCharge !== "number" ||
      !Number.isFinite(price.minimumCharge) || price.minimumCharge < 0)) {
    throw new ProviderConfigurationError("Provider snapshot minimumCharge is invalid");
  }
}

export function calculatePricingSnapshotHash(snapshot: ProviderPricingSnapshot): string {
  const payload = { ...snapshot } as unknown as Record<string, JsonValue | undefined>;
  delete payload.estimateSha256;
  return createHash("sha256")
    .update(stableJson(payload as unknown as JsonValue))
    .digest("hex");
}

function clonePricingSnapshot(snapshot: ProviderPricingSnapshot): ProviderPricingSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ProviderPricingSnapshot;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

interface LedgerLockMetadata {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
}

function isLedgerLockMetadata(value: unknown): value is LedgerLockMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.token === "string" &&
    /^[a-f0-9-]{36}$/i.test(record.token) &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt))
  );
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH" || error.code === "EINVAL") return false;
      if (error.code === "EPERM") return true;
    }
    return true;
  }
}

function positiveLockOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderConfigurationError(`${name} must be a positive safe integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function looksLikeIncompleteLedgerJson(value: string): boolean {
  const text = value.trimStart();
  const serializedPrefix = '{"schemaVersion":1,';
  if (
    !text.startsWith("{") ||
    !(serializedPrefix.startsWith(text) || text.startsWith(serializedPrefix))
  ) {
    return false;
  }
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) return false;
      continue;
    }
    if (!/[\s,:.0-9+\-eEtruefalsn]/.test(character)) return false;
  }
  return inString || escaped || stack.length > 0;
}
