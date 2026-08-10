import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComfyUiProviderAdapter } from "../../src/providers/comfyui.js";
import { ProviderExecutionManager } from "../../src/providers/execution-manager.js";
import type { AttemptContext, PaidSubmitConfirmation } from "../../src/providers/job-store.js";
import { ManualProviderAdapter } from "../../src/providers/manual.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type {
  ProviderAdapter,
  ProviderJob,
  ProviderOutput,
} from "../../src/providers/types.js";
import { ProviderProtocolError } from "../../src/providers/types.js";

const temporaryDirectories: string[] = [];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const tinyMp4 = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1]);
const tinyWav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
const tinyWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ProviderExecutionManager", () => {
  it("routes estimate, confirmed submit, poll, cancellation, and recovery through one task ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-"));
    temporaryDirectories.push(root);
    const adapter = fakeAdapter();
    const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
      clock: { now: () => new Date("2026-08-10T00:00:00.000Z") },
    });

    await expect(
      manager.estimate("fake", {
        capability: "video.i2v",
        input: { duration: 6 },
      }),
    ).resolves.toMatchObject({ providerId: "fake", estimatedSeconds: 6 });

    const { attempt } = await manager.submitConfirmed(
      "fake",
      {
        capability: "video.i2v",
        model: "fake-video",
        input: { firstFrame: "frame-1" },
      },
      {
        stage: "clips",
        stageRevision: 4,
        costConfirmation: {
          confirmedAt: "2026-08-10T00:00:00.000Z",
          confirmedBy: "user",
          confirmationReference: "review:clips:v004:cost-1",
          pricingStatus: "known",
          estimatedCost: 0.2,
          maximumCost: 0.25,
          currency: "USD",
        },
      },
    );
    expect(await manager.listAttempts()).toEqual([
      expect.objectContaining({
        attemptId: attempt.attemptId,
        providerId: "fake",
        state: "queued",
      }),
    ]);
    expect(await manager.poll(attempt.attemptId)).toMatchObject({ state: "running" });
    expect(await manager.resumeCandidates()).toEqual([
      expect.objectContaining({ attemptId: attempt.attemptId, state: "running" }),
    ]);
    expect(await manager.cancel(attempt.attemptId)).toMatchObject({ state: "cancelled" });
  });

  it("cannot bypass paid confirmation through the public submit entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-"));
    temporaryDirectories.push(root);
    const adapter = fakeAdapter();
    const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root);

    await expect(
      manager.submitConfirmed(
        "fake",
        { capability: "video.i2v", input: { firstFrame: "frame-1" } },
        undefined as never,
      ),
    ).rejects.toThrow(/confirmation is required/i);
  });

  it("binds confirmation to the adapter estimate and rejects caller-supplied underpricing", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-price-"));
    temporaryDirectories.push(root);
    let submitCalls = 0;
    const adapter = pricedImageAdapter(() => {
      submitCalls += 1;
    });
    const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
      clock: { now: () => new Date("2026-08-10T00:00:00.000Z") },
    });
    const request = { capability: "image.generate" as const, input: { prompt: "priced" } };

    await expect(
      manager.submitConfirmed(
        "priced",
        request,
        knownContext("keyframes", { estimatedCost: 0, maximumCost: 1 }),
      ),
    ).rejects.toThrow(/exactly match provider estimate 0\.2 USD/i);
    await expect(
      manager.submitConfirmed("priced", request, {
        stage: "keyframes",
        stageRevision: 1,
        costConfirmation: {
          confirmedAt: "2026-08-10T00:00:00.000Z",
          confirmedBy: "user",
          confirmationReference: "review:keyframes:v001:cost-missing",
          pricingStatus: "known",
          maximumCost: 1,
          currency: "USD",
        } as PaidSubmitConfirmation,
      }),
    ).rejects.toThrow(/exactly match provider estimate 0\.2 USD/i);
    expect(submitCalls).toBe(0);

    const { attempt } = await manager.submitConfirmed(
      "priced",
      request,
      knownContext("keyframes", { estimatedCost: 0.2, maximumCost: 0.25 }),
    );
    expect(submitCalls).toBe(1);
    expect(attempt.pricingSnapshot).toMatchObject({
      providerId: "priced",
      pricingStatus: "known",
      price: { currency: "USD", amount: 0.2, unit: "request" },
      calculatedCost: 0.2,
      currency: "USD",
      estimatedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(attempt.pricingSnapshot.estimateSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires an explicit unknown-price acknowledgement and permits manual packaging", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-manual-price-"));
    temporaryDirectories.push(root);
    const registry = new ProviderRegistry([
      new ManualProviderAdapter({
        id: "manual",
        requestDirectory: join(root, "unsafe", "requests"),
        resultDirectory: join(root, "unsafe", "results"),
      }),
    ]);
    const manager = new ProviderExecutionManager(registry, root, {
      clock: { now: () => new Date("2026-08-10T00:00:00.000Z") },
    });

    await expect(
      manager.submitConfirmed("manual", { capability: "image.generate", input: { prompt: "manual" } }, {
        stage: "keyframes",
        stageRevision: 1,
        costConfirmation: {
          confirmedAt: "2026-08-10T00:00:00.000Z",
          confirmedBy: "user",
          confirmationReference: "review:keyframes:v001:cost-unknown",
          pricingStatus: "unknown",
          maximumCost: 1,
          currency: "USD",
        } as PaidSubmitConfirmation,
      }),
    ).rejects.toThrow(/unknownPricingAcknowledged=true/i);

    const { attempt } = await manager.submitConfirmed(
      "manual",
      { capability: "image.generate", input: { prompt: "manual acknowledged" } },
      confirmedContext("keyframes"),
    );
    expect(attempt.pricingSnapshot).toMatchObject({
      providerId: "manual",
      pricingStatus: "unknown",
      currency: "USD",
    });
    expect(attempt.pricingSnapshot).not.toHaveProperty("calculatedCost");
  });

  it("reuses the original estimate and confirmation when resuming the same failed submit", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-resume-"));
    temporaryDirectories.push(root);
    let estimateCalls = 0;
    let submitCalls = 0;
    const adapter = outputAdapter({ submitState: "queued" });
    const recoverable: ProviderAdapter = {
      ...adapter,
      estimate: async (request) => {
        estimateCalls += 1;
        return { providerId: "remote", capability: request.capability };
      },
      submit: async () => {
        submitCalls += 1;
        if (submitCalls === 1) {
          throw new ProviderProtocolError("temporary submit failure", { retryable: true });
        }
        return adapter.submit({ capability: "image.generate", input: {} });
      },
    };
    const manager = new ProviderExecutionManager(new ProviderRegistry([recoverable]), root);
    const request = { capability: "image.generate" as const, input: { prompt: "resume" } };

    await expect(
      manager.submitConfirmed("remote", request, confirmedContext("keyframes")),
    ).rejects.toThrow(/temporary submit failure/);
    const [candidate] = await manager.resumeCandidates();
    expect(candidate).toMatchObject({ state: "failed_retryable" });

    await expect(manager.resumePrepared(candidate?.attemptId ?? "", request)).resolves.toMatchObject({
      attempt: { state: "queued" },
    });
    expect(estimateCalls).toBe(1);
    expect(submitCalls).toBe(2);
  });

  it("enforces provider concurrency one across independent managers sharing a task", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-concurrency-"));
    temporaryDirectories.push(root);
    let submitCalls = 0;
    const base = outputAdapter({ submitState: "queued" });
    const adapter: ProviderAdapter = {
      ...base,
      submit: async (request) => {
        submitCalls += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        return base.submit(request);
      },
    };
    const registry = new ProviderRegistry([adapter]);
    const managerA = new ProviderExecutionManager(registry, root);
    const managerB = new ProviderExecutionManager(registry, root);

    const results = await Promise.allSettled([
      managerA.submitConfirmed(
        "remote",
        { capability: "image.generate", input: { prompt: "first" } },
        confirmedContext("keyframes"),
      ),
      managerB.submitConfirmed(
        "remote",
        { capability: "image.generate", input: { prompt: "second" } },
        confirmedContext("keyframes"),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected one concurrent submit to fail");
    const reason: unknown = rejected.reason;
    expect(reason).toBeInstanceOf(Error);
    expect(reason instanceof Error ? reason.message : "").toMatch(
      /concurrency limit 1/i,
    );
    expect(submitCalls).toBe(1);
    expect(await managerA.listAttempts()).toEqual([
      expect.objectContaining({ providerId: "remote", state: "queued" }),
    ]);
  });

  it("keeps a single terminal projection under concurrent duplicate polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-poll-race-"));
    temporaryDirectories.push(root);
    let pollCalls = 0;
    const base = outputAdapter({ submitState: "queued", pollState: "succeeded" });
    const adapter: ProviderAdapter = {
      ...base,
      poll: async (request) => {
        pollCalls += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        return base.poll(request);
      },
    };
    const registry = new ProviderRegistry([adapter]);
    const managerA = new ProviderExecutionManager(registry, root);
    const managerB = new ProviderExecutionManager(registry, root);
    const { attempt } = await managerA.submitConfirmed(
      "remote",
      { capability: "image.generate", input: { prompt: "poll race" } },
      confirmedContext("keyframes"),
    );

    await expect(
      Promise.all([managerA.poll(attempt.attemptId), managerB.poll(attempt.attemptId)]),
    ).resolves.toEqual([
      expect.objectContaining({ state: "succeeded" }),
      expect.objectContaining({ state: "succeeded" }),
    ]);
    expect(pollCalls).toBe(2);
    expect(await managerA.listAttempts()).toEqual([
      expect.objectContaining({ attemptId: attempt.attemptId, state: "succeeded", revision: 3 }),
    ]);
    const ledger = await readFile(join(root, "provider-jobs.jsonl"), "utf8");
    expect(ledger.match(/"type":"polled"/g)).toHaveLength(1);
  });

  it("archives synchronous temporary outputs before recording success", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-"));
    temporaryDirectories.push(root);
    const signedUrl = "https://assets.example/frame.png?signature=must-not-persist";
    const adapter = outputAdapter({
      submitState: "succeeded",
      submitOutputs: [{ kind: "image", uri: signedUrl }],
    });
    const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
      downloadFetch: async () =>
        new Response(onePixelPng, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    });

    const { attempt, job } = await manager.submitConfirmed(
      "remote",
      { capability: "image.generate", input: { prompt: "archive me" } },
      confirmedContext("keyframes"),
    );

    expect(job.outputs?.[0]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      sizeBytes: onePixelPng.byteLength,
    });
    expect(job.outputs?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(job.outputs?.[0]?.uri).toBeUndefined();
    expect(await readFile(job.outputs?.[0]?.localPath ?? "")).toEqual(onePixelPng);
    expect(await readFile(job.outputs?.[0]?.archivedPath ?? "")).toEqual(onePixelPng);
    expect(attempt.state).toBe("succeeded");
    const ledger = await readFile(join(root, "provider-jobs.jsonl"), "utf8");
    expect(ledger).not.toContain("assets.example");
    expect(ledger).not.toContain("must-not-persist");
    expect(ledger).not.toContain('"uri"');
  });

  it.each([403, 410])(
    "keeps a synchronous attempt recoverable when its temporary URL returns HTTP %s",
    async (status) => {
      const root = await mkdtemp(join(tmpdir(), "provider-manager-"));
      temporaryDirectories.push(root);
      const adapter = outputAdapter({
        submitState: "succeeded",
        submitOutputs: [
          { kind: "image", uri: "https://assets.example/expired.png?signature=expired-secret" },
        ],
      });
      const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
        downloadFetch: async () =>
          new Response("expired", { status, headers: { "Content-Type": "text/plain" } }),
      });

      await expect(
        manager.submitConfirmed(
          "remote",
          { capability: "image.generate", input: { prompt: "expired" } },
          confirmedContext("keyframes"),
        ),
      ).rejects.toMatchObject({
        code: "provider_output_archive_failed",
        retryable: true,
      });
      expect(await manager.resumeCandidates()).toEqual([
        expect.objectContaining({ state: "failed_retryable" }),
      ]);
      const ledger = await readFile(join(root, "provider-jobs.jsonl"), "utf8");
      expect(ledger).not.toContain('"state":"succeeded"');
      expect(ledger).not.toContain("expired-secret");
      expect(ledger).not.toContain("assets.example");
    },
  );

  it("archives a successful poll before changing the attempt to succeeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-"));
    temporaryDirectories.push(root);
    const adapter = outputAdapter({
      submitState: "queued",
      pollState: "succeeded",
      pollOutputs: [
        { kind: "video", uri: "https://assets.example/clip.mp4?signature=poll-secret" },
      ],
    });
    const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
      downloadFetch: async () =>
        new Response(tinyMp4, { status: 200, headers: { "Content-Type": "video/mp4" } }),
    });
    const { attempt } = await manager.submitConfirmed(
      "remote",
      { capability: "image.generate", input: { prompt: "poll archive" } },
      confirmedContext("clips"),
    );

    const completed = await manager.poll(attempt.attemptId);
    expect(completed).toMatchObject({
      state: "succeeded",
      outputs: [{ kind: "video", mimeType: "video/mp4" }],
    });
    expect(completed.outputs?.[0]?.uri).toBeUndefined();
    expect(await readFile(completed.outputs?.[0]?.localPath ?? "")).toEqual(tinyMp4);
    const attempts = await manager.listAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("succeeded");
    expect(attempts[0]?.outputs?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const ledger = await readFile(join(root, "provider-jobs.jsonl"), "utf8");
    expect(ledger).not.toContain("poll-secret");
  });

  it("derives durable extensions from verified JPEG, WAV, and WebM MIME types", async () => {
    const cases: Array<{
      kind: ProviderOutput["kind"];
      mimeType: string;
      bytes: Buffer;
      extension: string;
    }> = [
      { kind: "image", mimeType: "image/jpeg", bytes: tinyJpeg, extension: ".jpg" },
      { kind: "audio", mimeType: "audio/wav", bytes: tinyWav, extension: ".wav" },
      { kind: "video", mimeType: "video/webm", bytes: tinyWebm, extension: ".webm" },
    ];

    for (const entry of cases) {
      const root = await mkdtemp(join(tmpdir(), "provider-manager-mime-"));
      temporaryDirectories.push(root);
      const adapter = outputAdapter({
        submitState: "succeeded",
        submitOutputs: [{ kind: entry.kind, uri: "https://assets.example/output" }],
      });
      const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
        downloadFetch: async () =>
          new Response(new Uint8Array(Array.from(entry.bytes)), {
            status: 200,
            headers: { "Content-Type": entry.mimeType },
          }),
      });
      const { job } = await manager.submitConfirmed(
        "remote",
        { capability: "image.generate", input: { prompt: `mime ${entry.mimeType}` } },
        confirmedContext("keyframes"),
      );
      const output = job.outputs?.[0];
      expect(output?.mimeType).toBe(entry.mimeType);
      expect(output?.localPath).toMatch(new RegExp(`\\${entry.extension}$`));
      expect(output?.archivedPath).toMatch(new RegExp(`\\${entry.extension}$`));
      expect(await readFile(output?.localPath ?? "")).toEqual(entry.bytes);
    }
  });

  it("allows ComfyUI local HTTP only for an explicitly trusted exact origin", async () => {
    const uri = "http://127.0.0.1:8188/view?filename=frame.png";
    const blockedRoot = await mkdtemp(join(tmpdir(), "provider-manager-"));
    const allowedRoot = await mkdtemp(join(tmpdir(), "provider-manager-"));
    temporaryDirectories.push(blockedRoot, allowedRoot);
    const blocked = new ProviderExecutionManager(
      new ProviderRegistry([outputAdapter({ adapter: "comfyui", submitState: "succeeded", submitOutputs: [{ kind: "image", uri }] })]),
      blockedRoot,
      { downloadFetch: async () => new Response(onePixelPng, { headers: { "Content-Type": "image/png" } }) },
    );
    await expect(
      blocked.submitConfirmed(
        "remote",
        { capability: "image.generate", input: { prompt: "local blocked" } },
        confirmedContext("keyframes"),
      ),
    ).rejects.toMatchObject({ code: "provider_output_archive_failed" });

    const allowed = new ProviderExecutionManager(
      new ProviderRegistry([outputAdapter({ adapter: "comfyui", submitState: "succeeded", submitOutputs: [{ kind: "image", uri }] })]),
      allowedRoot,
      {
        trustedComfyUiOutputOrigins: ["http://127.0.0.1:8188"],
        downloadFetch: async () =>
          new Response(onePixelPng, { headers: { "Content-Type": "image/png" } }),
      },
    );
    await expect(
      allowed.submitConfirmed(
        "remote",
        { capability: "image.generate", input: { prompt: "local allowed" } },
        confirmedContext("keyframes"),
      ),
    ).resolves.toMatchObject({ attempt: { state: "succeeded" } });
  });

  it("automatically trusts only the exact configured ComfyUI output origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manager-comfy-origin-"));
    temporaryDirectories.push(root);
    const providerFetch = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === "/prompt") {
        return jsonResponse({ prompt_id: "prompt-42", node_errors: {} });
      }
      if (url.pathname === "/history/prompt-42") {
        return jsonResponse({
          "prompt-42": {
            status: { completed: true, status_str: "success" },
            outputs: {
              node: { images: [{ filename: "frame.png", type: "output" }] },
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const adapter = new ComfyUiProviderAdapter({
      id: "comfy-local",
      baseUrl: "http://127.0.0.1:8188",
      fetch: providerFetch,
      clock: { now: () => new Date("2026-08-10T00:00:00.000Z") },
    });
    const manager = new ProviderExecutionManager(new ProviderRegistry([adapter]), root, {
      downloadFetch: async (input) => {
        expect(new URL(input).origin).toBe("http://127.0.0.1:8188");
        return new Response(onePixelPng, { headers: { "Content-Type": "image/png" } });
      },
    });
    const { attempt } = await manager.submitConfirmed(
      "comfy-local",
      {
        capability: "image.generate",
        input: { workflow: { node: { class_type: "SaveImage" } } },
        metadata: { workflowVersion: "v001" },
      },
      confirmedContext("keyframes"),
    );

    const completed = await manager.poll(attempt.attemptId);
    expect(completed).toMatchObject({ state: "succeeded" });
    expect(completed.outputs?.[0]).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(completed.outputs?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.outputs?.[0]?.uri).toBeUndefined();
  });

  it("routes one shared manual provider into isolated per-task package directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-manual-scope-"));
    temporaryDirectories.push(root);
    const sharedRequests = join(root, "unsafe-shared", "requests");
    const sharedResults = join(root, "unsafe-shared", "results");
    const registry = new ProviderRegistry([
      new ManualProviderAdapter({
        id: "manual",
        requestDirectory: sharedRequests,
        resultDirectory: sharedResults,
      }),
    ]);
    const taskA = join(root, "task-a");
    const taskB = join(root, "task-b");
    const managerA = new ProviderExecutionManager(registry, taskA);
    const managerB = new ProviderExecutionManager(registry, taskB);

    await managerA.submitConfirmed(
      "manual",
      { capability: "image.generate", input: { prompt: "task A" } },
      confirmedContext("keyframes"),
    );
    await managerB.submitConfirmed(
      "manual",
      { capability: "image.generate", input: { prompt: "task B" } },
      confirmedContext("keyframes"),
    );

    const taskAFiles = await readdir(join(taskA, "manual", "requests"));
    const taskBFiles = await readdir(join(taskB, "manual", "requests"));
    expect(taskAFiles).toHaveLength(1);
    expect(taskBFiles).toHaveLength(1);
    const packageA = await readFile(join(taskA, "manual", "requests", taskAFiles[0] ?? ""), "utf8");
    const packageB = await readFile(join(taskB, "manual", "requests", taskBFiles[0] ?? ""), "utf8");
    expect(packageA).toContain("task A");
    expect(packageA).not.toContain("task B");
    expect(packageB).toContain("task B");
    expect(packageB).not.toContain("task A");
    await expect(readdir(sharedRequests)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(sharedResults)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function confirmedContext(stage: string): AttemptContext {
  return {
    stage,
    stageRevision: 1,
    costConfirmation: {
      confirmedAt: "2026-08-10T00:00:00.000Z",
      confirmedBy: "user" as const,
      confirmationReference: `review:${stage}:v001:cost-1`,
      pricingStatus: "unknown",
      unknownPricingAcknowledged: true,
      maximumCost: 1,
      currency: "USD",
    },
  };
}

function knownContext(
  stage: string,
  costs: { estimatedCost: number; maximumCost: number },
): AttemptContext {
  return {
    stage,
    stageRevision: 1,
    costConfirmation: {
      confirmedAt: "2026-08-10T00:00:00.000Z",
      confirmedBy: "user",
      confirmationReference: `review:${stage}:v001:cost-known`,
      pricingStatus: "known",
      estimatedCost: costs.estimatedCost,
      maximumCost: costs.maximumCost,
      currency: "USD",
    },
  };
}

function pricedImageAdapter(beforeSubmit: () => void): ProviderAdapter {
  return {
    descriptor: {
      id: "priced",
      displayName: "Priced Fake",
      adapter: "fake",
      capabilities: ["image.generate"],
    },
    capabilities: async () => ["image.generate"],
    health: async () => ({
      providerId: "priced",
      status: "healthy",
      checkedAt: "2026-08-10T00:00:00.000Z",
    }),
    estimate: async (request) => ({
      providerId: "priced",
      capability: request.capability,
      price: { currency: "USD", amount: 0.2, unit: "request" },
    }),
    submit: async (request) => {
      beforeSubmit();
      return {
        id: "priced:job-1",
        remoteJobId: "job-1",
        providerId: "priced",
        capability: request.capability,
        state: "queued",
        submittedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      };
    },
    poll: async (request) => ({
      id: `priced:${request.remoteJobId}`,
      remoteJobId: request.remoteJobId,
      providerId: "priced",
      capability: request.capability,
      state: "running",
      submittedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    }),
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function outputAdapter(options: {
  adapter?: string;
  submitState: ProviderJob["state"];
  submitOutputs?: ProviderJob["outputs"];
  pollState?: ProviderJob["state"];
  pollOutputs?: ProviderJob["outputs"];
}): ProviderAdapter {
  const job = (
    state: ProviderJob["state"],
    outputs?: ProviderJob["outputs"],
  ): ProviderJob => ({
    id: "remote:job-1",
    remoteJobId: "job-1",
    providerId: "remote",
    capability: "image.generate",
    state,
    submittedAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
    ...(outputs ? { outputs } : {}),
  });
  return {
    descriptor: {
      id: "remote",
      displayName: "Remote Fake",
      adapter: options.adapter ?? "fake",
      capabilities: ["image.generate"],
    },
    capabilities: async () => ["image.generate"],
    health: async () => ({
      providerId: "remote",
      status: "healthy",
      checkedAt: "2026-08-10T00:00:00.000Z",
    }),
    estimate: async (request) => ({ providerId: "remote", capability: request.capability }),
    submit: async () => job(options.submitState, options.submitOutputs),
    poll: async () => job(options.pollState ?? "running", options.pollOutputs),
  };
}

function fakeAdapter(): ProviderAdapter {
  const job = (state: ProviderJob["state"]): ProviderJob => ({
    id: "fake:job-1",
    remoteJobId: "job-1",
    providerId: "fake",
    capability: "video.i2v",
    state,
    submittedAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
  });
  return {
    descriptor: {
      id: "fake",
      displayName: "Fake",
      adapter: "fake",
      capabilities: ["video.i2v"],
    },
    capabilities: async () => ["video.i2v"],
    health: async () => ({
      providerId: "fake",
      status: "healthy",
      checkedAt: "2026-08-10T00:00:00.000Z",
    }),
    estimate: async (request) => ({
      providerId: "fake",
      capability: request.capability,
      model: request.model,
      price: { currency: "USD", amount: 0.2, unit: "request" },
      estimatedSeconds: 6,
    }),
    submit: async () => job("queued"),
    poll: async () => job("running"),
    cancel: async () => job("cancelled"),
  };
}
