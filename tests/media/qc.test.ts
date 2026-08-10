import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { normalizeProbe } from "../../src/media/ffmpeg.js";
import { buildQcReport, createQcCommandPlan, parseQcAnalysis } from "../../src/media/qc.js";

const validProbeUrl = new URL("./fixtures/delivery-valid-probe.json", import.meta.url);
const invalidProbeUrl = new URL("./fixtures/delivery-invalid-probe.json", import.meta.url);
const validLogUrl = new URL("./fixtures/delivery-valid-qc.log", import.meta.url);
const invalidLogUrl = new URL("./fixtures/delivery-invalid-qc.log", import.meta.url);

describe("quality inspection helpers", () => {
  it("creates one no-output inspection plan for video and audio defects", async () => {
    const plan = createQcCommandPlan("episode.mp4");
    expect(plan.args.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(plan.args.join(" ")).toContain("blackdetect");
    expect(plan.args.join(" ")).toContain("silencedetect");
    expect(plan.args.join(" ")).toContain("freezedetect");
    expect(plan.args.join(" ")).toContain("ebur128=peak=true");
    expect(plan.args.join(" ")).toContain("astats=");

    const parsed = parseQcAnalysis(await readFile(validLogUrl, "utf8"));
    expect(parsed).toMatchObject({
      blackFrames: [{ startSeconds: 0, endSeconds: 0.2, durationSeconds: 0.2 }],
      integratedLoudnessLufs: -14,
      truePeakDbfs: -1.5,
      samplePeakDbfs: -2,
      clippedSamples: 0,
      clippingDetected: false,
    });
  });

  it("passes a compliant Chinese vertical delivery under default expectations", async () => {
    const probe = normalizeProbe(JSON.parse(await readFile(validProbeUrl, "utf8")) as unknown, "episode.mp4");
    const report = buildQcReport(probe, await readFile(validLogUrl, "utf8"), {}, "2026-08-10T00:00:00.000Z");
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.metrics).toMatchObject({
      durationSeconds: 75,
      width: 1080,
      height: 1920,
      frameRate: 30,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      audioSampleRate: 48000,
      blackSeconds: 0.2,
      silenceSeconds: 1,
      freezeSeconds: 1,
      integratedLoudnessLufs: -14,
    });
  });

  it("reports every blocking delivery defect with stable codes", async () => {
    const probe = normalizeProbe(JSON.parse(await readFile(invalidProbeUrl, "utf8")) as unknown, "bad.mp4");
    const report = buildQcReport(probe, await readFile(invalidLogUrl, "utf8"));
    const codes = report.findings.map((finding) => finding.code);
    expect(report.passed).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        "qc.duration.short",
        "qc.video.width",
        "qc.video.height",
        "qc.video.aspect_ratio",
        "qc.video.fps",
        "qc.video.codec",
        "qc.video.pixel_format",
        "qc.audio.codec",
        "qc.audio.sample_rate",
        "qc.audio.channels",
        "qc.black.excessive",
        "qc.silence.excessive",
        "qc.freeze.excessive",
        "qc.audio.clipping",
        "qc.audio.true_peak",
        "qc.audio.clipped_samples",
        "qc.audio.loudness",
      ]),
    );
  });
});
