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
    displayName: "即梦 AI（手工导出）",
    capabilities: VISUAL_CAPABILITIES,
    instructions:
      "在即梦 AI 中按 request.input 的提示词、参考图、画幅和时长创建内容；逐项下载原始图片/视频文件，不要只粘贴临时分享链接。将文件放入结果目录，并创建同 jobId 的 *.result.json；保留所用模型、种子（若可见）、生成时间和平台条款依据。",
    metadata: {
      platform: "jimeng-ai",
      handoff: "browser-or-desktop-manual",
      importRequired: true,
      temporaryShareLinksRejected: true,
    },
  },
  "kling-manual": {
    displayName: "可灵 AI（手工导出）",
    capabilities: VISUAL_CAPABILITIES,
    instructions:
      "在可灵 AI 中按 request.input 创建图片或视频；下载无水印权限范围内的原始文件并记录模型、模式、时长、画幅和任务编号。将本地文件及同 jobId 的 *.result.json 放入结果目录，勿提交需要登录的分享页或临时 URL。",
    metadata: {
      platform: "kling-ai",
      handoff: "browser-or-desktop-manual",
      importRequired: true,
      temporaryShareLinksRejected: true,
    },
  },
  "liblib-manual": {
    displayName: "LibLibAI（手工工作流导出）",
    capabilities: VISUAL_CAPABILITIES,
    instructions:
      "在 LibLibAI 选择与 request.metadata.workflowVersion 对应的工作流/模型，填入 request.input 后运行；下载原始输出，并记录工作流版本、模型/LoRA、种子及生成 UUID（若可见）。将文件和同 jobId 的 *.result.json 放入结果目录。",
    metadata: {
      platform: "liblibai",
      handoff: "hosted-workflow-manual",
      workflowVersionRecommended: true,
      importRequired: true,
    },
  },
  "jianying-manual": {
    displayName: "剪映（手工剪辑导出）",
    capabilities: ["render.timeline"],
    instructions:
      "把请求包中的镜头清单、已批准媒体、SRT/ASS 和时间线说明导入剪映，完成剪辑但不要改变批准内容。导出 H.264/yuv420p MP4，并同时导出或保留 SRT、ASS；画面必须含可见 AI 生成标识。将 MP4、字幕侧车、项目/时间线说明和同 jobId 的 *.result.json 放入结果目录；后续仍需进入 quality.inspect。",
    metadata: {
      platform: "jianying",
      handoff: "desktop-editor-manual",
      editableProjectOptional: true,
      requiredOutputs: ["mp4", "srt", "ass", "timeline-or-project-description"],
      qualityInspectionRequired: true,
      importRequired: true,
    },
  },
};

export function isManualPlatformAdapter(value: string): value is ManualPlatformAdapter {
  return (MANUAL_PLATFORM_ADAPTERS as readonly string[]).includes(value);
}
