import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  doctorMediaTools,
  normalizeProbe,
  probeMedia,
  resolveFfmpegToolchain,
} from "../../src/media/ffmpeg.js";
import type { ProcessRunner } from "../../src/media/process.js";

const probeFixtureUrl = new URL("../fixtures/ffprobe-video.json", import.meta.url);

describe("FFmpeg helpers", () => {
  it("resolves explicit, environment, managed, and system toolchains in order", () => {
    expect(
      resolveFfmpegToolchain({
        ffmpegPath: "configured-ffmpeg",
        environment: {
          AI_CARTOON_FFMPEG_PATH: "environment-ffmpeg",
          AI_CARTOON_FFPROBE_PATH: "environment-ffprobe",
        },
      }),
    ).toMatchObject({
      ffmpeg: { executable: "configured-ffmpeg", source: "explicit" },
      ffprobe: { executable: "environment-ffprobe", source: "environment" },
    });

    const managed = resolveFfmpegToolchain({
      environment: {},
      loadModule: (id) =>
        id === "ffmpeg-static" ? "/managed/ffmpeg" : { default: "/managed/ffprobe" },
      pathExists: () => true,
    });
    expect(managed).toMatchObject({
      ffmpeg: {
        executable: "/managed/ffmpeg",
        source: "managed",
        packageName: "ffmpeg-static",
      },
      ffprobe: {
        executable: "/managed/ffprobe",
        source: "managed",
        packageName: "@derhuerst/ffprobe-static",
      },
    });

    expect(
      resolveFfmpegToolchain({
        environment: { AI_CARTOON_DISABLE_MANAGED_FFMPEG: "true" },
        loadModule: () => "/should-not-load",
        pathExists: () => true,
      }),
    ).toEqual({
      ffmpeg: { executable: "ffmpeg", source: "system" },
      ffprobe: { executable: "ffprobe", source: "system" },
    });
  });

  it("doctors ffmpeg and ffprobe through an injected runner", async () => {
    const runner: ProcessRunner = async (executable) => ({
      exitCode: executable === "ffmpeg-custom" ? 0 : 1,
      stdout: executable === "ffmpeg-custom" ? "ffmpeg version 7.1\n" : "",
      stderr: executable === "ffmpeg-custom" ? "" : "missing",
      durationMs: 1,
    });
    const report = await doctorMediaTools({
      ffmpegPath: "ffmpeg-custom",
      ffprobePath: "ffprobe-custom",
      runner,
    });
    expect(report.ok).toBe(false);
    expect(report.ffmpeg).toMatchObject({
      available: true,
      version: "ffmpeg version 7.1",
      source: "explicit",
    });
    expect(report.ffprobe.available).toBe(false);
  });

  it("normalizes ffprobe streams and invokes a deterministic argument list", async () => {
    const stdout = await readFile(probeFixtureUrl, "utf8");
    let observedArgs: readonly string[] = [];
    const runner: ProcessRunner = async (_executable, args) => {
      observedArgs = args;
      return { exitCode: 0, stdout, stderr: "", durationMs: 1 };
    };
    const probe = await probeMedia("movie.mp4", { runner });
    expect(observedArgs.slice(0, 6)).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
    ]);
    expect(probe.format).toMatchObject({ durationSeconds: 12.5, sizeBytes: 1_024_000 });
    expect(probe.streams[0]).toMatchObject({
      codecType: "video",
      width: 1920,
      height: 1080,
      frameRate: 24,
    });
  });

  it("exports normalization for saved ffprobe reports", async () => {
    const fixture = JSON.parse(await readFile(probeFixtureUrl, "utf8")) as unknown;
    expect(normalizeProbe(fixture, "fixture.mp4").streams).toHaveLength(2);
  });
});
