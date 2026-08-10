export interface AssCue {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly style?: string;
  readonly text: string;
}

export interface AssIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly cueIndex?: number;
}

export interface AssValidationReport {
  readonly valid: boolean;
  readonly cues: readonly AssCue[];
  readonly errors: readonly AssIssue[];
  readonly warnings: readonly AssIssue[];
  readonly durationMs: number;
}

export function validateAss(source: string): AssValidationReport {
  const errors: AssIssue[] = [];
  const warnings: AssIssue[] = [];
  const cues: AssCue[] = [];
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let inEvents = false;
  let fields: readonly string[] | undefined;

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (/^\[.+\]$/.test(line)) {
      inEvents = line.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents || !line || line.startsWith(";")) continue;
    if (/^format\s*:/i.test(line)) {
      fields = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    if (!fields?.length) {
      errors.push({
        severity: "error",
        code: "ass.format.missing",
        message: "ASS [Events] must declare Format before Dialogue rows",
        line: lineIndex + 1,
      });
      continue;
    }
    const values = splitAssFields(line.slice(line.indexOf(":") + 1), fields.length);
    const row = Object.fromEntries(fields.map((field, index) => [field, values[index]?.trim() ?? ""]));
    const cueIndex = cues.length + 1;
    const startMs = parseAssTimestamp(row.start ?? "");
    const endMs = parseAssTimestamp(row.end ?? "");
    if (startMs === undefined || endMs === undefined) {
      errors.push({
        severity: "error",
        code: "ass.timing.invalid",
        message: `ASS dialogue ${cueIndex} has invalid timing`,
        line: lineIndex + 1,
        cueIndex,
      });
      continue;
    }
    if (endMs <= startMs) {
      errors.push({
        severity: "error",
        code: "ass.duration.invalid",
        message: `ASS dialogue ${cueIndex} must end after it starts`,
        line: lineIndex + 1,
        cueIndex,
      });
    }
    const text = row.text ?? "";
    if (!visibleAssText(text)) {
      errors.push({
        severity: "error",
        code: "ass.text.empty",
        message: `ASS dialogue ${cueIndex} has no visible text`,
        line: lineIndex + 1,
        cueIndex,
      });
    }
    cues.push({
      index: cueIndex,
      startMs,
      endMs,
      ...(row.style ? { style: row.style } : {}),
      text,
    });
  }

  if (!fields) {
    errors.push({
      severity: "error",
      code: "ass.events.missing",
      message: "ASS document has no formatted [Events] section",
    });
  } else if (!cues.length && !errors.some((issue) => issue.code.startsWith("ass.timing"))) {
    errors.push({ severity: "error", code: "ass.dialogue.empty", message: "ASS document has no dialogue cues" });
  }

  cues.forEach((cue, index) => {
    const previous = cues[index - 1];
    if (previous && cue.startMs < previous.startMs) {
      errors.push({
        severity: "error",
        code: "ass.timing.order",
        message: `ASS dialogue ${cue.index} starts before dialogue ${previous.index}`,
        cueIndex: cue.index,
      });
    } else if (previous && cue.startMs < previous.endMs) {
      warnings.push({
        severity: "warning",
        code: "ass.timing.overlap",
        message: `ASS dialogue ${cue.index} overlaps dialogue ${previous.index}`,
        cueIndex: cue.index,
      });
    }
  });

  return {
    valid: errors.length === 0,
    cues,
    errors,
    warnings,
    durationMs: cues.reduce((maximum, cue) => Math.max(maximum, cue.endMs), 0),
  };
}

function splitAssFields(value: string, fieldCount: number): readonly string[] {
  const fields: string[] = [];
  let remainder = value;
  for (let index = 1; index < fieldCount; index += 1) {
    const separator = remainder.indexOf(",");
    if (separator < 0) {
      fields.push(remainder);
      remainder = "";
      continue;
    }
    fields.push(remainder.slice(0, separator));
    remainder = remainder.slice(separator + 1);
  }
  fields.push(remainder);
  return fields;
}

function parseAssTimestamp(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2})[.](\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const centiseconds = Number(match[4]);
  if (minutes >= 60 || seconds >= 60) return undefined;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + centiseconds * 10;
}

function visibleAssText(value: string): string {
  return value.replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, "").trim();
}
