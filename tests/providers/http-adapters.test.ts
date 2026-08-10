import { describe, expect, it } from "vitest";
import { AlibabaWanProviderAdapter } from "../../src/providers/alibaba-wan.js";
import {
  MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR,
  MiniMaxProviderAdapter,
} from "../../src/providers/minimax.js";
import type { FetchLike } from "../../src/providers/types.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MiniMaxProviderAdapter", () => {
  it("normalizes async submit and poll without retaining credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return url.includes("query")
        ? jsonResponse({ task_id: "task-7", status: "Success", file_url: "https://cdn.example/f.mp4" })
        : jsonResponse({ task_id: "task-7", status: "Queueing" });
    };
    const adapter = new MiniMaxProviderAdapter({
      baseUrl: "https://minimax.example",
      apiKeyEnv: "TEST_MINIMAX_KEY",
      environment: { TEST_MINIMAX_KEY: "very-secret-value" },
      fetch,
      routes: {
        "video.t2v": {
          submitPath: "/generate",
          pollPath: "/query?task_id={jobId}",
        },
      },
    });

    const submitted = await adapter.submit({
      capability: "video.t2v",
      model: "video-01",
      input: { prompt: "lantern festival" },
    });
    const completed = await adapter.poll({
      capability: "video.t2v",
      remoteJobId: submitted.remoteJobId,
    });

    expect(submitted.state).toBe("queued");
    expect(completed).toMatchObject({
      state: "succeeded",
      outputs: [{ kind: "video", uri: "https://cdn.example/f.mp4" }],
    });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer very-secret-value",
    );
    expect(JSON.stringify(submitted)).not.toContain("very-secret-value");
  });

  it("rejects inline secret-like input", async () => {
    const adapter = new MiniMaxProviderAdapter({
      environment: { MINIMAX_API_KEY: "secret" },
      fetch: async () => jsonResponse({ task_id: "unused" }),
      routes: {
        "video.t2v": { submitPath: "/submit", pollPath: "/poll/{jobId}" },
      },
    });
    await expect(
      adapter.submit({ capability: "video.t2v", input: { apiKey: "inline" } }),
    ).rejects.toThrow(/Inline secret-like field/);
  });

  it("normalizes rate limits and transport timeouts as retryable failures", async () => {
    const limited = new MiniMaxProviderAdapter({
      environment: { MINIMAX_API_KEY: "fake-only-key" },
      fetch: async () =>
        new Response(JSON.stringify({ message: "slow down" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "2" },
        }),
      routes: {
        "video.t2v": { submitPath: "/submit", pollPath: "/poll/{jobId}" },
      },
    });
    await expect(
      limited.submit({ capability: "video.t2v", input: { prompt: "fake" } }),
    ).rejects.toMatchObject({ retryable: true, status: 429, retryAfterMs: 2_000 });

    const timedOut = new MiniMaxProviderAdapter({
      environment: { MINIMAX_API_KEY: "fake-only-key" },
      fetch: async () => {
        throw new DOMException("request timed out", "TimeoutError");
      },
      routes: {
        "video.t2v": { submitPath: "/submit", pollPath: "/poll/{jobId}" },
      },
    });
    await expect(
      timedOut.submit({ capability: "video.t2v", input: { prompt: "fake" } }),
    ).rejects.toMatchObject({ code: "provider_protocol", retryable: true });
  });

  it("exposes official direct image, video, and TTS capabilities", async () => {
    const adapter = new MiniMaxProviderAdapter({
      environment: { MINIMAX_API_KEY: "fake-only-key" },
      fetch: async () => jsonResponse({}),
    });

    expect(await adapter.capabilities()).toEqual([
      "audio.tts",
      "image.edit",
      "image.generate",
      "video.i2v",
      "video.r2v",
      "video.t2v",
    ]);
    expect(adapter.descriptor.metadata).toMatchObject({
      adapterScope: "official synchronous image/TTS and asynchronous video HTTP APIs",
      voiceCloneEnabled: false,
    });
    expect(MINIMAX_OFFICIAL_MCP_OVERLAY_DESCRIPTOR.metadata).toMatchObject({
      importRequired: true,
      voiceCloneAdvertised: false,
    });
  });

  it("uses the documented synchronous image and TTS endpoints with URL output", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch: FetchLike = async (input, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      return String(input).endsWith("/v1/image_generation")
        ? jsonResponse({
            id: "image-trace-1",
            data: { image_urls: ["https://cdn.example/frame.png?expires=soon"] },
            base_resp: { status_code: 0 },
          })
        : jsonResponse({
            trace_id: "speech-trace-1",
            data: { audio: "https://cdn.example/voice.mp3?expires=soon", status: 2 },
            base_resp: { status_code: 0 },
          });
    };
    const adapter = new MiniMaxProviderAdapter({
      environment: { MINIMAX_API_KEY: "fake-only-key" },
      fetch,
    });

    const image = await adapter.submit({
      capability: "image.edit",
      model: "image-01",
      input: {
        prompt: "same character, new pose",
        subject_reference: [{ type: "character", image_file: "https://example.test/ref.png" }],
        response_format: "base64",
      },
    });
    const speech = await adapter.submit({
      capability: "audio.tts",
      model: "speech-2.8-hd",
      input: {
        text: "你好",
        stream: true,
        output_format: "hex",
        voice_setting: { voice_id: "Chinese (Mandarin)_Warm_Girl" },
      },
    });

    expect(image).toMatchObject({
      state: "succeeded",
      outputs: [{ kind: "image", uri: "https://cdn.example/frame.png?expires=soon" }],
    });
    expect(speech).toMatchObject({
      state: "succeeded",
      outputs: [{ kind: "audio", uri: "https://cdn.example/voice.mp3?expires=soon" }],
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.minimax.io/v1/image_generation",
      body: { response_format: "url" },
    });
    expect(calls[1]).toMatchObject({
      url: "https://api.minimax.io/v1/t2a_v2",
      body: { stream: false, output_format: "url" },
    });
  });

  it("retrieves the documented video download URL after async success", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("query/video_generation")) {
        return jsonResponse({ task_id: "task-9", status: "Success", file_id: "file-9" });
      }
      if (url.includes("files/retrieve")) {
        return jsonResponse({
          file: { download_url: "https://cdn.example/final.mp4?expires=soon" },
          base_resp: { status_code: 0 },
        });
      }
      return jsonResponse({ task_id: "task-9", status: "Queueing" });
    };
    const adapter = new MiniMaxProviderAdapter({
      environment: { MINIMAX_API_KEY: "fake-only-key" },
      fetch,
      routes: {
        "video.i2v": {
          submitPath: "/v1/video_generation",
          pollPath: "/v1/query/video_generation?task_id={jobId}",
        },
      },
    });

    const submitted = await adapter.submit({
      capability: "video.i2v",
      model: "MiniMax-Hailuo-2.3",
      input: { first_frame_image: "https://example.test/frame.png", prompt: "wave" },
    });
    const completed = await adapter.poll({
      capability: "video.i2v",
      remoteJobId: submitted.remoteJobId,
    });

    expect(completed.outputs).toEqual([
      { kind: "video", uri: "https://cdn.example/final.mp4?expires=soon" },
    ]);
    expect(urls).toEqual([
      "https://api.minimax.io/v1/video_generation",
      "https://api.minimax.io/v1/query/video_generation?task_id=task-9",
      "https://api.minimax.io/v1/files/retrieve?file_id=file-9",
    ]);
  });
});

