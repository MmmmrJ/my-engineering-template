import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ComfyUiProviderAdapter } from "../../src/providers/comfyui.js";
import type { FetchLike } from "../../src/providers/types.js";

const fixtureUrl = new URL("../fixtures/comfy-history.json", import.meta.url);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ComfyUiProviderAdapter", () => {
  it("uses /prompt and /history and converts output files into /view URLs", async () => {
    const history = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;
    const calls: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      const pathname = new URL(url).pathname;
      if (pathname === "/prompt") return jsonResponse({ prompt_id: "prompt-42", node_errors: {} });
      if (pathname.startsWith("/history/")) return jsonResponse(history);
      return jsonResponse({});
    };
    const adapter = new ComfyUiProviderAdapter({
      baseUrl: "http://127.0.0.1:8188",
      fetch,
    });
    const submitted = await adapter.submit({
      capability: "image.generate",
      input: { workflow: { "1": { class_type: "EmptyLatentImage", inputs: {} } } },
      metadata: { workflowVersion: "v001" },
    });
    const completed = await adapter.poll({
      capability: "image.generate",
      remoteJobId: submitted.remoteJobId,
    });

    expect(calls).toEqual([
      "http://127.0.0.1:8188/prompt",
      "http://127.0.0.1:8188/history/prompt-42",
    ]);
    expect(completed.state).toBe("succeeded");
    expect(completed.outputs?.[0]).toMatchObject({
      kind: "image",
      uri: "http://127.0.0.1:8188/view?filename=frame+01.png&subfolder=cartoon&type=output",
    });
  });

  it("returns queued when history does not yet include the prompt", async () => {
    const adapter = new ComfyUiProviderAdapter({ fetch: async () => jsonResponse({}) });
    const job = await adapter.poll({
      capability: "video.t2v",
      remoteJobId: "pending",
    });
    expect(job.state).toBe("queued");
  });

  it("loads a named workflow only from the configured workflow directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "comfy-workflow-"));
    try {
      await writeFile(
        join(root, "image.json"),
        JSON.stringify({
          workflowVersion: "v001",
          workflow: { "1": { class_type: "CheckpointLoaderSimple", inputs: {} } },
        }),
      );
      await writeFile(
        join(root, "video.v002.json"),
        JSON.stringify({ "2": { class_type: "LoadImage", inputs: {} } }),
      );
      await writeFile(
        join(root, "legacy.json"),
        JSON.stringify({ "3": { class_type: "LegacyNode", inputs: {} } }),
      );
      let requestBody = "";
      const adapter = new ComfyUiProviderAdapter({
        workflowDirectory: root,
        fetch: async (_input, init) => {
          requestBody = typeof init?.body === "string" ? init.body : "";
          return jsonResponse({ prompt_id: "file-workflow", node_errors: {} });
        },
      });
      await adapter.submit({
        capability: "image.generate",
        input: { workflowFile: "image.json" },
      });
      expect(JSON.parse(requestBody)).toMatchObject({
        prompt: { "1": { class_type: "CheckpointLoaderSimple" } },
      });
      await adapter.submit({
        capability: "video.i2v",
        input: { workflowFile: "video.v002.json" },
      });
      expect(JSON.parse(requestBody)).toMatchObject({
        prompt: { "2": { class_type: "LoadImage" } },
      });
      await expect(
        adapter.submit({
          capability: "image.generate",
          input: { workflowFile: "legacy.json" },
        }),
      ).rejects.toThrow(/vNNN|schemaVersion\/workflowVersion/);
      await expect(
        adapter.submit({
          capability: "image.generate",
          input: { workflowFile: "../outside.json" },
        }),
      ).rejects.toThrow(/relative .json path|escapes/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit workflow version for inline workflows", async () => {
    const adapter = new ComfyUiProviderAdapter({
      fetch: async () => jsonResponse({ prompt_id: "unused", node_errors: {} }),
    });
    await expect(
      adapter.submit({
        capability: "image.generate",
        input: { workflow: { "1": { class_type: "EmptyLatentImage", inputs: {} } } },
      }),
    ).rejects.toThrow(/metadata\.workflowVersion/);
  });
});
