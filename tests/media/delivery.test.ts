import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateFinalDelivery,
  type FinalDeliveryValidatorDependencies,
} from "../../src/media/delivery.js";
import type { ProcessRunner } from "../../src/media/process.js";
import { parseQcAnalysis } from "../../src/media/qc.js";

const fixtureRoot = resolve("tests/media/fixtures");
const paths = {
  video: resolve(fixtureRoot, "episode.mp4"),
  srt: resolve(fixtureRoot, "episode.srt"),
  ass: resolve(fixtureRoot, "episode.ass"),
  qc: resolve(fixtureRoot, "episode.qc.json"),
} as const;
const hashes = {
  video: "a".repeat(64),
  srt: "b".repeat(64),
  ass: "c".repeat(64),
} as const;

describe("final delivery validation", () => {
  it("returns one serializable P0 report for a compliant delivery", async () => {
    const fixtures = await loadFixtureSet("valid");
    const result = await validateFinalDelivery(
      {
        videoPath: paths.video,
        srtPath: paths.srt,
        assPath: paths.ass,
        aiLabel: { visible: true, evidence: "edit/v003 burned-in corner label, visually inspected" },
      },
      dependencies(fixtures),
    );

    expect(result.ok).toBe(true);
    expect(result.mediaSha256).toBe(hashes.video);
    expect(result.report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      mediaSha256: hashes.video,
      subtitleSha256: { srt: hashes.srt, ass: hashes.ass },
      generatedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "codec",
        "pixelFormat",
        "resolution",
        "frameRate",
        "duration",
        "audioCodec",
        "sampleRate",
        "subtitles",
        "subtitles.burnIn",
        "blackFrames",
        "freezeFrames",
        "silence",
        "clipping",
        "loudness",
        "aiLabel.metadata",
        "aiLabel.visible",
      ]),
    );
    expect(JSON.parse(JSON.stringify(result.report))).toEqual(result.report);
  });

  it("fails all relevant checks for an invalid fixture without real FFmpeg", async () => {
    const fixtures = await loadFixtureSet("invalid");
    const result = await validateFinalDelivery(
      { videoPath: paths.video, srtPath: paths.srt, assPath: paths.ass },
      dependencies(fixtures),
    );
    const failed = result.checks.filter((check) => check.status === "fail").map((check) => check.id);

    expect(result.ok).toBe(false);
    expect(failed).toEqual(
      expect.arrayContaining([
        "codec",
        "pixelFormat",
        "resolution",
        "frameRate",
        "duration",
        "audioCodec",
        "sampleRate",
        "subtitles",
        "blackFrames",
        "freezeFrames",
        "silence",
        "clipping",
        "loudness",
        "aiLabel.metadata",
        "aiLabel.visible",
      ]),
    );
  });

  it("rejects otherwise valid media without subtitle-burn and visible-label render receipts", async () => {
    const fixtures = await loadFixtureSet("valid");
    const result = await validateFinalDelivery(
      {
        videoPath: paths.video,
        srtPath: paths.srt,
        assPath: paths.ass,
        aiLabel: { visible: true, evidence: "human review alone is insufficient" },
      },
      dependencies({
        ...fixtures,
        probe: fixtures.probe.replace(
          "; ai_label_visible=true; subtitle_ass_sha256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "",
        ),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "subtitles.burnIn", status: "fail" }),
        expect.objectContaining({ id: "aiLabel.visible", status: "fail" }),
      ]),
    );
  });

  it("rejects a stale external QC report whose hashes do not match", async () => {
    const fixtures = await loadFixtureSet("valid");
    const report = externalReport(fixtures.qcLog, {
      video: "d".repeat(64),
      srt: "e".repeat(64),
      ass: "f".repeat(64),
    });
    const deps = dependencies({ ...fixtures, qcReport: report });
    const result = await validateFinalDelivery(
      {
        videoPath: paths.video,
        srtPath: paths.srt,
        assPath: paths.ass,
        qcReportPath: paths.qc,
        aiLabel: { visible: true, evidence: "visually inspected" },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "qcReportBinding")?.status).toBe("fail");
    expect(result.report.reusedQcReportPath).toBeUndefined();
  });

  it("revalidates actual media and requires current visible-label evidence", async () => {
    const fixtures = await loadFixtureSet("valid");
    let ffmpegRuns = 0;
    const report = externalReport(fixtures.qcLog, hashes);
    const base = dependencies({ ...fixtures, qcReport: report });
    const runner: ProcessRunner = async (executable, args, options) => {
      if (executable === "ffmpeg") ffmpegRuns += 1;
      return (base.runner as ProcessRunner)(executable, args, options);
    };
    const result = await validateFinalDelivery(
      {
        videoPath: paths.video,
        srtPath: paths.srt,
        assPath: paths.ass,
        qcReportPath: paths.qc,
        aiLabel: { visible: true, evidence: "current approved edit review" },
      },
      { ...base, runner },
    );

    expect(result.ok).toBe(true);
    expect(ffmpegRuns).toBe(1);
    expect(result.report.reusedQcReportPath).toBe(paths.qc);
    expect(result.checks.find((check) => check.id === "aiLabel.visible")?.status).toBe("pass");
  });

  it("rejects a hash-bound QC report whose recorded status is failed", async () => {
    const fixtures = await loadFixtureSet("valid");
    const report = JSON.stringify({
      ...(JSON.parse(externalReport(fixtures.qcLog, hashes)) as Record<string, unknown>),
      status: "failed",
    });
    const result = await validateFinalDelivery(
      {
        videoPath: paths.video,
        srtPath: paths.srt,
        assPath: paths.ass,
        qcReportPath: paths.qc,
        aiLabel: { visible: true, evidence: "visually inspected" },
      },
      dependencies({ ...fixtures, qcReport: report }),
    );

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "qcReportBinding")?.status).toBe("fail");
    expect(result.report.reusedQcReportPath).toBeUndefined();
  });
});

