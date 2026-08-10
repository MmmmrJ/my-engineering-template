import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { validateAss, type AssValidationReport } from "./ass.js";
import { probeMedia, type MediaProbe } from "./ffmpeg.js";
import type { ProcessRunner } from "./process.js";
import { runChecked, runProcess } from "./process.js";
import {
  buildQcReport,
  createQcCommandPlan,
  parseQcAnalysis,
  type MediaQcReport,
  type ParsedQcAnalysis,
  type QcExpectations,
} from "./qc.js";
import { validateSrt, type SrtValidationReport } from "./srt.js";

export interface FinalDeliveryExpectations extends QcExpectations {
  readonly subtitleTimingToleranceMs?: number;
}

export type FinalDeliveryCheckId =
  | "hashes"
  | "qcReportBinding"
  | "codec"
  | "pixelFormat"
  | "resolution"
  | "frameRate"
  | "duration"
  | "audioCodec"
  | "sampleRate"
  | "subtitles"
  | "subtitles.burnIn"
  | "blackFrames"
  | "freezeFrames"
  | "silence"
  | "clipping"
  | "loudness"
  | "aiLabel.metadata"
  | "aiLabel.visible";

export interface FinalDeliveryCheck {
  readonly id: FinalDeliveryCheckId;
  readonly status: "pass" | "fail";
  readonly message: string;
  readonly actual?: unknown;
  readonly expected?: unknown;
}

export interface FinalDeliveryReport {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly mediaPath: string;
  readonly subtitlePaths: {
    readonly srt: string;
    readonly ass: string;
  };
  readonly mediaSha256: string;
  readonly subtitleSha256: {
    readonly srt: string;
    readonly ass: string;
  };
  readonly checks: readonly FinalDeliveryCheck[];
  readonly generatedAt: string;
  readonly probe: MediaProbe;
  readonly qc: MediaQcReport;
  readonly subtitles: {
    readonly srt: SrtValidationReport;
    readonly ass: AssValidationReport;
    readonly burnInReceipt?: {
      readonly format: "srt" | "ass";
      readonly sha256: string;
    };
  };
  readonly aiLabel: {
    readonly metadata?: { readonly key: string; readonly value: string };
    readonly visibleEvidence?: string;
    readonly renderReceipt?: string;
  };
  readonly reusedQcReportPath?: string;
}

export interface FinalDeliveryValidationInput {
  readonly videoPath: string;
  readonly srtPath: string;
  readonly assPath: string;
  readonly qcReportPath?: string;
  readonly expectations?: FinalDeliveryExpectations;
  readonly aiLabel?: {
    readonly visible: boolean;
    readonly evidence: string;
  };
}

export interface FinalDeliveryValidationResult {
  readonly ok: boolean;
  readonly checks: readonly FinalDeliveryCheck[];
  readonly mediaSha256: string;
  readonly report: FinalDeliveryReport;
}

export interface FinalDeliveryFileStat {
  readonly size: number;
  isFile(): boolean;
}

export interface FinalDeliveryValidatorDependencies {
  readonly runner?: ProcessRunner;
  readonly readFile?: (path: string) => Promise<string>;
  readonly stat?: (path: string) => Promise<FinalDeliveryFileStat>;
  readonly hashFile?: (path: string) => Promise<string>;
  readonly now?: () => string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
}

interface ReusableQcReport {
  readonly status: "passed" | "failed";
  readonly mediaSha256: string;
  readonly subtitleSha256: {
    readonly srt: string;
    readonly ass: string;
  };
}

interface DeliveryRenderReceipt {
  readonly aiLabelVisible: boolean;
  readonly raw?: string;
  readonly subtitle?: {
    readonly format: "srt" | "ass";
    readonly sha256: string;
  };
}

/**
 * Validates one immutable delivery set. Bad media returns `ok: false`; invalid
 * arguments, unreadable files, and unavailable media tools are operational
 * errors and reject the promise.
 */
