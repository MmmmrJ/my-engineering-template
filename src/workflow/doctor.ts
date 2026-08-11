import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import type { DoctorCheck, DoctorReport, DoctorRunner } from "../contracts/index.js";
import {
  resolveFfmpegToolchain,
  type ResolvedFfmpegToolchain,
  type ResolvedMediaTool,
} from "../media/ffmpeg.js";

const execFileAsync = promisify(execFile);

export interface DefaultDoctorOptions {
  outputRoot?: string;
  providerConfigCheck?: () => Promise<DoctorCheck>;
  ffmpegPath?: string;
  ffprobePath?: string;
}

export class DefaultDoctorRunner implements DoctorRunner {
  private readonly outputRoot: string;
  private readonly providerConfigCheck?: () => Promise<DoctorCheck>;
  private readonly toolchain: ResolvedFfmpegToolchain;

  constructor(options: DefaultDoctorOptions = {}) {
    this.outputRoot = resolve(
      options.outputRoot ?? process.env.AI_CARTOON_OUTPUT_ROOT ?? resolve(process.cwd(), "output"),
    );
    this.providerConfigCheck = options.providerConfigCheck;
    this.toolchain = resolveFfmpegToolchain({
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
    });
  }

  async run(): Promise<DoctorReport> {
    const [baseChecks, ffmpegFeatures] = await Promise.all([
      Promise.all([
      Promise.resolve(checkNodeVersion()),
      checkExecutable("ffmpeg", this.toolchain.ffmpeg),
      checkExecutable("ffprobe", this.toolchain.ffprobe),
      checkWritableAncestor(this.outputRoot),
        checkFont(),
        this.providerConfigCheck?.() ?? Promise.resolve({
          name: "provider-config",
          ok: true,
          message: "Provider config check was not configured for this runner.",
        }),
      ]),
      checkFfmpegFeatures(this.toolchain.ffmpeg.executable),
    ]);
    const checks = [...baseChecks, ...ffmpegFeatures];
    return { ok: checks.every((check) => check.ok), checks };
  }
}

async function checkFfmpegFeatures(ffmpegPath: string): Promise<DoctorCheck[]> {
  try {
    const [{ stdout: encoders }, { stdout: filters }] = await Promise.all([
      execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"], { windowsHide: true, timeout: 10_000 }),
      execFileAsync(ffmpegPath, ["-hide_banner", "-filters"], { windowsHide: true, timeout: 10_000 }),
    ]);
    return [
      {
        name: "ffmpeg-libx264",
        ok: /\blibx264\b/.test(encoders),
        message: /\blibx264\b/.test(encoders) ? "libx264 encoder available." : "libx264 encoder missing.",
      },
      {
        name: "ffmpeg-aac",
        ok: /\bAAC\b|\baac\b/.test(encoders),
        message: /\bAAC\b|\baac\b/.test(encoders) ? "AAC encoder available." : "AAC encoder missing.",
      },
      {
        name: "ffmpeg-subtitles",
        ok: /\bsubtitles\b/.test(filters),
        message: /\bsubtitles\b/.test(filters)
          ? "Subtitles filter available."
          : "Subtitles filter missing.",
      },
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      { name: "ffmpeg-libx264", ok: false, message },
      { name: "ffmpeg-aac", ok: false, message },
      { name: "ffmpeg-subtitles", ok: false, message },
    ];
  }
}

async function checkFont(): Promise<DoctorCheck> {
  const configured = process.env.AI_CARTOON_FONT;
  const candidates = configured ? [resolve(configured)] : defaultChineseFontCandidates();
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      return {
        name: "font",
        ok: true,
        message: `${configured ? "Configured" : "Detected"} zh-CN font: ${candidate}`,
      };
    } catch {
      // Check the next known cross-platform font location.
    }
  }
  return {
    name: "font",
    ok: false,
    message: configured
      ? `Configured font is unavailable: ${resolve(configured)}`
      : "No readable zh-CN font detected; set AI_CARTOON_FONT before subtitle rendering.",
  };
}

function defaultChineseFontCandidates(): string[] {
  if (process.platform === "win32") {
    const windowsDirectory = process.env.WINDIR ?? "C:\\Windows";
    return ["msyh.ttc", "msyhbd.ttc", "simhei.ttf"].map((font) =>
      join(windowsDirectory, "Fonts", font),
    );
  }
  if (process.platform === "darwin") {
    return [
      "/System/Library/Fonts/PingFang.ttc",
      "/System/Library/Fonts/STHeiti Light.ttc",
    ];
  }
  return [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  ];
}

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return {
    name: "node",
    ok: major >= 22 && major < 25,
    message: `Node ${process.versions.node}; expected >=22 <25.`,
  };
}

async function checkExecutable(
  command: "ffmpeg" | "ffprobe",
  tool: ResolvedMediaTool,
): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(tool.executable, ["-version"], {
      windowsHide: true,
      timeout: 10_000,
    });
    const version = `${stdout}${stderr}`.split(/\r?\n/)[0]?.trim() || "available";
    return {
      name: command,
      ok: true,
      message: `${version} [source=${tool.source}; executable=${tool.executable}]`,
    };
  } catch (error) {
    return {
      name: command,
      ok: false,
      message: `${command} is unavailable from ${tool.source} (${tool.executable}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function checkWritableAncestor(path: string): Promise<DoctorCheck> {
  let candidate = path;
  while (true) {
    try {
      const details = await stat(candidate);
      if (!details.isDirectory()) {
        return { name: "output-root", ok: false, message: `${candidate} is not a directory.` };
      }
      await access(candidate, fsConstants.W_OK);
      return { name: "output-root", ok: true, message: `Writable output ancestor: ${candidate}` };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return {
          name: "output-root",
          ok: false,
          message: `Output root is not writable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return { name: "output-root", ok: false, message: `No writable ancestor for ${path}.` };
      }
      candidate = parent;
    }
  }
}
