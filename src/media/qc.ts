import { resolve } from "node:path";
import type { MediaProbe } from "./ffmpeg.js";
import { DEFAULT_FINAL_DELIVERY_PROFILE } from "./profile.js";

export interface QcCommandPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly inputPath: string;
  readonly description: string;
}

export interface QcInterval {
  readonly startSeconds: number;
  readonly endSeconds?: number;
  readonly durationSeconds?: number;
}

export interface ParsedQcAnalysis {
  readonly blackFrames: readonly QcInterval[];
  readonly silences: readonly QcInterval[];
  readonly freezes: readonly QcInterval[];
  readonly integratedLoudnessLufs?: number;
  readonly truePeakDbfs?: number;
  readonly samplePeakDbfs?: number;
  readonly clippedSamples?: number;
  readonly clippingDetected: boolean;
}

export interface QcExpectations {
  readonly requireVideo?: boolean;
  readonly requireAudio?: boolean;
  readonly minDurationSeconds?: number;
  readonly maxDurationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly frameRateTolerance?: number;
  readonly minFrameRate?: number;
  readonly maxFrameRate?: number;
  readonly videoCodec?: string;
  readonly pixelFormat?: string;
  readonly audioCodec?: string;
  readonly audioSampleRate?: number;
  readonly audioChannels?: number;
  readonly maxBlackSeconds?: number;
  readonly maxSilenceSeconds?: number;
  readonly maxFreezeSeconds?: number;
  readonly integratedLoudnessTargetLufs?: number;
  readonly integratedLoudnessToleranceLufs?: number;
  readonly maxTruePeakDbfs?: number;
  readonly maxSamplePeakDbfs?: number;
  readonly maxClippedSamples?: number;
}

export interface ResolvedQcExpectations {
  readonly requireVideo: boolean;
  readonly requireAudio: boolean;
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly frameRateTolerance: number;
  readonly videoCodec: string;
  readonly pixelFormat: string;
  readonly audioCodec: string;
  readonly audioSampleRate: number;
  readonly audioChannels: number;
  readonly maxBlackSeconds: number;
  readonly maxSilenceSeconds: number;
  readonly maxFreezeSeconds: number;
  readonly integratedLoudnessTargetLufs: number;
  readonly integratedLoudnessToleranceLufs: number;
  readonly maxTruePeakDbfs: number;
  readonly maxSamplePeakDbfs: number;
  readonly maxClippedSamples: number;
  readonly minFrameRate?: number;
  readonly maxFrameRate?: number;
}

export const DEFAULT_QC_EXPECTATIONS: ResolvedQcExpectations = Object.freeze({
  requireVideo: true,
  requireAudio: true,
  minDurationSeconds: DEFAULT_FINAL_DELIVERY_PROFILE.minDurationSeconds,
  maxDurationSeconds: DEFAULT_FINAL_DELIVERY_PROFILE.maxDurationSeconds,
  width: DEFAULT_FINAL_DELIVERY_PROFILE.width,
  height: DEFAULT_FINAL_DELIVERY_PROFILE.height,
  frameRate: DEFAULT_FINAL_DELIVERY_PROFILE.frameRate,
  frameRateTolerance: DEFAULT_FINAL_DELIVERY_PROFILE.frameRateTolerance,
  videoCodec: DEFAULT_FINAL_DELIVERY_PROFILE.videoCodec,
  pixelFormat: DEFAULT_FINAL_DELIVERY_PROFILE.pixelFormat,
  audioCodec: DEFAULT_FINAL_DELIVERY_PROFILE.audioCodec,
  audioSampleRate: DEFAULT_FINAL_DELIVERY_PROFILE.audioSampleRate,
  audioChannels: DEFAULT_FINAL_DELIVERY_PROFILE.audioChannels,
  maxBlackSeconds: DEFAULT_FINAL_DELIVERY_PROFILE.maxBlackSeconds,
  maxSilenceSeconds: DEFAULT_FINAL_DELIVERY_PROFILE.maxSilenceSeconds,
  maxFreezeSeconds: DEFAULT_FINAL_DELIVERY_PROFILE.maxFreezeSeconds,
  integratedLoudnessTargetLufs: DEFAULT_FINAL_DELIVERY_PROFILE.integratedLoudnessTargetLufs,
  integratedLoudnessToleranceLufs: DEFAULT_FINAL_DELIVERY_PROFILE.integratedLoudnessToleranceLufs,
  maxTruePeakDbfs: DEFAULT_FINAL_DELIVERY_PROFILE.maxTruePeakDbfs,
  maxSamplePeakDbfs: -0.1,
  maxClippedSamples: DEFAULT_FINAL_DELIVERY_PROFILE.maxClippedSamples,
});

