import { ProviderConfigurationError, type JsonObject, type ProviderCapability } from "./types.js";
import type { ManualPlatformAdapter } from "./platform-manual.js";

export const PROVIDER_HANDOFF_STATES = [
  "prepared",
  "awaiting_login",
  "awaiting_confirmation",
  "submitted",
  "running",
  "download_ready",
  "completed",
  "blocked",
  "cancelled",
] as const;

export type ProviderHandoffState = (typeof PROVIDER_HANDOFF_STATES)[number];

export const PROVIDER_HANDOFF_BLOCK_REASONS = [
  "blocked_login",
  "blocked_captcha",
  "blocked_recharge",
  "blocked_terms_changed",
  "blocked_permission",
  "blocked_ui_changed",
  "blocked_quote_exceeded",
  "blocked_output_unavailable",
  "blocked_tool_unavailable",
  "blocked_other",
] as const;

export type ProviderHandoffBlockReason =
  (typeof PROVIDER_HANDOFF_BLOCK_REASONS)[number];

export type ProviderHandoffSurface = "chrome" | "computer-use";

export interface HandoffUploadFile {
  readonly path: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ProviderHandoffManifest {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly providerId: ManualPlatformAdapter;
  readonly capability: ProviderCapability;
  readonly stage: string;
  readonly stageRevision: number;
  readonly playbookVersion: string;
  readonly surface: ProviderHandoffSurface;
  readonly officialOrigins: readonly string[];
  readonly allowedApplications?: readonly string[];
  readonly requestPackagePath: string;
  readonly requestSha256: string;
  readonly model?: string;
  readonly uploads: readonly HandoffUploadFile[];
  readonly createdAt: string;
}

export interface HandoffSpendConfirmationBase {
  readonly confirmedAt: string;
  readonly confirmedBy: "user";
  readonly confirmationReference: string;
  readonly manifestSha256: string;
  readonly providerId: ManualPlatformAdapter;
  readonly model?: string;
  readonly creditUnit: string;
  readonly maximumCredits: number;
}

export type HandoffSpendConfirmation =
  | (HandoffSpendConfirmationBase & {
      readonly pricingStatus: "known";
      readonly estimatedCredits: number;
      readonly unknownPricingAcknowledged?: never;
    })
  | (HandoffSpendConfirmationBase & {
      readonly pricingStatus: "unknown";
      readonly unknownPricingAcknowledged: true;
      readonly estimatedCredits?: never;
    });

export interface HandoffReceipt {
  readonly externalTaskId?: string;
  readonly observedModel?: string;
  readonly observedCredits?: number;
  readonly creditUnit?: string;
  readonly generationUuid?: string;
  readonly seed?: string | number;
  readonly workflowId?: string;
  readonly workflowVersion?: string;
  readonly outputCount?: number;
  readonly evidence?: string;
}

export interface ProviderHandoffProjection {
  readonly state: ProviderHandoffState;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly playbookVersion: string;
  readonly surface: ProviderHandoffSurface;
  readonly officialOrigins: readonly string[];
  readonly allowedApplications?: readonly string[];
  readonly uploads: readonly HandoffUploadFile[];
  readonly spendConfirmation?: HandoffSpendConfirmation;
  readonly receipt?: HandoffReceipt;
  readonly blockedReason?: ProviderHandoffBlockReason;
  readonly failureReason?: string;
  readonly updatedAt: string;
}

export interface HandoffRecordInput {
  readonly state: Exclude<ProviderHandoffState, "prepared" | "completed">;
  readonly receipt?: HandoffReceipt;
  readonly blockedReason?: ProviderHandoffBlockReason;
  readonly failureReason?: string;
}

export interface PlatformHandoffPlaybook {
  readonly version: string;
  readonly providerId: ManualPlatformAdapter;
  readonly platform: string;
  readonly surface: ProviderHandoffSurface;
  readonly officialOrigins: readonly string[];
  readonly allowedApplications?: readonly string[];
  readonly capabilities: readonly ProviderCapability[];
  readonly semanticEvidence: Readonly<{
    login: readonly string[];
    prompt: readonly string[];
    upload: readonly string[];
    model: readonly string[];
    quote: readonly string[];
    submit: readonly string[];
    result: readonly string[];
    download: readonly string[];
  }>;
  readonly metadata?: JsonObject;
}

const VISUAL_CAPABILITIES = [
  "image.generate",
  "image.edit",
  "video.t2v",
  "video.i2v",
  "video.r2v",
] as const satisfies readonly ProviderCapability[];

export const PLATFORM_HANDOFF_PLAYBOOKS: Readonly<
  Record<ManualPlatformAdapter, PlatformHandoffPlaybook>
> = {
  "jimeng-manual": {
    version: "jimeng-cn.v1",
    providerId: "jimeng-manual",
    platform: "即梦 AI 中国大陆站",
    surface: "chrome",
    officialOrigins: ["https://jimeng.jianying.com"],
    capabilities: VISUAL_CAPABILITIES,
    semanticEvidence: {
      login: ["登录", "扫码登录", "手机号登录"],
      prompt: ["提示词", "描述你想生成的内容"],
      upload: ["上传", "参考图", "首帧", "尾帧"],
      model: ["模型", "图片生成", "视频生成"],
      quote: ["积分", "灵感值", "消耗"],
      submit: ["生成", "立即生成"],
      result: ["生成中", "生成完成", "作品"],
      download: ["下载", "原图", "原视频"],
    },
  },
  "kling-manual": {
    version: "kling-cn.v1",
    providerId: "kling-manual",
    platform: "可灵 AI 中国大陆站",
    surface: "chrome",
    officialOrigins: ["https://klingai.kuaishou.com"],
    capabilities: VISUAL_CAPABILITIES,
    semanticEvidence: {
      login: ["登录", "手机号登录", "扫码登录"],
      prompt: ["提示词", "创意描述"],
      upload: ["上传", "参考图", "首尾帧"],
      model: ["模型", "高品质", "高性能"],
      quote: ["灵感值", "积分", "消耗"],
      submit: ["立即生成", "生成"],
      result: ["任务", "生成中", "已完成"],
      download: ["下载", "无水印"],
    },
  },
  "liblib-manual": {
    version: "liblibai-cn.v1",
    providerId: "liblib-manual",
    platform: "LibLibAI 中国大陆站",
    surface: "chrome",
    officialOrigins: ["https://www.liblib.art", "https://liblib.art"],
    capabilities: VISUAL_CAPABILITIES,
    semanticEvidence: {
      login: ["登录", "手机号", "扫码登录"],
      prompt: ["提示词", "正向提示词", "负向提示词"],
      upload: ["上传", "输入图像", "参考图"],
      model: ["模型", "LoRA", "工作流", "Checkpoint"],
      quote: ["算力", "积分", "消耗"],
      submit: ["运行", "生成", "开始创作"],
      result: ["生成记录", "运行中", "生成完成"],
      download: ["下载", "保存原图"],
    },
    metadata: { persistSeed: true, persistGenerationUuid: true },
  },
  "jianying-manual": {
    version: "jianying-macos.v1",
    providerId: "jianying-manual",
    platform: "macOS 剪映专业版",
    surface: "computer-use",
    officialOrigins: [],
    allowedApplications: ["剪映专业版", "剪映", "com.lemon.lv"],
    capabilities: ["render.timeline"],
    semanticEvidence: {
      login: ["登录"],
      prompt: ["项目", "时间线"],
      upload: ["导入", "媒体", "字幕"],
      model: ["导出", "H.264", "1080P"],
      quote: ["预计大小", "时长"],
      submit: ["导出"],
      result: ["导出完成", "打开文件夹"],
      download: ["打开文件夹"],
    },
    metadata: { deterministicTimelineOnly: true, qualityInspect: "local-ffmpeg" },
  },
};

const HANDOFF_TRANSITIONS: Readonly<Record<ProviderHandoffState, readonly ProviderHandoffState[]>> = {
  prepared: ["awaiting_login", "awaiting_confirmation", "blocked", "cancelled"],
  awaiting_login: ["awaiting_confirmation", "blocked", "cancelled"],
  awaiting_confirmation: ["submitted", "blocked", "cancelled"],
  submitted: ["running", "download_ready", "blocked", "cancelled"],
  running: ["download_ready", "blocked", "cancelled"],
  download_ready: ["completed", "blocked", "cancelled"],
  completed: [],
  blocked: [
    "awaiting_login",
    "awaiting_confirmation",
    "submitted",
    "running",
    "download_ready",
    "cancelled",
  ],
  cancelled: [],
};

export function isProviderHandoffState(value: string): value is ProviderHandoffState {
  return (PROVIDER_HANDOFF_STATES as readonly string[]).includes(value);
}

export function isProviderHandoffBlockReason(
  value: string,
): value is ProviderHandoffBlockReason {
  return (PROVIDER_HANDOFF_BLOCK_REASONS as readonly string[]).includes(value);
}

export function assertHandoffTransition(
  from: ProviderHandoffState,
  to: ProviderHandoffState,
): void {
  if (from === to) return;
  if (!HANDOFF_TRANSITIONS[from].includes(to)) {
    throw new ProviderConfigurationError(
      `Invalid provider handoff transition: ${from} -> ${to}`,
    );
  }
}

export function playbookForProvider(providerId: string): PlatformHandoffPlaybook | undefined {
  return PLATFORM_HANDOFF_PLAYBOOKS[providerId as ManualPlatformAdapter];
}

export function playbookMatchesEvidence(
  playbook: PlatformHandoffPlaybook,
  fixture: Readonly<Record<keyof PlatformHandoffPlaybook["semanticEvidence"], readonly string[]>>,
): boolean {
  return (Object.keys(playbook.semanticEvidence) as Array<keyof typeof playbook.semanticEvidence>)
    .every((key) => {
      const visible = fixture[key].join("\n").toLocaleLowerCase("zh-CN");
      return playbook.semanticEvidence[key].some((candidate) =>
        visible.includes(candidate.toLocaleLowerCase("zh-CN")),
      );
    });
}
