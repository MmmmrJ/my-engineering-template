import type { ArtifactRecord, StaleTarget } from "./artifacts.js";
import type { ReviewDecision, RevisionTarget } from "./review.js";
import type { ProviderCapability, WorkflowStage } from "./stages.js";

export interface WorkflowEventBase {
  eventId: string;
  at: string;
  type: string;
}

export interface TaskCreatedEvent extends WorkflowEventBase {
  type: "task.created";
  taskId: string;
  input: {
    ip: string;
    theme: string;
  };
}

export interface ArtifactImportedEvent extends WorkflowEventBase {
  type: "artifact.imported";
  artifact: ArtifactRecord;
}

export interface RevisionCreatedEvent extends WorkflowEventBase {
  type: "revision.created";
  stage: WorkflowStage;
  revision: number;
  artifactIds: readonly string[];
  summary?: string;
  targetIds?: readonly string[];
}

export interface ReviewRecordedEvent extends WorkflowEventBase {
  type: "review.recorded";
  target: RevisionTarget;
  decision: ReviewDecision;
  feedback?: string;
  targetIds?: readonly string[];
}

export interface RevisionRequestedEvent extends WorkflowEventBase {
  type: "revision.requested";
  target: RevisionTarget;
  decision: "revise" | "regenerate";
  feedback: string;
  targetIds?: readonly string[];
}

export interface ProviderSelectedEvent extends WorkflowEventBase {
  type: "provider.selected";
  capability: ProviderCapability;
  providerId: string;
  mode: "api" | "mcp" | "manual";
  model?: string;
  profile?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface StageInvalidatedEvent extends WorkflowEventBase {
  type: "stage.invalidated";
  stage: WorkflowStage;
  target: StaleTarget;
}

export interface TaskExportedEvent extends WorkflowEventBase {
  type: "task.exported";
  exportId: string;
  outputPath: string;
  manifestSha256: string;
}

export type WorkflowEvent =
  | TaskCreatedEvent
  | ArtifactImportedEvent
  | RevisionCreatedEvent
  | ReviewRecordedEvent
  | RevisionRequestedEvent
  | ProviderSelectedEvent
  | StageInvalidatedEvent
  | TaskExportedEvent;

export type NewWorkflowEvent = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, "eventId" | "at">
    : never
  : never;