export interface QcFinding {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly actual?: number | string | boolean;
  readonly expected?: number | string | boolean;
}

export interface MediaQcReport {
  readonly inputPath: string;
  readonly passed: boolean;
  readonly inspectedAt: string;
  readonly expectations: ResolvedQcExpectations;
  readonly findings: readonly QcFinding[];
  readonly metrics: {
    readonly durationSeconds?: number;
    readonly width?: number;
    readonly height?: number;
    readonly frameRate?: number;
    readonly videoCodec?: string;
    readonly pixelFormat?: string;
    readonly audioCodec?: string;
    readonly audioSampleRate?: number;
    readonly audioChannels?: number;
    readonly integratedLoudnessLufs?: number;
    readonly truePeakDbfs?: number;
    readonly samplePeakDbfs?: number;
    readonly clippedSamples?: number;
    readonly blackSeconds: number;
    readonly silenceSeconds: number;
    readonly freezeSeconds: number;
  };
  readonly analysis: ParsedQcAnalysis;
}

export interface QcPlanOptions {
  readonly ffmpegPath?: string;
  readonly blackMinimumSeconds?: number;
  readonly blackPixelThreshold?: number;
  readonly silenceMinimumSeconds?: number;
  readonly silenceThresholdDb?: number;
  readonly freezeMinimumSeconds?: number;
  readonly freezeNoiseDb?: number;
}

export function createQcCommandPlan(
  inputPath: string,
  options: QcPlanOptions = {},
): QcCommandPlan {
  const absoluteInput = resolve(inputPath);
  const blackDuration = positive(options.blackMinimumSeconds ?? 0.5, "blackMinimumSeconds");
  const blackThreshold = bounded(options.blackPixelThreshold ?? 0.98, 0, 1, "blackPixelThreshold");
  const silenceDuration = positive(options.silenceMinimumSeconds ?? 2, "silenceMinimumSeconds");
  const silenceDb = finite(options.silenceThresholdDb ?? -50, "silenceThresholdDb");
  const freezeDuration = positive(options.freezeMinimumSeconds ?? 2, "freezeMinimumSeconds");
  const freezeDb = finite(options.freezeNoiseDb ?? -60, "freezeNoiseDb");
  return {
    executable: options.ffmpegPath ?? "ffmpeg",
    args: [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-i",
      absoluteInput,
      "-vf",
      `blackdetect=d=${format(blackDuration)}:pic_th=${format(blackThreshold)},` +
        `freezedetect=n=${format(freezeDb)}dB:d=${format(freezeDuration)}`,
      "-af",
      `silencedetect=n=${format(silenceDb)}dB:d=${format(silenceDuration)},` +
        "ebur128=peak=true:framelog=verbose,astats=metadata=0:reset=0",
      "-f",
      "null",
      "-",
    ],
    inputPath: absoluteInput,
    description: "Inspect black/frozen frames, silence, clipping, true peak, and EBU R128 loudness",
  };
}

