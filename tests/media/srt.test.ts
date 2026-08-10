import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertValidSrt, formatSrtTimestamp, validateSrt } from "../../src/media/srt.js";

const validFixtureUrl = new URL("../fixtures/subtitles-valid.srt", import.meta.url);
const invalidFixtureUrl = new URL("../fixtures/subtitles-invalid.srt", import.meta.url);

describe("SRT validation", () => {
  it("parses a valid document and reports its final duration", async () => {
    const report = validateSrt(await readFile(validFixtureUrl, "utf8"));
    expect(report.valid).toBe(true);
    expect(report.cues).toHaveLength(2);
    expect(report.durationMs).toBe(3_500);
    expect(formatSrtTimestamp(report.cues[1]?.startMs ?? 0)).toBe("00:00:01,750");
  });

  it("reports backwards timing, overlap, and index gaps", async () => {
    const source = await readFile(invalidFixtureUrl, "utf8");
    const report = validateSrt(source);
    expect(report.valid).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["srt.duration.invalid", "srt.index.sequence", "srt.timing.overlap"]),
    );
    expect(() => assertValidSrt(source)).toThrow(/Cue 1 must end after it starts/);
  });
});
