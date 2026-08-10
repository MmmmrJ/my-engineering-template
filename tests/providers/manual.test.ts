import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManualProviderAdapter } from "../../src/providers/manual.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ManualProviderAdapter", () => {
  it("writes a request package and imports a terminal result package", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-provider-"));
    temporaryDirectories.push(root);
    const adapter = new ManualProviderAdapter({
      requestDirectory: join(root, "requests"),
      resultDirectory: join(root, "results"),
      clock: { now: () => new Date("2026-08-10T00:00:00.000Z") },
      ids: { next: () => "manual-1" },
    });
    const submitted = await adapter.submit({
      capability: "audio.music",
      input: { prompt: "gentle strings", duration: 8 },
    });
    expect(submitted).toMatchObject({ remoteJobId: "manual-1", state: "queued" });
    const requestPackage = JSON.parse(await readFile(adapter.requestPath("manual-1"), "utf8")) as {
      input: { prompt: string };
    };
    expect(requestPackage.input.prompt).toBe("gentle strings");
    expect((await adapter.poll({ capability: "audio.music", remoteJobId: "manual-1" })).state).toBe(
      "queued",
    );

    await adapter.importResult({
      schemaVersion: 1,
      jobId: "manual-1",
      state: "succeeded",
      outputs: [
        {
          kind: "audio",
          localPath: join(root, "music.wav"),
          archivedPath: join(root, "archive", "music.wav"),
          mimeType: "audio/wav",
        },
      ],
      completedAt: "2026-08-10T00:00:08.000Z",
    });
    const completed = await adapter.poll({ capability: "audio.music", remoteJobId: "manual-1" });
    expect(completed).toMatchObject({
      state: "succeeded",
      outputs: [{ kind: "audio", mimeType: "audio/wav" }],
    });
  });

  it("blocks path traversal in externally supplied job ids", async () => {
    const adapter = new ManualProviderAdapter({
      requestDirectory: "requests",
      resultDirectory: "results",
    });
    await expect(
      adapter.poll({ capability: "audio.tts", remoteJobId: "../../escape" }),
    ).rejects.toThrow(/Unsafe manual job id/);
  });
});