export function parseQcAnalysis(stderr: string): ParsedQcAnalysis {
  const integratedLoudnessLufs = lastFiniteMatch(stderr, /\bI:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+LUFS/gi);
  const truePeakDbfs = lastFiniteMatch(stderr, /\bPeak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+dBFS/gi);
  const samplePeakDbfs = lastFiniteMatch(stderr, /Peak level dB:\s*(-?(?:\d+(?:\.\d+)?|inf))/gi);
  const clippedSamples = lastFiniteMatch(stderr, /(?:Number of )?[Cc]lipped samples:\s*(\d+(?:\.\d+)?)/g);
  const clippingDetected =
    (clippedSamples !== undefined && clippedSamples > 0) ||
    (samplePeakDbfs !== undefined && samplePeakDbfs >= 0) ||
    (truePeakDbfs !== undefined && truePeakDbfs >= 0);
  return {
    blackFrames: parseCompleteIntervals(
      stderr,
      /black_start:\s*(-?\d+(?:\.\d+)?)\s+black_end:\s*(-?\d+(?:\.\d+)?)\s+black_duration:\s*(\d+(?:\.\d+)?)/g,
    ),
    silences: parseSplitIntervals(stderr, "silence"),
    freezes: parseSplitIntervals(stderr, "freeze"),
    ...(integratedLoudnessLufs === undefined ? {} : { integratedLoudnessLufs }),
    ...(truePeakDbfs === undefined ? {} : { truePeakDbfs }),
    ...(samplePeakDbfs === undefined ? {} : { samplePeakDbfs }),
    ...(clippedSamples === undefined ? {} : { clippedSamples }),
    clippingDetected,
  };
}

export function resolveQcExpectations(expectations: QcExpectations = {}): ResolvedQcExpectations {
  return {
    ...DEFAULT_QC_EXPECTATIONS,
    ...expectations,
  };
}

