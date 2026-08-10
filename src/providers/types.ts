export const PROVIDER_CAPABILITIES = [
  "image.generate",
  "image.edit",
  "video.i2v",
  "video.r2v",
  "video.t2v",
  "audio.tts",
  "audio.music",
  "audio.sfx",
  "speech.transcribe",
  "render.timeline",
  "quality.inspect",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const PROVIDER_JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "cancelled",
] as const;

export type ProviderJobState = (typeof PROVIDER_JOB_STATES)[number];

export const PROVIDER_DATA_TRANSFER_MODES = [
  "user-managed",
  "local-only",
  "local-or-configured-remote",
  "external-cloud",
] as const;

/** Known modes are exported above; custom deployments may use a short description. */
export type ProviderDataTransferMode = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type PriceUnit =
  | "request"
  | "image"
  | "second"
  | "minute"
  | "character"
  | "token"
  | "megapixel"
  | "custom";

export interface ProviderPrice {
  readonly currency: string;
  readonly amount: number;
  readonly unit: PriceUnit;
  readonly unitLabel?: string;
  readonly minimumCharge?: number;
}

export interface ProviderModelDescriptor {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly regions?: readonly string[];
  readonly price?: ProviderPrice;
  readonly metadata?: JsonObject;
}

/**
 * A JSON-safe descriptor. `secretEnvVars` contains environment-variable names,
 * never resolved values, so descriptors may be persisted safely.
 */
export interface ProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly adapter: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly models?: readonly ProviderModelDescriptor[];
  readonly regions?: readonly string[];
  readonly price?: ProviderPrice;
  readonly secretEnvVars?: readonly string[];
  readonly optional?: boolean;
  readonly fallbackProviderIds?: readonly string[];
  readonly dataTransfer?: ProviderDataTransferMode;
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
  readonly metadata?: JsonObject;
}

export interface ProviderHealth {
  readonly providerId: string;
  readonly status: "healthy" | "degraded" | "unavailable" | "unconfigured";
  readonly checkedAt: string;
  readonly latencyMs?: number;
  readonly message?: string;
  readonly details?: JsonObject;
}

export interface ProviderEstimateRequest {
  readonly capability: ProviderCapability;
  readonly model?: string;
  readonly input: JsonObject;
  readonly region?: string;
}

export interface ProviderEstimate {
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly model?: string;
  readonly price?: ProviderPrice;
  readonly estimatedSeconds?: number;
  readonly notes?: readonly string[];
}

export interface ProviderSubmitRequest {
  readonly capability: ProviderCapability;
  readonly model?: string;
  readonly input: JsonObject;
  readonly region?: string;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

export interface ProviderOutput {
  readonly kind: "image" | "video" | "audio" | "subtitle" | "text" | "json" | "other";
  readonly uri?: string;
  readonly localPath?: string;
  readonly archivedPath?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly metadata?: JsonObject;
}

export interface ProviderJobError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

/**
 * The persistable job projection deliberately excludes request headers,
 * credentials, and provider response bodies.
 */
export interface ProviderJob {
  readonly id: string;
  readonly remoteJobId: string;
  readonly providerId: string;
  readonly capability: ProviderCapability;
  readonly state: ProviderJobState;
  readonly model?: string;
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly progress?: number;
  readonly outputs?: readonly ProviderOutput[];
  readonly error?: ProviderJobError;
  readonly retryAfterMs?: number;
  readonly metadata?: JsonObject;
}

export interface ProviderPollRequest {
  readonly remoteJobId: string;
  readonly capability: ProviderCapability;
  readonly model?: string;
}

export type ProviderCancelRequest = ProviderPollRequest;

export interface ProviderWebhookRequest {
  /** Lower-cased transport headers; resolved secrets must never be persisted. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly receivedAt: string;
}

export interface ProviderWebhookVerification {
  readonly verified: boolean;
  readonly eventId?: string;
  readonly remoteJobId?: string;
  readonly capability?: ProviderCapability;
  readonly state?: ProviderJobState;
  readonly payloadSha256?: string;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  capabilities(): Promise<readonly ProviderCapability[]>;
  health(): Promise<ProviderHealth>;
  estimate(request: ProviderEstimateRequest): Promise<ProviderEstimate>;
  submit(request: ProviderSubmitRequest): Promise<ProviderJob>;
  poll(request: ProviderPollRequest): Promise<ProviderJob>;
  cancel?(request: ProviderCancelRequest): Promise<ProviderJob>;
  verifyWebhook?(request: ProviderWebhookRequest): Promise<ProviderWebhookVerification>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function isProviderCapability(value: string): value is ProviderCapability {
  return (PROVIDER_CAPABILITIES as readonly string[]).includes(value);
}

export function isTerminalProviderJobState(state: ProviderJobState): boolean {
  return state === "succeeded" || state === "failed_terminal" || state === "cancelled";
}

export function assertProviderCapability(
  descriptor: ProviderDescriptor,
  capability: ProviderCapability,
): void {
  if (!descriptor.capabilities.includes(capability)) {
    throw new ProviderConfigurationError(
      `Provider ${descriptor.id} does not support capability ${capability}`,
    );
  }
}

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = options.code ?? "provider_error";
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ProviderConfigurationError extends ProviderError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: "provider_configuration", retryable: false, cause: options.cause });
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderProtocolError extends ProviderError {
  constructor(
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code: "provider_protocol",
      retryable: options.retryable ?? false,
      status: options.status,
      retryAfterMs: options.retryAfterMs,
      cause: options.cause,
    });
    this.name = "ProviderProtocolError";
  }
}
