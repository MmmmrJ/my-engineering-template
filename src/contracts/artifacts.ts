import type { ProviderCapability, WorkflowStage } from "./stages.js";

export interface OriginalRightsRecord {
  basis: "original";
  creator: string;
  declaration: string;
  evidence?: string;
}

export interface PublicDomainRightsRecord {
  basis: "public-domain";
  source: string;
  evidence: string;
  jurisdiction: string;
  authorOrPublicationFacts: string;
  legalBasis: string;
  verifiedAt: string;
}

export interface LicensedRightsRecord {
  basis: "licensed";
  work: string;
  rightsHolder: string;
  license: string;
  evidence: string;
  scope: string;
  verifiedAt: string;
}

export interface ProviderTermsRightsRecord {
  basis: "provider-terms";
  providerId: string;
  termsUrl: string;
  termsReviewedAt: string;
  commercialUseConfirmed: true;
  thirdPartyInputsCleared: true;
}

export interface WorkflowDerivedRightsRecord {
  basis: "workflow-derived";
  sourceArtifactIds: readonly string[];
  declaration: string;
}

export type RightsRecord =
  | OriginalRightsRecord
  | PublicDomainRightsRecord
  | LicensedRightsRecord
  | ProviderTermsRightsRecord
  | WorkflowDerivedRightsRecord;

export type ConceptRightsMetadata = OriginalRightsRecord | PublicDomainRightsRecord;

export interface ProviderProvenance {
  kind: "provider-output";
  providerId: string;
  capability: ProviderCapability;
  jobId?: string;
  model?: string;
  sourceUri?: string;
}

export interface LocalFileProvenance {
  kind: "local-file";
  sourceUri: string;
}

export type ArtifactSource = ProviderProvenance | LocalFileProvenance;

export interface ProvenanceRecord {
  source: ArtifactSource;
  importedAt: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type ArtifactProvenance = ProvenanceRecord;

export interface AiLabelRecord {
  aiGenerated: boolean;
  label: string;
  visibleLabel: boolean;
  metadataEmbedded: boolean;
  provenanceIncluded: boolean;
  method: string;
  disclosure?: string;
}

export interface VoiceCloneConsentRecord {
  enabled: true;
  subject: string;
  evidence: string;
  scope: string;
  grantedAt: string;
  userConfirmedAt: string;
  confirmation: string;
  reviewEventId?: string;
}

export interface ArtifactRecord {
  artifactId: string;
  stage: WorkflowStage;
  revision: number;
  fileName: string;
  relativePath: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  providerId?: string;
  providerAttemptId?: string;
  model?: string;
  jobId?: string;
  promptHash?: string;
  seed?: string | number;
  cost?: {
    amount: number;
    currency: string;
  };
  rights?: RightsRecord;
  provenance: ProvenanceRecord;
  aiLabel?: AiLabelRecord;
  voiceCloneConsent?: VoiceCloneConsentRecord;
  /** Stable shot/character/asset IDs directly represented by this artifact. */
  targetIds?: readonly string[];
  /** Stable IDs whose change requires rebuilding this aggregate artifact. */
  dependsOnIds?: readonly string[];
  /** Prior immutable artifact copied forward into a scoped replacement revision. */
  derivedFromArtifactId?: string;
  stale?: StaleTarget;
}

export type StaleTarget =
  | {
      kind: "revision";
      eventId: string;
      stage: WorkflowStage;
      revision: number;
      targetIds?: readonly string[];
    }
  | {
      kind: "provider";
      eventId: string;
      capability: ProviderCapability;
      providerId: string;
    };
