import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  REQUIRED_PROVIDER_CAPABILITIES,
  type ProviderFacade,
  type WorkflowStage,
} from "../../src/contracts/index.js";
import type { StoredProviderAttempt } from "../../src/providers/index.js";
import { WorkflowService } from "../../src/workflow/index.js";

describe("unified provider-job resume", () => {
  let root: string;
  let source: string;
  let attempts: StoredProviderAttempt[];
  let service: WorkflowService;
  let taskDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cartoon-provider-resume-"));
    source = join(root, "fixture.txt");
    await writeFile(source, "fixture\n");
    attempts = [];
    service = new WorkflowService({
      defaultRoot: root,
      legacyUnstructuredImportsForTests: true,
      providerJobReader: async () => attempts,
      providerFacade: manualProviderFacade(),
    });
    ({ taskDirectory } = await service.createTask({ ip: "Original", theme: "Recovery" }));
    for (const stage of ["concept", "script", "storyboard"] as const) {
      const imported = await service.importArtifact(taskDirectory, {
        stage,
        sourceFiles: [source],
        ...(stage === "concept"
          ? {
              rights: {
                basis: "original" as const,
                creator: "Creator",
                declaration: "I created and control this original IP.",
              },
            }
          : {}),
      });
      await service.review(taskDirectory, {
        target: { stage, revision: imported.revision },
        decision: "approve",
      });
    }
    await service.selectProviders(
      taskDirectory,
      REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
        capability,
        providerId: "manual",
        mode: "manual" as const,
      })),
    );
  });

  it("returns resume, poll, and import actions from the durable provider ledger", async () => {
    attempts = [attempt("prepared")];
    await expect(service.resume(taskDirectory)).resolves.toMatchObject({
      action: { type: "resume-provider-job", attemptId: "attempt-1", stage: "assets" },
    });

    attempts = [attempt("running", { externalJobId: "remote-1" })];
    await expect(service.resume(taskDirectory)).resolves.toMatchObject({
      action: { type: "poll-provider-job", attemptId: "attempt-1", state: "running" },
    });

    attempts = [
      attempt("succeeded", {
        externalJobId: "remote-1",
        outputs: [{ kind: "image", localPath: join(taskDirectory, "provider-downloads/a.png") }],
      }),
    ];
    await mkdir(join(taskDirectory, "provider-downloads"), { recursive: true });
    await writeFile(join(taskDirectory, "provider-downloads/a.png"), "resume fixture\n");
    await expect(service.resume(taskDirectory)).resolves.toMatchObject({
      action: {
        type: "import-provider-output",
        attemptId: "attempt-1",
        files: [join(taskDirectory, "provider-downloads/a.png")],
      },
    });
  });

  it("atomically assembles complete output sets from multiple attempts for one revision", async () => {
    const first = join(taskDirectory, "provider-downloads", "attempt-1", "output.txt");
    const second = join(taskDirectory, "provider-downloads", "attempt-2", "output.txt");
    await Promise.all([
      mkdir(join(taskDirectory, "provider-downloads", "attempt-1"), { recursive: true }),
      mkdir(join(taskDirectory, "provider-downloads", "attempt-2"), { recursive: true }),
    ]);
    await Promise.all([writeFile(first, "first output\n"), writeFile(second, "second output\n")]);
    const output = (path: string, content: string, seed: number) => ({
      kind: "text" as const,
      localPath: path,
      sizeBytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      metadata: { seed },
    });
    attempts = [
      attempt("succeeded", {
        attemptId: "attempt-1",
        externalJobId: "remote-1",
        outputs: [output(first, "first output\n", 11)],
      }),
      attempt("succeeded", {
        attemptId: "attempt-2",
        capability: "render.timeline",
        externalJobId: "remote-2",
        requestMetadata: { seed: 22 },
        outputs: [
          {
            kind: "text",
            localPath: second,
            sizeBytes: Buffer.byteLength("second output\n"),
            sha256: createHash("sha256").update("second output\n").digest("hex"),
          },
        ],
      }),
    ];

    const providerAttempts = [
      { providerId: "manual", capability: "image.generate" as const, attemptId: "attempt-1" },
      { providerId: "manual", capability: "render.timeline" as const, attemptId: "attempt-2" },
    ];
    await expect(
      service.importArtifact(taskDirectory, {
        stage: "assets",
        sourceFiles: [first],
        provider: providerAttempts[0],
      }),
    ).rejects.toThrow("must be imported together");
    await expect(
      service.importArtifact(taskDirectory, {
        stage: "assets",
        sourceFiles: [first, second],
        providerAttempts,
      }),
    ).rejects.toThrow("duplicate contract filename");

    const imported = await service.importArtifact(taskDirectory, {
      stage: "assets",
      sourceFiles: [first, second],
      fileNames: { [first]: "first.txt", [second]: "second.txt" },
      providerAttempts,
    });
    expect(imported.artifacts.map((artifact) => artifact.providerAttemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
    expect(imported.artifacts.map((artifact) => artifact.seed)).toEqual([11, 22]);
    expect(imported.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "01-first.txt",
      "02-second.txt",
    ]);
  });

  it("rejects a successful attempt prepared for a different stage revision", async () => {
    const archived = join(taskDirectory, "provider-downloads", "old.txt");
    await mkdir(join(taskDirectory, "provider-downloads"), { recursive: true });
    await writeFile(archived, "old output\n");
    attempts = [attempt("prepared", { stageRevision: 2 })];
    await expect(service.resume(taskDirectory)).resolves.toMatchObject({
      action: {
        type: "cancel-provider-job",
        attemptId: "attempt-1",
        reason: "obsolete-revision",
      },
    });
    attempts = [
      attempt("succeeded", {
        stageRevision: 2,
        outputs: [
          {
            kind: "text",
            localPath: archived,
            sizeBytes: Buffer.byteLength("old output\n"),
            sha256: createHash("sha256").update("old output\n").digest("hex"),
          },
        ],
      }),
    ];
    await expect(
      service.importArtifact(taskDirectory, {
        stage: "assets",
        sourceFiles: [archived],
        provider: {
          providerId: "manual",
          capability: "image.generate",
          attemptId: "attempt-1",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("fails resume instead of advertising an import when a successful output is missing", async () => {
    attempts = [
      attempt("succeeded", {
        outputs: [
          {
            kind: "image",
            localPath: join(taskDirectory, "provider-downloads", "missing.png"),
          },
        ],
      }),
    ];

    await expect(service.resume(taskDirectory)).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("imports only the hash-bound archived output of the named durable attempt", async () => {
    const archived = join(taskDirectory, "provider-downloads", "attempt-1", "output.txt");
    const forged = join(root, "forged.txt");
    await mkdir(join(taskDirectory, "provider-downloads", "attempt-1"), { recursive: true });
    await Promise.all([
      writeFile(archived, "durable provider output\n"),
      writeFile(forged, "different file\n"),
    ]);
    const content = Buffer.from("durable provider output\n");
    attempts = [
      attempt("succeeded", {
        externalJobId: "remote-1",
        outputs: [
          {
            kind: "text",
            localPath: archived,
            sizeBytes: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      }),
    ];
    const provider = {
      providerId: "manual",
      capability: "image.generate" as const,
      attemptId: "attempt-1",
    };

    await expect(
      service.importArtifact(taskDirectory, {
        stage: "assets",
        sourceFiles: [archived],
        provider: {
          providerId: "manual",
          capability: "image.generate",
          jobId: "remote-1",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    await expect(
      service.importArtifact(taskDirectory, {
        stage: "assets",
        sourceFiles: [forged],
        provider,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const imported = await service.importArtifact(taskDirectory, {
      stage: "assets",
      sourceFiles: [archived],
      provider,
    });
    expect(imported.artifacts[0]).toMatchObject({
      providerAttemptId: "attempt-1",
      providerId: "manual",
      jobId: "remote-1",
    });
    await expect(service.resume(taskDirectory)).resolves.toMatchObject({
      action: { type: "review", stage: "assets" },
    });
  });
});

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
      Promise.resolve([{ providerId: "manual", ok: true, metadata: { checkedAt: "2026-08-10T00:00:00.000Z" } }]),
  };
}

function attempt(
  state: StoredProviderAttempt["state"],
  overrides: Partial<StoredProviderAttempt> = {},
): StoredProviderAttempt {
  return {
    attemptId: "attempt-1",
    providerId: "manual",
    capability: "image.generate",
    requestSha256: "a".repeat(64),
    idempotencyKey: "attempt-1",
    stage: "assets" satisfies WorkflowStage,
    stageRevision: 1,
    costConfirmation: {
      pricingStatus: "unknown",
      unknownPricingAcknowledged: true,
      maximumCost: 0,
      currency: "CNY",
      confirmedAt: "2026-08-10T00:00:00.000Z",
      confirmedBy: "user",
      confirmationReference: "review/provider-1",
    },
    pricingSnapshot: {
      schemaVersion: 1,
      providerId: "manual",
      capability: "image.generate",
      pricingStatus: "unknown",
      currency: "CNY",
      estimatedAt: "2026-08-10T00:00:00.000Z",
      estimateSha256: "b".repeat(64),
    },
    preparedAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    state,
    revision: 1,
    ...overrides,
  };
}
