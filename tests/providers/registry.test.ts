import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProviderRegistry, ProviderRegistryFacade } from "../../src/providers/config.js";
import { HYPERFRAMES_DESCRIPTOR } from "../../src/providers/hyperframes.js";
import { MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR } from "../../src/providers/minimax.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type { ProviderAdapter, ProviderJob } from "../../src/providers/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fakeAdapter(id: string): ProviderAdapter {
  const now = "2026-08-10T00:00:00.000Z";
  const job: ProviderJob = {
    id: `${id}:remote-1`,
    remoteJobId: "remote-1",
    providerId: id,
    capability: "image.generate",
    state: "queued",
    submittedAt: now,
    updatedAt: now,
  };
  return {
    descriptor: {
      id,
      displayName: id,
      adapter: "fake",
      capabilities: ["image.generate"],
    },
    capabilities: async () => ["image.generate"],
    health: async () => ({ providerId: id, status: "healthy", checkedAt: now }),
    estimate: async (request) => ({ providerId: id, capability: request.capability }),
    submit: async () => job,
    poll: async () => job,
    verifyWebhook: async () => ({
      verified: true,
      eventId: "event-1",
      remoteJobId: "remote-1",
      capability: "image.generate",
      state: "succeeded",
      payloadSha256: "a".repeat(64),
    }),
  };
}

describe("ProviderRegistry", () => {
  it("discovers installed adapters and descriptor-only optional providers", async () => {
    const registry = new ProviderRegistry([fakeAdapter("local")]);
    registry.registerDescriptor(HYPERFRAMES_DESCRIPTOR);

    expect(await registry.capabilities()).toEqual(["image.generate"]);
    expect(registry.providersFor("render.timeline", false).map((item) => item.id)).toEqual([
      "hyperframes",
    ]);
    expect((await registry.health()).map((item) => [item.providerId, item.status])).toEqual([
      ["hyperframes", "unconfigured"],
      ["local", "healthy"],
    ]);
    expect(registry.snapshot()).not.toBe(registry.snapshot());
  });

  it("rejects duplicate ids", () => {
    const registry = new ProviderRegistry([fakeAdapter("same")]);
    expect(() => registry.register(fakeAdapter("same"))).toThrow(/already registered/);
  });

  it("supports an optional safe webhook verification contract", async () => {
    const adapter = fakeAdapter("webhook");
    await expect(
      adapter.verifyWebhook?.({
        headers: { "x-event-id": "event-1" },
        body: new TextEncoder().encode("{}"),
        receivedAt: "2026-08-10T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      verified: true,
      eventId: "event-1",
      remoteJobId: "remote-1",
      state: "succeeded",
    });
  });
});

describe("provider configuration", () => {
  it("loads manual adapters, retains disabled descriptors, and adapts the core facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "providers.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: [
          {
            id: "manual",
            adapter: "manual",
            enabled: true,
            requestDirectory: "requests",
            resultDirectory: "results",
          },
          {
            id: "minimax",
            adapter: "minimax",
            enabled: false,
            apiKeyEnv: "MINIMAX_API_KEY",
            dataTransfer: "external-cloud",
            termsUrl: "https://example.com/terms",
            privacyUrl: "https://example.com/privacy",
            routes: {
              "video.t2v": { submitPath: "/submit", pollPath: "/jobs/{jobId}" },
            },
          },
        ],
      }),
    );
    const registry = await loadProviderRegistry(configPath, {
      baseDirectory: root,
      includeHyperFrames: false,
    });
    const facade = new ProviderRegistryFacade(registry);

    expect(registry.hasAdapter("manual")).toBe(true);
    expect(registry.hasAdapter("minimax")).toBe(false);
    expect((await facade.list()).map((item) => [item.id, item.configured])).toEqual([
      ["manual", true],
      ["minimax", false],
      ["minimax-official-mcp", false],
    ]);
    expect(await facade.check("minimax")).toMatchObject([
      { providerId: "minimax", ok: false, metadata: { status: "unconfigured" } },
    ]);
    expect((await facade.list()).find((item) => item.id === "minimax")?.metadata).toMatchObject({
      dataTransfer: "external-cloud",
      termsUrl: "https://example.com/terms",
      privacyUrl: "https://example.com/privacy",
    });
    expect(registry.hasAdapter(MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR.id)).toBe(false);
    expect(registry.descriptor(MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR.id)).toMatchObject({
      adapter: "mcp-overlay",
      capabilities: ["image.generate", "video.i2v", "video.t2v", "audio.tts"],
    });
    await expect(
      registry.health(MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR.id),
    ).resolves.toMatchObject({ status: "unconfigured" });
  });

  it("rejects invalid transfer disclosure URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "providers.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: [
          {
            id: "manual",
            adapter: "manual",
            requestDirectory: "requests",
            resultDirectory: "results",
            dataTransfer: "user-managed",
            privacyUrl: "http://insecure.example/privacy",
          },
        ],
      }),
    );
    await expect(loadProviderRegistry(configPath)).rejects.toThrow(/privacyUrl must be an HTTPS URL/);
  });
});
