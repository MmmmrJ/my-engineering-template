import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createCartoonMcpServer } from "../../src/mcp/server.js";

describe("cartoon MCP server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("exposes the stable workflow surface and starts from IP plus theme", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "cartoon-mcp-"));
    const server = await createCartoonMcpServer({ outputRoot });
    const client = new Client({ name: "cartoon-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "cartoon_cancel_provider_job",
      "cartoon_complete_manual_provider_job",
      "cartoon_estimate_provider_job",
      "cartoon_export",
      "cartoon_generate_stage",
      "cartoon_import_artifact",
      "cartoon_list_artifacts",
      "cartoon_list_provider_jobs",
      "cartoon_list_providers",
      "cartoon_poll_provider_job",
      "cartoon_resume",
      "cartoon_resume_provider_job",
      "cartoon_select_providers",
      "cartoon_start",
      "cartoon_status",
      "cartoon_submit_provider_job",
      "cartoon_submit_review",
    ]);

    const result = await client.callTool({
      name: "cartoon_start",
      arguments: { ip: "Lantern Town", theme: "Ask for help" },
    });
    expect(result.isError).not.toBe(true);
    const content = firstContentBlock(result.content);
    if (
      content === null ||
      typeof content !== "object" ||
      !("type" in content) ||
      content.type !== "text" ||
      !("text" in content) ||
      typeof content.text !== "string"
    ) {
      throw new Error("Expected a text MCP result.");
    }
    const created = JSON.parse(content.text) as {
      taskDirectory: string;
      state: { activeStage: string; status: string };
    };
    expect(created.taskDirectory).toContain(outputRoot);
    expect(created.state).toMatchObject({ activeStage: "concept", status: "active" });

    const concept = join(outputRoot, "concept.md");
    await writeFile(concept, "# Public-domain concept\n", "utf8");
    const invalidRights = await client.callTool({
      name: "cartoon_import_artifact",
      arguments: {
        taskId: created.taskDirectory,
        stage: "concept",
        files: [concept],
        rights: {
          basis: "public-domain",
          source: "1919 edition",
          evidence: "catalog-record",
          jurisdiction: "US",
        },
      },
    });
    expect(invalidRights.isError).toBe(true);

    const generated = await client.callTool({
      name: "cartoon_generate_stage",
      arguments: {
        taskId: created.taskDirectory,
        rights: {
          basis: "original",
          creator: "Creator",
          declaration: "I created and control this original IP.",
        },
      },
    });
    expect(generated.isError).not.toBe(true);
    const generatedContent = firstContentBlock(generated.content);
    if (
      generatedContent === null ||
      typeof generatedContent !== "object" ||
      !("type" in generatedContent) ||
      generatedContent.type !== "text" ||
      !("text" in generatedContent) ||
      typeof generatedContent.text !== "string"
    ) {
      throw new Error("Expected a text MCP generation result.");
    }
    expect(JSON.parse(generatedContent.text)).toMatchObject({
      state: { stages: { concept: { status: "awaiting_review" } } },
      stageContract: { stage: "concept" },
    });
  });

  it("accepts quick review mode through the stable MCP start surface", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "cartoon-mcp-quick-"));
    const server = await createCartoonMcpServer({ outputRoot });
    const client = new Client({ name: "cartoon-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: "cartoon_start",
      arguments: { ip: "Lantern Town", theme: "Courage", reviewMode: "quick" },
    });
    const content = firstContentBlock(result.content);
    if (
      content === null ||
      typeof content !== "object" ||
      !("type" in content) ||
      content.type !== "text" ||
      !("text" in content) ||
      typeof content.text !== "string"
    ) {
      throw new Error("Expected a text MCP result.");
    }
    expect(JSON.parse(content.text)).toMatchObject({
      state: { policies: { review: { mode: "quick" } } },
    });
  });
});

function firstContentBlock(value: unknown): unknown {
  if (!Array.isArray(value)) throw new Error("Expected MCP content blocks.");
  return (value as readonly unknown[])[0];
}
