import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { isIP } from "node:net";
import type { FetchLike, ProviderOutput } from "./types.js";
import { ProviderConfigurationError, ProviderProtocolError } from "./types.js";

export interface SafeDownloadRequest {
  readonly url: string;
  readonly destinationRoot: string;
  readonly relativePath: string;
  readonly archiveRoot: string;
  readonly allowedMimeTypes: readonly string[];
  readonly maxBytes: number;
  readonly expectedSha256?: string;
  /** Choose the final file extension from the verified response MIME type. */
  readonly deriveExtensionFromMime?: boolean;
  readonly allowHttp?: boolean;
  readonly allowPrivateHosts?: boolean;
  /** Optional exact origin allowlist, primarily for explicitly trusted local providers. */
  readonly allowedOrigins?: readonly string[];
  readonly maxRedirects?: number;
  readonly fetch?: FetchLike;
}

export interface ArchivedDownload extends ProviderOutput {
  readonly localPath: string;
  readonly archivedPath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sourceUrl: string;
}

export interface SafeLocalArchiveRequest {
  readonly sourcePath: string;
  readonly destinationRoot: string;
  readonly relativePath: string;
  readonly archiveRoot: string;
  readonly kind: ProviderOutput["kind"];
  readonly allowedMimeTypes: readonly string[];
  readonly maxBytes: number;
  readonly expectedSha256?: string;
}

/** Copies a user-exported local result into task scope after size, signature, kind and hash checks. */
export async function archiveLocalFile(request: SafeLocalArchiveRequest): Promise<ArchivedDownload> {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
    throw new ProviderConfigurationError("Local archive maxBytes must be a positive safe integer");
  }
  if (!request.allowedMimeTypes.length) {
    throw new ProviderConfigurationError("Local archive needs at least one allowed MIME type");
  }
  if (request.expectedSha256 && !/^[a-fA-F0-9]{64}$/.test(request.expectedSha256)) {
    throw new ProviderConfigurationError("expectedSha256 must contain exactly 64 hexadecimal characters");
  }
  if (extname(request.relativePath)) {
    throw new ProviderConfigurationError("Local archive relativePath must not include an extension");
  }
  const sourcePath = resolve(request.sourcePath);
  const details = await stat(sourcePath);
  if (!details.isFile() || details.size <= 0) {
    throw new ProviderProtocolError("Manual result source must be a non-empty file");
  }
  if (details.size > request.maxBytes) {
    throw new ProviderProtocolError(
      `Manual result contains ${details.size} bytes, exceeding the ${request.maxBytes}-byte limit`,
    );
  }
  const signature = Buffer.alloc(32);
  const handle = await open(sourcePath, "r");
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(signature, 0, signature.length, 0));
  } finally {
    await handle.close();
  }
  const detectedMime = detectMimeType(signature.subarray(0, bytesRead));
  const extensionMime = mimeTypeForExtension(extname(sourcePath));
  const mimeType =
    detectedMime === "video/mp4" && extensionMime === "audio/mp4"
      ? "audio/mp4"
      : detectedMime ?? extensionMime;
  if (!mimeType || !mimeAllowed(mimeType, request.allowedMimeTypes)) {
    throw new ProviderProtocolError(
      `Manual result MIME ${mimeType ?? "unknown"} is not allowed for ${request.kind}`,
    );
  }
  if (detectedMime && extensionMime && !mimeTypesEquivalent(detectedMime, extensionMime)) {
    throw new ProviderProtocolError(
      `Manual result signature ${detectedMime} does not match file extension ${extname(sourcePath)}`,
    );
  }
  const detectedKind = inferKind(mimeType);
  if (request.kind !== detectedKind && !(request.kind === "subtitle" && detectedKind === "text")) {
    throw new ProviderProtocolError(
      `Manual result kind ${request.kind} does not match detected kind ${detectedKind}`,
    );
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(sourcePath)) digest.update(chunk as Buffer);
  const sha256 = digest.digest("hex");
  if (request.expectedSha256 && !hashesEqual(sha256, request.expectedSha256)) {
    throw new ProviderProtocolError("Manual result SHA-256 does not match expectedSha256");
  }
  const extension = extensionForLocalFile(extname(sourcePath), mimeType, request.kind);
  const destinationPath = safeChildPath(request.destinationRoot, `${request.relativePath}${extension}`);
  const archiveRoot = resolve(request.archiveRoot);
  const archivePath = safeChildPath(archiveRoot, `${sha256.slice(0, 2)}/${sha256}${extension}`);
  await mkdir(resolve(destinationPath, ".."), { recursive: true });
  await mkdir(resolve(archivePath, ".."), { recursive: true });
  await copyWithVerifiedExisting(sourcePath, archivePath, sha256);
  await copyWithVerifiedExisting(archivePath, destinationPath, sha256);
  return {
    kind: request.kind,
    uri: sourcePath,
    sourceUrl: sourcePath,
    localPath: destinationPath,
    archivedPath: archivePath,
    mimeType,
    sizeBytes: details.size,
    sha256,
  };
}

