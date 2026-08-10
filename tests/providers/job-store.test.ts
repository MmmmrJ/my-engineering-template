import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculatePricingSnapshotHash,
  ProviderJobStore,
  type AuditedAttemptContext,
  type PaidSubmitConfirmation,
  type ProviderPricingSnapshot,
} from "../../src/providers/job-store.js";
import type { ProviderAdapter, ProviderJob } from "../../src/providers/types.js";
import { ProviderProtocolError } from "../../src/providers/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProviderJobStore", () => {
  it("fsyncs a redacted prepared record before submit and resumes by external job id", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    const store = new ProviderJobStore(root, {
      clock: { now: () => new Date("2026-08-10T00:00:00.000Z") },
      environment: { TEST_PROVIDER_SECRET: "do-not-persist-this-secret" },
    });
    const adapter = fakeAdapter(async () => {
      const ledgerBeforeCall = await readFile(store.path, "utf8");
      expect(ledgerBeforeCall).toContain('"type":"prepared"');
      expect(ledgerBeforeCall).not.toContain("lantern prompt");
    });

    const { attempt, job } = await store.submitTracked(
      adapter,
      {
        capability: "image.generate",
        model: "fake-image",
        input: { prompt: "lantern prompt" },
      },
      {
        ...auditedContext({
          stageRevision: 3,
          confirmation: knownConfirmation({ estimatedCost: 0.12, maximumCost: 0.2 }),
          calculatedCost: 0.12,
          model: "fake-image",
        }),
      },
    );
    expect(attempt).toMatchObject({
      state: "queued",
      externalJobId: "external-7",
      stage: "keyframes",
      stageRevision: 3,
      costConfirmation: {
        confirmedBy: "user",
        confirmationReference: "review:keyframes:v003:cost-1",
        pricingStatus: "known",
        estimatedCost: 0.12,
        maximumCost: 0.2,
        currency: "USD",
      },
      pricingSnapshot: {
        pricingStatus: "known",
        calculatedCost: 0.12,
        currency: "USD",
      },
    });
    expect(attempt.pricingSnapshot.estimateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(job.remoteJobId).toBe("external-7");

    await store.pollTracked(adapter, attempt.attemptId);
    const ledger = await readFile(store.path, "utf8");
    expect(ledger).not.toContain("lantern prompt");
    expect(ledger).not.toContain("signed-secret");
    expect(ledger).not.toContain("do-not-persist-this-secret");

    const reopened = new ProviderJobStore(root);
    const candidates = await reopened.resumeCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      attemptId: attempt.attemptId,
      externalJobId: "external-7",
      state: "running",
      stage: "keyframes",
      stageRevision: 3,
    });
  });

  it("rejects unsafe attempt audit context", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    const store = new ProviderJobStore(root);
    await expect(
      store.prepareSubmit(
        "fake",
        { capability: "image.generate", input: { prompt: "okay" } },
        {
          ...auditedContext(),
          stage: "../../secret",
          stageRevision: 0,
        },
      ),
    ).rejects.toThrow(/safe identifier/);
  });

  it("rejects a new submit without auditable user cost confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    let submitCalls = 0;
    const store = new ProviderJobStore(root);
    const adapter = fakeAdapter(async () => {
      submitCalls += 1;
    });

    await expect(
      store.submitTracked(
        adapter,
        { capability: "image.generate", input: { prompt: "new paid request" } },
        undefined as never,
      ),
    ).rejects.toThrow(/confirmation is required/i);
    expect(submitCalls).toBe(0);
    await expect(readFile(store.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks an estimate above the user-approved ceiling before submit", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    let submitCalls = 0;
    const store = new ProviderJobStore(root);
    const adapter = fakeAdapter(async () => {
      submitCalls += 1;
    });

    await expect(
      store.submitTracked(
        adapter,
        { capability: "image.generate", input: { prompt: "cost cap" } },
        {
          ...auditedContext({
            confirmation: knownConfirmation({ estimatedCost: 1.01, maximumCost: 1 }),
            calculatedCost: 1.01,
          }),
        },
      ),
    ).rejects.toThrow(/exceeds the user-approved maximum/);
    expect(submitCalls).toBe(0);
  });

  it("allows an unknown estimate while retaining a ceiling and confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    const store = new ProviderJobStore(root);
    const adapter = fakeAdapter(async () => undefined);

    const { attempt } = await store.submitTracked(
      adapter,
      { capability: "image.generate", input: { prompt: "unknown estimate" } },
      {
        ...auditedContext({
          confirmation: unknownConfirmation({ maximumCost: 0.75 }),
        }),
      },
    );

    expect(attempt.costConfirmation).toMatchObject({
      maximumCost: 0.75,
      currency: "USD",
      confirmedBy: "user",
      pricingStatus: "unknown",
      unknownPricingAcknowledged: true,
    });
    expect(attempt.costConfirmation.estimatedCost).toBeUndefined();
  });

  it("resumes the same prepared request without a second paid confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    const request = {
      capability: "image.generate" as const,
      input: { prompt: "recover exactly once" },
    };
    const initial = new ProviderJobStore(root);
    const prepared = await initial.prepareSubmit(
      "fake",
      request,
      auditedContext({
        stageRevision: 2,
        confirmation: unknownConfirmation({ maximumCost: 0.4 }),
      }),
    );

    const reopened = new ProviderJobStore(root);
    const { attempt } = await reopened.resumeSubmitTracked(
      fakeAdapter(async () => undefined),
      prepared.attemptId,
      request,
    );
    expect(attempt.state).toBe("queued");

    const lines = (await readFile(reopened.path, "utf8")).trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('"type":"prepared"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"confirmationReference"'))).toHaveLength(1);
  });

  it("deduplicates repeated poll projections and preserves terminal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    const store = new ProviderJobStore(root);
    const { attempt } = await store.submitTracked(
      fakeAdapter(async () => undefined),
      { capability: "image.generate", input: { prompt: "duplicate callback" } },
      {
        ...auditedContext(),
      },
    );
    const succeeded: ProviderJob = {
      id: "fake:external-7",
      remoteJobId: "external-7",
      providerId: "fake",
      capability: "image.generate",
      state: "succeeded",
      submittedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:02.000Z",
      outputs: [{ kind: "image", localPath: "assets/frame.png", sha256: "a".repeat(64) }],
    };
    const first = await store.recordPoll(attempt.attemptId, succeeded);
    const linesAfterFirst = (await readFile(store.path, "utf8")).trim().split(/\r?\n/);
    const duplicate = await store.recordPoll(attempt.attemptId, succeeded);
    const linesAfterDuplicate = (await readFile(store.path, "utf8")).trim().split(/\r?\n/);
    expect(duplicate.revision).toBe(first.revision);
    expect(linesAfterDuplicate).toEqual(linesAfterFirst);

    await expect(
      store.recordPoll(attempt.attemptId, { ...succeeded, state: "running" }),
    ).rejects.toThrow(/Cannot change terminal attempt/);
    await expect(store.get(attempt.attemptId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("persists retry-after guidance for crash-safe rate-limit recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-"));
    temporaryDirectories.push(root);
    const store = new ProviderJobStore(root);
    const adapter: ProviderAdapter = {
      ...fakeAdapter(async () => undefined),
      submit: async () => {
        throw new ProviderProtocolError("rate limited", {
          status: 429,
          retryable: true,
          retryAfterMs: 2_000,
        });
      },
    };
    await expect(
      store.submitTracked(
        adapter,
        { capability: "image.generate", input: { prompt: "wait and resume" } },
        {
          ...auditedContext(),
        },
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 2_000 });
    await expect(store.resumeCandidates()).resolves.toEqual([
      expect.objectContaining({ state: "failed_retryable", retryAfterMs: 2_000 }),
    ]);
  });

  it("recovers a lock abandoned by a dead process before mutating the ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-lock-"));
    temporaryDirectories.push(root);
    const store = new ProviderJobStore(root, {
      lockTimeoutMs: 250,
      lockRetryMs: 5,
    });
    await mkdir(root, { recursive: true });
    await writeFile(
      store.lockPath,
      JSON.stringify({
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000001",
        pid: 2_147_483_647,
        createdAt: "2026-08-10T00:00:00.000Z",
      }),
      "utf8",
    );

    await expect(
      store.prepareSubmit(
        "fake",
        { capability: "image.generate", input: { prompt: "recover abandoned lock" } },
        auditedContext(),
      ),
    ).resolves.toMatchObject({ state: "prepared" });
    await expect(readFile(store.lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("truncates only an incomplete no-newline tail after at least one durable event", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-tail-"));
    temporaryDirectories.push(root);
    const initial = new ProviderJobStore(root);
    const prepared = await initial.prepareSubmit(
      "fake",
      { capability: "image.generate", input: { prompt: "durable prefix" } },
      auditedContext(),
    );
    const durableContents = await readFile(initial.path, "utf8");
    await appendFile(initial.path, '{"schemaVersion":1,"eventId":"partial', "utf8");

    const reopened = new ProviderJobStore(root);
    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({ attemptId: prepared.attemptId, state: "prepared" }),
    ]);
    expect(await readFile(initial.path, "utf8")).toBe(durableContents);
  });

  it("fails closed for a corrupt middle or newline-terminated ledger record", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-ledger-corrupt-"));
    temporaryDirectories.push(root);
    const initial = new ProviderJobStore(root);
    await initial.prepareSubmit(
      "fake",
      { capability: "image.generate", input: { prompt: "durable prefix" } },
      auditedContext(),
    );
    await appendFile(initial.path, "not-json\n", "utf8");
    await appendFile(initial.path, '{"schemaVersion":1', "utf8");

    await expect(new ProviderJobStore(root).list()).rejects.toThrow(/corrupt at line 2/i);
  });
});

