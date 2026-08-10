export interface SrtCue {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly lines: readonly string[];
}

export interface SrtIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly block?: number;
  readonly cueIndex?: number;
}

export interface SrtValidationOptions {
  readonly requireContiguousIndices?: boolean;
  readonly allowOverlap?: boolean;
  readonly maxLinesPerCue?: number;
  readonly maxCharactersPerLine?: number;
  readonly maxCharactersPerSecond?: number;
}

export interface SrtValidationReport {
  readonly valid: boolean;
  readonly cues: readonly SrtCue[];
  readonly errors: readonly SrtIssue[];
  readonly warnings: readonly SrtIssue[];
  readonly durationMs: number;
}

export class SrtValidationError extends Error {
  readonly report: SrtValidationReport;

  constructor(report: SrtValidationReport) {
    super(report.errors.map((issue) => issue.message).join("; ") || "Invalid SRT subtitles");
    this.name = "SrtValidationError";
    this.report = report;
  }
}

export function validateSrt(
  source: string,
  options: SrtValidationOptions = {},
): SrtValidationReport {
  const errors: SrtIssue[] = [];
  const warnings: SrtIssue[] = [];
  const cues: SrtCue[] = [];
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    errors.push({ severity: "error", code: "srt.empty", message: "SRT document is empty" });
    return { valid: false, cues, errors, warnings, durationMs: 0 };
  }
  const blocks = normalized.split(/\n{2,}/);
  for (const [blockIndex, block] of blocks.entries()) {
    const lines = block.split("\n");
    const indexText = lines[0]?.trim() ?? "";
    const timingText = lines[1]?.trim() ?? "";
    const index = /^\d+$/.test(indexText) ? Number(indexText) : undefined;
    if (index === undefined || !Number.isSafeInteger(index) || index <= 0) {
      errors.push({
        severity: "error",
        code: "srt.index.invalid",
        message: `Block ${blockIndex + 1} has an invalid cue index`,
        block: blockIndex + 1,
      });
      continue;
    }
    const timing = parseTimingLine(timingText);
    if (!timing) {
      errors.push({
        severity: "error",
        code: "srt.timing.invalid",
        message: `Cue ${index} has an invalid timing line`,
        block: blockIndex + 1,
        cueIndex: index,
      });
      continue;
    }
    const textLines = lines.slice(2).map((line) => line.trimEnd());
    const text = textLines.join("\n").trim();
    if (!text) {
      errors.push({
        severity: "error",
        code: "srt.text.empty",
        message: `Cue ${index} has no subtitle text`,
        block: blockIndex + 1,
        cueIndex: index,
      });
    }
    if (timing.endMs <= timing.startMs) {
      errors.push({
        severity: "error",
        code: "srt.duration.invalid",
        message: `Cue ${index} must end after it starts`,
        block: blockIndex + 1,
        cueIndex: index,
      });
    }
    const cue: SrtCue = {
      index,
      startMs: timing.startMs,
      endMs: timing.endMs,
      text,
      lines: textLines,
    };
    cues.push(cue);
    addReadabilityWarnings(cue, warnings, options);
  }

  for (const [position, cue] of cues.entries()) {
    if ((options.requireContiguousIndices ?? true) && cue.index !== position + 1) {
      errors.push({
        severity: "error",
        code: "srt.index.sequence",
        message: `Expected cue index ${position + 1}, received ${cue.index}`,
        cueIndex: cue.index,
      });
    }
    const previous = cues[position - 1];
    if (previous && cue.startMs < previous.endMs && !(options.allowOverlap ?? false)) {
      errors.push({
        severity: "error",
        code: "srt.timing.overlap",
        message: `Cue ${cue.index} overlaps cue ${previous.index}`,
        cueIndex: cue.index,
      });
    }
    if (previous && cue.startMs < previous.startMs) {
      errors.push({
        severity: "error",
        code: "srt.timing.order",
        message: `Cue ${cue.index} starts before cue ${previous.index}`,
        cueIndex: cue.index,
      });
    }
  }
  const durationMs = cues.reduce((maximum, cue) => Math.max(maximum, cue.endMs), 0);
  return { valid: errors.length === 0, cues, errors, warnings, durationMs };
}

export function assertValidSrt(
  source: string,
  options: SrtValidationOptions = {},
): readonly SrtCue[] {
  const report = validateSrt(source, options);
  if (!report.valid) throw new SrtValidationError(report);
  return report.cues;
}

export function formatSrtTimestamp(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError("SRT timestamp must be a non-negative integer number of milliseconds");
  }
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

function parseTimingLine(value: string): { startMs: number; endMs: number } | undefined {
  const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2,}):(\d{2}):(\d{2}),(\d{3})(?:\s+.*)?$/.exec(
    value,
  );
  if (!match) return undefined;
  const values = match.slice(1).map(Number);
  const [startHours, startMinutes, startSeconds, startMillis, endHours, endMinutes, endSeconds, endMillis] =
    values;
  if (
    values.some((part) => part === undefined) ||
    (startMinutes ?? 60) >= 60 ||
    (startSeconds ?? 60) >= 60 ||
    (startMillis ?? 1_000) >= 1_000 ||
    (endMinutes ?? 60) >= 60 ||
    (endSeconds ?? 60) >= 60 ||
    (endMillis ?? 1_000) >= 1_000
  ) {
    return undefined;
  }
  return {
    startMs:
      (startHours ?? 0) * 3_600_000 +
      (startMinutes ?? 0) * 60_000 +
      (startSeconds ?? 0) * 1_000 +
      (startMillis ?? 0),
    endMs:
      (endHours ?? 0) * 3_600_000 +
      (endMinutes ?? 0) * 60_000 +
      (endSeconds ?? 0) * 1_000 +
      (endMillis ?? 0),
  };
}

function addReadabilityWarnings(
  cue: SrtCue,
  warnings: SrtIssue[],
  options: SrtValidationOptions,
): void {
  const maxLines = options.maxLinesPerCue ?? 2;
  const maxCharacters = options.maxCharactersPerLine ?? 42;
  const maxCps = options.maxCharactersPerSecond ?? 20;
  if (cue.lines.length > maxLines) {
    warnings.push({
      severity: "warning",
      code: "srt.readability.lines",
      message: `Cue ${cue.index} has ${cue.lines.length} lines (recommended maximum: ${maxLines})`,
      cueIndex: cue.index,
    });
  }
  cue.lines.forEach((line, lineIndex) => {
    if ([...line].length > maxCharacters) {
      warnings.push({
        severity: "warning",
        code: "srt.readability.line_length",
        message: `Cue ${cue.index} line ${lineIndex + 1} exceeds ${maxCharacters} characters`,
        cueIndex: cue.index,
      });
    }
  });
  const durationSeconds = (cue.endMs - cue.startMs) / 1_000;
  const visibleCharacters = [...cue.text.replace(/\s/g, "")].length;
  if (durationSeconds > 0 && visibleCharacters / durationSeconds > maxCps) {
    warnings.push({
      severity: "warning",
      code: "srt.readability.speed",
      message: `Cue ${cue.index} exceeds ${maxCps} characters per second`,
      cueIndex: cue.index,
    });
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