describe("AlibabaWanProviderAdapter", () => {
  it("discovers built-in async image generation and editing", async () => {
    const adapter = new AlibabaWanProviderAdapter({
      environment: { DASHSCOPE_API_KEY: "dash-secret" },
      fetch: async () => jsonResponse({}),
    });
    expect(await adapter.capabilities()).toEqual(
      expect.arrayContaining(["image.generate", "image.edit", "video.t2v"]),
    );
  });

  it("maps DashScope task responses and async header", async () => {
    const headers: Headers[] = [];
    const fetch: FetchLike = async (_input, init) => {
      headers.push(new Headers(init?.headers));
      return headers.length === 1
        ? jsonResponse({ output: { task_id: "wan-1", task_status: "PENDING" } })
        : jsonResponse({
            output: {
              task_id: "wan-1",
              task_status: "SUCCEEDED",
              video_url: "https://cdn.example/wan.mp4",
            },
          });
    };
    const adapter = new AlibabaWanProviderAdapter({
      baseUrl: "https://dashscope.example/api/v1",
      environment: { DASHSCOPE_API_KEY: "dash-secret" },
      fetch,
      routes: {
        "video.i2v": { submitPath: "/generate", pollPath: "/tasks/{jobId}" },
      },
    });
    const submitted = await adapter.submit({
      capability: "video.i2v",
      model: "wan-i2v",
      input: { image_url: "https://assets.example/frame.png", prompt: "wave" },
    });
    const completed = await adapter.poll({
      capability: "video.i2v",
      remoteJobId: submitted.remoteJobId,
    });

    expect(submitted.state).toBe("queued");
    expect(completed.state).toBe("succeeded");
    expect(headers[0]?.get("x-dashscope-async")).toBe("enable");
  });
});
