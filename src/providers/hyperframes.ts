import type { ProviderDescriptor } from "./types.js";

/**
 * Discovery-only descriptor. HyperFrames support is optional and no package or
 * network dependency is required by this repository.
 */
export const HYPERFRAMES_DESCRIPTOR: ProviderDescriptor = {
  id: "hyperframes",
  displayName: "HyperFrames by HeyGen",
  adapter: "optional-external",
  capabilities: ["video.r2v", "render.timeline"],
  optional: true,
  fallbackProviderIds: ["comfyui", "manual"],
  dataTransfer: "external-cloud",
  models: [
    {
      id: "hyperframes",
      displayName: "HyperFrames",
      capabilities: ["video.r2v", "render.timeline"],
      regions: ["global"],
    },
  ],
  regions: ["global"],
  metadata: {
    integration: "plugin-optional",
    packageRequired: false,
  },
};

export function hyperFramesDescriptor(
  overrides: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
  return {
    ...HYPERFRAMES_DESCRIPTOR,
    ...overrides,
    capabilities: overrides.capabilities ?? HYPERFRAMES_DESCRIPTOR.capabilities,
  };
}