function knownConfirmation(
  overrides: Partial<{
    estimatedCost: number;
    maximumCost: number;
  }> = {},
): PaidSubmitConfirmation {
  return {
    confirmedAt: "2026-08-10T00:00:00.000Z",
    confirmedBy: "user" as const,
    confirmationReference: "review:keyframes:v003:cost-1",
    pricingStatus: "known",
    estimatedCost: overrides.estimatedCost ?? 0.12,
    maximumCost: overrides.maximumCost ?? 1,
    currency: "USD",
  };
}

function unknownConfirmation(
  overrides: Partial<{ maximumCost: number }> = {},
): PaidSubmitConfirmation {
  return {
    confirmedAt: "2026-08-10T00:00:00.000Z",
    confirmedBy: "user",
    confirmationReference: "review:keyframes:v003:cost-1",
    pricingStatus: "unknown",
    unknownPricingAcknowledged: true,
    maximumCost: overrides.maximumCost ?? 1,
    currency: "USD",
  };
}

function auditedContext(
  options: {
    stage?: string;
    stageRevision?: number;
    confirmation?: PaidSubmitConfirmation;
    calculatedCost?: number;
    model?: string;
  } = {},
): AuditedAttemptContext {
  const confirmation = options.confirmation ?? unknownConfirmation();
  const snapshotWithoutHash: ProviderPricingSnapshot = {
    schemaVersion: 1,
    providerId: "fake",
    capability: "image.generate",
    ...(options.model ? { model: options.model } : {}),
    pricingStatus: confirmation.pricingStatus,
    ...(confirmation.pricingStatus === "known"
      ? {
          price: { currency: confirmation.currency, amount: options.calculatedCost ?? 0.12, unit: "request" },
          calculatedCost: options.calculatedCost ?? 0.12,
        }
      : {}),
    currency: confirmation.currency,
    estimatedAt: "2026-08-10T00:00:00.000Z",
    estimateSha256: "",
  };
  return {
    stage: options.stage ?? "keyframes",
    stageRevision: options.stageRevision ?? 1,
    costConfirmation: confirmation,
    pricingSnapshot: {
      ...snapshotWithoutHash,
      estimateSha256: calculatePricingSnapshotHash(snapshotWithoutHash),
    },
  };
}

function fakeAdapter(beforeSubmit: () => Promise<void>): ProviderAdapter {
  const base = (state: ProviderJob["state"]): ProviderJob => ({
    id: "fake:external-7",
    remoteJobId: "external-7",
    providerId: "fake",
    capability: "image.generate",
    state,
    submittedAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
    outputs: [
      {
        kind: "image",
        uri: "https://assets.example/frame.png?signature=signed-secret",
        localPath: "assets/frame.png",
        archivedPath: "archive/frame.png",
        mimeType: "image/png",
        sha256: "a".repeat(64),
      },
    ],
  });
  return {
    descriptor: {
      id: "fake",
      displayName: "Fake",
      adapter: "fake",
      capabilities: ["image.generate"],
    },
    capabilities: async () => ["image.generate"],
    health: async () => ({
      providerId: "fake",
      status: "healthy",
      checkedAt: "2026-08-10T00:00:00.000Z",
    }),
    estimate: async () => ({ providerId: "fake", capability: "image.generate" }),
    submit: async () => {
      await beforeSubmit();
      return base("queued");
    },
    poll: async () => base("running"),
    cancel: async () => base("cancelled"),
  };
}
