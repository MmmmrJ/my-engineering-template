import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { REQUIRED_PROVIDER_CAPABILITIES } from "../../src/contracts/index.js";
import { createCartoonMcpServer } from "../../src/mcp/server.js";
import {
  ManualProviderAdapter,
  ProviderRegistry,
  ProviderRegistryFacade,
} from "../../src/providers/index.js";
import { WorkflowService } from "../../src/workflow/index.js";

describe("provider handoff MCP tools", () => {
  it("exposes durable prepare, confirm, record, and resume actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-handoff-mcp-"));
    const registry = new ProviderRegistry([
      new ManualProviderAdapter({
        id: "jimeng-manual",
        displayName: "即梦 AI",
        adapter: "jimeng-manual",
        requestDirectory: join(root, "health", "requests"),
        resultDirectory: join(root, "health", "results"),
        capabilities: REQUIRED_PROVIDER_CAPABILITIES,
      }),
    ]);
    let sequence = 0;
    const workflow = new WorkflowService({
      legacyUnstructuredImportsForTests: true,
      defaultRoot: root,
      providerFacade: new ProviderRegistryFacade(registry),
      clock: () => new Date("2026-08-11T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    const taskId = await prepareMediaTask(workflow);
    const uploadPath = join(workflow.resolveTaskDirectory(taskId), "reference.png");
    await writeFile(
      uploadPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const server = await createCartoonMcpServer({ workflow, providers: registry });
    const client = new Client({ name: "handoff-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const preparedResult = await client.callTool({
        name: "cartoon_prepare_provider_handoff",
        arguments: {
          taskId,
          providerId: "jimeng-manual",
          stage: "assets",
          request: {
            capability: "image.generate",
            input: { prompt: "Original lantern character" },
          },
          uploadPaths: [uploadPath],
        },
      });
      expect(preparedResult.isError).not.toBe(true);
      const prepared = JSON.parse(textResult(preparedResult)) as {
        attempt: {
          attemptId: string;
          handoff: { manifestSha256: string };
        };
      };
      const firstResume = await client.callTool({
        name: "cartoon_resume",
        arguments: { taskId },
      });
      expect(JSON.parse(textResult(firstResume))).toMatchObject({
        action: { type: "execute-provider-handoff" },
      });

      await client.callTool({
        name: "cartoon_record_provider_handoff",
        arguments: {
          taskId,
          attemptId: prepared.attempt.attemptId,
          record: { state: "awaiting_confirmation" },
        },
      });
      const confirmed = await client.callTool({
        name: "cartoon_confirm_provider_handoff",
        arguments: {
          taskId,
          attemptId: prepared.attempt.attemptId,
          confirmation: {
            confirmedAt: "2026-08-11T01:03:00.000Z",
            confirmedBy: "user",
            confirmationReference: `codex:${prepared.attempt.attemptId}:spend`,
            manifestSha256: prepared.attempt.handoff.manifestSha256,
            providerId: "jimeng-manual",
            creditUnit: "积分",
            pricingStatus: "unknown",
            unknownPricingAcknowledged: true,
            maximumCredits: 10,
          },
        },
      });
      expect(confirmed.isError).not.toBe(true);
      const submitted = await client.callTool({
        name: "cartoon_record_provider_handoff",
        arguments: {
          taskId,
          attemptId: prepared.attempt.attemptId,
          record: {
            state: "submitted",
            receipt: {
              externalTaskId: "jimeng-task-mcp",
              observedCredits: 8,
              creditUnit: "积分",
            },
          },
        },
      });
      expect(JSON.parse(textResult(submitted))).toMatchObject({
        handoff: { state: "submitted", receipt: { observedCredits: 8 } },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function prepareMediaTask(workflow: WorkflowService): Promise<string> {
  const created = await workflow.createTask({ ip: "Original Lantern Town", theme: "Courage" });
  for (const stage of ["concept", "script", "storyboard"] as const) {
    const generated = await workflow.generateStage(created.manifest.taskId, {
      ...(stage === "concept"
        ? {
            rights: {
              basis: "original" as const,
              creator: "Test Creator",
              declaration: "I created and control this test IP.",
            },
          }
        : {}),
    });
    await workflow.review(created.manifest.taskId, {
      target: { stage, revision: generated.revision },
      decision: "approve",
    });
  }
  await workflow.selectProviders(
    created.manifest.taskId,
    REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
      capability,
      providerId: "jimeng-manual",
      mode: "manual" as const,
    })),
  );
  return created.manifest.taskId;
}

function textResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    throw new Error("Expected MCP text result");
  }
  const content: unknown = result.content;
  if (!Array.isArray(content)) throw new Error("Expected MCP text result");
  const first: unknown = (content as unknown[])[0];
  if (!first || typeof first !== "object" || !("text" in first)) {
    throw new Error("Expected MCP text result");
  }
  const text: unknown = first.text;
  if (typeof text !== "string") throw new Error("Expected MCP text result");
  return text;
}