export function buildQcReport(
  probe: MediaProbe,
  analysis: ParsedQcAnalysis | string,
  expectations: QcExpectations = {},
  inspectedAt = new Date().toISOString(),
): MediaQcReport {
  const parsed = typeof analysis === "string" ? parseQcAnalysis(analysis) : analysis;
  const expected = resolveQcExpectations(expectations);
  const findings: QcFinding[] = [];
  const video = probe.streams.find((stream) => stream.codecType === "video");
  const audio = probe.streams.find((stream) => stream.codecType === "audio");
  const duration = probe.format.durationSeconds ?? video?.durationSeconds;
  if (expected.requireVideo && !video) {
    findings.push(error("qc.video.missing", "Expected a video stream", false, true));
  }
  if (expected.requireAudio && !audio) {
    findings.push(error("qc.audio.missing", "Expected an audio stream", false, true));
  }
  compareMinimum(findings, "qc.duration.short", "Media duration is too short", duration, expected.minDurationSeconds);
  compareMaximum(findings, "qc.duration.long", "Media duration is too long", duration, expected.maxDurationSeconds);
  compareExact(findings, "qc.video.width", "Video width does not match", video?.width, expected.width);
  compareExact(findings, "qc.video.height", "Video height does not match", video?.height, expected.height);
  compareAspectRatio(findings, video?.width, video?.height, expected.width, expected.height);
  compareNear(
    findings,
    "qc.video.fps",
    "Video frame rate does not match",
    video?.frameRate,
    expected.frameRate,
    expected.frameRateTolerance,
  );
  compareMinimum(findings, "qc.video.fps.low", "Video frame rate is too low", video?.frameRate, expected.minFrameRate);
  compareMaximum(findings, "qc.video.fps.high", "Video frame rate is too high", video?.frameRate, expected.maxFrameRate);
  compareText(findings, "qc.video.codec", "Video codec does not match", video?.codecName, expected.videoCodec);
  compareText(findings, "qc.video.pixel_format", "Video pixel format does not match", video?.pixelFormat, expected.pixelFormat);
  compareText(findings, "qc.audio.codec", "Audio codec does not match", audio?.codecName, expected.audioCodec);
  compareExact(
    findings,
    "qc.audio.sample_rate",
    "Audio sample rate does not match",
    audio?.sampleRate,
    expected.audioSampleRate,
  );
  compareExact(findings, "qc.audio.channels", "Audio channel count does not match", audio?.channels, expected.audioChannels);

  const blackSeconds = totalDuration(parsed.blackFrames, duration);
  const silenceSeconds = totalDuration(parsed.silences, duration);
  const freezeSeconds = totalDuration(parsed.freezes, duration);
  compareMaximum(findings, "qc.black.excessive", "Black-frame duration exceeds the allowed maximum", blackSeconds, expected.maxBlackSeconds);
  compareMaximum(findings, "qc.silence.excessive", "Silence duration exceeds the allowed maximum", silenceSeconds, expected.maxSilenceSeconds);
  compareMaximum(findings, "qc.freeze.excessive", "Frozen-frame duration exceeds the allowed maximum", freezeSeconds, expected.maxFreezeSeconds);

  if (parsed.clippingDetected) {
    findings.push(error("qc.audio.clipping", "Audio analysis detected clipped samples", true, false));
  }
  if (parsed.samplePeakDbfs === undefined && parsed.truePeakDbfs === undefined && parsed.clippedSamples === undefined) {
    findings.push(error("qc.audio.clipping.unavailable", "Audio clipping analysis is missing", "missing", "measured"));
  }
  compareMaximum(
    findings,
    "qc.audio.sample_peak",
    "Audio sample peak exceeds the allowed maximum",
    parsed.samplePeakDbfs,
    expected.maxSamplePeakDbfs,
  );
  compareMaximum(
    findings,
    "qc.audio.true_peak",
    "Audio true peak exceeds the allowed maximum",
    parsed.truePeakDbfs,
    expected.maxTruePeakDbfs,
  );
  if (parsed.clippedSamples !== undefined) {
    compareMaximum(
      findings,
      "qc.audio.clipped_samples",
      "Audio contains clipped samples",
      parsed.clippedSamples,
      expected.maxClippedSamples,
    );
  }
  compareRange(
    findings,
    "qc.audio.loudness",
    "Integrated loudness is outside the delivery range",
    parsed.integratedLoudnessLufs,
    expected.integratedLoudnessTargetLufs - expected.integratedLoudnessToleranceLufs,
    expected.integratedLoudnessTargetLufs + expected.integratedLoudnessToleranceLufs,
  );

  return {
    inputPath: probe.path,
    passed: !findings.some((finding) => finding.severity === "error"),
    inspectedAt,
    expectations: expected,
    findings,
    metrics: {
      ...(duration === undefined ? {} : { durationSeconds: duration }),
      ...(video?.width === undefined ? {} : { width: video.width }),
      ...(video?.height === undefined ? {} : { height: video.height }),
      ...(video?.frameRate === undefined ? {} : { frameRate: video.frameRate }),
      ...(video?.codecName === undefined ? {} : { videoCodec: video.codecName }),
      ...(video?.pixelFormat === undefined ? {} : { pixelFormat: video.pixelFormat }),
      ...(audio?.codecName === undefined ? {} : { audioCodec: audio.codecName }),
      ...(audio?.sampleRate === undefined ? {} : { audioSampleRate: audio.sampleRate }),
      ...(audio?.channels === undefined ? {} : { audioChannels: audio.channels }),
      ...(parsed.integratedLoudnessLufs === undefined ? {} : { integratedLoudnessLufs: parsed.integratedLoudnessLufs }),
      ...(parsed.truePeakDbfs === undefined ? {} : { truePeakDbfs: parsed.truePeakDbfs }),
      ...(parsed.samplePeakDbfs === undefined ? {} : { samplePeakDbfs: parsed.samplePeakDbfs }),
      ...(parsed.clippedSamples === undefined ? {} : { clippedSamples: parsed.clippedSamples }),
      blackSeconds,
      silenceSeconds,
      freezeSeconds,
    },
    analysis: parsed,
  };
}

function parseCompleteIntervals(stderr: string, pattern: RegExp): QcInterval[] {
  return [...stderr.matchAll(pattern)].map((match) => ({
    startSeconds: Number(match[1]),
    endSeconds: Number(match[2]),
    durationSeconds: Number(match[3]),
  }));
}

