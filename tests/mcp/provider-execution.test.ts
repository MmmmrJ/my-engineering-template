import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REQUIRED_PROVIDER_CAPABILITIES } from "../../src/contracts/index.js";
import { createCartoonMcpServer } from "../../src/mcp/server.js";
import {
  ProviderRegistry,
  ProviderRegistryFacade,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderJob,
} from "../../src/providers/index.js";
import { WorkflowService } from "../../src/workflow/index.js";

describe("provider execution MCP tools", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];
  let client: Client;
  let taskId: string;
  let submitCalls: number;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "cartoon-provider-mcp-"));
    submitCalls = 0;
    const registry = new ProviderRegistry([fakeAdapter(() => ++submitCalls)]);
    let sequence = 0;
    const workflow = new WorkflowService({
      defaultRoot: root,
      providerFacade: new ProviderRegistryFacade(registry),
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    taskId = await prepareMediaTask(workflow, root);
    const server = await createCartoonMcpServer({ workflow, providers: registry });
    client = new Client({ name: "provider-tools-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });
  });

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("rejects unconfirmed, over-limit, and binding-mismatched submits before the adapter", async () => {
    const unconfirmed = await client.callTool({
      name: "cartoon_submit_provider_job",
      arguments: {
        taskId,
        providerId: "fake",
        stage: "assets",
        request: providerRequest(),
      },
    });
    expect(unconfirmed.isError).toBe(true);
    expect(submitCalls).toBe(0);

    const overLimit = await client.callTool({
      name: "cartoon_submit_provider_job",
      arguments: {
        taskId,
        providerId: "fake",
        stage: "assets",
        request: providerRequest(),
        confirmation: confirmation(2, 1),
      },
    });
    expect(overLimit.isError).toBe(true);
    expect(submitCalls).toBe(0);

    const mismatch = await client.callTool({
      name: "cartoon_submit_provider_job",
      arguments: {
        taskId,
        providerId: "other",
        stage: "assets",
        request: providerRequest(),
        confirmation: confirmation(0.2, 0.25),
      },
    });
    expect(mismatch.isError).toBe(true);
    expect(textResult(mismatch)).toContain("frozen to fake");
    expect(submitCalls).toBe(0);
  });

  it("estimates, submits, polls, and lists one durable attempt without reconfirming", async () => {
    const estimate = await client.callTool({
      name: "cartoon_estimate_provider_job",
      arguments: {
        taskId,
        providerId: "fake",
        request: providerRequest(),
      },
    });
    expect(estimate.isError).not.toBe(true);
    expect(JSON.parse(textResult(estimate))).toMatchObject({
      providerId: "fake",
      price: { amount: 0.2, currency: "USD" },
    });

    const submittedResult = await client.callTool({
      name: "cartoon_submit_provider_job",
      arguments: {
        taskId,
        providerId: "fake",
        stage: "assets",
        request: providerRequest(),
        confirmation: confirmation(0.2, 0.25),
      },
    });
    expect(submittedResult.isError).not.toBe(true);
    const submitted = JSON.parse(textResult(submittedResult)) as {
      attempt: { attemptId: string; state: string };
    };
    expect(submitted.attempt.state).toBe("queued");
    expect(submitCalls).toBe(1);

    const polled = await client.callTool({
      name: "cartoon_poll_provider_job",
      arguments: { taskId, attemptId: submitted.attempt.attemptId },
    });
    expect(polled.isError).not.toBe(true);
    expect(JSON.parse(textResult(polled))).toMatchObject({ state: "running" });
    expect(submitCalls).toBe(1);

    const listed = await client.callTool({
      name: "cartoon_list_provider_jobs",
      arguments: { taskId, resumableOnly: false },
    });
    expect(JSON.parse(textResult(listed))).toEqual([
      expect.objectContaining({
        attemptId: submitted.attempt.attemptId,
        state: "running",
      }),
    ]);
  });
});

function providerRequest() {
  return {
    capability: "image.generate",
    input: { prompt: "A lantern hero, original character" },
  };
}

function confirmation(estimatedCost: number, maximumCost: number) {
  return {
    confirmedAt: "2026-08-10T01:02:03.000Z",
    confirmedBy: "user",
    confirmationReference: "review:assets:v001:cost-1",
    pricingStatus: "known",
    estimatedCost,
    maximumCost,
    currency: "USD",
  };
}

function fakeAdapter(onSubmit: () => number): ProviderAdapter {
  const job = (
    state: ProviderJob["state"],
    capability: ProviderCapability,
    ordinal: number,
  ): ProviderJob => ({
    id: `fake:job-${ordinal}`,
    remoteJobId: `job-${ordinal}`,
    providerId: "fake",
    capability,
    state,
    submittedAt: "2026-08-10T01:02:03.000Z",
    updatedAt: "2026-08-10T01:02:04.000Z",
  });
  return {
    descriptor: {
      id: "fake",
      displayName: "Fake Provider",
      adapter: "fake",
      capabilities: REQUIRED_PROVIDER_CAPABILITIES,
    },
    capabilities: async () => REQUIRED_PROVIDER_CAPABILITIES,
    health: async () => ({
      providerId: "fake",
      status: "healthy",
      checkedAt: "2026-08-10T01:02:03.000Z",
    }),
    estimate: async (request) => ({
      providerId: "fake",
      capability: request.capability,
      price: { amount: 0.2, currency: "USD", unit: "request" },
    }),
    submit: async (request) => job("queued", request.capability, onSubmit()),
    poll: async (request) => job("running", request.capability, 1),
    cancel: async (request) => job("cancelled", request.capability, 1),
  };
}

async function prepareMediaTask(workflow: WorkflowService, root: string): Promise<string> {
  const created = await workflow.createTask({ ip: "Original Lantern Town", theme: "Courage" });
  const source = join(root, "stage.md");
  await writeFile(source, "# approved stage\n", "utf8");
  for (const stage of ["concept", "script", "storyboard"] as const) {
    const imported = await workflow.importArtifact(created.manifest.taskId, {
      stage,
      sourceFiles: [source],
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
      target: { stage, revision: imported.revision },
      decision: "approve",
    });
  }
  await workflow.selectProviders(
    created.manifest.taskId,
    REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
      capability,
      providerId: "fake",
      mode: "api" as const,
    })),
  );
  return created.manifest.taskId;
}

function textResult(result: unknown): string {
  if (
    result === null ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected MCP content blocks.");
  }
  const block = (result.content as readonly unknown[])[0];
  if (
    block === null ||
    typeof block !== "object" ||
    !("type" in block) ||
    block.type !== "text" ||
    !("text" in block) ||
    typeof block.text !== "string"
  ) {
    throw new Error("Expected a text MCP result.");
  }
  return block.text;
}
