import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  REQUIRED_PROVIDER_CAPABILITIES,
  WORKFLOW_STAGES,
  type AiLabelRecord,
  type ProviderFacade,
  type RightsRecord,
  type WorkflowStage,
} from "../../src/contracts/index.js";
import {
  validateFinalDelivery,
  createTimelineRenderPlan,
  executeMediaPlan,
  type FinalDeliveryExpectations,
} from "../../src/media/index.js";
import { WorkflowService } from "../../src/workflow/index.js";

const HAS_MEDIA_TOOLS = commandWorks("ffmpeg") && commandWorks("ffprobe");
const TEST_EXPECTATIONS: FinalDeliveryExpectations = {
  width: 324,
  height: 576,
  minDurationSeconds: 1.8,
  maxDurationSeconds: 2.2,
};
const AI_LABEL: AiLabelRecord = {
  aiGenerated: true,
  label: "AI-generated cartoon",
  visibleLabel: true,
  metadataEmbedded: true,
  provenanceIncluded: true,
  method: "Approved visible end-card disclosure and MP4 metadata",
  disclosure: "The approved master visibly discloses AI-generated content.",
};
const ORIGINAL_RIGHTS = {
  basis: "original" as const,
  creator: "Offline E2E Fixture",
  declaration: "This test fixture is an original synthetic production.",
};
const PROVIDER_TERMS_RIGHTS = {
  basis: "provider-terms" as const,
  providerId: "fake-offline",
  termsUrl: "https://provider.example.test/terms/commercial",
  termsReviewedAt: "2026-08-10T00:00:00.000Z",
  commercialUseConfirmed: true as const,
  thirdPartyInputsCleared: true as const,
};
const LICENSED_AUDIO_RIGHTS = {
  basis: "licensed" as const,
  work: "Synthetic offline audio fixture",
  rightsHolder: "Offline E2E Fixture",
  license: "Repository test-fixture license",
  evidence: "tests/e2e/offline.test.ts",
  scope: "Automated offline validation only",
  verifiedAt: "2026-08-10T00:00:00.000Z",
};

