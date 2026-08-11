import type { JsonObject, ProviderCapability } from "./types.js";

export const MANUAL_PLATFORM_ADAPTERS = [
  "jimeng-manual",
  "kling-manual",
  "liblib-manual",
  "jianying-manual",
] as const;

export type ManualPlatformAdapter = (typeof MANUAL_PLATFORM_ADAPTERS)[number];

export interface ManualPlatformProfile {
  readonly displayName: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly instructions: string;
  readonly metadata: JsonObject;
}

const VISUAL_CAPABILITIES = [
  "image.generate",
  "image.edit",
  "video.t2v",
  "video.i2v",
  "video.r2v",
] as const satisfies readonly ProviderCapability[];

export const MANUAL_PLATFORM_PROFILES: Readonly<Record<ManualPlatformAdapter, ManualPlatformProfile>> = {
  "jimeng-manual": {
    displayName: "即梦 AI（Codex Chrome 交接）",
    capabilities: VISUAL_CAPABILITIES,
    instructions:
      "通过 durable handoff manifest 在 Chrome 中执行即梦中国大陆站任务；仅上传清单内且哈希匹配的文件，确认积分后生成并下载原始文件。只使用 complete-manual 归档，不手工编辑 ledger 或 *.result.json。",
    metadata: {
      platform: "jimeng-ai",
      handoff: "browser-or-desktop-manual",
      importRequired: true,
      temporaryShareLinksRejected: true,
      playbookVersion: "jimeng-cn.v1",
      executionSurface: "chrome",
      officialOrigins: ["https://jimeng.jianying.com"],
    },
  },
  "kling-manual": {
    displayName: "可灵 AI（Codex Chrome 交接）",
    capabilities: VISUAL_CAPABILITIES,
    instructions:
      "通过 durable handoff manifest 在 Chrome 中执行可灵中国大陆站任务；确认模型、上传清单和灵感值后生成，下载权限范围内的原始结果，并只使用 complete-manual 归档。",
    metadata: {
      platform: "kling-ai",
      handoff: "browser-or-desktop-manual",
      importRequired: true,
      temporaryShareLinksRejected: true,
      playbookVersion: "kling-cn.v1",
      executionSurface: "chrome",
      officialOrigins: ["https://klingai.kuaishou.com"],
    },
  },
  "liblib-manual": {
    displayName: "LibLibAI（Codex Chrome 交接）",
    capabilities: VISUAL_CAPABILITIES,
    instructions:
      "通过 durable handoff manifest 在 Chrome 中执行 LibLibAI 中国大陆站工作流；确认工作流、模型/LoRA、seed、上传清单和算力后运行，下载原始输出并只使用 complete-manual 归档。",
    metadata: {
      platform: "liblibai",
      handoff: "hosted-workflow-manual",
      workflowVersionRecommended: true,
      importRequired: true,
      playbookVersion: "liblibai-cn.v1",
      executionSurface: "chrome",
      officialOrigins: ["https://www.liblib.art", "https://liblib.art"],
    },
  },
  "jianying-manual": {
    displayName: "macOS 剪映专业版（Codex 桌面交接）",
    capabilities: ["render.timeline"],
    instructions:
      "通过 durable handoff manifest 和 Computer Use 把已批准媒体、SRT/ASS 与确定性时间线导入 macOS 剪映专业版；不得改剧情或镜头。导出 H.264/yuv420p MP4 和字幕后只使用 complete-manual 归档，并继续 local-ffmpeg quality.inspect。",
    metadata: {
      platform: "jianying",
      handoff: "desktop-editor-manual",
      editableProjectOptional: true,
      requiredOutputs: ["mp4", "srt", "ass", "timeline-or-project-description"],
      qualityInspectionRequired: true,
      importRequired: true,
      playbookVersion: "jianying-macos.v1",
      executionSurface: "computer-use",
      allowedApplications: ["剪映专业版", "剪映", "com.lemon.lv"],
    },
  },
};

export function isManualPlatformAdapter(value: string): value is ManualPlatformAdapter {
  return (MANUAL_PLATFORM_ADAPTERS as readonly string[]).includes(value);
}