/**
 * Downloads a bounded response, verifies its declared MIME/signature/hash, then
 * writes both a content-addressed archive copy and the requested local copy.
 */
export async function downloadAndArchive(request: SafeDownloadRequest): Promise<ArchivedDownload> {
  validateDownloadPolicy(request);
  if (request.deriveExtensionFromMime && extname(request.relativePath)) {
    throw new ProviderConfigurationError(
      "Download relativePath must not include an extension when deriveExtensionFromMime is enabled",
    );
  }
  safeChildPath(request.destinationRoot, request.relativePath);
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const response = await fetchFollowingSafeRedirects(fetchImpl, request);
  if (!response.ok) {
    throw new ProviderProtocolError(`Asset download returned HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }

  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > request.maxBytes) {
    throw new ProviderProtocolError(
      `Asset declares ${declaredLength} bytes, exceeding the ${request.maxBytes}-byte limit`,
    );
  }
  const mimeType = normalizeMimeType(response.headers.get("content-type"));
  if (!mimeType || !mimeAllowed(mimeType, request.allowedMimeTypes)) {
    throw new ProviderProtocolError(
      `Asset MIME type ${mimeType ?? "missing"} is not allowed (${request.allowedMimeTypes.join(", ")})`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > request.maxBytes) {
    throw new ProviderProtocolError(
      `Asset contains ${bytes.byteLength} bytes, exceeding the ${request.maxBytes}-byte limit`,
    );
  }
  const detectedMime = detectMimeType(bytes);
  if (detectedMime && !mimeTypesEquivalent(mimeType, detectedMime)) {
    throw new ProviderProtocolError(
      `Asset signature is ${detectedMime}, which does not match declared MIME ${mimeType}`,
    );
  }
  const extension = request.deriveExtensionFromMime
    ? extensionForMimeType(mimeType)
    : safeExtension(extname(request.relativePath));
  const destinationPath = safeChildPath(
    request.destinationRoot,
    request.deriveExtensionFromMime ? `${request.relativePath}${extension}` : request.relativePath,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (request.expectedSha256 && !hashesEqual(digest, request.expectedSha256)) {
    throw new ProviderProtocolError(
      `Asset SHA-256 mismatch: expected ${request.expectedSha256.toLowerCase()}, received ${digest}`,
    );
  }

  const archiveRoot = resolve(request.archiveRoot);
  const archivePath = safeChildPath(archiveRoot, `${digest.slice(0, 2)}/${digest}${extension}`);
  await mkdir(resolve(archivePath, ".."), { recursive: true });
  await mkdir(resolve(destinationPath, ".."), { recursive: true });

  const archiveTemp = `${archivePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(archiveTemp, bytes, { flag: "wx" });
    try {
      await rename(archiveTemp, archivePath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await unlink(archiveTemp).catch(() => undefined);
    }
    const destinationTemp = `${destinationPath}.${randomUUID()}.tmp`;
    try {
      await copyFile(archivePath, destinationTemp);
      await rename(destinationTemp, destinationPath);
    } catch (error) {
      await unlink(destinationTemp).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await unlink(archiveTemp).catch(() => undefined);
    throw error;
  }

  return {
    kind: inferKind(mimeType),
    uri: response.url || request.url,
    sourceUrl: request.url,
    localPath: destinationPath,
    archivedPath: archivePath,
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256: digest,
  };
}

export function safeChildPath(root: string, child: string): string {
  if (!child || isAbsolute(child)) {
    throw new ProviderConfigurationError("Download relativePath must be a non-empty relative path");
  }
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const relation = relative(resolvedRoot, resolvedChild);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new ProviderConfigurationError("Download path escapes its configured root");
  }
  return resolvedChild;
}

export function detectMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) {
    return "audio/mpeg";
  }
  if (ascii(bytes, 4, 4) === "ftyp") return "video/mp4";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return undefined;
}

async function fetchFollowingSafeRedirects(
  fetchImpl: FetchLike,
  request: SafeDownloadRequest,
): Promise<Response> {
  let current = new URL(request.url);
  const maxRedirects = request.maxRedirects ?? 3;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    validateAssetUrl(current, request.allowHttp ?? false, request.allowPrivateHosts ?? false);
    if (request.allowedOrigins && !request.allowedOrigins.includes(current.origin)) {
      throw new ProviderConfigurationError(
        `Asset origin ${current.origin} is outside the configured origin allowlist`,
      );
    }
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: request.allowedMimeTypes.join(", ") },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new ProviderProtocolError("Asset redirect omitted the Location header");
    if (redirectCount === maxRedirects) {
      throw new ProviderProtocolError(`Asset exceeded the ${maxRedirects}-redirect limit`);
    }
    current = new URL(location, current);
  }
  throw new ProviderProtocolError("Asset redirect loop exceeded its limit");
}