export async function validateFinalDelivery(
  input: FinalDeliveryValidationInput,
  dependencies: FinalDeliveryValidatorDependencies = {},
): Promise<FinalDeliveryValidationResult> {
  assertInputPaths(input);
  const readText = dependencies.readFile ?? ((path: string) => readFile(path, "utf8"));
  const getStat = dependencies.stat ?? stat;
  const hash = dependencies.hashFile ?? sha256File;
  const runner = dependencies.runner ?? runProcess;
  const generatedAt = dependencies.now?.() ?? new Date().toISOString();
  const paths = [input.videoPath, input.srtPath, input.assPath] as const;
  const fileStats = await Promise.all(paths.map((path) => getStat(path)));
  for (const [index, fileStat] of fileStats.entries()) {
    if (!fileStat.isFile()) throw new TypeError(`Final delivery path is not a file: ${paths[index]}`);
  }

  const [mediaSha256, srtSha256, assSha256, srtSource, assSource, probe] = await Promise.all([
    hash(input.videoPath),
    hash(input.srtPath),
    hash(input.assPath),
    readText(input.srtPath),
    readText(input.assPath),
    probeMedia(input.videoPath, {
      ffprobePath: dependencies.ffprobePath,
      runner,
    }),
  ]);
  assertSha256(mediaSha256, "video");
  assertSha256(srtSha256, "SRT");
  assertSha256(assSha256, "ASS");

  const currentHashes = {
    mediaSha256,
    subtitleSha256: { srt: srtSha256, ass: assSha256 },
  } as const;
  const renderReceipt = findRenderReceipt(probe, currentHashes.subtitleSha256);
  let reusableReport: ReusableQcReport | undefined;
  let reportBindingMatches = input.qcReportPath === undefined;
  if (input.qcReportPath) {
    reusableReport = parseReusableQcReport(await readText(input.qcReportPath));
    reportBindingMatches =
      reusableReport.status === "passed" &&
      reusableReport.mediaSha256 === mediaSha256 &&
      reusableReport.subtitleSha256.srt === srtSha256 &&
      reusableReport.subtitleSha256.ass === assSha256;
  }

  // Export is the final trust boundary. Always inspect the actual immutable
  // media instead of trusting analysis copied into an editable JSON report.
  const analysis = await inspectDeliveryMedia(input.videoPath, runner, dependencies.ffmpegPath);
  const { subtitleTimingToleranceMs = 100, ...qcExpectations } = input.expectations ?? {};
  const qc = buildQcReport(probe, analysis, qcExpectations, generatedAt);
  const srtReport = validateSrt(srtSource);
  const assReport = validateAss(assSource);
  const checks = buildFinalDeliveryChecks(
    qc,
    srtReport,
    assReport,
    reportBindingMatches,
    input.qcReportPath,
    subtitleTimingToleranceMs,
    currentHashes,
    probe,
    input.aiLabel,
    renderReceipt,
  );
  const status = checks.some((check) => check.status === "fail") ? "failed" : "passed";
  const report: FinalDeliveryReport = {
    schemaVersion: 1,
    status,
    mediaPath: input.videoPath,
    subtitlePaths: { srt: input.srtPath, ass: input.assPath },
    mediaSha256,
    subtitleSha256: currentHashes.subtitleSha256,
    checks,
    generatedAt,
    probe,
    qc,
    subtitles: {
      srt: srtReport,
      ass: assReport,
      ...(renderReceipt.subtitle ? { burnInReceipt: renderReceipt.subtitle } : {}),
    },
    aiLabel: {
      ...(findAiLabelMetadata(probe) ?? {}),
      ...(input.aiLabel?.visible && input.aiLabel.evidence.trim()
        ? { visibleEvidence: input.aiLabel.evidence.trim() }
        : {}),
      ...(renderReceipt.raw ? { renderReceipt: renderReceipt.raw } : {}),
    },
    ...(input.qcReportPath && reportBindingMatches ? { reusedQcReportPath: input.qcReportPath } : {}),
  };
  return { ok: status === "passed", checks, mediaSha256, report };
}

async function inspectDeliveryMedia(
  videoPath: string,
  runner: ProcessRunner,
  ffmpegPath?: string,
): Promise<ParsedQcAnalysis> {
  const plan = createQcCommandPlan(videoPath, { ffmpegPath });
  const result = await runChecked(runner, plan.executable, plan.args, {
    timeoutMs: 15 * 60_000,
    maxOutputBytes: 25 * 1_024 * 1_024,
  });
  return parseQcAnalysis(result.stderr);
}

