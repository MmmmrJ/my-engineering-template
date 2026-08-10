import type {
  ConceptRightsMetadata,
  LicensedRightsRecord,
  ProviderTermsRightsRecord,
  PublicDomainRightsRecord,
  RightsRecord,
  WorkflowDerivedRightsRecord,
} from "../contracts/artifacts.js";
import { WorkflowError } from "./errors.js";
import { cleanText } from "./util.js";

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateConceptRights(
  rights: RightsRecord | undefined,
): ConceptRightsMetadata {
  if (!rights) {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      "Concept imports require an original-work declaration or evidenced public-domain metadata.",
    );
  }
  if (rights.basis !== "original" && rights.basis !== "public-domain") {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      "Concept rights must be original or evidenced public-domain; licenses, provider terms, and workflow derivation do not establish the task IP.",
    );
  }
  const validated = validateRightsRecord(rights);
  if (validated.basis === "original" || validated.basis === "public-domain") {
    return validated;
  }
  throw new WorkflowError("RIGHTS_REQUIRED", "Concept rights validation failed closed.");
}

export function validateRightsRecord(rights: RightsRecord | undefined): RightsRecord {
  if (!rights) {
    throw new WorkflowError("RIGHTS_REQUIRED", "Artifact rights metadata is required.");
  }

  switch (rights.basis) {
    case "original":
      return {
        basis: "original",
        creator: rightsText(rights.creator, "rights.creator"),
        declaration: rightsText(rights.declaration, "rights.declaration"),
        ...(rights.evidence !== undefined
          ? { evidence: rightsText(rights.evidence, "rights.evidence") }
          : {}),
      };
    case "public-domain":
      return validatePublicDomainRights(rights);
    case "licensed":
      return validateLicensedRights(rights);
    case "provider-terms":
      return validateProviderTermsRights(rights);
    case "workflow-derived":
      return validateWorkflowDerivedRights(rights);
    default:
      throw new WorkflowError("RIGHTS_REQUIRED", "Unsupported artifact rights basis.");
  }
}

function validatePublicDomainRights(
  rights: PublicDomainRightsRecord,
): PublicDomainRightsRecord {
  return {
    basis: "public-domain",
    source: rightsText(rights.source, "rights.source"),
    evidence: rightsText(rights.evidence, "rights.evidence"),
    jurisdiction: rightsText(rights.jurisdiction, "rights.jurisdiction"),
    authorOrPublicationFacts: rightsText(
      rights.authorOrPublicationFacts,
      "rights.authorOrPublicationFacts",
    ),
    legalBasis: rightsText(rights.legalBasis, "rights.legalBasis"),
    verifiedAt: validateIsoInstant(rights.verifiedAt, "rights.verifiedAt"),
  };
}

function validateLicensedRights(rights: LicensedRightsRecord): LicensedRightsRecord {
  return {
    basis: "licensed",
    work: rightsText(rights.work, "rights.work"),
    rightsHolder: rightsText(rights.rightsHolder, "rights.rightsHolder"),
    license: rightsText(rights.license, "rights.license"),
    evidence: rightsText(rights.evidence, "rights.evidence"),
    scope: rightsText(rights.scope, "rights.scope"),
    verifiedAt: validateIsoInstant(rights.verifiedAt, "rights.verifiedAt"),
  };
}

function validateProviderTermsRights(
  rights: ProviderTermsRightsRecord,
): ProviderTermsRightsRecord {
  const termsUrl = rightsText(rights.termsUrl, "rights.termsUrl");
  let parsed: URL;
  try {
    parsed = new URL(termsUrl);
  } catch {
    throw new WorkflowError("RIGHTS_REQUIRED", "rights.termsUrl must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      "rights.termsUrl must be a credential-free HTTPS URL.",
    );
  }
  if (rights.commercialUseConfirmed !== true || rights.thirdPartyInputsCleared !== true) {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      "Provider terms require explicit commercial-use confirmation and cleared third-party inputs.",
    );
  }
  return {
    basis: "provider-terms",
    providerId: rightsText(rights.providerId, "rights.providerId"),
    termsUrl: parsed.toString(),
    termsReviewedAt: validateIsoInstant(
      rights.termsReviewedAt,
      "rights.termsReviewedAt",
    ),
    commercialUseConfirmed: true,
    thirdPartyInputsCleared: true,
  };
}

function validateWorkflowDerivedRights(
  rights: WorkflowDerivedRightsRecord,
): WorkflowDerivedRightsRecord {
  if (!Array.isArray(rights.sourceArtifactIds) || rights.sourceArtifactIds.length === 0) {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      "Workflow-derived rights require at least one source artifact ID.",
    );
  }
  const sourceArtifactIds = [
    ...new Set(
      rights.sourceArtifactIds.map((artifactId) =>
        rightsText(artifactId, "rights.sourceArtifactIds"),
      ),
    ),
  ];
  return {
    basis: "workflow-derived",
    sourceArtifactIds,
    declaration: rightsText(rights.declaration, "rights.declaration"),
  };
}

export function validateIsoInstant(value: string, field: string): string {
  const normalized = rightsText(value, field);
  if (!ISO_INSTANT.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw new WorkflowError("RIGHTS_REQUIRED", `${field} must be an ISO 8601 timestamp with offset.`);
  }
  return normalized;
}

function rightsText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WorkflowError("RIGHTS_REQUIRED", `${field} must be a non-empty string.`);
  }
  try {
    return cleanText(value, field);
  } catch {
    throw new WorkflowError("RIGHTS_REQUIRED", `${field} must be a non-empty string.`);
  }
}
