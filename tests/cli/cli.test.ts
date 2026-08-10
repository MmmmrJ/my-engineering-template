import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { DoctorRunner, ProviderFacade } from "../../src/contracts/index.js";
import { runCli } from "../../src/cli/index.js";
import { WorkflowService } from "../../src/workflow/index.js";

describe("cartoon CLI", () => {
  let root: string;
  let workflow: WorkflowService;
  let stdout: string;
  let stderr: string;
  let sequence: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cartoon-cli-"));
    sequence = 0;
    workflow = new WorkflowService({
      defaultRoot: root,
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    stdout = "";
    stderr = "";
  });

  const dependencies = () => ({
    workflow,
    cwd: root,
    stdout: (value: string) => {
      stdout += value;
    },
    stderr: (value: string) => {
      stderr += value;
    },
  });

  it("starts from only IP/theme and imports G1 without inferring review", async () => {
    expect(
      await runCli(["start", "--ip", "Lantern Town", "--theme", "Courage", "--json"], dependencies()),
    ).toBe(0);
    const created = JSON.parse(stdout) as { manifest: { taskId: string }; taskDirectory: string };
    expect(created.manifest.taskId).toMatch(/^20260810-010203-lantern-town-/);

    const artifact = join(root, "concept.md");
    const metadata = join(root, "metadata.json");
    await writeFile(artifact, "# Concept\n", "utf8");
    await writeFile(
      metadata,
      JSON.stringify({
        rights: {
          basis: "original",
          creator: "Creator",
          declaration: "I created and control this original IP.",
        },
      }),
      "utf8",
    );
    stdout = "";
    expect(
      await runCli(
        [
          "import",
          created.manifest.taskId,
          "--stage",
          "concept",
          "--file",
          artifact,
          "--metadata",
          `@${metadata}`,
        ],
        dependencies(),
      ),
    ).toBe(0);
    expect(stdout).toContain("review required");
    const state = await workflow.getState(created.taskDirectory);
    expect(state.stages.concept.status).toBe("awaiting_review");
    expect(state.stages.script.status).toBe("pending");
  });

  it("refuses bare provider selection instead of silently choosing", async () => {
    const providers: ProviderFacade = {
      list: async () => [],
      check: async () => [],
    };
    const result = await runCli(["providers", "select", "task-id"], {
      ...dependencies(),
      providerFacade: providers,
    });
    expect(result).toBe(2);
    expect(stderr).toContain("Choose providers explicitly");
  });

  it("keeps the complete public-domain shortcut fail-closed", async () => {
    const created = await workflow.createTask({ ip: "Aesop fable", theme: "Honesty" });
    const artifact = join(root, "concept.md");
    await writeFile(artifact, "# Public-domain concept\n", "utf8");

    expect(
      await runCli(
        [
          "import",
          created.manifest.taskId,
          "--stage",
          "concept",
          "--file",
          artifact,
          "--rights",
          "public-domain",
          "--source",
          "Aesop's Fables, 1919 edition",
          "--evidence",
          "catalog-record-001",
          "--jurisdiction",
          "US",
          "--author-or-publication-facts",
          "Ancient attributed author; cited edition published in 1919",
          "--legal-basis",
          "Publication predates the applicable copyright cutoff",
          "--verified-at",
          "2026-08-10T00:00:00.000Z",
        ],
        dependencies(),
      ),
    ).toBe(0);
    expect((await workflow.getState(created.taskDirectory)).stages.concept.status).toBe(
      "awaiting_review",
    );
  });

  it("delegates doctor and preserves JSON output/exit status", async () => {
    const doctor: DoctorRunner = {
      run: async () => ({
        ok: false,
        checks: [{ name: "ffmpeg", ok: false, message: "missing" }],
      }),
    };
    expect(await runCli(["doctor", "--json"], { ...dependencies(), doctor })).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      checks: [{ name: "ffmpeg", ok: false, message: "missing" }],
    });
  });
});