function buildFinalDeliveryChecks(
  qc: MediaQcReport,
  srt: SrtValidationReport,
  ass: AssValidationReport,
  reportBindingMatches: boolean,
  qcReportPath: string | undefined,
  subtitleTimingToleranceMs: number,
  hashes: {
    readonly mediaSha256: string;
    readonly subtitleSha256: { readonly srt: string; readonly ass: string };
  },
  probe: MediaProbe,
  aiLabel: FinalDeliveryValidationInput["aiLabel"],
  renderReceipt: DeliveryRenderReceipt,
): readonly FinalDeliveryCheck[] {
  const failedCodes = new Set(qc.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code));
  const durationMs = (qc.metrics.durationSeconds ?? 0) * 1_000;
  const subtitleTimingValid =
    srt.valid &&
    ass.valid &&
    srt.cues.length > 0 &&
    srt.cues.length === ass.cues.length &&
    srt.durationMs <= durationMs + subtitleTimingToleranceMs &&
    ass.durationMs <= durationMs + subtitleTimingToleranceMs &&
    srt.cues.every((cue, index) => {
      const assCue = ass.cues[index];
      return assCue !== undefined &&
        Math.abs(cue.startMs - assCue.startMs) <= subtitleTimingToleranceMs &&
        Math.abs(cue.endMs - assCue.endMs) <= subtitleTimingToleranceMs;
    });
  const aiMetadata = findAiLabelMetadata(probe)?.metadata;
  const visibleEvidence = aiLabel?.visible === true && Boolean(aiLabel.evidence.trim());

  return [
    pass("hashes", "Delivery files are bound by SHA-256", hashes),
    reportBindingMatches
      ? pass(
          "qcReportBinding",
          qcReportPath ? "External QC report hashes match this delivery" : "QC was generated for this delivery",
          qcReportPath ?? "generated",
        )
      : fail(
          "qcReportBinding",
          "External QC report is not a passed report bound to this delivery",
          qcReportPath,
          hashes,
        ),
    fromQc(
      "codec",
      "Video codec is H.264",
      failedCodes,
      ["qc.video.missing", "qc.video.codec"],
      qc.metrics.videoCodec,
      qc.expectations.videoCodec,
    ),
    fromQc(
      "pixelFormat",
      "Video pixel format is yuv420p",
      failedCodes,
      ["qc.video.missing", "qc.video.pixel_format"],
      qc.metrics.pixelFormat,
      qc.expectations.pixelFormat,
    ),
    fromQc(
      "resolution",
      "Video is 1080x1920 at 9:16",
      failedCodes,
      ["qc.video.missing", "qc.video.width", "qc.video.height", "qc.video.aspect_ratio"],
      `${qc.metrics.width ?? "missing"}x${qc.metrics.height ?? "missing"}`,
      `${qc.expectations.width}x${qc.expectations.height} (9:16)`,
    ),
    fromQc(
      "frameRate",
      "Video frame rate is 30 fps",
      failedCodes,
      ["qc.video.missing", "qc.video.fps", "qc.video.fps.low", "qc.video.fps.high"],
      qc.metrics.frameRate,
      `${qc.expectations.frameRate} ± ${qc.expectations.frameRateTolerance}`,
    ),
    fromQc(
      "duration",
      "Duration is within 60-90 seconds",
      failedCodes,
      ["qc.duration.short", "qc.duration.long"],
      qc.metrics.durationSeconds,
      `${qc.expectations.minDurationSeconds}-${qc.expectations.maxDurationSeconds}`,
    ),
    fromQc(
      "audioCodec",
      "Audio codec is AAC",
      failedCodes,
      ["qc.audio.missing", "qc.audio.codec", "qc.audio.channels"],
      qc.metrics.audioCodec,
      `${qc.expectations.audioCodec}/${qc.expectations.audioChannels}ch`,
    ),
    fromQc(
      "sampleRate",
      "Audio sample rate is 48 kHz",
      failedCodes,
      ["qc.audio.missing", "qc.audio.sample_rate"],
      qc.metrics.audioSampleRate,
      qc.expectations.audioSampleRate,
    ),
    subtitleTimingValid
      ? pass("subtitles", "SRT and ASS exist, parse, align, and end within the video", {
          cueCount: srt.cues.length,
          durationMs: srt.durationMs,
        })
      : fail(
          "subtitles",
          "SRT/ASS are missing, invalid, misaligned, or outside the video duration",
          {
            srtValid: srt.valid,
            assValid: ass.valid,
            srtCueCount: srt.cues.length,
            assCueCount: ass.cues.length,
            srtDurationMs: srt.durationMs,
            assDurationMs: ass.durationMs,
            mediaDurationMs: durationMs,
          },
          `matching cues within ±${subtitleTimingToleranceMs}ms`,
        ),
    renderReceipt.subtitle
      ? pass(
          "subtitles.burnIn",
          "MP4 metadata binds the subtitle file used by the deterministic burn-in renderer",
          renderReceipt.subtitle,
        )
      : fail(
          "subtitles.burnIn",
          "MP4 is missing a subtitle burn-in receipt bound to the current SRT or ASS hash",
          probe.format.tags ?? "missing",
          `subtitle_srt_sha256=${hashes.subtitleSha256.srt} or subtitle_ass_sha256=${hashes.subtitleSha256.ass}`,
        ),
    fromQc(
      "blackFrames",
      "Black-frame duration is within the threshold",
      failedCodes,
      ["qc.black.excessive"],
      qc.metrics.blackSeconds,
      `<=${qc.expectations.maxBlackSeconds}`,
    ),
    fromQc(
      "freezeFrames",
      "Frozen-frame duration is within the threshold",
      failedCodes,
      ["qc.freeze.excessive"],
      qc.metrics.freezeSeconds,
      `<=${qc.expectations.maxFreezeSeconds}`,
    ),
    fromQc(
      "silence",
      "Silence duration is within the threshold",
      failedCodes,
      ["qc.silence.excessive"],
      qc.metrics.silenceSeconds,
      `<=${qc.expectations.maxSilenceSeconds}`,
    ),
    fromQc(
      "clipping",
      "Audio peak and clipping checks pass",
      failedCodes,
      ["qc.audio.clipping", "qc.audio.clipping.unavailable", "qc.audio.sample_peak", "qc.audio.true_peak", "qc.audio.clipped_samples"],
      {
        ...(qc.metrics.truePeakDbfs === undefined ? {} : { truePeakDbfs: qc.metrics.truePeakDbfs }),
        ...(qc.metrics.samplePeakDbfs === undefined ? {} : { samplePeakDbfs: qc.metrics.samplePeakDbfs }),
        ...(qc.metrics.clippedSamples === undefined ? {} : { clippedSamples: qc.metrics.clippedSamples }),
      },
      { maxTruePeakDbfs: qc.expectations.maxTruePeakDbfs, maxClippedSamples: qc.expectations.maxClippedSamples },
    ),
    fromQc(
      "loudness",
      "Integrated loudness is within the delivery range",
      failedCodes,
      ["qc.audio.loudness"],
      qc.metrics.integratedLoudnessLufs,
      `${qc.expectations.integratedLoudnessTargetLufs} ± ${qc.expectations.integratedLoudnessToleranceLufs} LUFS`,
    ),
    aiMetadata
      ? pass("aiLabel.metadata", "MP4 metadata declares AI-generated content", aiMetadata)
      : fail(
          "aiLabel.metadata",
          "MP4 metadata must declare AI-generated content",
          probe.format.tags ?? "missing",
          "comment/description/dedicated tag containing AI-generated or 人工智能生成",
        ),
    visibleEvidence && renderReceipt.aiLabelVisible
      ? pass(
          "aiLabel.visible",
          "Visible AI label evidence and the deterministic render receipt are bound to this media hash",
          { evidence: aiLabel?.evidence.trim(), receipt: renderReceipt.raw },
          hashes.mediaSha256,
        )
      : fail(
          "aiLabel.visible",
          "Visible AI label requires both explicit review evidence and an MP4 render receipt",
          { aiLabel: aiLabel ?? "missing", receipt: renderReceipt.raw ?? "missing" },
          "visible=true with evidence and ai_label_visible=true in the rendered MP4 metadata",
        ),
  ];
}

