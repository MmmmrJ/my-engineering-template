import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Clock,
  IdGenerator,
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
  ProviderJobError,
  ProviderModelDescriptor,
  ProviderOutput,
  ProviderPollRequest,
  ProviderSubmitRequest,
} from "./types.js";
import {
  PROVIDER_CAPABILITIES,
  ProviderConfigurationError,
  ProviderProtocolError,
  assertProviderCapability,
  systemClock,
} from "./types.js";
import { assertNoInlineSecrets, uuidGenerator } from "./utils.js";

export interface ManualProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly requestDirectory: string;
  readonly resultDirectory: string;
  readonly capabilities?: readonly ProviderCapability[];
  readonly models?: readonly ProviderModelDescriptor[];
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly dataTransfer?: ProviderDataTransferMode;
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
  /** Distinguishes platform-specific handoff packages from the generic manual adapter. */
  readonly adapter?: string;
  readonly instructions?: string;
  readonly metadata?: JsonObject;
}

export interface ManualRequestPackage {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly model?: string;
  readonly input: JsonObject;
  readonly metadata?: JsonObject;
  readonly createdAt: string;
  readonly instructions: string;
}

export interface ManualResultPackage {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly state:
    | "succeeded"
    | "failed_retryable"
    | "failed_terminal"
    | "cancelled";
  readonly outputs?: readonly ProviderOutput[];
  readonly error?: ProviderJobError;
  readonly completedAt?: string;
}

