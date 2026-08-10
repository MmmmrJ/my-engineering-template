import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConcatPlan,
  createContactSheetPlan,
  createTimelineRenderPlan,
} from "../../src/media/plans.js";

describe("deterministic FFmpeg command plans", () => {
  it("builds a deterministic contact sheet with caller order and bounded geometry", () => {
    const plan = createContactSheetPlan({
      inputPaths: ["SHOT-02.png", "SHOT-01.png", "SHOT-03.png"],
      outputPath: "contact-sheet.png",
      columns: 2,
      thumbnailWidth: 270,
      thumbnailHeight: 480,
    });
    expect(option(plan.args, "-filter_complex")).toContain(
      "xstack=inputs=3:layout=0_0|270_0|0_480",
    );
    expect(plan.args.filter((argument) => argument.endsWith("SHOT-02.png"))).toHaveLength(1);
    expect(plan.outputPath).toBe(resolve("contact-sheet.png"));
    expect(() =>
      createContactSheetPlan({ inputPaths: [], outputPath: "empty.png" }),
    ).toThrow(/between 1 and 100/);
  });

  it("creates a normalized vertical ffconcat plan in caller-declared order", () => {
    const first = createConcatPlan(["b clip.mp4", "a'clip.mp4"], "movie.mp4");
    const second = createConcatPlan(["b clip.mp4", "a'clip.mp4"], "movie.mp4");
    expect(first).toEqual(second);
    expect(first.auxiliaryFiles[0]?.content).toContain("ffconcat version 1.0");
    expect(first.auxiliaryFiles[0]?.content.indexOf("b clip.mp4")).toBeLessThan(
      first.auxiliaryFiles[0]?.content.indexOf("a'\\''clip.mp4") ?? -1,
    );
    expect(first.args.at(-1)).toBe(resolve("movie.mp4"));
    expect(first.args).toContain("creation_time=1970-01-01T00:00:00Z");
    expect(first.args).toContain("comment=AI-generated / 人工智能生成");
    expect(first.args[first.args.indexOf("-vf") + 1]).toContain("scale=1080:1920");
    expect(option(first.args, "-r")).toBe("30");
    expect(option(first.args, "-pix_fmt")).toBe("yuv420p");
    expect(option(first.args, "-c:v")).toBe("libx264");
    expect(option(first.args, "-c:a")).toBe("aac");
    expect(option(first.args, "-ar")).toBe("48000");
  });

  it("builds a vertical timeline with silence, music mixing and burned SRT", () => {
    const plan = createTimelineRenderPlan({
      clips: [
        { sourcePath: "shot-1.mp4", durationMs: 2_000, hasAudio: true },
        { sourcePath: "shot-2.mp4", inMs: 500, durationMs: 3_000, hasAudio: false },
      ],
      audioTracks: [
        { sourcePath: "music.wav", durationMs: 5_000, gainDb: -12, offsetMs: 250 },
      ],
      subtitlePath: "captions.srt",
      subtitleSha256: "a".repeat(64),
      outputPath: "episode.mp4",
    });
    const filter = option(plan.args, "-filter_complex");
    expect(filter).toContain("scale=1080:1920");
    expect(filter).toContain("fps=30");
    expect(filter).toContain("concat=n=2:v=1:a=1[vbase][abase]");
    expect(filter).toContain("anullsrc=channel_layout=stereo");
    expect(filter).toContain("amix=inputs=2:duration=first");
    expect(filter).toContain("subtitles=filename=");
    expect(filter).toContain("force_style=");
    expect(filter).toContain(".ai-label.ass");
    expect(plan.args).not.toContain("mov_text");
    expect(plan.args).toContain(
      `comment=AI-generated / 人工智能生成; ai_label_visible=true; subtitle_srt_sha256=${"a".repeat(64)}`,
    );
    expect(plan.auxiliaryFiles[0]?.content).toContain("AI GENERATED / 人工智能生成");
    expect(option(plan.args, "-r")).toBe("30");
    expect(option(plan.args, "-ar")).toBe("48000");
    expect(plan.args.at(-1)).toBe(resolve("episode.mp4"));
  });

  it("uses the ASS burn filter and rejects unsupported subtitle formats", () => {
    const plan = createTimelineRenderPlan({
      clips: [{ sourcePath: "shot.mp4", durationMs: 75_000, hasAudio: false }],
      subtitlePath: "captions.ass",
      subtitleSha256: "b".repeat(64),
      outputPath: "episode.mp4",
    });
    expect(option(plan.args, "-filter_complex")).toContain("[vbase]ass=filename=");
    expect(() =>
      createTimelineRenderPlan({
        clips: [{ sourcePath: "shot.mp4", durationMs: 75_000 }],
        subtitlePath: "captions.vtt",
        subtitleSha256: "c".repeat(64),
        outputPath: "episode.mp4",
      }),
    ).toThrow(/SRT or ASS/);
  });
});

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1] ?? "";
}
