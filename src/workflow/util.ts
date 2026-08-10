import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";

import { WorkflowError } from "./errors.js";

export type Clock = () => Date;
export type IdGenerator = (prefix: string) => string;

export const systemClock: Clock = () => new Date();
export const randomId: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;

const RESOLVED_CREDENTIAL_KEY =
  /(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|credential)/i;

export function versionLabel(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999) {
    throw new WorkflowError(
      "STATE_INVARIANT",
      `Revision ${String(revision)} cannot be represented as vNNN.`,
    );
  }
  return `v${revision.toString().padStart(3, "0")}`;
}

export function parseRevision(value: string | number): number {
  const normalized = typeof value === "number" ? String(value) : value.trim();
  const match = /^(?:v)?(\d{1,3})$/i.exec(normalized);
  const revision = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999) {
    throw new WorkflowError("INVALID_INPUT", `Invalid revision: ${String(value)}`);
  }
  return revision;
}

export function cleanText(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) {
    throw new WorkflowError("INVALID_INPUT", `${field} must not be empty.`);
  }
  return clean;
}

/** Prevent resolved credentials from entering task events through any transport. */
export function assertNoResolvedCredentials(value: unknown, path = "metadata"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoResolvedCredentials(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (RESOLVED_CREDENTIAL_KEY.test(key)) {
      throw new WorkflowError(
        "INVALID_INPUT",
        `Resolved credentials are forbidden in ${path}.${key}.`,
      );
    }
    assertNoResolvedCredentials(item, `${path}.${key}`);
  }
}

/** Keep useful provenance while dropping credentials and temporary signed query strings. */
export function sanitizeProvenanceUri(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function safeFileName(value: string): string {
  const normalized = basename(value)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*]/g, "-");
  const name = Array.from(normalized, (character) =>
    character.charCodeAt(0) < 32 ? "-" : character,
  )
    .join("")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return name || "artifact.bin";
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function stableJsonLine(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
