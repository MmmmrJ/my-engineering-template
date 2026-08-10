import type {
  AiLabelRecord,
  ArtifactRecord,
  RightsRecord,
  VoiceCloneConsentRecord,
} from "./artifacts.js";
import type { ReviewInput } from "./review.js";
import type { ProviderCapability, WorkflowStage } from "./stages.js";
import type { ProjectManifest, TaskState } from "./state.js";

/** The only creative inputs accepted when a task is created. */
export interface CreateTaskInput {
  ip: string;
  theme: string;
}

export interface CreateTaskResult {
  taskDirectory: string;
  manifest: ProjectManifest;
  state: TaskState;
}

export interface ProviderArtifactMetadata {
  providerId: string;
  capability: ProviderCapability;
  jobId?: string;
  model?: string;
  promptHash?: string;
  seed?: string | number;
  cost?: {
    amount: number;
    currency: string;
  };
  sourceUri?: string;
}

export interface ImportArtifactInput {
  stage: WorkflowStage;
  sourceFiles: readonly string[];
  summary?: string;
  mediaType?: string;
  rights?: RightsRecord;
  provider?: ProviderArtifactMetadata;
  aiLabel?: AiLabelRecord;
  voiceCloneConsent?: VoiceCloneConsentRecord;
  /** Default scope applied to each imported file unless fileScopes overrides it. */
  targetIds?: readonly string[];
  /** Default dependency IDs applied to each imported file unless overridden. */
  dependsOnIds?: readonly string[];
  /** Per-file scope keyed by the source path or its basename. */
  fileScopes?: Readonly<
    Record<
      string,
      {
        targetIds?: readonly string[];
        dependsOnIds?: readonly string[];
      }
    >
  >;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ImportArtifactResult {
  state: TaskState;
  revision: number;
  artifacts: readonly ArtifactRecord[];
}

export type ReviewRevisionInput = ReviewInput;

export interface SelectProviderInput {
  capability: ProviderCapability;
  providerId: string;
  mode?: "api" | "mcp" | "manual";
  model?: string;
  profile?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ListArtifactsFilter {
  stage?: WorkflowStage;
  includeStale?: boolean;
}

export interface ExportResult {
  exportId: string;
  outputDirectory: string;
  manifestPath: string;
  manifestSha256: string;
  files: readonly ArtifactRecord[];
}
