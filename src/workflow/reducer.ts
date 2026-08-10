import type {
  ArtifactRecord,
  ProviderCapability,
  RevisionRecord,
  StaleTarget,
  StageState,
  TaskState,
  WorkflowEvent,
  WorkflowStage,
} from "../contracts/index.js";
import {
  REQUIRED_PROVIDER_CAPABILITIES,
  WORKFLOW_STAGES,
  nextStage,
} from "../contracts/stages.js";
import { invariant } from "./errors.js";
import { validateConceptRights } from "./rights.js";
import { versionLabel } from "./util.js";

export function reduceEvents(events: readonly WorkflowEvent[]): TaskState {
  invariant(events.length > 0, "The event log is empty.");
  invariant(events[0]?.type === "task.created", "The first event must create the task.");

  let state: TaskState | undefined;
  const eventIds = new Set<string>();

  for (const [index, event] of events.entries()) {
    invariant(event.eventId.length > 0, `Event ${index + 1} has no eventId.`);
    invariant(!eventIds.has(event.eventId), `Duplicate eventId ${event.eventId}.`);
    eventIds.add(event.eventId);

    if (event.type === "task.created") {
      invariant(!state, "A task can only be created once.");
      state = createInitialState(event);
    } else {
      invariant(state, "An event occurred before task creation.");
      applyEvent(state, event);
    }

    state.eventsApplied = index + 1;
    state.updatedAt = event.at;
    recomputeTaskStatus(state);
  }

  invariant(state, "The event log did not create a task.");
  return state;
}

function createInitialState(event: Extract<WorkflowEvent, { type: "task.created" }>): TaskState {
  const stages = Object.fromEntries(
    WORKFLOW_STAGES.map((stage) => [
      stage,
      {
        stage,
        status: "pending",
        revisions: [],
      } satisfies StageState,
    ]),
  ) as unknown as Record<WorkflowStage, StageState>;

  return {
    schemaVersion: 1,
    taskId: event.taskId,
    input: { ...event.input },
    createdAt: event.at,
    updatedAt: event.at,
    status: "active",
    activeStage: "concept",
    stages,
    artifacts: {},
    providers: {},
    policies: { voiceClone: { defaultEnabled: false, consentRequired: true } },
    exports: [],
    eventsApplied: 0,
  };
}

function applyEvent(
  state: TaskState,
  event: Exclude<WorkflowEvent, { type: "task.created" }>,
): void {
  invariant(state.status !== "cancelled", "No events may mutate a cancelled task.");

  switch (event.type) {
    case "artifact.imported": {
      invariant(!state.artifacts[event.artifact.artifactId], "Artifact IDs are immutable and unique.", {
        artifactId: event.artifact.artifactId,
      });
      if (event.artifact.stage === "concept") {
        validateConceptRights(event.artifact.rights);
      }
      state.artifacts[event.artifact.artifactId] = structuredClone(event.artifact);
      return;
    }
    case "revision.created": {
      const stage = state.stages[event.stage];
      const expected = stage.revisions.length + 1;
      invariant(event.revision === expected, `Expected ${versionLabel(expected)} for ${event.stage}.`, {
        actual: event.revision,
      });
      invariant(event.artifactIds.length > 0, "A revision must contain at least one artifact.");
      for (const artifactId of event.artifactIds) {
        const artifact = state.artifacts[artifactId];
        invariant(artifact, `Revision references missing artifact ${artifactId}.`);
        invariant(artifact.stage === event.stage, `Artifact ${artifactId} belongs to another stage.`);
        invariant(artifact.revision === event.revision, `Artifact ${artifactId} belongs to another revision.`);
      }
      const revision: RevisionRecord = {
        revision: event.revision,
        version: versionLabel(event.revision),
        artifactIds: [...event.artifactIds],
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.targetIds?.length ? { targetIds: [...event.targetIds] } : {}),
        createdAt: event.at,
        createdByEventId: event.eventId,
      };
      stage.revisions = [...stage.revisions, revision];
      stage.currentRevision = event.revision;
      stage.status = "awaiting_review";
      delete stage.stale;
      delete stage.requestedChange;
      delete stage.blockedBy;
      return;
    }
    case "review.recorded": {
      const stage = state.stages[event.target.stage];
      const revision = stage.revisions[event.target.revision - 1];
      invariant(revision, `Review target ${event.target.stage}/${versionLabel(event.target.revision)} does not exist.`);
      invariant(stage.currentRevision === event.target.revision, "Only the current revision can be reviewed.");
      invariant(!revision.review, "A revision can only receive one review decision.");
      invariant(stage.status === "awaiting_review", "The target revision is not awaiting review.");
      revision.review = {
        decision: event.decision,
        ...(event.feedback ? { feedback: event.feedback } : {}),
        ...(event.targetIds ? { targetIds: [...event.targetIds] } : {}),
        eventId: event.eventId,
        at: event.at,
      };

      if (event.decision === "approve") {
        stage.status = "approved";
        stage.approvedRevision = event.target.revision;
        delete stage.requestedChange;
        makeNextStageActionable(state, event.target.stage);
      } else if (event.decision === "abort") {
        stage.status = "cancelled";
      } else {
        stage.status = "revision_requested";
        stage.requestedChange = event.decision;
      }
      return;
    }
    case "revision.requested": {
      const stage = state.stages[event.target.stage];
      const revision = stage.revisions[event.target.revision - 1];
      invariant(revision, `Revision request target ${event.target.stage}/${versionLabel(event.target.revision)} does not exist.`);
      invariant(stage.approvedRevision === event.target.revision, "Only the approved revision can be reopened.");
      invariant(stage.status === "approved", "The target stage is not currently approved.");
      invariant(revision.review?.decision === "approve", "Only an explicitly approved revision can be reopened.");
      revision.changeRequests = [
        ...(revision.changeRequests ?? []),
        {
          decision: event.decision,
          feedback: event.feedback,
          ...(event.targetIds ? { targetIds: [...event.targetIds] } : {}),
          eventId: event.eventId,
          at: event.at,
        },
      ];
      stage.status = "revision_requested";
      stage.requestedChange = event.decision;
      return;
    }
    case "provider.selected": {
      invariant(
        event.mode === "api" || event.mode === "mcp" || event.mode === "manual",
        `Unknown provider binding mode: ${String(event.mode)}.`,
      );
      invariant(
        !state.providers[event.capability],
        `Provider binding for ${event.capability} is frozen once selected.`,
      );
      state.providers[event.capability] = {
        capability: event.capability,
        providerId: event.providerId,
        mode: event.mode,
        ...(event.model ? { model: event.model } : {}),
        ...(event.profile ? { profile: event.profile } : {}),
        selectedAt: event.at,
        selectedByEventId: event.eventId,
        ...(event.metadata ? { metadata: structuredClone(event.metadata) } : {}),
      };
      const assets = state.stages.assets;
      if (assets.status === "blocked" && missingProviders(state).length === 0) {
        assets.status = "pending";
        delete assets.blockedBy;
      }
      return;
    }
    case "stage.invalidated": {
      const stage = state.stages[event.stage];
      invariant(stage.revisions.length > 0, `Cannot invalidate empty stage ${event.stage}.`);
      stage.status = "stale";
      stage.stale = structuredClone(event.target);
      delete stage.requestedChange;
      delete stage.blockedBy;
      stage.revisions = stage.revisions.map((revision) => ({
        ...revision,
        stale: structuredClone(event.target),
      }));
      for (const artifactId of stage.revisions.flatMap((revision) => revision.artifactIds)) {
        const artifact = state.artifacts[artifactId];
        if (artifact && shouldInvalidateArtifact(artifact, event.target)) {
          state.artifacts[artifactId] = { ...artifact, stale: structuredClone(event.target) };
        }
      }
      return;
    }
    case "task.exported": {
      state.exports = [
        ...state.exports,
        {
          exportId: event.exportId,
          outputPath: event.outputPath,
          manifestSha256: event.manifestSha256,
          exportedAt: event.at,
          eventId: event.eventId,
        },
      ];
      return;
    }
    default: {
      const unknownEvent = event as { type?: unknown };
      invariant(false, `Unknown workflow event type: ${String(unknownEvent.type)}`);
    }
  }
}

