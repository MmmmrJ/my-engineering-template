import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PLATFORM_HANDOFF_PLAYBOOKS,
  ProviderExecutionManager,
  ProviderRegistry,
  ManualProviderAdapter,
  playbookMatchesEvidence,
  type HandoffSpendConfirmation,
} from "../../src/providers/index.js";

const temporaryDirectories: string[] = [];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("provider platform handoff", () => {
  it("persists an attempt-bound lifecycle, credit receipt, and archived output", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-handoff-"));
    temporaryDirectories.push(root);
    const uploadPath = join(root, "03-storyboard", "reference.png");
    await mkdir(join(root, "03-storyboard"), { recursive: true });
    await writeFile(uploadPath, onePixelPng, { flag: "wx" });
    const manager = handoffManager(root);

    const prepared = await manager.prepareHandoff(
      "jimeng-manual",
      {
        capability: "image.edit",
        model: "jimeng-image-v1",
        input: { prompt: "lantern town", seed: 7 },
      },
      { stage: "assets", stageRevision: 1, uploadPaths: [uploadPath] },
    );
    expect(prepared.attempt).toMatchObject({
      state: "queued",
      stage: "assets",
      stageRevision: 1,
      costConfirmation: {
        confirmedBy: "workflow",
        maximumCost: 0,
        pricingStatus: "unknown",
      },
      handoff: {
        state: "prepared",
        playbookVersion: "jimeng-cn.v1",
        surface: "chrome",
        uploads: [{ relativePath: "03-storyboard/reference.png" }],
      },
    });
    expect(await readFile(prepared.attempt.handoff?.manifestPath ?? "", "utf8"))
      .toContain('"officialOrigins"');

    await manager.recordHandoff(prepared.attempt.attemptId, {
      state: "awaiting_confirmation",
    });
    const confirmation = knownConfirmation(prepared.attempt, 12);
    await manager.confirmHandoff(prepared.attempt.attemptId, confirmation);
    await expect(
      manager.confirmHandoff(prepared.attempt.attemptId, {
        ...confirmation,
        maximumCredits: 13,
      }),
    ).rejects.toThrow(/immutable spend confirmation/i);
    await expect(
      manager.recordHandoff(prepared.attempt.attemptId, {
        state: "submitted",
        receipt: {
          externalTaskId: "jimeng-task-1",
          observedModel: "jimeng-image-v1",
          observedCredits: 13,
          creditUnit: "积分",
        },
      }),
    ).rejects.toThrow(/does not match confirmed estimate/i);

    await manager.recordHandoff(prepared.attempt.attemptId, {
      state: "submitted",
      receipt: {
        externalTaskId: "jimeng-task-1",
        observedModel: "jimeng-image-v1",
        observedCredits: 12,
        creditUnit: "积分",
      },
    });
    await manager.recordHandoff(prepared.attempt.attemptId, { state: "running" });
    await manager.recordHandoff(prepared.attempt.attemptId, {
      state: "download_ready",
      receipt: { outputCount: 1 },
    });
    const outputPath = join(root, "manual", "jimeng-manual", "downloads", "result.png");
    await mkdir(join(root, "manual", "jimeng-manual", "downloads"), {
      recursive: true,
    });
    await writeFile(outputPath, onePixelPng);
    await expect(
      manager.completeManual(prepared.attempt.attemptId, {
        outputs: [{ kind: "image", sourcePath: outputPath }],
      }),
    ).resolves.toMatchObject({ state: "succeeded" });
    const [completed] = await manager.listAttempts();
    expect(completed).toMatchObject({
      state: "succeeded",
      handoff: {
        state: "completed",
        receipt: {
          externalTaskId: "jimeng-task-1",
          observedCredits: 12,
          outputCount: 1,
        },
      },
    });
  });

  it("fails closed for outside-task uploads, changed hashes, and temporary links", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-handoff-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "provider-handoff-outside-"));
    temporaryDirectories.push(root, outside);
    const outsidePath = join(outside, "outside.png");
    await writeFile(outsidePath, onePixelPng);
    const manager = handoffManager(root);
    const request = { capability: "image.edit" as const, input: { prompt: "safe" } };

    await expect(
      manager.prepareHandoff("jimeng-manual", request, {
        stage: "assets",
        stageRevision: 1,
        uploadPaths: [outsidePath],
      }),
    ).rejects.toThrow(/outside the task workspace/i);

    const uploadPath = join(root, "reference.png");
    await writeFile(uploadPath, onePixelPng);
    const prepared = await manager.prepareHandoff("jimeng-manual", request, {
      stage: "assets",
      stageRevision: 1,
      uploadPaths: [uploadPath],
    });
    await writeFile(uploadPath, Buffer.concat([onePixelPng, Buffer.from("changed")]));
    await expect(
      manager.confirmHandoff(prepared.attempt.attemptId, knownConfirmation(prepared.attempt, 1)),
    ).rejects.toThrow(/changed after preparation/i);
    await expect(
      manager.recordHandoff(prepared.attempt.attemptId, {
        state: "blocked",
        blockedReason: "blocked_output_unavailable",
        failureReason: "open https://temporary.example/share/secret",
      }),
    ).rejects.toThrow(/must not persist URLs/i);
    expect(await readFile(join(root, "provider-jobs.jsonl"), "utf8"))
      .not.toContain("temporary.example");
  });

  it("matches every versioned playbook against its fixed semantic fixture", async () => {
    for (const [providerId, playbook] of Object.entries(PLATFORM_HANDOFF_PLAYBOOKS)) {
      const fixture = JSON.parse(
        await readFile(
          join(process.cwd(), "tests", "fixtures", "handoff", `${providerId}.json`),
          "utf8",
        ),
      ) as Parameters<typeof playbookMatchesEvidence>[1];
      expect(playbookMatchesEvidence(playbook, fixture), providerId).toBe(true);
    }
  });
});

function handoffManager(root: string): ProviderExecutionManager {
  const adapter = new ManualProviderAdapter({
    id: "jimeng-manual",
    displayName: "即梦 AI",
    adapter: "jimeng-manual",
    requestDirectory: join(root, "health", "requests"),
    resultDirectory: join(root, "health", "results"),
    capabilities: ["image.generate", "image.edit", "video.t2v", "video.i2v", "video.r2v"],
    models: [
      {
        id: "jimeng-image-v1",
        capabilities: ["image.generate", "image.edit"],
      },
    ],
  });
  return new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
    clock: { now: () => new Date("2026-08-11T00:00:00.000Z") },
  });
}

function knownConfirmation(
  attempt: Awaited<ReturnType<ProviderExecutionManager["listAttempts"]>>[number],
  credits: number,
): HandoffSpendConfirmation {
  return {
    confirmedAt: "2026-08-11T00:01:00.000Z",
    confirmedBy: "user",
    confirmationReference: `codex:${attempt.attemptId}:spend`,
    manifestSha256: attempt.handoff?.manifestSha256 ?? "",
    providerId: "jimeng-manual",
    ...(attempt.model ? { model: attempt.model } : {}),
    creditUnit: "积分",
    pricingStatus: "known",
    estimatedCredits: credits,
    maximumCredits: credits,
  };
}
