import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadAndArchive, safeChildPath } from "../../src/providers/download.js";

const temporaryDirectories: string[] = [];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("downloadAndArchive", () => {
  it("checks MIME, length and SHA-256 before writing local and archive copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-download-"));
    temporaryDirectories.push(root);
    const expectedSha256 = createHash("sha256").update(onePixelPng).digest("hex");
    const result = await downloadAndArchive({
      url: "https://assets.example/frame.png",
      destinationRoot: join(root, "current"),
      relativePath: "shots/frame.png",
      archiveRoot: join(root, "archive"),
      allowedMimeTypes: ["image/*"],
      maxBytes: 1_024,
      expectedSha256,
      fetch: async () =>
        new Response(onePixelPng, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(onePixelPng.byteLength),
          },
        }),
    });

    expect(result.sha256).toBe(expectedSha256);
    expect(await readFile(result.localPath)).toEqual(onePixelPng);
    expect(await readFile(result.archivedPath)).toEqual(onePixelPng);
    expect(result.archivedPath).toContain(expectedSha256);
  });

  it("rejects traversal and MIME-signature mismatches", async () => {
    expect(() => safeChildPath("safe", "../escape.png")).toThrow(/escapes/);
    await expect(
      downloadAndArchive({
        url: "https://assets.example/fake.jpg",
        destinationRoot: "safe",
        relativePath: "fake.jpg",
        archiveRoot: "archive",
        allowedMimeTypes: ["image/jpeg"],
        maxBytes: 1_024,
        fetch: async () =>
          new Response(onePixelPng, { headers: { "Content-Type": "image/jpeg" } }),
      }),
    ).rejects.toThrow(/signature/);
  });

  it.each([403, 410])("does not create files when a temporary URL returns HTTP %s", async (status) => {
    const root = await mkdtemp(join(tmpdir(), "asset-expired-"));
    temporaryDirectories.push(root);
    const localPath = join(root, "current", "shots", "frame.png");
    await expect(
      downloadAndArchive({
        url: "https://assets.example/expired.png",
        destinationRoot: join(root, "current"),
        relativePath: "shots/frame.png",
        archiveRoot: join(root, "archive"),
        allowedMimeTypes: ["image/png"],
        maxBytes: 1_024,
        fetch: async () =>
          new Response(JSON.stringify({ message: "expired" }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    ).rejects.toMatchObject({ status });
    await expect(readFile(localPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
