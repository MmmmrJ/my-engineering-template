import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROVIDER_CAPABILITIES,
  REQUIRED_PROVIDER_CAPABILITIES,
  REVIEW_DECISIONS,
  STAGE_DIRECTORIES,
  WORKFLOW_STAGES,
  isProviderCapability,
  isReviewDecision,
  isWorkflowStage,
} from "../../src/contracts/index.js";
import type {
  AiLabelRecord,
  ArtifactRecord,
  ProjectManifest,
  ProviderBinding,
  ProviderJob,
  ProvenanceRecord,
  RightsRecord,
  StageRevision,
  StageStatus,
} from "../../src/contracts/index.js";

describe("public workflow contracts", () => {
  it("keeps the nine stage IDs and fixed numbered directories", () => {
    expect(WORKFLOW_STAGES).toEqual([
      "concept",
      "script",
      "storyboard",
      "assets",
      "keyframes",
      "clips",
      "audio",
      "edit",
      "qc",
    ]);
    expect(WORKFLOW_STAGES.map((stage) => STAGE_DIRECTORIES[stage])).toEqual([
      "01-concept",
      "02-script",
      "03-storyboard",
      "04-assets",
      "05-keyframes",
      "06-clips",
      "07-audio",
      "08-edit",
      "09-qc",
    ]);
    expect(WORKFLOW_STAGES.every(isWorkflowStage)).toBe(true);
  });

  it("uses the approved decisions and provider capability vocabulary", () => {
    expect(REVIEW_DECISIONS).toEqual(["approve", "revise", "regenerate", "abort"]);
    expect(REVIEW_DECISIONS.every(isReviewDecision)).toBe(true);
    expect(PROVIDER_CAPABILITIES.every(isProviderCapability)).toBe(true);
    expect(REQUIRED_PROVIDER_CAPABILITIES).toEqual([
      "image.generate",
      "video.i2v",
      "audio.tts",
      "audio.music",
      "audio.sfx",
      "render.timeline",
    ]);
  });

  it("exports the stable MCP-facing type names", () => {
    type PublicNames =
      | ProjectManifest
      | StageRevision
      | ArtifactRecord
      | ProviderBinding
      | ProviderJob
      | RightsRecord
      | ProvenanceRecord
      | AiLabelRecord;
    const statuses: StageStatus[] = [
      "pending",
      "running",
      "awaiting_review",
      "approved",
      "revision_requested",
      "stale",
      "failed",
      "blocked",
      "cancelled",
    ];
    expect(statuses).toHaveLength(9);
    expectTypeOf<PublicNames>().not.toBeNever();
  });
});