function shouldInvalidateArtifact(artifact: ArtifactRecord, target: StaleTarget): boolean {
  if (target.kind !== "revision" || !target.targetIds?.length) return true;
  const scope = [...(artifact.targetIds ?? []), ...(artifact.dependsOnIds ?? [])];
  if (scope.length === 0) return true;
  const changed = new Set(target.targetIds);
  return scope.some((id) => changed.has(id));
}

function makeNextStageActionable(state: TaskState, approvedStage: WorkflowStage): void {
  const next = nextStage(approvedStage);
  if (!next) return;

  const nextState = state.stages[next];
  if (nextState.status !== "pending") return;

  if (approvedStage === "storyboard" && missingProviders(state).length > 0) {
    nextState.status = "blocked";
    nextState.blockedBy = "provider-selection";
    return;
  }

  nextState.status = "pending";
}

export function missingProviders(state: TaskState): ProviderCapability[] {
  return REQUIRED_PROVIDER_CAPABILITIES.filter((capability) => !state.providers[capability]);
}

function recomputeTaskStatus(state: TaskState): void {
  const stageStates = WORKFLOW_STAGES.map((stage) => state.stages[stage]);
  const cancelled = stageStates.find((stage) => stage.status === "cancelled");
  if (cancelled) {
    state.status = "cancelled";
    state.activeStage = cancelled.stage;
    return;
  }

  if (stageStates.every((stage) => stage.status === "approved")) {
    state.status = "completed";
    delete state.activeStage;
    return;
  }

  const active = stageStates.find((stage) => stage.status !== "approved");
  invariant(active, "An active task must have an actionable stage.");
  state.activeStage = active.stage;
  if (active.status === "blocked") {
    state.status = "blocked";
  } else if (active.status === "awaiting_review") {
    state.status = "awaiting_review";
  } else {
    state.status = "active";
  }
}

export function approvedArtifacts(state: TaskState): ArtifactRecord[] {
  return WORKFLOW_STAGES.flatMap((stageName) => {
    const stage = state.stages[stageName];
    if (!stage.approvedRevision || stage.status !== "approved") return [];
    const revision = stage.revisions[stage.approvedRevision - 1];
    invariant(revision, `Approved revision missing for ${stageName}.`);
    return revision.artifactIds.map((artifactId) => {
      const artifact = state.artifacts[artifactId];
      invariant(artifact, `Approved artifact ${artifactId} is missing.`);
      return artifact;
    });
  });
}