function validateAssetUrl(url: URL, allowHttp: boolean, allowPrivateHosts: boolean): void {
  if (url.username || url.password) {
    throw new ProviderConfigurationError("Asset URLs must not contain inline credentials");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ProviderConfigurationError("Asset URLs must use HTTPS unless HTTP is explicitly allowed");
  }
  if (!allowPrivateHosts && isPrivateHostLiteral(url.hostname)) {
    throw new ProviderConfigurationError(`Asset host ${url.hostname} is private or local`);
  }
}

function isPrivateHostLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  if (family === 6) {
    return host === "::" || host === "::1" || host.startsWith("fe8") || host.startsWith("fe9") ||
      host.startsWith("fea") || host.startsWith("feb") || host.startsWith("fc") || host.startsWith("fd");
  }
  return false;
}

function validateDownloadPolicy(request: SafeDownloadRequest): void {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
    throw new ProviderConfigurationError("Download maxBytes must be a positive safe integer");
  }
  if (!request.allowedMimeTypes.length) {
    throw new ProviderConfigurationError("At least one allowed MIME type is required");
  }
  if (request.expectedSha256 && !/^[a-fA-F0-9]{64}$/.test(request.expectedSha256)) {
    throw new ProviderConfigurationError("expectedSha256 must contain exactly 64 hexadecimal characters");
  }
  if (!Number.isSafeInteger(request.maxRedirects ?? 3) || (request.maxRedirects ?? 3) < 0) {
    throw new ProviderConfigurationError("maxRedirects must be a non-negative safe integer");
  }
  for (const origin of request.allowedOrigins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch (error) {
      throw new ProviderConfigurationError(`Invalid allowed download origin ${JSON.stringify(origin)}`, {
        cause: error,
      });
    }
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new ProviderConfigurationError(
        `Allowed download origin must be an exact HTTP(S) origin: ${JSON.stringify(origin)}`,
      );
    }
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new ProviderProtocolError("Asset Content-Length is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ProviderProtocolError("Asset Content-Length is unsafe");
  return parsed;
}

function normalizeMimeType(value: string | null): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function mimeAllowed(mimeType: string, allowed: readonly string[]): boolean {
  return allowed.some((pattern) => {
    const normalized = pattern.toLowerCase();
    return normalized === mimeType ||
      (normalized.endsWith("/*") && mimeType.startsWith(normalized.slice(0, -1)));
  });
}

function mimeTypesEquivalent(left: string, right: string): boolean {
  const aliases: Readonly<Record<string, string>> = {
    "image/jpg": "image/jpeg",
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "video/quicktime": "video/mp4",
  };
  return (aliases[left] ?? left) === (aliases[right] ?? right);
}

function hashesEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function safeExtension(value: string): string {
  return /^\.[a-zA-Z0-9]{1,10}$/.test(value) ? value.toLowerCase() : "";
}

function extensionForMimeType(mimeType: string): string {
  const extensions: Readonly<Record<string, string>> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "application/x-subrip": ".srt",
    "application/json": ".json",
    "application/octet-stream": ".bin",
    "text/plain": ".txt",
  };
  const extension = extensions[mimeType];
  if (!extension) {
    throw new ProviderProtocolError(
      `No safe file extension is configured for verified MIME type ${mimeType}`,
    );
  }
  return extension;
}

function mimeTypeForExtension(extension: string): string | undefined {
  const mimeTypes: Readonly<Record<string, string>> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".srt": "application/x-subrip",
    ".ass": "text/plain",
    ".txt": "text/plain",
    ".md": "text/plain",
    ".json": "application/json",
  };
  return mimeTypes[extension.toLowerCase()];
}

function extensionForLocalFile(
  sourceExtension: string,
  mimeType: string,
  kind: ProviderOutput["kind"],
): string {
  const extension = sourceExtension.toLowerCase();
  if (kind === "subtitle" && (extension === ".srt" || extension === ".ass")) return extension;
  if (kind === "text" && (extension === ".txt" || extension === ".md")) return extension;
  return extensionForMimeType(mimeType);
}

async function copyWithVerifiedExisting(
  source: string,
  destination: string,
  expectedSha256: string,
): Promise<void> {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if ((await hashLocalFile(destination)) !== expectedSha256) {
      throw new ProviderProtocolError(`Existing archived manual result differs: ${destination}`);
    }
  }
}

async function hashLocalFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function inferKind(mimeType: string): ArchivedDownload["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/json") return "json";
  if (mimeType.startsWith("text/")) return "text";
  return "other";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
