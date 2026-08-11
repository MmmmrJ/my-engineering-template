import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REQUIRED_PROVIDER_CAPABILITIES, stageContractSchema } from "../../src/contracts/index.js";
import type { ConceptStageContract, ProviderFacade } from "../../src/contracts/index.js";
import { validateStageContract, WorkflowService } from "../../src/workflow/index.js";

const ORIGINAL_RIGHTS = {
  basis: "original" as const,
  creator: "Test creator",
  declaration: "I created and control this original IP.",
};

describe("structured stage contracts and default generator", () => {
  it("represents documented clip exceptions and narration-only audio", () => {
    expect(
      stageContractSchema.safeParse({
        schemaVersion: 1,
        stage: "clips",
        clips: [
          {
            shotId: "SHOT_01",
            durationMs: 5_000,
            technicalPassed: false,
            exception: "Static hold is intentional for this approved shot.",
          },
        ],
        proxyAssemblyFile: "proxy.mp4",
        technicalReportFile: "technical.json",
      }).success,
    ).toBe(true);
    expect(
      stageContractSchema.safeParse({
        schemaVersion: 1,
        stage: "audio",
        dialogueVoiceMap: [],
        narrationVoice: {
          voiceId: "VOICE_NARRATOR",
          file: "narration.wav",
          catalogVoice: true,
        },
        musicCues: [],
        sfxCues: [],
        mixPreviewFile: "mix.wav",
        subtitleContentFile: "subtitles.srt",
        pronunciationChecked: true,
        rightsChecked: true,
      }).success,
    ).toBe(true);
  });

  it("fails closed when a production import has no contract or an empty artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-contract-required-"));
    const service = new WorkflowService({ defaultRoot: root });
    const created = await service.createTask({ ip: "Original Lantern", theme: "Courage" });
    const source = join(root, "concept.md");
    const empty = join(root, "empty.md");
    await Promise.all([writeFile(source, "# concept\n"), writeFile(empty, "")]);

    await expect(
      service.importArtifact(created.taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
        rights: ORIGINAL_RIGHTS,
      }),
    ).rejects.toMatchObject({ code: "STAGE_CONTRACT_INVALID" });

    const valid = conceptContract("Original Lantern", "Courage");
    await expect(
      service.importArtifact(created.taskDirectory, {
        stage: "concept",
        sourceFiles: [empty],
        stageContract: valid,
        rights: ORIGINAL_RIGHTS,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });

  it("generates validated G1-G3 revisions and never self-approves them", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-default-generator-"));
    let sequence = 0;
    const service = new WorkflowService({
      defaultRoot: root,
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    const created = await service.createTask({ ip: "Original Lantern", theme: "Courage" });

    expect((await service.resume(created.taskDirectory)).action).toEqual({
      type: "generate-stage",
      stage: "concept",
    });
    const concept = await service.generateStage(created.taskDirectory, {
      rights: ORIGINAL_RIGHTS,
    });
    expect(concept.state.stages.concept.status).toBe("awaiting_review");
    expect(concept.state.stages.concept.revisions[0]?.stageContract?.stage).toBe("concept");
    await service.review(created.taskDirectory, {
      target: { stage: "concept", revision: concept.revision },
      decision: "approve",
    });

    expect((await service.resume(created.taskDirectory)).action).toEqual({
      type: "generate-stage",
      stage: "script",
    });
    const script = await service.generateStage(created.taskDirectory);
    expect(script.stageContract).toMatchObject({
      stage: "script",
      totalDurationMs: 75_000,
      automaticReview: { passed: true, issues: [] },
    });
    expect(script.artifacts[0]?.rights).toEqual({
      basis: "workflow-derived",
      sourceArtifactIds: concept.artifacts.map((artifact) => artifact.artifactId),
      declaration:
        "Generated script derives only from the approved concept revision and task-controlled input.",
    });
    await service.review(created.taskDirectory, {
      target: { stage: "script", revision: script.revision },
      decision: "approve",
    });

    const storyboard = await service.generateStage(created.taskDirectory);
    expect(storyboard.stageContract.stage).toBe("storyboard");
    if (storyboard.stageContract.stage !== "storyboard") throw new Error("contract mismatch");
    expect(storyboard.stageContract.shots).toHaveLength(10);
    expect(storyboard.stageContract.shots.reduce((sum, shot) => sum + shot.durationMs, 0)).toBe(
      75_000,
    );
    expect(storyboard.state.stages.storyboard.status).toBe("awaiting_review");
    expect(storyboard.artifacts[0]?.rights).toEqual({
      basis: "workflow-derived",
      sourceArtifactIds: script.artifacts.map((artifact) => artifact.artifactId),
      declaration:
        "Generated storyboard derives only from the approved script revision and task-controlled input.",
    });
  });

  it("fails closed instead of claiming deterministic baseline feedback was applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-feedback-required-"));
    const service = new WorkflowService({ defaultRoot: root });
    const created = await service.createTask({ ip: "Original Lantern", theme: "Courage" });
    const concept = await service.generateStage(created.taskDirectory, { rights: ORIGINAL_RIGHTS });
    await service.review(created.taskDirectory, {
      target: { stage: "concept", revision: concept.revision },
      decision: "approve",
    });
    await service.review(created.taskDirectory, {
      target: { stage: "concept", revision: concept.revision },
      decision: "revise",
      feedback: "Change the premise so the protagonist asks for help before acting.",
      targetIds: ["DIR_MAIN"],
    });

    await expect(
      service.generateStage(created.taskDirectory, { rights: ORIGINAL_RIGHTS }),
    ).rejects.toMatchObject({
      code: "GENERATOR_UNAVAILABLE",
    });
    const state = await service.getState(created.taskDirectory);
    expect(state.stages.concept.revisions).toHaveLength(1);
    expect(state.stages.concept.status).toBe("revision_requested");
  });

  it("requires rights for every production import", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-all-rights-"));
    const service = new WorkflowService({ defaultRoot: root });
    const created = await service.createTask({ ip: "Original Lantern", theme: "Courage" });
    const concept = await service.generateStage(created.taskDirectory, { rights: ORIGINAL_RIGHTS });
    await service.review(created.taskDirectory, {
      target: { stage: "concept", revision: concept.revision },
      decision: "approve",
    });
    const source = join(root, "script.md");
    await writeFile(source, "# replacement script\n");

    await expect(
      service.importArtifact(created.taskDirectory, {
        stage: "script",
        sourceFiles: [source],
        stageContract: conceptContract("Original Lantern", "Courage"),
      }),
    ).rejects.toMatchObject({ code: "RIGHTS_REQUIRED" });
  });

  it("rejects a structurally valid concept contract that does not match task identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-contract-identity-"));
    const service = new WorkflowService({ defaultRoot: root });
    const created = await service.createTask({ ip: "Original Lantern", theme: "Courage" });
    const source = join(root, "concept.md");
    await writeFile(source, "# concept\n");

    await expect(
      service.importArtifact(created.taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
        stageContract: conceptContract("Different IP", "Courage"),
        rights: ORIGINAL_RIGHTS,
      }),
    ).rejects.toMatchObject({ code: "STAGE_CONTRACT_INVALID" });
  });

  it("quick mode records policy approvals and pauses only at audited bundle checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-quick-review-"));
    let sequence = 0;
    const service = new WorkflowService({
      defaultRoot: root,
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    const created = await service.createTask({
      ip: "Original Lantern",
      theme: "Courage",
      reviewMode: "quick",
    });
    expect(created.manifest.policies.review).toEqual({
      mode: "quick",
      explicitCheckpoints: ["storyboard", "keyframes", "qc"],
    });

    const concept = await service.generateStage(created.taskDirectory, { rights: ORIGINAL_RIGHTS });
    expect(concept.state.stages.concept).toMatchObject({
      status: "approved",
      approvedRevision: 1,
      revisions: [{ review: { decision: "approve", actor: "quick-policy" } }],
    });
    expect((await service.resume(created.taskDirectory)).action).toEqual({
      type: "generate-stage",
      stage: "script",
    });

    const script = await service.generateStage(created.taskDirectory);
    expect(script.state.stages.script.revisions[0]?.review?.actor).toBe("quick-policy");
    const storyboard = await service.generateStage(created.taskDirectory);
    expect(storyboard.state.stages.storyboard.status).toBe("awaiting_review");
    expect((await service.resume(created.taskDirectory)).action).toEqual({
      type: "review",
      stage: "storyboard",
      revision: 1,
      bundle: {
        id: "creative",
        stages: ["concept", "script", "storyboard"],
      },
    });

    const reviewed = await service.review(created.taskDirectory, {
      target: { stage: "storyboard", revision: 1 },
      decision: "approve",
    });
    expect(reviewed.stages.storyboard.revisions[0]?.review?.actor).toBe("user");
    expect(reviewed.status).toBe("blocked");
  });

  it("rejects media-stage contracts that reuse one file across incompatible roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-contract-file-roles-"));
    const service = new WorkflowService({ defaultRoot: root });
    const created = await service.createTask({
      ip: "Original Lantern",
      theme: "Courage",
      reviewMode: "quick",
    });
    await service.generateStage(created.taskDirectory, { rights: ORIGINAL_RIGHTS });
    await service.generateStage(created.taskDirectory);
    const storyboard = await service.generateStage(created.taskDirectory);
    await service.review(created.taskDirectory, {
      target: { stage: "storyboard", revision: storyboard.revision },
      decision: "approve",
    });
    const state = await service.getState(created.taskDirectory);
    const approvedStoryboard = state.stages.storyboard.revisions[0]?.stageContract;
    if (approvedStoryboard?.stage !== "storyboard") throw new Error("storyboard fixture missing");
    expect(() =>
      validateStageContract({
        stage: "assets",
        state,
        sourceFiles: [join(root, "asset.png")],
        contract: {
          schemaVersion: 1,
          stage: "assets",
          styleSpecification: "Consistent original cartoon style.",
          assets: approvedStoryboard.assetDefinitions.map((asset) => ({
            ...asset,
            file: "asset.png",
            prompt: `Create ${asset.name}`,
            negativePrompt: "watermark, drift",
            rightsNote: "Original provider-cleared output.",
          })),
          contactSheetFiles: ["asset.png"],
          inventoryComplete: true,
        },
      }),
    ).toThrow(/distinct file/);

    const assetFiles = approvedStoryboard.assetDefinitions.map(
      (_, index) => join(root, `asset-${index + 1}.png`),
    );
    expect(() =>
      validateStageContract({
        stage: "assets",
        state,
        sourceFiles: [...assetFiles, join(root, "contact-sheet.png")],
        contract: {
          schemaVersion: 1,
          stage: "assets",
          styleSpecification: "Consistent original cartoon style.",
          assets: approvedStoryboard.assetDefinitions.map((asset, index) => ({
            ...asset,
            ...(index === 0 ? { type: "prop" as const } : {}),
            file: `asset-${index + 1}.png`,
            prompt: `Create ${asset.name}`,
            negativePrompt: "watermark, drift",
            rightsNote: "Original provider-cleared output.",
          })),
          contactSheetFiles: ["contact-sheet.png"],
          inventoryComplete: true,
        },
      }),
    ).toThrow(/preserve storyboard type/);
  });

  it("rejects an invalid manual capability before freezing provider bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-manual-capability-"));
    const providers: ProviderFacade = {
      list: () =>
        Promise.resolve([
          {
            id: "jimeng-manual",
            name: "Jimeng manual",
            capabilities: ["image.generate", "video.i2v"],
            configured: true,
          },
        ]),
      check: () => Promise.resolve([{ providerId: "jimeng-manual", ok: true }]),
    };
    const service = new WorkflowService({ defaultRoot: root, providerFacade: providers });
    const created = await service.createTask({ ip: "Original", theme: "Capability", reviewMode: "quick" });
    await service.generateStage(created.taskDirectory, { rights: ORIGINAL_RIGHTS });
    await service.generateStage(created.taskDirectory);
    const storyboard = await service.generateStage(created.taskDirectory);
    await service.review(created.taskDirectory, {
      target: { stage: "storyboard", revision: storyboard.revision },
      decision: "approve",
    });

    await expect(
      service.selectProviders(
        created.taskDirectory,
        REQUIRED_PROVIDER_CAPABILITIES.map(
          (capability) => ({
            capability,
            providerId: "jimeng-manual",
            mode: "manual" as const,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

function conceptContract(ip: string, theme: string): ConceptStageContract {
  return {
    schemaVersion: 1,
    stage: "concept",
    ip,
    theme,
    premise: "A visual conflict forces the protagonist to make a meaningful choice.",
    audience: "General mobile audience",
    language: "zh-CN",
    tone: "Warm and concise",
    logline: "A small failure becomes a chance to act with courage.",
    synopsis: "The protagonist fails, discovers the missing clue, changes approach, and succeeds.",
    intendedUse: "Original vertical cartoon short",
    format: { aspectRatio: "9:16", durationSeconds: 75 },
    directions: [
      { id: "DIR_MAIN", title: "Main", summary: "Action reversal", recommended: true },
      { id: "DIR_ALT_A", title: "Mystery", summary: "Light mystery", recommended: false },
      { id: "DIR_ALT_B", title: "Comedy", summary: "Partner comedy", recommended: false },
    ],
  };
}