export class ManualProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #requestDirectory: string;
  readonly #resultDirectory: string;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #instructions: string;

  constructor(config: ManualProviderConfig) {
    this.#requestDirectory = resolve(config.requestDirectory);
    this.#resultDirectory = resolve(config.resultDirectory);
    this.#clock = config.clock ?? systemClock;
    this.#ids = config.ids ?? uuidGenerator;
    this.#instructions =
      config.instructions ??
      "Complete this request outside the workflow, then place a matching *.result.json package in the configured result directory.";
    this.descriptor = {
      id: config.id ?? "manual",
      displayName: config.displayName ?? "Manual Import",
      adapter: config.adapter ?? "manual",
      capabilities: config.capabilities ?? PROVIDER_CAPABILITIES,
      ...(config.models ? { models: config.models } : {}),
      dataTransfer: config.dataTransfer ?? "user-managed",
      ...(config.termsUrl ? { termsUrl: config.termsUrl } : {}),
      ...(config.privacyUrl ? { privacyUrl: config.privacyUrl } : {}),
      metadata: {
        manualPackage: true,
        requestDirectory: this.#requestDirectory,
        resultDirectory: this.#resultDirectory,
        ...(config.metadata ?? {}),
      },
    };
  }

  capabilities(): Promise<readonly ProviderCapability[]> {
    return Promise.resolve([...this.descriptor.capabilities]);
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = this.#clock.now().toISOString();
    try {
      await Promise.all([
        mkdir(this.#requestDirectory, { recursive: true }),
        mkdir(this.#resultDirectory, { recursive: true }),
      ]);
      await Promise.all([
        access(this.#requestDirectory, fsConstants.R_OK | fsConstants.W_OK),
        access(this.#resultDirectory, fsConstants.R_OK | fsConstants.W_OK),
      ]);
      return { providerId: this.descriptor.id, status: "healthy", checkedAt };
    } catch (error) {
      return {
        providerId: this.descriptor.id,
        status: "unavailable",
        checkedAt,
        message: error instanceof Error ? error.message : "Manual package directories are unavailable",
      };
    }
  }

  estimate(request: ProviderEstimateRequest): Promise<ProviderEstimate> {
    assertProviderCapability(this.descriptor, request.capability);
    return Promise.resolve({
      providerId: this.descriptor.id,
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      notes: ["Manual work is not priced or timed automatically"],
    });
  }

  async submit(request: ProviderSubmitRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertNoInlineSecrets(request.input);
    if (request.metadata) assertNoInlineSecrets(request.metadata, "metadata");
    await Promise.all([
      mkdir(this.#requestDirectory, { recursive: true }),
      mkdir(this.#resultDirectory, { recursive: true }),
    ]);
    const remoteJobId = this.#ids.next();
    assertSafeJobId(remoteJobId);
    const now = this.#clock.now().toISOString();
    const requestPackage: ManualRequestPackage = {
      schemaVersion: 1,
      jobId: remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      ...(request.model ? { model: request.model } : {}),
      input: request.input,
      ...(request.metadata ? { metadata: request.metadata } : {}),
      createdAt: now,
      instructions: this.#instructions,
    };
    await writeFile(this.requestPath(remoteJobId), `${JSON.stringify(requestPackage, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return {
      id: `${this.descriptor.id}:${remoteJobId}`,
      remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      state: "queued",
      ...(request.model ? { model: request.model } : {}),
      submittedAt: now,
      updatedAt: now,
      metadata: { requestPackagePath: this.requestPath(remoteJobId) },
    };
  }

  async poll(request: ProviderPollRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertSafeJobId(request.remoteJobId);
    const requestPackage = await this.#readRequestPackage(request.remoteJobId);
    const now = this.#clock.now().toISOString();
    let result: ManualResultPackage;
    try {
      result = validateResultPackage(
        JSON.parse(await readFile(this.resultPath(request.remoteJobId), "utf8")) as unknown,
        request.remoteJobId,
      );
    } catch (error) {
      if (isMissingFile(error)) {
        return this.#job(request, requestPackage.createdAt, now, "queued");
      }
      throw error;
    }
    return this.#job(
      request,
      requestPackage.createdAt,
      result.completedAt ?? now,
      result.state,
      result.outputs,
      result.error,
    );
  }

  async cancel(request: ProviderCancelRequest): Promise<ProviderJob> {
    assertProviderCapability(this.descriptor, request.capability);
    assertSafeJobId(request.remoteJobId);
    const requestPackage = await this.#readRequestPackage(request.remoteJobId);
    const now = this.#clock.now().toISOString();
    const result: ManualResultPackage = {
      schemaVersion: 1,
      jobId: request.remoteJobId,
      state: "cancelled",
      completedAt: now,
    };
    try {
      await this.importResult(result);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return this.poll(request);
    }
    return this.#job(request, requestPackage.createdAt, now, "cancelled");
  }

  /** Import a human-produced result without allowing arbitrary destination paths. */
  async importResult(result: ManualResultPackage): Promise<string> {
    const normalized = validateResultPackage(result, result.jobId);
    assertSafeJobId(normalized.jobId);
    await mkdir(this.#resultDirectory, { recursive: true });
    const path = this.resultPath(normalized.jobId);
    await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return path;
  }

  requestPath(jobId: string): string {
    assertSafeJobId(jobId);
    return resolve(this.#requestDirectory, `${jobId}.request.json`);
  }

  resultPath(jobId: string): string {
    assertSafeJobId(jobId);
    return resolve(this.#resultDirectory, `${jobId}.result.json`);
  }

  async #readRequestPackage(jobId: string): Promise<ManualRequestPackage> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.requestPath(jobId), "utf8")) as unknown;
    } catch (error) {
      if (isMissingFile(error)) {
        throw new ProviderConfigurationError(`Unknown manual job ${jobId}`);
      }
      throw new ProviderProtocolError(`Could not read manual request package for ${jobId}`, {
        cause: error,
      });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderProtocolError(`Manual request package for ${jobId} is invalid`);
    }
    const record = value as Record<string, unknown>;
    if (record.jobId !== jobId || typeof record.createdAt !== "string") {
      throw new ProviderProtocolError(`Manual request package for ${jobId} has mismatched fields`);
    }
    return value as ManualRequestPackage;
  }

  #job(
    request: ProviderPollRequest,
    submittedAt: string,
    updatedAt: string,
    state: ProviderJob["state"],
    outputs?: readonly ProviderOutput[],
    error?: ProviderJobError,
  ): ProviderJob {
    return {
      id: `${this.descriptor.id}:${request.remoteJobId}`,
      remoteJobId: request.remoteJobId,
      providerId: this.descriptor.id,
      capability: request.capability,
      state,
      ...(request.model ? { model: request.model } : {}),
      submittedAt,
      updatedAt,
      ...(outputs?.length ? { outputs } : {}),
      ...(error ? { error } : {}),
      metadata: {
        requestPackagePath: this.requestPath(request.remoteJobId),
        resultPackagePath: this.resultPath(request.remoteJobId),
      },
    };
  }
}

function validateResultPackage(value: unknown, expectedJobId: string): ManualResultPackage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError("Manual result package must be a JSON object");
  }
  const result = value as Partial<ManualResultPackage>;
  if (result.schemaVersion !== 1) {
    throw new ProviderProtocolError("Manual result package schemaVersion must be 1");
  }
  if (result.jobId !== expectedJobId) {
    throw new ProviderProtocolError("Manual result package jobId does not match the requested job");
  }
  const states = ["succeeded", "failed_retryable", "failed_terminal", "cancelled"];
  if (!result.state || !states.includes(result.state)) {
    throw new ProviderProtocolError("Manual result package has an invalid terminal state");
  }
  if (result.state === "succeeded" && !result.outputs?.length) {
    throw new ProviderProtocolError("Successful manual result package must include outputs");
  }
  if (result.state.startsWith("failed") && !result.error) {
    throw new ProviderProtocolError("Failed manual result package must include an error");
  }
  if (result.error && result.error.retryable !== (result.state === "failed_retryable")) {
    throw new ProviderProtocolError("Manual result error.retryable does not match its state");
  }
  return result as ManualResultPackage;
}

function assertSafeJobId(jobId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(jobId)) {
    throw new ProviderConfigurationError(`Unsafe manual job id ${JSON.stringify(jobId)}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
