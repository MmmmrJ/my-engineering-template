import { extname, resolve } from "node:path";
import { DEFAULT_FINAL_DELIVERY_PROFILE } from "./profile.js";

export interface AuxiliaryFile {
  readonly path: string;
  readonly content: string;
}

export interface MediaCommandPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly auxiliaryFiles: readonly AuxiliaryFile[];
  readonly outputPath: string;
  readonly description: string;
}

export interface ConcatPlanOptions {
  readonly ffmpegPath?: string;
  readonly listFilePath?: string;
  readonly overwrite?: boolean;
  readonly copyCodecs?: boolean;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly crf?: number;
  readonly preset?: string;
  readonly audioBitRate?: string;
  readonly threads?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly sampleRate?: number;
  readonly audioChannels?: number;
}

export interface TimelineClip {
  readonly sourcePath: string;
  readonly inMs?: number;
  readonly durationMs: number;
  readonly hasAudio?: boolean;
}

export interface TimelineAudioTrack {
  readonly sourcePath: string;
  readonly inMs?: number;
  readonly durationMs?: number;
  readonly offsetMs?: number;
  readonly gainDb?: number;
}

export interface TimelineRenderSpec {
  readonly clips: readonly TimelineClip[];
  readonly audioTracks?: readonly TimelineAudioTrack[];
  readonly subtitlePath?: string;
  readonly subtitleFormat?: "srt" | "ass";
  /** SHA-256 of the exact subtitle sidecar burned into the rendered pixels. */
  readonly subtitleSha256?: string;
  readonly subtitleFontDirectory?: string;
  readonly subtitleFontName?: string;
  /** Visible disclosure burned into every frame by the deterministic renderer. */
  readonly aiLabelText?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly sampleRate?: number;
  readonly outputPath: string;
}

export interface TimelineRenderOptions {
  readonly ffmpegPath?: string;
  readonly overwrite?: boolean;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly crf?: number;
  readonly preset?: string;
  readonly audioBitRate?: string;
  readonly threads?: number;
}

export interface ContactSheetSpec {
  readonly inputPaths: readonly string[];
  readonly outputPath: string;
  readonly columns?: number;
  readonly thumbnailWidth?: number;
  readonly thumbnailHeight?: number;
}

export interface ContactSheetOptions {
  readonly ffmpegPath?: string;
  readonly overwrite?: boolean;
  readonly threads?: number;
}

export function createContactSheetPlan(
  spec: ContactSheetSpec,
  options: ContactSheetOptions = {},
): MediaCommandPlan {
  if (!spec.inputPaths.length || spec.inputPaths.length > 100) {
    throw new TypeError("Contact sheet needs between 1 and 100 inputs");
  }
  const inputs = spec.inputPaths.map((path) => {
    assertCleanPath(path);
    return resolve(path);
  });
  assertCleanPath(spec.outputPath);
  if (extname(spec.outputPath).toLowerCase() !== ".png") {
    throw new TypeError("Contact sheet output must be a PNG file");
  }
  const columns = spec.columns ?? Math.ceil(Math.sqrt(inputs.length));
  const width = spec.thumbnailWidth ?? 270;
  const height = spec.thumbnailHeight ?? 480;
  for (const [name, value] of Object.entries({ columns, thumbnailWidth: width, thumbnailHeight: height })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`Contact sheet ${name} must be a positive integer`);
    }
  }
  const filters = inputs.map(
    (_path, index) =>
      `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${index}]`,
  );
  const layout = inputs
    .map((_path, index) => `${(index % columns) * width}_${Math.floor(index / columns) * height}`)
    .join("|");
  filters.push(
    `${inputs.map((_path, index) => `[v${index}]`).join("")}xstack=inputs=${inputs.length}:layout=${layout}:fill=black[sheet]`,
  );
  const outputPath = resolve(spec.outputPath);
  return {
    executable: options.ffmpegPath ?? "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      options.overwrite ? "-y" : "-n",
      ...inputs.flatMap((path) => ["-i", path]),
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[sheet]",
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-threads",
      String(options.threads ?? 1),
      outputPath,
    ],
    auxiliaryFiles: [],
    outputPath,
    description: `Create a ${columns}-column contact sheet from ${inputs.length} inputs`,
  };
}

