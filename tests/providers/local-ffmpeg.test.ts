import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FinalDeliveryValidationResult } from "../../src/media/delivery.js";
import type { ExecutedMediaPlan } from "../../src/media/executor.js";
import type { MediaCommandPlan } from "../../src/media/plans.js";
import { ProviderExecutionManager } from "../../src/providers/execution-manager.js";
import { LocalFfmpegProviderAdapter } from "../../src/providers/local-ffmpeg.js";
import { ProviderRegistry } from "../../src/providers/registry.js";

const temporaryDirectories: string[] = [];
const fixedClock = { now: () => new Date("2026-08-11T00:00:00.000Z") };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LocalFfmpegProviderAdapter", () => {
  it("renders a task-scoped timeline and reuses the durable local result", async () => {
    const root = await taskDirectory();
    const clip = join(root, "06-clips", "v001", "shot-01.mp4");
    await mkdir(join(root, "06-clips", "v001"), { recursive: true });
    await writeFile(clip, "fake source clip");
    const adapter = localAdapter(root);
    const request = {
      capability: "render.timeline" as const,
      idempotencyKey: "render-v001",
      input: {
        schemaVersion: 1,
        timeline: {
          clips: [{ sourcePath: "06-clips/v001/shot-01.mp4", durationMs: 2_000 }],
          width: 324,
          height: 576,
          fps: 30,
          outputPath: "08-edit/v001/episode.mp4",
        },
      },
    };

    const first = await adapter.submit(request);
    expect(first).toMatchObject({
      providerId: "local-ffmpeg",
      capability: "render.timeline",
      state: "succeeded",
      outputs: [
        {
          kind: "video",
          mimeType: "video/mp4",
          localPath: join(root, "08-edit", "v001", "episode.mp4"),
        },
      ],
    });
    await expect(
      adapter.poll({
        capability: "render.timeline",
        remoteJobId: first.remoteJobId,
      }),
    ).resolves.toEqual(first);
    await expect(adapter.submit(request)).resolves.toEqual(first);
  });

  it("creates a contact sheet through the frozen render.timeline capability", async () => {
    const root = await taskDirectory();
    await mkdir(join(root, "05-keyframes", "v001"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "05-keyframes", "v001", "shot-01.png"), "frame one"),
      writeFile(join(root, "05-keyframes", "v001", "shot-02.png"), "frame two"),
    ]);
    const adapter = localAdapter(root);

    const result = await adapter.submit({
      capability: "render.timeline",
      idempotencyKey: "contact-sheet-v001",
      input: {
        schemaVersion: 1,
        contactSheet: {
          inputPaths: [
            "05-keyframes/v001/shot-01.png",
            "05-keyframes/v001/shot-02.png",
          ],
          outputPath: "05-keyframes/v001/contact-sheet.png",
          columns: 2,
        },
      },
    });

    expect(result.outputs).toEqual([
      expect.objectContaining({
        kind: "image",
        mimeType: "image/png",
        localPath: join(root, "05-keyframes", "v001", "contact-sheet.png"),
      }),
    ]);
  });

  it("writes a hash-verified QC report and rejects workspace escapes", async () => {
    const root = await taskDirectory();
    await mkdir(join(root, "08-edit", "v001"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "08-edit", "v001", "episode.mp4"), "video"),
      writeFile(join(root, "08-edit", "v001", "subtitles.srt"), "srt"),
      writeFile(join(root, "08-edit", "v001", "subtitles.ass"), "ass"),
    ]);
    const adapter = localAdapter(root, {
      validateFinalDelivery: async (input) => ({
        ok: true,
        checks: [],
        mediaSha256: "a".repeat(64),
        report: {
          schemaVersion: 1,
          status: "passed",
          mediaSha256: "a".repeat(64),
          subtitleSha256: { srt: "b".repeat(64), ass: "c".repeat(64) },
          generatedAt: fixedClock.now().toISOString(),
          sourceVideo: input.videoPath,
        },
      } as unknown as FinalDeliveryValidationResult),
    });

    const result = await adapter.submit({
      capability: "quality.inspect",
      idempotencyKey: "qc-v001",
      input: {
        schemaVersion: 1,
        delivery: {
          videoPath: "08-edit/v001/episode.mp4",
          srtPath: "08-edit/v001/subtitles.srt",
          assPath: "08-edit/v001/subtitles.ass",
          aiLabel: { visible: true, evidence: "Visible generated-content label" },
        },
        reportPath: "09-qc/v001/qc-report.json",
      },
    });
    const reportPath = result.outputs?.[0]?.localPath;
    expect(reportPath).toBe(join(root, "09-qc", "v001", "qc-report.json"));
    await expect(readFile(reportPath ?? "", "utf8")).resolves.toContain('"status": "passed"');

    await expect(
      adapter.submit({
        capability: "render.timeline",
        idempotencyKey: "escape-v001",
        input: {
          schemaVersion: 1,
          contactSheet: {
            inputPaths: ["../outside.png"],
            outputPath: "05-keyframes/v001/contact.png",
          },
        },
      }),
    ).rejects.toThrow(/Invalid versioned render\.timeline request/);
  });

  it("is automatically task-scoped by ProviderExecutionManager", async () => {
    const root = await taskDirectory();
    await mkdir(join(root, "06-clips", "v001"), { recursive: true });
    await writeFile(join(root, "06-clips", "v001", "shot-01.mp4"), "clip");
    const globalAdapter = localAdapter(undefined);
    const manager = new ProviderExecutionManager(new ProviderRegistry([globalAdapter]), root, {
      clock: fixedClock,
    });

    const result = await manager.submitConfirmed(
      "local-ffmpeg",
      {
        capability: "render.timeline",
        input: {
          schemaVersion: 1,
          timeline: {
            clips: [{ sourcePath: "06-clips/v001/shot-01.mp4", durationMs: 1_000 }],
            outputPath: "08-edit/v001/episode.mp4",
          },
        },
      },
      {
        stage: "edit",
        stageRevision: 1,
        costConfirmation: {
          confirmedAt: fixedClock.now().toISOString(),
          confirmedBy: "user",
          confirmationReference: "review:edit:v001:local-render",
          pricingStatus: "known",
          estimatedCost: 0,
          maximumCost: 0,
          currency: "CNY",
        },
      },
    );

    expect(result.job.outputs?.[0]?.localPath).toBe(
      join(root, "08-edit", "v001", "episode.mp4"),
    );
    await expect(readFile(join(root, "provider-jobs.jsonl"), "utf8")).resolves.toContain(
      '"providerId":"local-ffmpeg"',
    );
  });

  it("reports local FFmpeg health without invoking a shell", async () => {
    const calls: string[] = [];
    const adapter = new LocalFfmpegProviderAdapter({
      clock: fixedClock,
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      runner: async (executable) => {
        calls.push(executable);
        return { exitCode: 0, stdout: "version", stderr: "", durationMs: 1 };
      },
    });

    await expect(adapter.health()).resolves.toMatchObject({
      providerId: "local-ffmpeg",
      status: "healthy",
    });
    expect(calls).toEqual(["ffmpeg", "ffprobe"]);
  });
});

async function taskDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-ffmpeg-provider-"));
  temporaryDirectories.push(root);
  return root;
}

function localAdapter(
  taskDirectory: string | undefined,
  overrides: Partial<ConstructorParameters<typeof LocalFfmpegProviderAdapter>[0]> = {},
): LocalFfmpegProviderAdapter {
  return new LocalFfmpegProviderAdapter({
    ...(taskDirectory ? { taskDirectory } : {}),
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    clock: fixedClock,
    ids: { next: () => "local-test-id" },
    executeMediaPlan: fakeExecuteMediaPlan,
    ...overrides,
  });
}

async function fakeExecuteMediaPlan(plan: MediaCommandPlan): Promise<ExecutedMediaPlan> {
  const content = extname(plan.outputPath).toLowerCase() === ".png"
    ? Buffer.from("fake png")
    : Buffer.from("fake mp4");
  await writeFile(plan.outputPath, content, { flag: "wx" });
  return {
    outputPath: plan.outputPath,
    sizeBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    auxiliaryFiles: [],
    durationMs: 1,
  };
}
