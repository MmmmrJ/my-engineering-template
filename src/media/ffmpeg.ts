import { resolve } from "node:path";
import type { ProcessRunner } from "./process.js";
import { MediaProcessError, runChecked, runProcess } from "./process.js";

export interface MediaToolStatus {
  readonly executable: string;
  readonly available: boolean;
  readonly version?: string;
  readonly message?: string;
  readonly latencyMs: number;
}

export interface MediaDoctorReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly ffmpeg: MediaToolStatus;
  readonly ffprobe: MediaToolStatus;
}

export interface MediaDoctorOptions {
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
}

export interface ProbedMediaStream {
  readonly index: number;
  readonly codecType?: string;
  readonly codecName?: string;
  readonly pixelFormat?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly frameRate?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly channelLayout?: string;
  readonly language?: string;
}

export interface ProbedMediaFormat {
  readonly formatName?: string;
  readonly formatLongName?: string;
  readonly durationSeconds?: number;
  readonly sizeBytes?: number;
  readonly bitRate?: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface MediaProbe {
  readonly path: string;
  readonly streams: readonly ProbedMediaStream[];
  readonly format: ProbedMediaFormat;
}

export interface ProbeMediaOptions {
  readonly ffprobePath?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
}

export async function doctorMediaTools(
  options: MediaDoctorOptions = {},
): Promise<MediaDoctorReport> {
  const runner = options.runner ?? runProcess;
  const [ffmpeg, ffprobe] = await Promise.all([
    checkTool(options.ffmpegPath ?? "ffmpeg", runner, options.timeoutMs ?? 10_000),
    checkTool(options.ffprobePath ?? "ffprobe", runner, options.timeoutMs ?? 10_000),
  ]);
  return {
    ok: ffmpeg.available && ffprobe.available,
    checkedAt: new Date().toISOString(),
    ffmpeg,
    ffprobe,
  };
}

export async function probeMedia(
  path: string,
  options: ProbeMediaOptions = {},
): Promise<MediaProbe> {
  const absolutePath = resolve(path);
  const executable = options.ffprobePath ?? "ffprobe";
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ] as const;
  const result = await runChecked(options.runner ?? runProcess, executable, args, {
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: 20 * 1_024 * 1_024,
  });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new MediaProcessError("ffprobe returned invalid JSON", {
      executable,
      args,
      exitCode: result.exitCode,
      stderr: result.stderr,
      cause: error,
    });
  }
  return normalizeProbe(value, absolutePath);
}

export function normalizeProbe(value: unknown, path: string): MediaProbe {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaProcessError("ffprobe JSON root must be an object", {
      executable: "ffprobe",
      args: [],
    });
  }
  const root = value as Record<string, unknown>;
  const streams = Array.isArray(root.streams)
    ? root.streams.map(normalizeStream).filter((entry): entry is ProbedMediaStream => entry !== undefined)
    : [];
  const rawFormat =
    root.format !== null && typeof root.format === "object" && !Array.isArray(root.format)
      ? (root.format as Record<string, unknown>)
      : {};
  const tags = stringRecord(rawFormat.tags);
  return {
    path,
    streams,
    format: {
      ...optionalString("formatName", rawFormat.format_name),
      ...optionalString("formatLongName", rawFormat.format_long_name),
      ...optionalNumber("durationSeconds", rawFormat.duration),
      ...optionalNumber("sizeBytes", rawFormat.size),
      ...optionalNumber("bitRate", rawFormat.bit_rate),
      ...(tags ? { tags } : {}),
    },
  };
}

async function checkTool(
  executable: string,
  runner: ProcessRunner,
  timeoutMs: number,
): Promise<MediaToolStatus> {
  const startedAt = performance.now();
  try {
    const result = await runner(executable, ["-version"], { timeoutMs, maxOutputBytes: 1_024 * 1_024 });
    const firstLine = (result.stdout || result.stderr).split(/\r?\n/, 1)[0]?.trim();
    return {
      executable,
      available: result.exitCode === 0,
      ...(firstLine ? { version: firstLine } : {}),
      ...(result.exitCode === 0 ? {} : { message: `Exited with code ${result.exitCode}` }),
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      executable,
      available: false,
      message: error instanceof Error ? error.message : "Tool check failed",
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}

function normalizeStream(value: unknown, fallbackIndex: number): ProbedMediaStream | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stream = value as Record<string, unknown>;
  const tags = stringRecord(stream.tags);
  return {
    index: numeric(stream.index) ?? fallbackIndex,
    ...optionalString("codecType", stream.codec_type),
    ...optionalString("codecName", stream.codec_name),
    ...optionalString("pixelFormat", stream.pix_fmt),
    ...optionalNumber("width", stream.width),
    ...optionalNumber("height", stream.height),
    ...optionalNumber("durationSeconds", stream.duration),
    ...optionalRational("frameRate", stream.avg_frame_rate ?? stream.r_frame_rate),
    ...optionalNumber("sampleRate", stream.sample_rate),
    ...optionalNumber("channels", stream.channels),
    ...optionalString("channelLayout", stream.channel_layout),
    ...(tags?.language ? { language: tags.language } : {}),
  };
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function rational(value: unknown): number | undefined {
  if (typeof value !== "string") return numeric(value);
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) return numeric(value);
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return denominator > 0 ? numerator / denominator : undefined;
}

function optionalString<Key extends string>(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: string } {
  return typeof value === "string" && value ? ({ [key]: value } as { [Property in Key]: string }) : {};
}

function optionalNumber<Key extends string>(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: number } {
  const parsed = numeric(value);
  return parsed === undefined ? {} : ({ [key]: parsed } as { [Property in Key]: number });
}

function optionalRational<Key extends string>(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: number } {
  const parsed = rational(value);
  return parsed === undefined ? {} : ({ [key]: parsed } as { [Property in Key]: number });
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
