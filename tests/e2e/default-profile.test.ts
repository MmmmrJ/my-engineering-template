import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createTimelineRenderPlan,
  executeMediaPlan,
  validateFinalDelivery,
} from "../../src/media/index.js";

const ENABLED =
  process.env.AI_CARTOON_FULL_MEDIA_E2E === "1" &&
  commandWorks("ffmpeg") &&
  commandWorks("ffprobe");

it.skipIf(!ENABLED)(
  "renders and validates the complete default 1080x1920, 60-second delivery profile",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-default-media-e2e-"));
    const raw = join(root, "raw.mp4");
    const video = join(root, "episode.mp4");
    const srt = join(root, "subtitles.srt");
    const ass = join(root, "subtitles.ass");
    await Promise.all([
      writeFile(
        srt,
        "1\n00:00:01,000 --> 00:00:59,000\nAI-generated default-profile verification\n",
        "utf8",
      ),
      writeFile(
        ass,
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n" +
          "[Events]\n" +
          "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
          "Dialogue: 0,0:00:01.00,0:00:59.00,Default,,0,0,0,,AI-generated default-profile verification\n",
        "utf8",
      ),
    ]);
    generateRawFixture(raw);
    const assSha256 = createHash("sha256").update(await readFile(ass)).digest("hex");
    await executeMediaPlan(
      createTimelineRenderPlan(
        {
          clips: [{ sourcePath: raw, durationMs: 60_000, hasAudio: true }],
          subtitlePath: ass,
          subtitleFormat: "ass",
          subtitleSha256: assSha256,
          outputPath: video,
        },
        { overwrite: true, preset: "ultrafast", crf: 32, threads: 2 },
      ),
      { workspaceRoot: root, timeoutMs: 240_000 },
    );

    const validation = await validateFinalDelivery({
      videoPath: video,
      srtPath: srt,
      assPath: ass,
      aiLabel: {
        visible: true,
        evidence: "Deterministic renderer burned the generated AI disclosure overlay.",
      },
    });
    expect(validation.ok, JSON.stringify(validation.checks, undefined, 2)).toBe(true);
    expect(validation.report.qc.metrics).toMatchObject({
      width: 1_080,
      height: 1_920,
      frameRate: 30,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      audioSampleRate: 48_000,
    });
    expect(validation.report.qc.metrics.durationSeconds).toBeGreaterThanOrEqual(60);
    expect(validation.report.subtitles.burnInReceipt).toEqual({
      format: "ass",
      sha256: assSha256,
    });
  },
  300_000,
);

function commandWorks(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
}

function generateRawFixture(output: string): void {
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
      "testsrc2=size=270x480:rate=30:duration=60",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=60",
      "-af",
      "volume=2.2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "32",
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
    { encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    throw new Error(`FFmpeg default fixture generation failed: ${result.stderr || result.error?.message}`);
  }
}
