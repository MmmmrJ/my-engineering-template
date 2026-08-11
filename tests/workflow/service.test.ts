import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  REQUIRED_PROVIDER_CAPABILITIES,
  STAGE_DIRECTORIES,
  WORKFLOW_STAGES,
} from "../../src/contracts/index.js";
import type {
  AiLabelRecord,
  ProviderFacade,
  RightsRecord,
  WorkflowStage,
} from "../../src/contracts/index.js";
import type { FinalDeliveryValidationResult } from "../../src/media/index.js";
import { WorkflowService } from "../../src/workflow/index.js";

const FIXED_DATE = new Date("2026-08-10T01:02:03.000Z");
const ORIGINAL_RIGHTS = {
  basis: "original" as const,
  creator: "Test Creator",
  declaration: "I created and control this original IP.",
};
const PROVIDER_TERMS_RIGHTS = {
  basis: "provider-terms" as const,
  providerId: "manual",
  termsUrl: "https://provider.example.test/terms/commercial",
  termsReviewedAt: "2026-08-09T00:00:00.000Z",
  commercialUseConfirmed: true as const,
  thirdPartyInputsCleared: true as const,
};
const LICENSED_RIGHTS = {
  basis: "licensed" as const,
  work: "Original production audio library",
  rightsHolder: "Test Rights Holder",
  license: "Commercial synchronization and distribution license",
  evidence: "license-record-audio-001",
  scope: "This episode, worldwide digital distribution",
  verifiedAt: "2026-08-09T00:00:00.000Z",
};
const COMPLETE_AI_LABEL: AiLabelRecord = {
  aiGenerated: true,
  label: "AI-generated cartoon",
  visibleLabel: true,
  metadataEmbedded: true,
  provenanceIncluded: true,
  method: "burned-in end card plus manifest metadata",
  disclosure: "A visible AI-generated end card was reviewed in the approved master.",
};
const PASSING_DELIVERY_VALIDATION = {
  ok: true,
  checks: [],
  mediaSha256: "a".repeat(64),
  report: {
    schemaVersion: 1,
    status: "passed",
    mediaSha256: "a".repeat(64),
    subtitleSha256: { srt: "b".repeat(64), ass: "c".repeat(64) },
    checks: [],
    generatedAt: FIXED_DATE.toISOString(),
  },
} as unknown as FinalDeliveryValidationResult;