function fromQc(
  id: FinalDeliveryCheckId,
  message: string,
  failedCodes: ReadonlySet<string>,
  relevantCodes: readonly string[],
  actual?: unknown,
  expected?: unknown,
): FinalDeliveryCheck {
  return relevantCodes.some((code) => failedCodes.has(code))
    ? fail(id, message, actual, expected)
    : pass(id, message, actual, expected);
}

function pass(
  id: FinalDeliveryCheckId,
  message: string,
  actual?: unknown,
  expected?: unknown,
): FinalDeliveryCheck {
  return { id, status: "pass", message, ...(actual === undefined ? {} : { actual }), ...(expected === undefined ? {} : { expected }) };
}

function fail(
  id: FinalDeliveryCheckId,
  message: string,
  actual?: unknown,
  expected?: unknown,
): FinalDeliveryCheck {
  return { id, status: "fail", message, ...(actual === undefined ? {} : { actual }), ...(expected === undefined ? {} : { expected }) };
}

function parseReusableQcReport(source: string): ReusableQcReport {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError("QC report is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== 1) throw new TypeError("QC report schemaVersion must be 1");
  if (value.status !== "passed" && value.status !== "failed") {
    throw new TypeError("QC report status must be passed or failed");
  }
  if (!Array.isArray(value.checks)) throw new TypeError("QC report is missing checks");
  if (typeof value.mediaSha256 !== "string") throw new TypeError("QC report is missing mediaSha256");
  if (!isRecord(value.subtitleSha256) || typeof value.subtitleSha256.srt !== "string" || typeof value.subtitleSha256.ass !== "string") {
    throw new TypeError("QC report is missing subtitleSha256 bindings");
  }
  return {
    status: value.status,
    mediaSha256: value.mediaSha256,
    subtitleSha256: { srt: value.subtitleSha256.srt, ass: value.subtitleSha256.ass },
  };
}

function findRenderReceipt(
  probe: MediaProbe,
  subtitleHashes: { readonly srt: string; readonly ass: string },
): DeliveryRenderReceipt {
  const raw = Object.values(probe.format.tags ?? {}).join("; ");
  const aiLabelVisible = /(?:^|[;\s])ai_label_visible=(?:true|1)(?:$|[;\s])/i.test(raw);
  const subtitleMatch = /(?:^|[;\s])subtitle_(srt|ass)_sha256=([a-f\d]{64})(?:$|[;\s])/i.exec(raw);
  const format = subtitleMatch?.[1]?.toLowerCase();
  const sha256 = subtitleMatch?.[2]?.toLowerCase();
  let subtitle: DeliveryRenderReceipt["subtitle"];
  if ((format === "srt" || format === "ass") && sha256 === subtitleHashes[format]) {
    subtitle = { format, sha256 };
  }
  return {
    aiLabelVisible,
    ...(raw ? { raw } : {}),
    ...(subtitle ? { subtitle } : {}),
  };
}

function findAiLabelMetadata(
  probe: MediaProbe,
): { readonly metadata: { readonly key: string; readonly value: string } } | undefined {
  const match = Object.entries(probe.format.tags ?? {}).find(([key, value]) => {
    const normalizedKey = key.toLowerCase();
    const explicitFalse = /^(?:0|false|no|none)$/i.test(value.trim());
    return (
      (!explicitFalse && /ai[_ -]?(?:generated|label)|artificial[_ -]?intelligence/.test(normalizedKey)) ||
      /(?:ai[- ]?generated|人工智能生成|ai生成|生成合成内容)/i.test(value)
    );
  });
  return match ? { metadata: { key: match[0], value: match[1] } } : undefined;
}

function assertInputPaths(input: FinalDeliveryValidationInput): void {
  const entries = [
    ["videoPath", input.videoPath, ".mp4"],
    ["srtPath", input.srtPath, ".srt"],
    ["assPath", input.assPath, ".ass"],
    ...(input.qcReportPath ? [["qcReportPath", input.qcReportPath, ".json"]] : []),
  ] as const;
  for (const [name, path, extension] of entries) {
    if (!isAbsolute(path)) throw new TypeError(`${name} must be an absolute path`);
    if (extname(path).toLowerCase() !== extension) throw new TypeError(`${name} must end in ${extension}`);
  }
  const tolerance = input.expectations?.subtitleTimingToleranceMs;
  if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0)) {
    throw new TypeError("subtitleTimingToleranceMs must be a non-negative number");
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new TypeError(`${label} hash must be a SHA-256 hex digest`);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
