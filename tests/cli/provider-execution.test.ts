import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { runCli, type CliDependencies } from "../../src/cli/index.js";
import {
  paidSubmitConfirmationSchema,
  providerSubmitRequestSchema,
} from "../../src/cli/provider-execution.js";
import { REQUIRED_PROVIDER_CAPABILITIES } from "../../src/contracts/index.js";
import {
  ProviderError,
  ManualProviderAdapter,
  ProviderRegistry,
  ProviderRegistryFacade,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderJob,
} from "../../src/providers/index.js";
import { WorkflowService } from "../../src/workflow/index.js";
import { makeStageContract } from "../helpers/stage-contracts.js";

describe("provider execution CLI", () => {
  let root: string;
  let workflow: WorkflowService;
  let registry: ProviderRegistry;
  let taskId: string;
  let stdout: string;
  let stderr: string;
  let submitCalls: number;
  let failNextSubmit: boolean;
  let lastSubmittedModel: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cartoon-provider-cli-"));
    stdout = "";
    stderr = "";
    submitCalls = 0;
    failNextSubmit = false;
    lastSubmittedModel = undefined;
    registry = new ProviderRegistry([fakeAdapter()]);
    let sequence = 0;
    workflow = new WorkflowService({
      legacyUnstructuredImportsForTests: true,
      defaultRoot: root,
      providerFacade: new ProviderRegistryFacade(registry),
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    taskId = await prepareMediaTask(workflow);
  });

  const dependencies = (): CliDependencies => ({
    workflow,
    providerFacade: new ProviderRegistryFacade(registry),
    providerRegistry: registry,
    cwd: root,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });

  it("blocks missing confirmation, excess cost, and a provider that differs from the frozen binding", async () => {
    const requestPath = await writeRequest(root);
    const confirmationPath = await writeConfirmation(root, {
      estimatedCost: 2,
      maximumCost: 1,
    });

    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          `@${requestPath}`,
        ],
        dependencies(),
      ),
    ).toBe(2);
    expect(stderr).toContain("confirmation");
    expect(submitCalls).toBe(0);

    stderr = "";
    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
        ],
        dependencies(),
      ),
    ).toBe(1);
    expect(stderr).toContain("estimatedCost exceeds");
    expect(submitCalls).toBe(0);

    await writeConfirmation(root, { estimatedCost: 0.2, maximumCost: 0.25 });
    stderr = "";
    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "other",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
        ],
        dependencies(),
      ),
    ).toBe(1);
    expect(stderr).toContain("frozen to fake");
    expect(submitCalls).toBe(0);
  });

  it("rejects an unfrozen request model and injects the explicitly frozen model", async () => {
    const adHocRequest = join(root, "ad-hoc-model-request.json");
    await writeFile(
      adHocRequest,
      JSON.stringify({
        capability: "image.generate",
        model: "unfrozen-model",
        input: { prompt: "Original lantern hero" },
      }),
      "utf8",
    );
    const confirmationPath = await writeConfirmation(root, {
      estimatedCost: 0.2,
      maximumCost: 0.25,
    });
    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          adHocRequest,
          "--confirmation",
          confirmationPath,
        ],
        dependencies(),
      ),
    ).toBe(1);
    expect(stderr).toContain("has no frozen model");
    expect(submitCalls).toBe(0);

    root = await mkdtemp(join(tmpdir(), "cartoon-provider-model-cli-"));
    let sequence = 500;
    workflow = new WorkflowService({
      legacyUnstructuredImportsForTests: true,
      defaultRoot: root,
      providerFacade: new ProviderRegistryFacade(registry),
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    taskId = await prepareMediaTask(workflow, "fake", "api", "frozen-model");
    const requestPath = await writeRequest(root);
    const frozenConfirmationPath = await writeConfirmation(root, {
      estimatedCost: 0.2,
      maximumCost: 0.25,
    });
    stderr = "";
    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          frozenConfirmationPath,
        ],
        dependencies(),
      ),
    ).toBe(0);
    expect(lastSubmittedModel).toBe("frozen-model");
  });

  it("enforces the known/unknown pricing confirmation discriminant", () => {
    const base = {
      confirmedAt: "2026-08-10T01:02:03.000Z",
      confirmedBy: "user",
      confirmationReference: "review:assets:v001:cost-1",
      maximumCost: 0,
      currency: "USD",
    } as const;
    expect(
      paidSubmitConfirmationSchema.safeParse({
        ...base,
        pricingStatus: "unknown",
        unknownPricingAcknowledged: true,
      }).success,
    ).toBe(true);
    expect(
      paidSubmitConfirmationSchema.safeParse({
        ...base,
        pricingStatus: "unknown",
        unknownPricingAcknowledged: true,
        estimatedCost: 0,
      }).success,
    ).toBe(false);
    expect(
      paidSubmitConfirmationSchema.safeParse({
        ...base,
        pricingStatus: "unknown",
      }).success,
    ).toBe(false);
  });

  it("submits once and polls/lists the same durable job without another confirmation", async () => {
    const requestPath = await writeRequest(root);
    const confirmationPath = await writeConfirmation(root, {
      estimatedCost: 0.2,
      maximumCost: 0.25,
    });

    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    const submitted = JSON.parse(stdout) as {
      attempt: { attemptId: string; state: string };
    };
    expect(submitted.attempt.state).toBe("queued");
    expect(submitCalls).toBe(1);

    stdout = "";
    expect(
      await runCli(
        ["providers", "poll", taskId, "--attempt", submitted.attempt.attemptId, "--json"],
        dependencies(),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ state: "running" });
    expect(submitCalls).toBe(1);

    stdout = "";
    expect(
      await runCli(["providers", "jobs", taskId, "--json"], dependencies()),
    ).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({
        attemptId: submitted.attempt.attemptId,
        state: "running",
      }),
    ]);
  });

  it("allows an assets contact-sheet render through the public provider-job CLI", async () => {
    const requestPath = join(root, "contact-sheet-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        capability: "render.timeline",
        input: {
          schemaVersion: 1,
          contactSheet: {
            inputPaths: ["04-assets/v001/character.png"],
            outputPath: "04-assets/v001/contact-sheet.png",
          },
        },
      }),
      "utf8",
    );
    const confirmationPath = await writeConfirmation(root, {
      estimatedCost: 0.2,
      maximumCost: 0.25,
    });

    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      job: { capability: "render.timeline", state: "queued" },
    });
    expect(submitCalls).toBe(1);
  });

  it("resumes the exact failed request using the persisted confirmation", async () => {
    const requestPath = await writeRequest(root);
    const confirmationPath = await writeConfirmation(root, {
      estimatedCost: 0.2,
      maximumCost: 0.25,
    });
    failNextSubmit = true;

    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
        ],
        dependencies(),
      ),
    ).toBe(1);
    expect(submitCalls).toBe(1);

    stdout = "";
    expect(
      await runCli(["providers", "jobs", taskId, "--json"], dependencies()),
    ).toBe(0);
    const attempts = JSON.parse(stdout) as Array<{ attemptId: string; state: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("failed_retryable");

    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "resume-job",
          taskId,
          "--attempt",
          attempts[0]?.attemptId ?? "missing",
          "--request",
          requestPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ job: { state: "queued" } });
    expect(submitCalls).toBe(2);
  });

  it("creates a zero-cost manual request package and leaves the stage waiting for import", async () => {
    const requestDirectory = join(root, "manual", "requests");
    const resultDirectory = join(root, "manual", "results");
    let manualSequence = 0;
    registry = new ProviderRegistry([
      new ManualProviderAdapter({
        requestDirectory,
        resultDirectory,
        ids: { next: () => `manual-job-${++manualSequence}` },
        clock: { now: () => new Date("2026-08-10T01:02:03.000Z") },
      }),
    ]);
    let sequence = 100;
    workflow = new WorkflowService({
      legacyUnstructuredImportsForTests: true,
      defaultRoot: root,
      providerFacade: new ProviderRegistryFacade(registry),
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    taskId = await prepareMediaTask(workflow, "manual", "manual");
    const requestPath = await writeRequest(root);
    const confirmationPath = await writeConfirmation(root, {
      pricingStatus: "unknown",
      unknownPricingAcknowledged: true,
      maximumCost: 0,
    });

    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "manual",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    const submitted = JSON.parse(stdout) as {
      attempt: { attemptId: string };
      job: { state: string; metadata: { requestPackagePath: string } };
    };
    expect(submitted.job.state).toBe("queued");
    const requestPackage = JSON.parse(
      await readFile(submitted.job.metadata.requestPackagePath, "utf8"),
    ) as {
      schemaVersion: number;
      providerId: string;
      capability: string;
      instructions: string;
    };
    expect(requestPackage).toMatchObject({
      schemaVersion: 1,
      providerId: "manual",
      capability: "image.generate",
    });
    expect(requestPackage.instructions).toContain("outside the workflow");

    stdout = "";
    expect(
      await runCli(
        ["providers", "poll", taskId, "--attempt", submitted.attempt.attemptId, "--json"],
        dependencies(),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ state: "queued" });
    expect((await workflow.getState(taskId)).stages.assets.status).toBe("pending");

    const state = await workflow.getState(taskId);
    const storyboard = state.stages.storyboard.revisions[0]?.stageContract;
    if (storyboard?.stage !== "storyboard") throw new Error("structured storyboard missing");
    const exportedImages = Array.from(
      { length: storyboard.assetDefinitions.length + 1 },
      (_, index) => join(root, `manual-export-${index + 1}.png`),
    );
    const completionPath = join(root, "manual-completion-1.json");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await Promise.all(exportedImages.map((path) => writeFile(path, png)));
    const firstOutputs = exportedImages.slice(0, 2);
    const secondOutputs = exportedImages.slice(2);
    await writeFile(
      completionPath,
      JSON.stringify({
        outputs: firstOutputs.map((sourcePath) => ({ kind: "image", sourcePath })),
      }),
      "utf8",
    );
    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "complete-manual",
          taskId,
          "--attempt",
          submitted.attempt.attemptId,
          "--result",
          completionPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    const completedFirst = JSON.parse(stdout) as {
      state: string;
      outputs: Array<{ kind: string; mimeType: string; localPath: string }>;
    };
    expect(completedFirst.state).toBe("succeeded");
    expect(completedFirst.outputs).toHaveLength(firstOutputs.length);
    expect(
      completedFirst.outputs.every(
        (output) => output.kind === "image" && output.mimeType === "image/png",
      ),
    ).toBe(true);

    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "manual",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    const submittedSecond = JSON.parse(stdout) as { attempt: { attemptId: string } };
    const secondCompletionPath = join(root, "manual-completion-2.json");
    await writeFile(
      secondCompletionPath,
      JSON.stringify({
        outputs: secondOutputs.map((sourcePath) => ({ kind: "image", sourcePath })),
      }),
      "utf8",
    );
    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "complete-manual",
          taskId,
          "--attempt",
          submittedSecond.attempt.attemptId,
          "--result",
          secondCompletionPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    const completedSecond = JSON.parse(stdout) as {
      state: string;
      outputs: Array<{ kind: string; mimeType: string; localPath: string }>;
    };
    const completedOutputs = [...completedFirst.outputs, ...completedSecond.outputs];
    const logicalFileNames = completedOutputs.map((_, index) =>
      index < storyboard.assetDefinitions.length
        ? `asset-${index + 1}.png`
        : "contact-sheet.png",
    );
    await expect(workflow.resume(taskId)).resolves.toMatchObject({
      action: {
        type: "import-provider-output",
        attemptIds: [submitted.attempt.attemptId, submittedSecond.attempt.attemptId],
      },
    });

    const contractPath = join(root, "assets-contract.json");
    const metadataPath = join(root, "assets-metadata.json");
    const contract = await makeStageContract(
      await workflow.getState(taskId),
      "assets",
      logicalFileNames,
    );
    await Promise.all([
      writeFile(contractPath, JSON.stringify(contract), "utf8"),
      writeFile(
        metadataPath,
        JSON.stringify({
          rights: {
            basis: "provider-terms",
            providerId: "manual",
            termsUrl: "https://provider.example.test/terms/commercial",
            termsReviewedAt: "2026-08-09T00:00:00.000Z",
            commercialUseConfirmed: true,
            thirdPartyInputsCleared: true,
          },
          fileNames: Object.fromEntries(
            completedOutputs.map((output, index) => [output.localPath, logicalFileNames[index]]),
          ),
        }),
        "utf8",
      ),
    ]);
    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "import-output",
          taskId,
          "--attempt",
          submitted.attempt.attemptId,
          "--attempt",
          submittedSecond.attempt.attemptId,
          "--contract",
          contractPath,
          "--metadata",
          metadataPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    const imported = JSON.parse(stdout) as {
      artifacts: Array<{ stage: string; providerAttemptId?: string }>;
    };
    expect(imported.artifacts).toHaveLength(exportedImages.length);
    expect(
      imported.artifacts.every(
        (artifact) => artifact.stage === "assets" && Boolean(artifact.providerAttemptId),
      ),
    ).toBe(true);
    expect(new Set(imported.artifacts.map((artifact) => artifact.providerAttemptId))).toEqual(
      new Set([submitted.attempt.attemptId, submittedSecond.attempt.attemptId]),
    );
    await expect(workflow.resume(taskId)).resolves.toMatchObject({
      action: { type: "review", stage: "assets" },
    });
  });

  it("prepares, confirms, records, and resumes a Codex-controlled platform handoff", async () => {
    registry = new ProviderRegistry([
      new ManualProviderAdapter({
        id: "jimeng-manual",
        displayName: "即梦 AI",
        adapter: "jimeng-manual",
        requestDirectory: join(root, "health", "requests"),
        resultDirectory: join(root, "health", "results"),
        capabilities: REQUIRED_PROVIDER_CAPABILITIES,
      }),
    ]);
    let sequence = 200;
    workflow = new WorkflowService({
      legacyUnstructuredImportsForTests: true,
      defaultRoot: root,
      providerFacade: new ProviderRegistryFacade(registry),
      clock: () => new Date("2026-08-10T01:02:03.000Z"),
      idGenerator: (prefix) => `${prefix}_${++sequence}`,
    });
    taskId = await prepareMediaTask(workflow, "jimeng-manual", "manual");
    const requestPath = await writeRequest(root);
    const uploadPath = join(workflow.resolveTaskDirectory(taskId), "handoff-reference.png");
    await writeFile(
      uploadPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    expect(
      await runCli(
        [
          "providers",
          "prepare-handoff",
          taskId,
          "--provider",
          "jimeng-manual",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--upload",
          uploadPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    const prepared = JSON.parse(stdout) as {
      attempt: {
        attemptId: string;
        handoff: { manifestSha256: string; manifestPath: string };
      };
    };
    expect((await workflow.resume(taskId)).action).toMatchObject({
      type: "execute-provider-handoff",
      attemptId: prepared.attempt.attemptId,
    });

    const awaitingPath = join(root, "handoff-awaiting.json");
    await writeFile(awaitingPath, JSON.stringify({ state: "awaiting_confirmation" }));
    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "record-handoff",
          taskId,
          "--attempt",
          prepared.attempt.attemptId,
          "--record",
          awaitingPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    expect((await workflow.resume(taskId)).action).toMatchObject({
      type: "confirm-provider-spend",
      attemptId: prepared.attempt.attemptId,
    });

    const confirmationPath = join(root, "handoff-spend.json");
    await writeFile(
      confirmationPath,
      JSON.stringify({
        confirmedAt: "2026-08-10T01:03:00.000Z",
        confirmedBy: "user",
        confirmationReference: `codex:${prepared.attempt.attemptId}:spend`,
        manifestSha256: prepared.attempt.handoff.manifestSha256,
        providerId: "jimeng-manual",
        creditUnit: "积分",
        pricingStatus: "known",
        estimatedCredits: 5,
        maximumCredits: 5,
      }),
    );
    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "confirm-handoff",
          taskId,
          "--attempt",
          prepared.attempt.attemptId,
          "--confirmation",
          confirmationPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);

    const submittedPath = join(root, "handoff-submitted.json");
    await writeFile(
      submittedPath,
      JSON.stringify({
        state: "submitted",
        receipt: {
          externalTaskId: "jimeng-task-5",
          observedCredits: 5,
          creditUnit: "积分",
        },
      }),
    );
    stdout = "";
    expect(
      await runCli(
        [
          "providers",
          "record-handoff",
          taskId,
          "--attempt",
          prepared.attempt.attemptId,
          "--record",
          submittedPath,
          "--json",
        ],
        dependencies(),
      ),
    ).toBe(0);
    expect((await workflow.resume(taskId)).action).toMatchObject({
      type: "poll-provider-handoff",
      attemptId: prepared.attempt.attemptId,
    });
  });

  it("rejects recursive clone intent before the adapter is called without rejecting catalog voiceId", async () => {
    expect(
      providerSubmitRequestSchema.safeParse({
        capability: "audio.tts",
        input: { voiceId: "catalog-narrator-01", text: "Ordinary catalog voice." },
      }).success,
    ).toBe(true);

    const requestPath = join(root, "clone-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        capability: "image.generate",
        input: {
          prompt: "An original lantern hero",
          nested: { voiceReference: "performer-reference.wav" },
        },
      }),
      "utf8",
    );
    const confirmationPath = await writeConfirmation(root, {
      estimatedCost: 0.2,
      maximumCost: 0.25,
    });

    expect(
      await runCli(
        [
          "providers",
          "submit",
          taskId,
          "--provider",
          "fake",
          "--stage",
          "assets",
          "--request",
          requestPath,
          "--confirmation",
          confirmationPath,
        ],
        dependencies(),
      ),
    ).toBe(1);
    expect(stderr).toContain("VoiceCloneConsent");
    expect(stderr).toContain("manual import");
    expect(submitCalls).toBe(0);
  });

  function fakeAdapter(): ProviderAdapter {
    const job = (
      state: ProviderJob["state"],
      capability: ProviderCapability,
    ): ProviderJob => ({
      id: `fake:job-${submitCalls || 1}`,
      remoteJobId: `job-${submitCalls || 1}`,
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
      submit: async (request) => {
        submitCalls += 1;
        lastSubmittedModel = request.model;
        if (failNextSubmit) {
          failNextSubmit = false;
          throw new ProviderError("temporary timeout", { retryable: true });
        }
        return job("queued", request.capability);
      },
      poll: async (request) => job("running", request.capability),
      cancel: async (request) => job("cancelled", request.capability),
    };
  }
});

async function prepareMediaTask(
  workflow: WorkflowService,
  providerId = "fake",
  mode: "api" | "manual" = "api",
  model?: string,
): Promise<string> {
  const created = await workflow.createTask({ ip: "Original Lantern Town", theme: "Courage" });
  for (const stage of ["concept", "script", "storyboard"] as const) {
    const imported = await workflow.generateStage(created.manifest.taskId, {
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
      providerId,
      mode,
      ...(model ? { model } : {}),
    })),
  );
  return created.manifest.taskId;
}

async function writeRequest(root: string): Promise<string> {
  const path = join(root, "provider-request.json");
  await writeFile(
    path,
    JSON.stringify({
      capability: "image.generate",
      input: { prompt: "A lantern hero, original character" },
    }),
    "utf8",
  );
  return path;
}

async function writeConfirmation(
  root: string,
  pricing:
    | { pricingStatus?: "known"; estimatedCost: number; maximumCost: number }
    | {
        pricingStatus: "unknown";
        unknownPricingAcknowledged: true;
        maximumCost: number;
      },
): Promise<string> {
  const path = join(root, "paid-confirmation.json");
  const normalizedPricing = pricing.pricingStatus === "unknown"
    ? pricing
    : { pricingStatus: "known" as const, ...pricing };
  await writeFile(
    path,
    JSON.stringify({
      confirmedAt: "2026-08-10T01:02:03.000Z",
      confirmedBy: "user",
      confirmationReference: "review:assets:v001:cost-1",
      currency: "USD",
      ...normalizedPricing,
    }),
    "utf8",
  );
  return path;
}
