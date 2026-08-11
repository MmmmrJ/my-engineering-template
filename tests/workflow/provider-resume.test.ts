import { mkdtemp, writeFile } from "node:fs/promises";
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
    await expect(service.resume(taskDirectory)).resolves.toMatchObject({
      action: {
        type: "import-provider-output",
        attemptId: "attempt-1",
        files: [join(taskDirectory, "provider-downloads/a.png")],
      },
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