export function createConcatPlan(
  inputPaths: readonly string[],
  outputPath: string,
  options: ConcatPlanOptions = {},
): MediaCommandPlan {
  if (!inputPaths.length) throw new TypeError("Concat plan needs at least one input");
  const absoluteInputs = inputPaths.map((path) => {
    assertCleanPath(path);
    return resolve(path);
  });
  const absoluteOutput = resolve(outputPath);
  const width = options.width ?? DEFAULT_FINAL_DELIVERY_PROFILE.width;
  const height = options.height ?? DEFAULT_FINAL_DELIVERY_PROFILE.height;
  const fps = options.fps ?? DEFAULT_FINAL_DELIVERY_PROFILE.frameRate;
  const sampleRate = options.sampleRate ?? DEFAULT_FINAL_DELIVERY_PROFILE.audioSampleRate;
  const audioChannels = options.audioChannels ?? DEFAULT_FINAL_DELIVERY_PROFILE.audioChannels;
  validateOutputGeometry(width, height, fps, sampleRate, audioChannels);
  const listFilePath = resolve(options.listFilePath ?? `${absoluteOutput}.ffconcat`);
  const content = ["ffconcat version 1.0", ...absoluteInputs.map((path) => `file '${ffconcatEscape(path)}'`)]
    .join("\n") + "\n";
  const args: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    options.overwrite ? "-y" : "-n",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
  ];
  if (options.copyCodecs) {
    args.push("-c", "copy");
  } else {
    args.push(
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=${DEFAULT_FINAL_DELIVERY_PROFILE.pixelFormat}`,
      "-c:v",
      options.videoCodec ?? DEFAULT_FINAL_DELIVERY_PROFILE.videoEncoder,
      "-preset",
      options.preset ?? "medium",
      "-crf",
      String(options.crf ?? 18),
      "-pix_fmt",
      DEFAULT_FINAL_DELIVERY_PROFILE.pixelFormat,
      "-r",
      String(fps),
      "-fps_mode",
      "cfr",
      "-c:a",
      options.audioCodec ?? DEFAULT_FINAL_DELIVERY_PROFILE.audioEncoder,
      "-b:a",
      options.audioBitRate ?? "192k",
      "-ar",
      String(sampleRate),
      "-ac",
      String(audioChannels),
      "-threads",
      String(options.threads ?? 1),
    );
  }
  args.push(
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-metadata",
    "creation_time=1970-01-01T00:00:00Z",
    "-metadata",
    "comment=AI-generated / 人工智能生成",
    "-metadata",
    "description=人工智能生成合成内容",
    "-movflags",
    "+faststart",
    absoluteOutput,
  );
  return {
    executable: options.ffmpegPath ?? "ffmpeg",
    args,
    auxiliaryFiles: [{ path: listFilePath, content }],
    outputPath: absoluteOutput,
    description: `Concatenate ${absoluteInputs.length} media files in declared order`,
  };
}

export function createTimelineRenderPlan(
  spec: TimelineRenderSpec,
  options: TimelineRenderOptions = {},
): MediaCommandPlan {
  validateTimeline(spec);
  const width = spec.width ?? DEFAULT_FINAL_DELIVERY_PROFILE.width;
  const height = spec.height ?? DEFAULT_FINAL_DELIVERY_PROFILE.height;
  const fps = spec.fps ?? DEFAULT_FINAL_DELIVERY_PROFILE.frameRate;
  const sampleRate = spec.sampleRate ?? DEFAULT_FINAL_DELIVERY_PROFILE.audioSampleRate;
  const clips = spec.clips.map((clip) => ({ ...clip, sourcePath: resolve(clip.sourcePath) }));
  const tracks = (spec.audioTracks ?? []).map((track) => ({
    ...track,
    sourcePath: resolve(track.sourcePath),
  }));
  const aiLabelPath = resolve(`${spec.outputPath}.ai-label.ass`);
  const aiLabelText = cleanAiLabel(spec.aiLabelText ?? "AI GENERATED / 人工智能生成");
  const totalDurationMs = clips.reduce((total, clip) => total + clip.durationMs, 0);
  const args: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    options.overwrite ? "-y" : "-n",
  ];
  for (const clip of clips) args.push("-i", clip.sourcePath);
  for (const track of tracks) args.push("-i", track.sourcePath);
  const filters: string[] = [];
  for (const [index, clip] of clips.entries()) {
    const start = seconds(clip.inMs ?? 0);
    const duration = seconds(clip.durationMs);
    filters.push(
      `[${index}:v:0]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS,` +
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`,
    );
    if (clip.hasAudio ?? true) {
      filters.push(
        `[${index}:a:0]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS,` +
          `aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
      );
    } else {
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=${sampleRate},atrim=duration=${duration},` +
          `asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
  }
  const concatInputs = clips.map((_clip, index) => `[v${index}][a${index}]`).join("");
  filters.push(`${concatInputs}concat=n=${clips.length}:v=1:a=1[vbase][abase]`);

  const labelInput = spec.subtitlePath ? "vsub" : "vbase";
  if (spec.subtitlePath) filters.push(`[vbase]${createSubtitleBurnFilter(spec)}[vsub]`);
  filters.push(`[${labelInput}]ass=filename='${escapeFilterValue(aiLabelPath)}'[vout]`);

  tracks.forEach((track, trackIndex) => {
    const inputIndex = clips.length + trackIndex;
    const operations = [
      `atrim=start=${seconds(track.inMs ?? 0)}${track.durationMs ? `:duration=${seconds(track.durationMs)}` : ""}`,
      "asetpts=PTS-STARTPTS",
      `aresample=${sampleRate}`,
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
    ];
    if (track.gainDb !== undefined) operations.push(`volume=${formatNumber(track.gainDb)}dB`);
    if ((track.offsetMs ?? 0) > 0) {
      operations.push(`adelay=${Math.round(track.offsetMs ?? 0)}|${Math.round(track.offsetMs ?? 0)}`);
    }
    filters.push(`[${inputIndex}:a:0]${operations.join(",")}[mix${trackIndex}]`);
  });
  const finalAudioLabel = tracks.length ? "aout" : "abase";
  if (tracks.length) {
    filters.push(
      `[abase]${tracks.map((_track, index) => `[mix${index}]`).join("")}` +
        `amix=inputs=${tracks.length + 1}:duration=first:dropout_transition=0[aout]`,
    );
  }

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", `[${finalAudioLabel}]`);
  args.push(
    "-c:v",
    options.videoCodec ?? DEFAULT_FINAL_DELIVERY_PROFILE.videoEncoder,
    "-preset",
    options.preset ?? "medium",
    "-crf",
    String(options.crf ?? 18),
    "-pix_fmt",
    DEFAULT_FINAL_DELIVERY_PROFILE.pixelFormat,
    "-r",
    String(fps),
    "-fps_mode",
    "cfr",
    "-c:a",
    options.audioCodec ?? DEFAULT_FINAL_DELIVERY_PROFILE.audioEncoder,
    "-b:a",
    options.audioBitRate ?? "192k",
    "-ar",
    String(sampleRate),
    "-ac",
    String(DEFAULT_FINAL_DELIVERY_PROFILE.audioChannels),
    "-threads",
    String(options.threads ?? 1),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-metadata",
    "creation_time=1970-01-01T00:00:00Z",
    "-metadata",
    renderReceiptComment(spec),
    "-metadata",
    "description=人工智能生成合成内容",
    "-movflags",
    "+faststart+use_metadata_tags",
    "-shortest",
    resolve(spec.outputPath),
  );
  return {
    executable: options.ffmpegPath ?? "ffmpeg",
    args,
    auxiliaryFiles: [
      {
        path: aiLabelPath,
        content: createAiLabelAss(
          aiLabelText,
          totalDurationMs,
          width,
          height,
          spec.subtitleFontName ?? "Noto Sans CJK SC",
        ),
      },
    ],
    outputPath: resolve(spec.outputPath),
    description: `Render deterministic ${clips.length}-clip timeline at ${width}x${height}/${fps}fps`,
  };
}

function validateTimeline(spec: TimelineRenderSpec): void {
  if (!spec.clips.length) throw new TypeError("Timeline render needs at least one clip");
  for (const [index, clip] of spec.clips.entries()) {
    assertCleanPath(clip.sourcePath);
    if (!Number.isFinite(clip.durationMs) || clip.durationMs <= 0) {
      throw new TypeError(`Timeline clip ${index} durationMs must be positive`);
    }
    if (clip.inMs !== undefined && (!Number.isFinite(clip.inMs) || clip.inMs < 0)) {
      throw new TypeError(`Timeline clip ${index} inMs must be non-negative`);
    }
  }
  for (const [index, track] of (spec.audioTracks ?? []).entries()) {
    assertCleanPath(track.sourcePath);
    if (track.durationMs !== undefined && (!Number.isFinite(track.durationMs) || track.durationMs <= 0)) {
      throw new TypeError(`Timeline audio track ${index} durationMs must be positive`);
    }
    if ((track.inMs ?? 0) < 0 || (track.offsetMs ?? 0) < 0) {
      throw new TypeError(`Timeline audio track ${index} offsets must be non-negative`);
    }
  }
  for (const [name, value] of Object.entries({
    width: spec.width ?? DEFAULT_FINAL_DELIVERY_PROFILE.width,
    height: spec.height ?? DEFAULT_FINAL_DELIVERY_PROFILE.height,
    fps: spec.fps ?? DEFAULT_FINAL_DELIVERY_PROFILE.frameRate,
    sampleRate: spec.sampleRate ?? DEFAULT_FINAL_DELIVERY_PROFILE.audioSampleRate,
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`Timeline ${name} must be a positive integer`);
  }
  const width = spec.width ?? DEFAULT_FINAL_DELIVERY_PROFILE.width;
  const height = spec.height ?? DEFAULT_FINAL_DELIVERY_PROFILE.height;
  if (width % 2 || height % 2) throw new TypeError("Timeline dimensions must be even for yuv420p output");
  assertCleanPath(spec.outputPath);
  if (spec.subtitlePath) {
    assertCleanPath(spec.subtitlePath);
    const format = resolveSubtitleFormat(spec.subtitlePath, spec.subtitleFormat);
    if (format !== "srt" && format !== "ass") throw new TypeError("Timeline subtitles must be SRT or ASS");
    if (!/^[a-f\d]{64}$/i.test(spec.subtitleSha256 ?? "")) {
      throw new TypeError("Timeline subtitleSha256 must bind the exact burned SRT or ASS file");
    }
  } else if (spec.subtitleSha256) {
    throw new TypeError("Timeline subtitleSha256 requires subtitlePath");
  }
  if (spec.subtitleFontDirectory) assertCleanPath(spec.subtitleFontDirectory);
}

function renderReceiptComment(spec: TimelineRenderSpec): string {
  const receipt = ["AI-generated / 人工智能生成", "ai_label_visible=true"];
  if (spec.subtitlePath && spec.subtitleSha256) {
    const format = resolveSubtitleFormat(spec.subtitlePath, spec.subtitleFormat);
    receipt.push(`subtitle_${format}_sha256=${spec.subtitleSha256.toLowerCase()}`);
  }
  return `comment=${receipt.join("; ")}`;
}

function createAiLabelAss(
  text: string,
  durationMs: number,
  width: number,
  height: number,
  fontName: string,
): string {
  const safeFont = fontName.replace(/[,\r\n]/g, " ").trim() || "Arial";
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: AI-Label,${safeFont},28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,9,24,24,24,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,${formatAssTimestamp(durationMs)},AI-Label,,0,0,0,,${text}`,
    "",
  ].join("\n");
}

function cleanAiLabel(value: string): string {
  const cleaned = value.replace(/[{}\\\r\n]/g, " ").trim();
  if (!cleaned) throw new TypeError("Timeline aiLabelText must be visible non-empty text");
  return cleaned.slice(0, 120);
}

function formatAssTimestamp(milliseconds: number): string {
  const centiseconds = Math.max(1, Math.ceil(milliseconds / 10));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function createSubtitleBurnFilter(spec: TimelineRenderSpec): string {
  const subtitlePath = resolve(spec.subtitlePath ?? "");
  const format = resolveSubtitleFormat(subtitlePath, spec.subtitleFormat);
  const filter = format === "ass" ? "ass" : "subtitles";
  const options = [`filename='${escapeFilterValue(subtitlePath)}'`];
  if (spec.subtitleFontDirectory) {
    options.push(`fontsdir='${escapeFilterValue(resolve(spec.subtitleFontDirectory))}'`);
  }
  if (format === "srt") {
    const fontName = (spec.subtitleFontName ?? "Noto Sans CJK SC").replace(/[,'\\]/g, "");
    options.push(
      `force_style='FontName=${fontName},FontSize=48,PrimaryColour=&H00FFFFFF,` +
        "OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=120'",
    );
  }
  return `${filter}=${options.join(":")}`;
}

function resolveSubtitleFormat(path: string, explicit?: "srt" | "ass"): "srt" | "ass" | undefined {
  if (explicit) return explicit;
  const extension = extname(path).toLowerCase();
  if (extension === ".srt") return "srt";
  if (extension === ".ass") return "ass";
  return undefined;
}

function escapeFilterValue(path: string): string {
  let escaped = path.replace(/\\/g, "/");
  for (const character of ["'", ":", ",", ";", "[", "]"] as const) {
    escaped = escaped.replaceAll(character, `\\${character}`);
  }
  return escaped;
}

function validateOutputGeometry(
  width: number,
  height: number,
  fps: number,
  sampleRate: number,
  channels: number,
): void {
  for (const [name, value] of Object.entries({ width, height, fps, sampleRate, channels })) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  }
  if (width % 2 || height % 2) throw new TypeError("Output dimensions must be even for yuv420p output");
}

function ffconcatEscape(path: string): string {
  return path.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function assertCleanPath(path: string): void {
  if (!path || /[\0\r\n]/.test(path)) throw new TypeError("Media paths must not be empty or contain line breaks");
}

function seconds(milliseconds: number): string {
  return formatNumber(milliseconds / 1_000);
}

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}