interface FixtureSet {
  readonly probe: string;
  readonly qcLog: string;
  readonly srt: string;
  readonly ass: string;
  readonly qcReport?: string;
}

async function loadFixtureSet(kind: "valid" | "invalid"): Promise<FixtureSet> {
  const prefix = `delivery-${kind}`;
  const [probe, qcLog, srt, ass] = await Promise.all([
    readFile(resolve(fixtureRoot, `${prefix}-probe.json`), "utf8"),
    readFile(resolve(fixtureRoot, `${prefix}-qc.log`), "utf8"),
    readFile(resolve(fixtureRoot, `${prefix}.srt`), "utf8"),
    readFile(resolve(fixtureRoot, `${prefix}.ass`), "utf8"),
  ]);
  return { probe, qcLog, srt, ass };
}

function dependencies(fixtures: FixtureSet): FinalDeliveryValidatorDependencies {
  const runner: ProcessRunner = async (executable) => ({
    exitCode: 0,
    stdout: executable === "ffprobe" ? fixtures.probe : "",
    stderr: executable === "ffmpeg" ? fixtures.qcLog : "",
    durationMs: 1,
  });
  return {
    runner,
    readFile: async (path) => {
      if (path === paths.srt) return fixtures.srt;
      if (path === paths.ass) return fixtures.ass;
      if (path === paths.qc && fixtures.qcReport) return fixtures.qcReport;
      throw new Error(`Unexpected fixture read: ${path}`);
    },
    stat: async () => ({ size: 1, isFile: () => true }),
    hashFile: async (path) => {
      if (path === paths.video) return hashes.video;
      if (path === paths.srt) return hashes.srt;
      if (path === paths.ass) return hashes.ass;
      throw new Error(`Unexpected fixture hash: ${path}`);
    },
    now: () => "2026-08-10T00:00:00.000Z",
  };
}

function externalReport(
  qcLog: string,
  boundHashes: { readonly video: string; readonly srt: string; readonly ass: string },
): string {
  return JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    mediaSha256: boundHashes.video,
    subtitleSha256: { srt: boundHashes.srt, ass: boundHashes.ass },
    checks: [{ id: "aiLabel.visible", status: "pass" }],
    qc: { analysis: parseQcAnalysis(qcLog) },
  });
}
