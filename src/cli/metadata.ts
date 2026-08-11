import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";

import type {
  AiLabelRecord,
  ImportArtifactInput,
  ProviderArtifactMetadata,
  RightsRecord,
  StageContract,
  VoiceCloneConsentRecord,
} from "../contracts/index.js";
import { isProviderCapability, stageContractSchema } from "../contracts/index.js";
import { WorkflowError } from "../workflow/errors.js";
import { assertNoResolvedCredentials, sha256Text } from "../workflow/util.js";

export interface ImportMetadata {
  stageContract?: StageContract;
  rights?: RightsRecord;
  fileRights?: Readonly<Record<string, RightsRecord>>;
  fileNames?: Readonly<Record<string, string>>;
  provider?: ProviderArtifactMetadata;
  aiLabel?: AiLabelRecord;
  voiceCloneConsent?: VoiceCloneConsentRecord;
  mediaType?: string;
  summary?: string;
  targetIds?: readonly string[];
  dependsOnIds?: readonly string[];
  fileScopes?: ImportArtifactInput["fileScopes"];
  metadata?: Readonly<Record<string, unknown>>;
}

export async function readImportMetadata(
  reference: string | undefined,
  cwd: string,
): Promise<ImportMetadata> {
  if (!reference) return {};
  const path = resolve(cwd, reference.startsWith("@") ? reference.slice(1) : reference);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new WorkflowError(
      "INVALID_INPUT",
      `Could not parse import metadata ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = asRecord(value, "metadata document");
  assertNoResolvedCredentials(record);

  return {
    ...(record.stageContract !== undefined
      ? { stageContract: parseStageContract(record.stageContract) }
      : {}),
    ...(record.rights !== undefined ? { rights: parseRights(record.rights) } : {}),
    ...(record.fileRights !== undefined
      ? { fileRights: parseFileRights(record.fileRights) }
      : {}),
    ...(record.fileNames !== undefined ? { fileNames: parseFileNames(record.fileNames) } : {}),
    ...(record.provider ? { provider: parseProvider(record.provider) } : {}),
    ...(record.aiLabel ? { aiLabel: parseAiLabel(record.aiLabel) } : {}),
    ...(record.voiceCloneConsent
      ? { voiceCloneConsent: parseVoiceConsent(record.voiceCloneConsent) }
      : {}),
    ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    ...(record.targetIds ? { targetIds: stringArray(record.targetIds, "targetIds") } : {}),
    ...(record.dependsOnIds
      ? { dependsOnIds: stringArray(record.dependsOnIds, "dependsOnIds") }
      : {}),
    ...(record.fileScopes ? { fileScopes: parseFileScopes(record.fileScopes) } : {}),
    ...(record.metadata ? { metadata: asRecord(record.metadata, "metadata.metadata") } : {}),
  };
}

export function importMetadataToInput(
  metadata: ImportMetadata,
): Partial<Pick<
  ImportArtifactInput,
  | "rights"
  | "fileRights"
  | "fileNames"
  | "stageContract"
  | "provider"
  | "aiLabel"
  | "voiceCloneConsent"
  | "mediaType"
  | "summary"
  | "targetIds"
  | "dependsOnIds"
  | "fileScopes"
  | "metadata"
>> {
  return metadata;
}

function parseStageContract(value: unknown): StageContract {
  const parsed = stageContractSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkflowError(
      "STAGE_CONTRACT_INVALID",
      `metadata.stageContract is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function parseRights(value: unknown): RightsRecord {
  const record = asRecord(value, "rights");
  if (record.basis === "original") {
    assertExactFields(record, ["basis", "creator", "declaration", "evidence"], "rights");
    return {
      basis: "original",
      creator: stringField(record, "creator", "rights"),
      declaration: stringField(record, "declaration", "rights"),
      ...(record.evidence !== undefined
        ? { evidence: stringField(record, "evidence", "rights") }
        : {}),
    };
  }
  if (record.basis === "public-domain") {
    assertExactFields(
      record,
      [
        "basis",
        "source",
        "evidence",
        "jurisdiction",
        "authorOrPublicationFacts",
        "legalBasis",
        "verifiedAt",
      ],
      "rights",
    );
    return {
      basis: "public-domain",
      source: stringField(record, "source", "rights"),
      evidence: stringField(record, "evidence", "rights"),
      jurisdiction: stringField(record, "jurisdiction", "rights"),
      authorOrPublicationFacts: stringField(
        record,
        "authorOrPublicationFacts",
        "rights",
      ),
      legalBasis: stringField(record, "legalBasis", "rights"),
      verifiedAt: isoInstantField(record, "verifiedAt", "rights"),
    };
  }
  if (record.basis === "licensed") {
    assertExactFields(
      record,
      ["basis", "work", "rightsHolder", "license", "evidence", "scope", "verifiedAt"],
      "rights",
    );
    return {
      basis: "licensed",
      work: stringField(record, "work", "rights"),
      rightsHolder: stringField(record, "rightsHolder", "rights"),
      license: stringField(record, "license", "rights"),
      evidence: stringField(record, "evidence", "rights"),
      scope: stringField(record, "scope", "rights"),
      verifiedAt: isoInstantField(record, "verifiedAt", "rights"),
    };
  }
  if (record.basis === "provider-terms") {
    assertExactFields(
      record,
      [
        "basis",
        "providerId",
        "termsUrl",
        "termsReviewedAt",
        "commercialUseConfirmed",
        "thirdPartyInputsCleared",
      ],
      "rights",
    );
    const termsUrl = httpsUrlField(record, "termsUrl", "rights");
    if (record.commercialUseConfirmed !== true || record.thirdPartyInputsCleared !== true) {
      throw new WorkflowError(
        "INVALID_INPUT",
        "rights provider-terms confirmations must both be true.",
      );
    }
    return {
      basis: "provider-terms",
      providerId: stringField(record, "providerId", "rights"),
      termsUrl,
      termsReviewedAt: isoInstantField(record, "termsReviewedAt", "rights"),
      commercialUseConfirmed: true,
      thirdPartyInputsCleared: true,
    };
  }
  if (record.basis === "workflow-derived") {
    assertExactFields(record, ["basis", "sourceArtifactIds", "declaration"], "rights");
    const sourceArtifactIds = stringArray(record.sourceArtifactIds, "rights.sourceArtifactIds");
    if (sourceArtifactIds.length === 0) {
      throw new WorkflowError(
        "INVALID_INPUT",
        "rights.sourceArtifactIds must contain at least one artifact ID.",
      );
    }
    return {
      basis: "workflow-derived",
      sourceArtifactIds,
      declaration: stringField(record, "declaration", "rights"),
    };
  }
  throw new WorkflowError(
    "INVALID_INPUT",
    "rights.basis must be original, public-domain, licensed, provider-terms, or workflow-derived.",
  );
}

function parseFileRights(value: unknown): Readonly<Record<string, RightsRecord>> {
  const record = asRecord(value, "fileRights");
  const parsed: Record<string, RightsRecord> = {};
  for (const [file, rights] of Object.entries(record)) {
    if (!file.trim()) {
      throw new WorkflowError("INVALID_INPUT", "fileRights keys must be non-empty file paths or basenames.");
    }
    parsed[file] = parseRights(rights);
  }
  return parsed;
}

function parseFileNames(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value, "fileNames");
  const parsed: Record<string, string> = {};
  for (const [file, logicalName] of Object.entries(record)) {
    if (!file.trim() || typeof logicalName !== "string" || !logicalName.trim()) {
      throw new WorkflowError(
        "INVALID_INPUT",
        "fileNames must map non-empty source paths or basenames to non-empty filenames.",
      );
    }
    parsed[file] = logicalName.trim();
  }
  return parsed;
}

function parseProvider(value: unknown): ProviderArtifactMetadata {
  const record = asRecord(value, "provider");
  const capability = stringField(record, "capability", "provider");
  if (!isProviderCapability(capability)) {
    throw new WorkflowError("INVALID_INPUT", `Unknown provider capability: ${capability}`);
  }
  const promptHash =
    typeof record.promptHash === "string"
      ? record.promptHash
      : typeof record.prompt === "string"
        ? sha256Text(record.prompt)
        : undefined;
  const cost = record.cost ? asRecord(record.cost, "provider.cost") : undefined;
  return {
    providerId: stringField(record, "providerId", "provider"),
    capability,
    ...(typeof record.attemptId === "string" ? { attemptId: record.attemptId } : {}),
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(typeof record.seed === "string" || typeof record.seed === "number"
      ? { seed: record.seed }
      : {}),
    ...(cost
      ? {
          cost: {
            amount: numberField(cost, "amount", "provider.cost"),
            currency: stringField(cost, "currency", "provider.cost"),
          },
        }
      : {}),
    ...(typeof record.sourceUri === "string" ? { sourceUri: record.sourceUri } : {}),
  };
}

function parseAiLabel(value: unknown): AiLabelRecord {
  const record = asRecord(value, "aiLabel");
  return {
    aiGenerated: booleanField(record, "aiGenerated", "aiLabel"),
    label: stringField(record, "label", "aiLabel"),
    visibleLabel: booleanField(record, "visibleLabel", "aiLabel"),
    metadataEmbedded: booleanField(record, "metadataEmbedded", "aiLabel"),
    provenanceIncluded: booleanField(record, "provenanceIncluded", "aiLabel"),
    method: stringField(record, "method", "aiLabel"),
    ...(typeof record.disclosure === "string" ? { disclosure: record.disclosure } : {}),
  };
}

function parseVoiceConsent(value: unknown): VoiceCloneConsentRecord {
  const record = asRecord(value, "voiceCloneConsent");
  if (record.enabled !== true) {
    throw new WorkflowError("INVALID_INPUT", "voiceCloneConsent.enabled must be true.");
  }
  return {
    enabled: true,
    subject: stringField(record, "subject", "voiceCloneConsent"),
    evidence: stringField(record, "evidence", "voiceCloneConsent"),
    scope: stringField(record, "scope", "voiceCloneConsent"),
    grantedAt: stringField(record, "grantedAt", "voiceCloneConsent"),
    userConfirmedAt: stringField(record, "userConfirmedAt", "voiceCloneConsent"),
    confirmation: stringField(record, "confirmation", "voiceCloneConsent"),
    ...(typeof record.reviewEventId === "string"
      ? { reviewEventId: record.reviewEventId }
      : {}),
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowError("INVALID_INPUT", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string, parent: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkflowError("INVALID_INPUT", `${parent}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function numberField(record: Record<string, unknown>, key: string, parent: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowError("INVALID_INPUT", `${parent}.${key} must be a finite number.`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string, parent: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new WorkflowError("INVALID_INPUT", `${parent}.${key} must be a boolean.`);
  }
  return value;
}

function isoInstantField(
  record: Record<string, unknown>,
  key: string,
  parent: string,
): string {
  const value = stringField(record, key, parent);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new WorkflowError(
      "INVALID_INPUT",
      `${parent}.${key} must be an ISO 8601 timestamp with offset.`,
    );
  }
  return value;
}

function httpsUrlField(
  record: Record<string, unknown>,
  key: string,
  parent: string,
): string {
  const value = stringField(record, key, parent);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkflowError("INVALID_INPUT", `${parent}.${key} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new WorkflowError(
      "INVALID_INPUT",
      `${parent}.${key} must be a credential-free HTTPS URL.`,
    );
  }
  return parsed.toString();
}

function assertExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  parent: string,
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) {
    throw new WorkflowError(
      "INVALID_INPUT",
      `${parent} contains unknown field(s): ${unknown.join(", ")}.`,
    );
  }
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new WorkflowError("INVALID_INPUT", `${field} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function parseFileScopes(value: unknown): NonNullable<ImportArtifactInput["fileScopes"]> {
  const record = asRecord(value, "fileScopes");
  return Object.fromEntries(
    Object.entries(record).map(([file, rawScope]) => {
      const scope = asRecord(rawScope, `fileScopes.${file}`);
      return [
        file,
        {
          ...(scope.targetIds
            ? { targetIds: stringArray(scope.targetIds, `fileScopes.${file}.targetIds`) }
            : {}),
          ...(scope.dependsOnIds
            ? {
                dependsOnIds: stringArray(
                  scope.dependsOnIds,
                  `fileScopes.${file}.dependsOnIds`,
                ),
              }
            : {}),
        },
      ];
    }),
  );
}
