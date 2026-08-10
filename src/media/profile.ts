export interface FinalDeliveryProfile {
  readonly language: "zh-CN";
  readonly aspectRatio: "9:16";
  readonly targetDurationSeconds: number;
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly frameRateTolerance: number;
  readonly videoEncoder: "libx264";
  readonly videoCodec: "h264";
  readonly pixelFormat: "yuv420p";
  readonly audioEncoder: "aac";
  readonly audioCodec: "aac";
  readonly audioSampleRate: number;
  readonly audioChannels: number;
  readonly integratedLoudnessTargetLufs: number;
  readonly integratedLoudnessToleranceLufs: number;
  readonly maxTruePeakDbfs: number;
  readonly maxBlackSeconds: number;
  readonly maxFreezeSeconds: number;
  readonly maxSilenceSeconds: number;
  readonly maxClippedSamples: number;
}

/**
 * The version-one delivery profile. Rendering and final-delivery validation
 * intentionally consume the same immutable values.
 */
export const DEFAULT_FINAL_DELIVERY_PROFILE: FinalDeliveryProfile = Object.freeze({
  language: "zh-CN",
  aspectRatio: "9:16",
  targetDurationSeconds: 75,
  minDurationSeconds: 60,
  maxDurationSeconds: 90,
  width: 1_080,
  height: 1_920,
  frameRate: 30,
  frameRateTolerance: 0.01,
  videoEncoder: "libx264",
  videoCodec: "h264",
  pixelFormat: "yuv420p",
  audioEncoder: "aac",
  audioCodec: "aac",
  audioSampleRate: 48_000,
  audioChannels: 2,
  integratedLoudnessTargetLufs: -14,
  integratedLoudnessToleranceLufs: 2,
  maxTruePeakDbfs: -1,
  maxBlackSeconds: 0.5,
  maxFreezeSeconds: 2,
  maxSilenceSeconds: 3,
  maxClippedSamples: 0,
});