describe("WorkflowService", () => {
  let root: string;
  let source: string;
  let service: WorkflowService;
  let sequence: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cartoon-workflow-"));
    source = join(root, "source.txt");
    await writeFile(source, "deterministic artifact\n", "utf8");
    sequence = 0;
    service = new WorkflowService({
      legacyUnstructuredImportsForTests: true,
      defaultRoot: root,
      clock: () => FIXED_DATE,
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
      deliveryValidator: () => Promise.resolve(structuredClone(PASSING_DELIVERY_VALIDATION)),
      providerFacade: manualProviderFacade(),
    });
  });

  it("creates the fixed durable layout and rejects unproven concept rights", async () => {
    const created = await service.createTask({ ip: "Lantern Town", theme: "Ask for help" });
    expect(created.manifest.taskId).toMatch(/^20260810-010203-lantern-town-/);
    expect(created.state.activeStage).toBe("concept");

    const rootEntries = await Promise.all(
      [
        "project.json",
        "state.json",
        "events.jsonl",
        "artifacts.jsonl",
        "provider-bindings.json",
        "reviews",
        "final",
        ...WORKFLOW_STAGES.map((stage) => STAGE_DIRECTORIES[stage]),
      ].map(async (entry) => {
        try {
          await readFile(join(created.taskDirectory, entry));
          return entry;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EISDIR") return entry;
          const { stat } = await import("node:fs/promises");
          await stat(join(created.taskDirectory, entry));
          return entry;
        }
      }),
    );
    expect(rootEntries).toHaveLength(16);

    await expect(
      service.importArtifact(created.taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
      }),
    ).rejects.toMatchObject({ code: "RIGHTS_REQUIRED" });

    const imported = await service.importArtifact(created.taskDirectory, {
      stage: "concept",
      sourceFiles: [source],
      rights: ORIGINAL_RIGHTS,
    });
    expect(imported.revision).toBe(1);
    expect(imported.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imported.artifacts[0]?.relativePath).toBe("01-concept/v001/01-source.txt");
    expect((await service.resume(created.taskDirectory)).action).toEqual({
      type: "review",
      stage: "concept",
      revision: 1,
    });
    expect((await readFile(join(created.taskDirectory, "events.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("accepts evidenced public-domain rights and rejects unsupported copyright bases", async () => {
    const publicDomain = await service.createTask({ ip: "Aesop fable", theme: "Honesty" });
    await expect(
      service.importArtifact(publicDomain.taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
        rights: {
          basis: "public-domain",
          source: "Aesop's Fables, 1919 public-domain edition",
          evidence: "https://example.test/public-domain-record",
          jurisdiction: "CN/US review recorded by producer",
          authorOrPublicationFacts:
            "Ancient attributed author; the cited English edition was published in 1919.",
          legalBasis: "The cited edition was published before the applicable copyright cutoff.",
          verifiedAt: "2026-08-10T00:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({ revision: 1 });

    const incomplete = await service.createTask({ ip: "Incomplete fable proof", theme: "Care" });
    await expect(
      service.importArtifact(incomplete.taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
        rights: {
          basis: "public-domain",
          source: "1919 edition",
          evidence: "catalog-record",
          jurisdiction: "US",
        } as unknown as RightsRecord,
      }),
    ).rejects.toMatchObject({ code: "RIGHTS_REQUIRED" });

    const unsupported = await service.createTask({ ip: "Licensed franchise", theme: "Adventure" });
    await expect(
      service.importArtifact(unsupported.taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
        rights: {
          basis: "licensed",
          license: "unknown",
        } as unknown as typeof ORIGINAL_RIGHTS,
      }),
    ).rejects.toMatchObject({ code: "RIGHTS_REQUIRED" });
  });

  it("enforces every stage review gate and records abort without inference", async () => {
    const first = await service.createTask({ ip: "Original", theme: "All gates" });
    for (const [index, stage] of WORKFLOW_STAGES.entries()) {
      const consentReviewEventId =
        stage === "audio"
          ? (await service.getState(first.taskDirectory)).stages.storyboard.revisions[0]?.review
              ?.eventId
          : undefined;
      if (stage === "audio") {
        expect(consentReviewEventId).toBeTruthy();
        await expect(
          service.importArtifact(first.taskDirectory, {
            stage,
            sourceFiles: [source],
            metadata: { voiceClone: true },
            voiceCloneConsent: {
              enabled: true,
              subject: "Test performer",
              evidence: "consent-record-001",
              scope: "This episode and this synthetic line only",
              grantedAt: "2026-08-09T00:00:00.000Z",
              userConfirmedAt: "2026-08-10T00:00:00.000Z",
              confirmation: "Use this authorized clone for the named scope.",
              reviewEventId: "event_from_another_or_missing_task",
            },
          }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
      const imported = await service.importArtifact(first.taskDirectory, {
        stage,
        sourceFiles: [source],
        ...(stage === "concept" ? { rights: ORIGINAL_RIGHTS } : {}),
        ...(stage === "audio"
          ? {
              metadata: { voiceClone: true },
              voiceCloneConsent: {
                enabled: true as const,
                subject: "Test performer",
                evidence: "consent-record-001",
                scope: "This episode and this synthetic line only",
                grantedAt: "2026-08-09T00:00:00.000Z",
                userConfirmedAt: "2026-08-10T00:00:00.000Z",
                confirmation: "Use this authorized clone for the named scope.",
                reviewEventId: consentReviewEventId,
              },
            }
          : {}),
      });
      const nextStage = WORKFLOW_STAGES[index + 1];
      if (nextStage) {
        await expect(
          service.importArtifact(first.taskDirectory, {
            stage: nextStage,
            sourceFiles: [source],
          }),
        ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
      }
      await service.review(first.taskDirectory, {
        target: { stage, revision: imported.revision },
        decision: "approve",
      });
      if (stage === "storyboard") {
        await service.selectProviders(
          first.taskDirectory,
          REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
            capability,
            providerId: "manual",
            mode: "manual" as const,
          })),
        );
      }
    }
    expect((await service.getState(first.taskDirectory)).status).toBe("completed");

    const aborted = await service.createTask({ ip: "Original", theme: "Abort safely" });
    const concept = await service.importArtifact(aborted.taskDirectory, {
      stage: "concept",
      sourceFiles: [source],
      rights: ORIGINAL_RIGHTS,
    });
    const stopped = await service.review(aborted.taskDirectory, {
      target: { stage: "concept", revision: concept.revision },
      decision: "abort",
      feedback: "The user explicitly stopped this production.",
    });
    expect(stopped.status).toBe("cancelled");
    expect((await service.resume(aborted.taskDirectory)).action).toEqual({
      type: "stopped",
      reason: "cancelled",
    });

    const unauthorized = await service.createTask({ ip: "Original", theme: "No clone" });
    await expect(
      service.importArtifact(unauthorized.taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
        rights: ORIGINAL_RIGHTS,
        metadata: { voiceClone: true },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects resolved credentials at the service boundary and strips signed provenance", async () => {
    const { taskDirectory } = await service.createTask({ ip: "Original", theme: "Traceability" });
    await expect(
      service.importArtifact(taskDirectory, {
        stage: "concept",
        sourceFiles: [source],
        rights: ORIGINAL_RIGHTS,
        metadata: { nested: { apiKey: "must-not-persist" } },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readFile(join(taskDirectory, "events.jsonl"), "utf8")).not.toContain(
      "must-not-persist",
    );

    await importAndApprove(service, taskDirectory, "concept", source, ORIGINAL_RIGHTS);
    await importAndApprove(service, taskDirectory, "script", source);
    await importAndApprove(service, taskDirectory, "storyboard", source);
    await service.selectProviders(
      taskDirectory,
      REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
        capability,
        providerId: "manual",
        mode: "manual" as const,
      })),
    );
    const imported = await service.importArtifact(taskDirectory, {
      stage: "assets",
      sourceFiles: [source],
      provider: {
        providerId: "manual",
        capability: "image.generate",
        sourceUri: "https://assets.example/frame.png?signature=temporary-secret#download",
      },
    });
    expect(imported.artifacts[0]?.provenance.source.sourceUri).toBe(
      "https://assets.example/frame.png",
    );
  });

  it("blocks G4 until explicit frozen bindings and reopens approved upstream work audibly", async () => {
    const { taskDirectory } = await service.createTask({ ip: "Original", theme: "Continuity" });
    await importAndApprove(service, taskDirectory, "concept", source, ORIGINAL_RIGHTS);
    await importAndApprove(service, taskDirectory, "script", source);
    await importAndApprove(service, taskDirectory, "storyboard", source);

    const blocked = await service.getState(taskDirectory);
    expect(blocked.status).toBe("blocked");
    expect(blocked.stages.assets).toMatchObject({ status: "blocked", blockedBy: "provider-selection" });
    expect((await service.resume(taskDirectory)).action).toEqual({
      type: "select-providers",
      missing: [...REQUIRED_PROVIDER_CAPABILITIES],
    });

    await expect(
      service.importArtifact(taskDirectory, { stage: "assets", sourceFiles: [source] }),
    ).rejects.toMatchObject({ code: "PROVIDER_SELECTION_REQUIRED" });

    await service.selectProviders(
      taskDirectory,
      REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
        capability,
        providerId: "manual",
        mode: "manual" as const,
      })),
    );
    await expect(
      service.selectProvider(taskDirectory, {
        capability: "image.generate",
        providerId: "manual",
        mode: "manual",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    await importAndApprove(service, taskDirectory, "assets", source);
    await expect(
      service.importArtifact(taskDirectory, { stage: "script", sourceFiles: [source] }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const reopened = await service.review(taskDirectory, {
      target: { stage: "script", revision: 1 },
      decision: "revise",
      feedback: "Change line L02 and rebuild its dependent shots.",
      targetIds: ["L02"],
    });
    expect(reopened.stages.script.status).toBe("revision_requested");
    expect(reopened.stages.storyboard.status).toBe("stale");
    expect(reopened.stages.assets.status).toBe("stale");
    expect(reopened.stages.storyboard.stale).toMatchObject({
      kind: "revision",
      stage: "script",
      revision: 1,
    });

    const events = (await readFile(join(taskDirectory, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toContain("revision.requested");
    expect(events.filter((event) => event.type === "stage.invalidated")).toHaveLength(2);

    const revision = await service.importArtifact(taskDirectory, {
      stage: "script",
      sourceFiles: [source],
    });
    expect(revision.revision).toBe(2);
    await service.review(taskDirectory, {
      target: { stage: "script", revision: 2 },
      decision: "approve",
    });
    expect((await service.resume(taskDirectory)).action).toMatchObject({
      type: "replace-stale",
      stage: "storyboard",
    });
  });

  it("limits shot-scoped visual rework and carries forward unaffected immutable artifacts", async () => {
    const { taskDirectory } = await service.createTask({ ip: "Original", theme: "Scoped repair" });
    await importAndApprove(service, taskDirectory, "concept", source, ORIGINAL_RIGHTS);
    await importAndApprove(service, taskDirectory, "script", source);
    await importAndApprove(service, taskDirectory, "storyboard", source);
    await service.selectProviders(
      taskDirectory,
      REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
        capability,
        providerId: "manual",
        mode: "manual" as const,
      })),
    );
    await importAndApprove(service, taskDirectory, "assets", source);

    const shot1 = join(root, "SHOT-01.txt");
    const shot2 = join(root, "SHOT-02.txt");
    const replacement = join(root, "SHOT-01-replacement.txt");
    await writeFile(shot1, "shot 1 v1\n", "utf8");
    await writeFile(shot2, "shot 2 v1\n", "utf8");
    await writeFile(replacement, "shot 1 v2\n", "utf8");
    const keyframes = await service.importArtifact(taskDirectory, {
      stage: "keyframes",
      sourceFiles: [shot1, shot2],
      fileScopes: {
        "SHOT-01.txt": { targetIds: ["SHOT-01"] },
        "SHOT-02.txt": { targetIds: ["SHOT-02"] },
      },
    });
    await service.review(taskDirectory, {
      target: { stage: "keyframes", revision: keyframes.revision },
      decision: "approve",
    });
    for (const stage of ["clips", "audio", "edit", "qc"] as const) {
      await importAndApprove(service, taskDirectory, stage, source);
    }

    const reopened = await service.review(taskDirectory, {
      target: { stage: "keyframes", revision: 1 },
      decision: "regenerate",
      feedback: "Regenerate only SHOT-01; retain the approved SHOT-02 anchor.",
      targetIds: ["SHOT-01"],
    });
    expect(reopened.stages.clips.status).toBe("stale");
    expect(reopened.stages.edit.status).toBe("stale");
    expect(reopened.stages.qc.status).toBe("stale");
    expect(reopened.stages.audio.status).toBe("approved");

    const next = await service.importArtifact(taskDirectory, {
      stage: "keyframes",
      sourceFiles: [replacement],
      fileScopes: {
        "SHOT-01-replacement.txt": { targetIds: ["SHOT-01"] },
      },
    });
    expect(next.revision).toBe(2);
    expect(next.artifacts).toHaveLength(2);
    expect(next.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetIds: ["SHOT-01"] }),
        expect.objectContaining({
          targetIds: ["SHOT-02"],
          derivedFromArtifactId: keyframes.artifacts[1]?.artifactId,
        }),
      ]),
    );
  });

  it("exports only a clean G9 approval with explicit AI label evidence", async () => {
    const { taskDirectory } = await service.createTask({ ip: "Original", theme: "Disclosure" });
    const rightsSources = new Map<WorkflowStage, string[]>();
    for (const stage of WORKFLOW_STAGES) {
      if (stage === "assets") {
        await service.selectProviders(
          taskDirectory,
          REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
            capability,
            providerId: "manual",
            mode: "manual" as const,
          })),
        );
      }
      const rights: RightsRecord | undefined =
        stage === "concept"
          ? ORIGINAL_RIGHTS
          : stage === "assets"
            ? PROVIDER_TERMS_RIGHTS
            : stage === "keyframes"
              ? {
                  basis: "workflow-derived",
                  sourceArtifactIds: rightsSources.get("assets") ?? [],
                  declaration: "Keyframes derive only from the cleared approved asset sources.",
                }
              : stage === "clips"
                ? {
                    basis: "workflow-derived",
                    sourceArtifactIds: rightsSources.get("keyframes") ?? [],
                    declaration: "Clips derive only from the cleared approved keyframes.",
                  }
                : stage === "audio"
                  ? LICENSED_RIGHTS
                  : stage === "edit"
                    ? {
                        basis: "workflow-derived",
                        sourceArtifactIds: [
                          ...(rightsSources.get("clips") ?? []),
                          ...(rightsSources.get("audio") ?? []),
                        ],
                        declaration: "The edit combines only cleared clips and licensed audio.",
                      }
                    : undefined;
      const imported = await service.importArtifact(taskDirectory, {
        stage,
        sourceFiles: [source],
        ...(rights ? { rights } : {}),
      });
      await service.review(taskDirectory, {
        target: { stage, revision: imported.revision },
        decision: "approve",
      });
      rightsSources.set(
        stage,
        imported.artifacts.map((artifact) => artifact.artifactId),
      );
    }
    expect((await service.getState(taskDirectory)).status).toBe("completed");
    await expect(service.export(taskDirectory)).rejects.toMatchObject({ code: "EXPORT_NOT_READY" });

    await service.review(taskDirectory, {
      target: { stage: "edit", revision: 1 },
      decision: "revise",
      feedback: "Add visible and metadata AI disclosures.",
      targetIds: ["master"],
    });

    const master = join(root, "episode.mp4");
    const srt = join(root, "subtitles.srt");
    const ass = join(root, "subtitles.ass");
    const qcReport = join(root, "qc-report.json");
    await Promise.all([
      writeFile(master, Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])),
      writeFile(srt, "1\n00:00:00,000 --> 00:00:01,000\nAI-generated fixture\n"),
      writeFile(
        ass,
        "[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,AI-generated fixture\n",
      ),
      writeFile(qcReport, JSON.stringify(PASSING_DELIVERY_VALIDATION.report)),
    ]);
    const edit = await service.importArtifact(taskDirectory, {
      stage: "edit",
      sourceFiles: [master, srt, ass],
      aiLabel: COMPLETE_AI_LABEL,
      rights: {
        basis: "workflow-derived",
        sourceArtifactIds: [
          ...(rightsSources.get("clips") ?? []),
          ...(rightsSources.get("audio") ?? []),
        ],
        declaration: "The final edit combines only cleared clips and licensed audio.",
      },
    });
    await service.review(taskDirectory, {
      target: { stage: "edit", revision: edit.revision },
      decision: "approve",
    });
    const qc = await service.importArtifact(taskDirectory, {
      stage: "qc",
      sourceFiles: [qcReport],
      aiLabel: COMPLETE_AI_LABEL,
    });
    await service.review(taskDirectory, {
      target: { stage: "qc", revision: qc.revision },
      decision: "approve",
    });

    const exported = await service.export(taskDirectory);
    expect(exported.outputDirectory).toBe(join(taskDirectory, "final", "v001"));
    expect(exported.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(exported.manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      taskId: (await service.getState(taskDirectory)).taskId,
      approvedRevisions: { edit: "v002", qc: "v002" },
      deliveryValidation: { status: "passed" },
    });
    await expect(readFile(join(exported.outputDirectory, "episode.mp4"))).resolves.toEqual(
      Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    );
    await expect(readFile(join(exported.outputDirectory, "subtitles.srt"), "utf8")).resolves.toContain(
      "AI-generated fixture",
    );

    // Simulate a crash after the atomic final-directory rename but before the
    // task.exported event append. Retrying must adopt the exact verified v001
    // rather than overwrite it or get stuck forever.
    const eventPath = join(taskDirectory, "events.jsonl");
    const committedEvents = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean);
    expect(JSON.parse(committedEvents.at(-1) ?? "{}") as { type?: string }).toMatchObject({
      type: "task.exported",
    });
    await writeFile(eventPath, `${committedEvents.slice(0, -1).join("\n")}\n`, "utf8");

    const recovered = await service.export(taskDirectory);
    expect(recovered.exportId).toBe(exported.exportId);
    expect(recovered.outputDirectory).toBe(exported.outputDirectory);
    expect(recovered.manifestSha256).toBe(exported.manifestSha256);
    expect((await service.getState(taskDirectory)).exports).toHaveLength(1);
    await expect(stat(join(taskDirectory, "final", "v002"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails export when any approved production artifact lacks rights", async () => {
    const { taskDirectory } = await service.createTask({ ip: "Original", theme: "Rights gate" });
    for (const stage of WORKFLOW_STAGES) {
      if (stage === "assets") {
        await service.selectProviders(
          taskDirectory,
          REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
            capability,
            providerId: "manual",
            mode: "manual" as const,
          })),
        );
      }
      await importAndApprove(
        service,
        taskDirectory,
        stage,
        source,
        stage === "concept" ? ORIGINAL_RIGHTS : undefined,
      );
    }
    await expect(service.export(taskDirectory)).rejects.toMatchObject({
      code: "RIGHTS_REQUIRED",
    });
  });
});

async function importAndApprove(
  service: WorkflowService,
  taskDirectory: string,
  stage: WorkflowStage,
  source: string,
  rights?: RightsRecord,
  aiLabel?: AiLabelRecord,
): Promise<void> {
  const imported = await service.importArtifact(taskDirectory, {
    stage,
    sourceFiles: [source],
    ...(rights ? { rights } : {}),
    ...(aiLabel ? { aiLabel } : {}),
  });
  await service.review(taskDirectory, {
    target: { stage, revision: imported.revision },
    decision: "approve",
  });
}

function manualProviderFacade(): ProviderFacade {
  return {
    list: () =>
      Promise.resolve([
        {
          id: "manual",
          name: "Manual Import",
          capabilities: REQUIRED_PROVIDER_CAPABILITIES,
          configured: true,
        },
      ]),
    check: () =>
      Promise.resolve([{ providerId: "manual", ok: true, metadata: { checkedAt: FIXED_DATE.toISOString() } }]),
  };
}
