import type { ArtifactRecord, StaleTarget } from "./artifacts.js";
import type { ReviewActor, ReviewDecision, ReviewMode } from "./review.js";
import type { ProviderCapability, WorkflowStage } from "./stages.js";
import type { StageContract } from "./stage-contracts.js";

export type StageStatus =
  | "pending"
  | "running"
  | "awaiting_review"
  | "approved"
  | "revision_requested"
  | "stale"
  | "failed"
  | "blocked"
  | "cancelled";

export interface RevisionReview {
  decision: ReviewDecision;
  feedback?: string;
  targetIds?: readonly string[];
  eventId: string;
  at: string;
  actor: ReviewActor;
}

export interface RevisionRequestRecord {
  decision: "revise" | "regenerate";
  feedback: string;
  targetIds?: readonly string[];
  eventId: string;
  at: string;
}

export interface RevisionRecord {
  revision: number;
  version: string;
  artifactIds: readonly string[];
  summary?: string;
  targetIds?: readonly string[];
  /** Validated, immutable structured contract for this exact revision. */
  stageContract?: StageContract;
  createdAt: string;
  createdByEventId: string;
  review?: RevisionReview;
  changeRequests?: readonly RevisionRequestRecord[];
  stale?: StaleTarget;
}

export type StageRevision = RevisionRecord;

export interface StageState {
  stage: WorkflowStage;
  status: StageStatus;
  revisions: readonly RevisionRecord[];
  currentRevision?: number;
  approvedRevision?: number;
  stale?: StaleTarget;
  requestedChange?: "revise" | "regenerate";
  blockedBy?: "provider-selection";
}

export interface ProviderBinding {
  capability: ProviderCapability;
  providerId: string;
  mode: "api" | "mcp" | "manual";
  model?: string;
  profile?: string;
  selectedAt: string;
  selectedByEventId: string;
  metadata?: Readonly<Record<string, unknown>>;
}


export type ProviderSelection = ProviderBinding;

export interface ExportRecord {
  exportId: string;
  outputPath: string;
  manifestSha256: string;
  exportedAt: string;
  eventId: string;
}

export type TaskStatus =
  | "active"
  | "blocked"
  | "awaiting_review"
  | "cancelled"
  | "failed"
  | "completed";

export interface TaskState {
  schemaVersion: 1;
  taskId: string;
  input: {
    ip: string;
    theme: string;
  };
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  activeStage?: WorkflowStage;
  stages: Record<WorkflowStage, StageState>;
  artifacts: Record<string, ArtifactRecord>;
  providers: Partial<Record<ProviderCapability, ProviderBinding>>;
  policies: {
    review: {
      mode: ReviewMode;
      explicitCheckpoints: readonly WorkflowStage[];
    };
    voiceClone: {
      defaultEnabled: false;
      consentRequired: true;
    };
  };
  exports: readonly ExportRecord[];
  eventsApplied: number;
}

export interface ProjectManifest {
  schemaVersion: 1;
  taskId: string;
  createdAt: string;
  input: {
    ip: string;
    theme: string;
  };
  workflow: {
    stages: readonly WorkflowStage[];
  };
  delivery: {
    language: "zh-CN";
    aspectRatio: "9:16";
    targetDurationSeconds: 75;
    minimumDurationSeconds: 60;
    maximumDurationSeconds: 90;
    targetShotCount: 10;
    minimumShotCount: 8;
    maximumShotCount: 12;
    width: 1080;
    height: 1920;
    frameRate: 30;
    videoCodec: "h264";
    pixelFormat: "yuv420p";
    audioCodec: "aac";
    audioSampleRate: 48000;
    subtitles: {
      language: "zh-CN";
      sidecars: readonly ["srt", "ass"];
      burnIn: true;
    };
  };
  policies: {
    review: {
      mode: ReviewMode;
      explicitCheckpoints: readonly WorkflowStage[];
    };
    voiceClone: {
      defaultEnabled: false;
      consentRequired: true;
    };
  };
}

export type ResumeAction =
  | { type: "generate-stage"; stage: "concept" | "script" | "storyboard" }
  | { type: "work"; stage: WorkflowStage }
  | {
      type: "review";
      stage: WorkflowStage;
      revision: number;
      bundle?: { id: "creative" | "visual" | "delivery"; stages: readonly WorkflowStage[] };
    }
  | {
      type: "revise" | "regenerate";
      stage: WorkflowStage;
      previousRevision: number;
    }
  | { type: "select-providers"; missing: readonly ProviderCapability[] }
  | { type: "replace-stale"; stage: WorkflowStage; target: StaleTarget }
  | {
      type: "resume-provider-job" | "poll-provider-job";
      attemptId: string;
      providerId: string;
      capability: ProviderCapability;
      stage: WorkflowStage;
      state: "prepared" | "queued" | "running" | "failed_retryable";
    }
  | {
      type: "import-provider-output";
      attemptId: string;
      providerId: string;
      capability: ProviderCapability;
      stage: WorkflowStage;
      jobId?: string;
      files: readonly string[];
    }
  | { type: "export" }
  | { type: "stopped"; reason: "cancelled" | "failed" };

export interface ResumeResult {
  taskId: string;
  status: TaskStatus;
  action: ResumeAction;
}