it.skipIf(!HAS_MEDIA_TOOLS)(
  "completes all review gates with a fake provider and exports a validated MP4 offline",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-offline-e2e-"));
    const stageSource = join(root, "stage-contract.md");
    const rawVideo = join(root, "raw-clip.mp4");
    const video = join(root, "episode.mp4");
    const srt = join(root, "subtitles.srt");
    const ass = join(root, "subtitles.ass");
    const qcPath = join(root, "qc-report.json");
    await Promise.all([
      writeFile(stageSource, "# Deterministic offline stage contract\n", "utf8"),
      writeFile(srt, "1\n00:00:00,100 --> 00:00:01,800\nAI-generated offline story\n", "utf8"),
      writeFile(
        ass,
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 324\nPlayResY: 576\n\n" +
          "[Events]\n" +
          "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
          "Dialogue: 0,0:00:00.10,0:00:01.80,Default,,0,0,0,,AI-generated offline story\n",
        "utf8",
      ),
    ]);
    generateFixtureVideo(rawVideo);
    const assSha256 = createHash("sha256").update(await readFile(ass)).digest("hex");
    await executeMediaPlan(
      createTimelineRenderPlan(
        {
          clips: [{ sourcePath: rawVideo, durationMs: 2_000, hasAudio: true }],
          subtitlePath: ass,
          subtitleFormat: "ass",
          subtitleSha256: assSha256,
          width: 324,
          height: 576,
          outputPath: video,
        },
        { overwrite: true, preset: "ultrafast", crf: 30 },
      ),
      { workspaceRoot: root, timeoutMs: 60_000 },
    );

    const initialQc = await validateFinalDelivery({
      videoPath: video,
      srtPath: srt,
      assPath: ass,
      expectations: TEST_EXPECTATIONS,
      aiLabel: { visible: true, evidence: AI_LABEL.disclosure ?? AI_LABEL.method },
    });
    expect(initialQc.ok, JSON.stringify(initialQc.checks, undefined, 2)).toBe(true);
    await writeFile(qcPath, `${JSON.stringify(initialQc.report, undefined, 2)}\n`, "utf8");

    let sequence = 0;
    const service = new WorkflowService({
      defaultRoot: root,
      providerFacade: fakeProviderFacade(),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
      deliveryValidator: (input) =>
        validateFinalDelivery({ ...input, expectations: TEST_EXPECTATIONS }),
    });
    const { taskDirectory } = await service.createTask({
      ip: "原创灯塔镇",
      theme: "在困境中互相帮助",
    });

    const rightsSources = new Map<WorkflowStage, readonly string[]>();
    for (const stage of WORKFLOW_STAGES) {
      if (stage === "assets") {
        await service.selectProviders(
          taskDirectory,
          REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
            capability,
            providerId: "fake-offline",
            mode: "api" as const,
          })),
        );
      }
      const sourceFiles =
        stage === "edit" ? [video, srt, ass] : stage === "qc" ? [qcPath] : [stageSource];
      const rights: RightsRecord | undefined =
        stage === "concept"
          ? ORIGINAL_RIGHTS
          : stage === "assets"
            ? PROVIDER_TERMS_RIGHTS
            : stage === "keyframes"
              ? derivedRights(rightsSources.get("assets"), "Approved keyframes derive from cleared assets.")
              : stage === "clips"
                ? derivedRights(rightsSources.get("keyframes"), "Approved clips derive from cleared keyframes.")
                : stage === "audio"
                  ? LICENSED_AUDIO_RIGHTS
                  : stage === "edit"
                    ? derivedRights(
                        [
                          ...(rightsSources.get("clips") ?? []),
                          ...(rightsSources.get("audio") ?? []),
                        ],
                        "The final edit combines only cleared clips and licensed audio.",
                      )
                    : undefined;
      const imported = await service.importArtifact(taskDirectory, {
        stage,
        sourceFiles,
        ...(rights ? { rights } : {}),
        ...(stage === "edit" || stage === "qc" ? { aiLabel: AI_LABEL } : {}),
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

    const exported = await service.export(taskDirectory);
    expect((await service.getState(taskDirectory)).status).toBe("completed");
    expect(await readFile(join(exported.outputDirectory, "episode.mp4"))).not.toHaveLength(0);
    expect(JSON.parse(await readFile(exported.manifestPath, "utf8"))).toMatchObject({
      input: { ip: "原创灯塔镇", theme: "在困境中互相帮助" },
      deliveryValidation: { schemaVersion: 1, status: "passed" },
    });
  },
  120_000,
);

function derivedRights(
  sourceArtifactIds: readonly string[] | undefined,
  declaration: string,
): RightsRecord {
  return {
    basis: "workflow-derived",
    sourceArtifactIds: sourceArtifactIds ?? [],
    declaration,
  };
}

function commandWorks(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
}

function generateFixtureVideo(output: string): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=324x576:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
      "-af",
      "volume=2.2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-shortest",
      output,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`FFmpeg fixture generation failed: ${result.stderr || result.error?.message}`);
  }
}

function fakeProviderFacade(): ProviderFacade {
  return {
    list: () =>
      Promise.resolve([
        {
          id: "fake-offline",
          name: "Fake offline provider",
          capabilities: REQUIRED_PROVIDER_CAPABILITIES,
          configured: true,
          metadata: {
            price: { currency: "USD", amount: 0, unit: "request" },
            dataTransfer: "local-only",
          },
        },
      ]),
    check: () =>
      Promise.resolve([
        {
          providerId: "fake-offline",
          ok: true,
          metadata: { status: "healthy", checkedAt: "2026-08-10T00:00:00.000Z" },
        },
      ]),
  };
}
