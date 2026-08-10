import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { executeMediaPlan } from "../../src/media/executor.js";
import type { MediaCommandPlan } from "../../src/media/plans.js";

describe("executeMediaPlan", () => {
  it("writes deterministic auxiliaries and verifies a non-empty immutable output", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-executor-"));
    const output = join(root, "edit", "episode.mp4");
    const auxiliary = join(root, "edit", "ai-label.ass");
    const plan: MediaCommandPlan = {
      executable: "fake-ffmpeg",
      args: ["-i", "source", output],
      auxiliaryFiles: [{ path: auxiliary, content: "[Events]\n" }],
      outputPath: output,
      description: "fake deterministic render",
    };
    const result = await executeMediaPlan(plan, {
      workspaceRoot: root,
      runner: async () => {
        await writeFile(output, "fake mp4 bytes");
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 7 };
      },
    });

    expect(result).toMatchObject({ outputPath: output, durationMs: 7 });
    expect(result.sha256).toMatch(/^[a-f\d]{64}$/);
    await expect(readFile(auxiliary, "utf8")).resolves.toBe("[Events]\n");
    await expect(executeMediaPlan(plan, { workspaceRoot: root })).rejects.toThrow(/immutable/);
  });

  it("rejects outputs and auxiliary files outside the task workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-executor-"));
    const outside = resolve(root, "..", "escaped.mp4");
    await expect(
      executeMediaPlan(
        {
          executable: "fake-ffmpeg",
          args: [],
          auxiliaryFiles: [],
          outputPath: outside,
          description: "escape attempt",
        },
        { workspaceRoot: root },
      ),
    ).rejects.toThrow(/workspace root/);
  });
});