function parseSplitIntervals(stderr: string, prefix: "silence" | "freeze"): QcInterval[] {
  const eventPattern = new RegExp(
    `${prefix}_(start|end):\\s*(-?\\d+(?:\\.\\d+)?)(?:\\s*\\|\\s*${prefix}_duration:\\s*(\\d+(?:\\.\\d+)?))?`,
    "g",
  );
  const intervals: QcInterval[] = [];
  let pendingStart: number | undefined;
  for (const match of stderr.matchAll(eventPattern)) {
    const value = Number(match[2]);
    if (match[1] === "start") {
      if (pendingStart !== undefined) intervals.push({ startSeconds: pendingStart });
      pendingStart = value;
      continue;
    }
    const duration = match[3] === undefined ? undefined : Number(match[3]);
    const start = pendingStart ?? (duration === undefined ? value : value - duration);
    intervals.push({
      startSeconds: start,
      endSeconds: value,
      ...(duration === undefined ? { durationSeconds: Math.max(0, value - start) } : { durationSeconds: duration }),
    });
    pendingStart = undefined;
  }
  if (pendingStart !== undefined) intervals.push({ startSeconds: pendingStart });
  return intervals;
}

function lastFiniteMatch(source: string, pattern: RegExp): number | undefined {
  let value: number | undefined;
  for (const match of source.matchAll(pattern)) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) value = parsed;
  }
  return value;
}

function totalDuration(intervals: readonly QcInterval[], mediaDuration?: number): number {
  return intervals.reduce((total, interval) => {
    const duration = interval.durationSeconds ??
      (interval.endSeconds === undefined
        ? Math.max(0, (mediaDuration ?? interval.startSeconds) - interval.startSeconds)
        : Math.max(0, interval.endSeconds - interval.startSeconds));
    return total + duration;
  }, 0);
}

function compareExact(
  findings: QcFinding[],
  code: string,
  message: string,
  actual?: number,
  expected?: number,
): void {
  if (expected !== undefined && actual !== expected) findings.push(error(code, message, actual ?? "missing", expected));
}

function compareText(
  findings: QcFinding[],
  code: string,
  message: string,
  actual?: string,
  expected?: string,
): void {
  if (expected !== undefined && actual?.toLowerCase() !== expected.toLowerCase()) {
    findings.push(error(code, message, actual ?? "missing", expected));
  }
}

function compareNear(
  findings: QcFinding[],
  code: string,
  message: string,
  actual: number | undefined,
  expected: number,
  tolerance: number,
): void {
  if (actual === undefined || Math.abs(actual - expected) > tolerance) {
    findings.push(error(code, message, actual ?? "missing", `${expected} ± ${tolerance}`));
  }
}

function compareAspectRatio(
  findings: QcFinding[],
  actualWidth: number | undefined,
  actualHeight: number | undefined,
  expectedWidth: number,
  expectedHeight: number,
): void {
  if (actualWidth === undefined || actualHeight === undefined || actualHeight === 0) {
    findings.push(error("qc.video.aspect_ratio", "Video aspect ratio is unavailable", "missing", "9:16"));
    return;
  }
  if (Math.abs(actualWidth / actualHeight - expectedWidth / expectedHeight) > 0.000_1) {
    findings.push(error("qc.video.aspect_ratio", "Video aspect ratio does not match", `${actualWidth}:${actualHeight}`, "9:16"));
  }
}

function compareMinimum(
  findings: QcFinding[],
  code: string,
  message: string,
  actual?: number,
  expected?: number,
): void {
  if (expected !== undefined && (actual === undefined || actual < expected)) {
    findings.push(error(code, message, actual ?? "missing", expected));
  }
}

function compareMaximum(
  findings: QcFinding[],
  code: string,
  message: string,
  actual?: number,
  expected?: number,
): void {
  if (expected !== undefined && (actual === undefined || actual > expected)) {
    findings.push(error(code, message, actual ?? "missing", expected));
  }
}

function compareRange(
  findings: QcFinding[],
  code: string,
  message: string,
  actual: number | undefined,
  minimum: number,
  maximum: number,
): void {
  if (actual === undefined || actual < minimum || actual > maximum) {
    findings.push(error(code, message, actual ?? "missing", `${minimum}..${maximum}`));
  }
}

function error(
  code: string,
  message: string,
  actual: number | string | boolean,
  expected: number | string | boolean,
): QcFinding {
  return { severity: "error", code, message, actual, expected };
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function format(value: number): string {
  return Number(value.toFixed(6)).toString();
}
