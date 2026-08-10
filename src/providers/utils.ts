import { createHash, randomUUID } from "node:crypto";
import type {
  FetchLike,
  IdGenerator,
  JsonObject,
  JsonValue,
  ProviderDescriptor,
  ProviderJobError,
  ProviderJobState,
  ProviderOutput,
} from "./types.js";
import { ProviderConfigurationError, ProviderProtocolError } from "./types.js";

const SECRET_KEY_PATTERN = /^(?:api[_-]?key|access[_-]?key|secret|token|authorization|password|credential)s?$/i;

export const uuidGenerator: IdGenerator = {
  next: () => randomUUID(),
};

export function assertSafeEnvironmentVariableName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new ProviderConfigurationError(
      `Invalid environment-variable name ${JSON.stringify(name)}; use upper-case names only`,
    );
  }
}

export function readSecretFromEnvironment(
  envName: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  assertSafeEnvironmentVariableName(envName);
  const value = environment[envName];
  if (!value) {
    throw new ProviderConfigurationError(`Required secret environment variable ${envName} is not set`);
  }
  return value;
}

/** Reject obvious inline credentials before a request can be persisted or sent. */
export function assertNoInlineSecrets(value: JsonValue, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInlineSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ProviderConfigurationError(
        `Inline secret-like field ${path}.${key} is forbidden; configure an environment-variable name instead`,
      );
    }
    assertNoInlineSecrets(child, `${path}.${key}`);
  }
}

export function descriptorSnapshot(descriptor: ProviderDescriptor): ProviderDescriptor {
  assertNoInlineSecrets(descriptor.metadata ?? {}, "descriptor.metadata");
  return JSON.parse(JSON.stringify(descriptor)) as ProviderDescriptor;
}

export function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function firstPath(value: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

export function stringAt(value: unknown, paths: readonly string[]): string | undefined {
  const candidate = firstPath(value, paths);
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : undefined;
}

export function numberAt(value: unknown, paths: readonly string[]): number | undefined {
  const candidate = firstPath(value, paths);
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && candidate.trim() !== "") {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function objectAt(value: unknown, paths: readonly string[]): Record<string, unknown> | undefined {
  const candidate = firstPath(value, paths);
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

export function normalizeState(
  rawState: unknown,
  stateMap: Readonly<Record<string, ProviderJobState>>,
  fallback: ProviderJobState = "running",
): ProviderJobState {
  if (typeof rawState !== "string") return fallback;
  return stateMap[rawState.trim().toLowerCase()] ?? fallback;
}

export function inferOutputKind(mimeType?: string, uri?: string): ProviderOutput["kind"] {
  const mime = mimeType?.toLowerCase();
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime === "application/json") return "json";
  if (mime?.startsWith("text/")) return mime.includes("subrip") ? "subtitle" : "text";
  const extension = uri?.split(/[?#]/, 1)[0]?.toLowerCase();
  if (extension?.match(/\.(png|jpe?g|webp|gif)$/)) return "image";
  if (extension?.match(/\.(mp4|webm|mov|mkv)$/)) return "video";
  if (extension?.match(/\.(mp3|wav|ogg|m4a|flac)$/)) return "audio";
  if (extension?.endsWith(".srt")) return "subtitle";
  return "other";
}

export function normalizeOutputs(raw: unknown): ProviderOutput[] {
  if (raw === undefined || raw === null) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  const outputs: ProviderOutput[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry))) {
      const uri = String(entry);
      outputs.push({ kind: inferOutputKind(undefined, uri), uri });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const uri = [record.url, record.uri, record.file_url, record.output_url].find(
      (candidate): candidate is string => typeof candidate === "string",
    );
    const mimeType = [record.mime_type, record.mimeType].find(
      (candidate): candidate is string => typeof candidate === "string",
    );
    const kindValue = typeof record.kind === "string" ? record.kind : undefined;
    const supportedKinds: ProviderOutput["kind"][] = [
      "image",
      "video",
      "audio",
      "subtitle",
      "text",
      "json",
      "other",
    ];
    const kind = supportedKinds.includes(kindValue as ProviderOutput["kind"])
      ? (kindValue as ProviderOutput["kind"])
      : inferOutputKind(mimeType, uri);
    outputs.push({ kind, ...(uri ? { uri } : {}), ...(mimeType ? { mimeType } : {}) });
  }
  return outputs;
}

export function normalizeError(
  raw: unknown,
  retryable: boolean,
  fallbackMessage = "Provider job failed",
): ProviderJobError {
  if (typeof raw === "string") {
    return { code: "provider_job_failed", message: raw, retryable };
  }
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    return {
      code: scalarString(record.code ?? record.error_code) ?? "provider_job_failed",
      message: scalarString(record.message ?? record.error_message) ?? fallbackMessage,
      retryable,
    };
  }
  return { code: "provider_job_failed", message: fallbackMessage, retryable };
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    const body = (await response.text()).slice(0, 1_024);
    throw new ProviderProtocolError(
      `Expected JSON from provider, received ${contentType || "unknown content type"}${body ? `: ${body}` : ""}`,
      { status: response.status, retryable: response.status >= 500 },
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderProtocolError("Provider returned invalid JSON", {
      status: response.status,
      retryable: response.status >= 500,
      cause: error,
    });
  }
}

export async function fetchJson(
  fetchImpl: FetchLike,
  url: string | URL,
  init: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new ProviderProtocolError("Provider request failed before a response was received", {
      retryable: true,
      cause: error,
    });
  }
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const message = stringAt(body, ["message", "error.message", "error_message"]);
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    throw new ProviderProtocolError(message ?? `Provider returned HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return { response, body };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

export function replacePathTokens(path: string, values: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new ProviderConfigurationError(`Missing route token ${key}`);
    }
    return encodeURIComponent(value);
  });
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError("Expected provider JSON object");
  }
  return value as JsonObject;
}
