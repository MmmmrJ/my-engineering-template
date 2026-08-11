import type {
  ConceptStageContract,
  ScriptStageContract,
  StageContract,
  StoryboardStageContract,
  TaskState,
} from "../contracts/index.js";
import { WorkflowError } from "./errors.js";

export type GeneratableStage = "concept" | "script" | "storyboard";

export interface StageGenerationRequest {
  readonly state: TaskState;
  readonly stage: GeneratableStage;
  readonly generatedAt: string;
  readonly feedback?: string;
}

export interface GeneratedStageDraft {
  readonly contract: StageContract;
  readonly reviewPacketMarkdown: string;
  readonly summary: string;
}

export interface StageGenerator {
  generate(request: StageGenerationRequest): Promise<GeneratedStageDraft>;
}

/**
 * Dependency-free baseline generator. It creates conservative, reviewable
 * contracts for G1-G3; deployments can inject an LLM-backed implementation
 * without weakening the same validator or review gates.
 */
export class DefaultStageGenerator implements StageGenerator {
  generate(request: StageGenerationRequest): Promise<GeneratedStageDraft> {
    if (request.feedback?.trim()) {
      throw new WorkflowError(
        "GENERATOR_UNAVAILABLE",
        `The deterministic baseline generator cannot faithfully apply revision feedback for ${request.stage}; import a complete replacement contract or configure a feedback-capable StageGenerator.`,
      );
    }
    switch (request.stage) {
      case "concept":
        return Promise.resolve(conceptDraft(request));
      case "script":
        return Promise.resolve(scriptDraft(request));
      case "storyboard":
        return Promise.resolve(storyboardDraft(request));
    }
  }
}

function conceptDraft(request: StageGenerationRequest): GeneratedStageDraft {
  const { ip, theme } = request.state.input;
  const contract: ConceptStageContract = {
    schemaVersion: 1,
    stage: "concept",
    ip,
    theme,
    premise: `${ip}中的主角在一次小危机中学习并实践“${theme}”。`,
    audience: "适合移动端观看的全年龄中文短剧观众",
    language: "zh-CN",
    tone: "温暖、紧凑、具有清晰反转和积极落点",
    logline: `当熟悉的秩序被意外打破，${ip}中的主角必须用行动理解${theme}。`,
    synopsis: `故事从一个可视化的小目标开始，主角因错误判断受阻，在伙伴提醒和一次反转后改变做法，最终以可验证的行动完成目标，并让“${theme}”落到角色选择上。`,
    intendedUse: "原创或公版 IP 的中文竖屏 AI 漫剧样片",
    format: { aspectRatio: "9:16", durationSeconds: 75 },
    directions: [
      {
        id: "DIR_MAIN",
        title: "行动反转",
        summary: "用一次错误行动和一次正确行动形成清晰前后对照，制作可控、主题明确。",
        recommended: true,
      },
      {
        id: "DIR_MYSTERY",
        title: "轻悬念",
        summary: "围绕丢失的小物件推进，在结尾揭示误会来源。",
        recommended: false,
      },
      {
        id: "DIR_COMEDY",
        title: "伙伴喜剧",
        summary: "通过两位角色的节奏错位制造笑点，再共同解决问题。",
        recommended: false,
      },
    ],
  };
  return packet(request, contract, "G1 默认概念草案");
}

function scriptDraft(request: StageGenerationRequest): GeneratedStageDraft {
  const concept = approvedContract(request.state, "concept");
  if (concept.stage !== "concept") throw new WorkflowError("STATE_INVARIANT", "Concept contract mismatch.");
  const contract: ScriptStageContract = {
    schemaVersion: 1,
    stage: "script",
    synopsis: concept.synopsis,
    characters: [
      { id: "CHAR_PROTAGONIST", name: "主角", role: "推动行动", motivation: `证明自己理解${request.state.input.theme}` },
      { id: "CHAR_COMPANION", name: "伙伴", role: "提供提醒与对照", motivation: "帮助主角看见被忽略的线索" },
    ],
    scenes: [
      {
        id: "SCENE_01",
        startMs: 0,
        endMs: 25_000,
        locationId: "LOC_MAIN",
        action: "主角发现目标受阻，急于独自解决，结果让问题扩大。",
        dialogue: [
          { characterId: "CHAR_PROTAGONIST", text: "我自己马上就能解决。" },
          { characterId: "CHAR_COMPANION", text: "先看看我们漏掉了什么。" },
        ],
      },
      {
        id: "SCENE_02",
        startMs: 25_000,
        endMs: 50_000,
        locationId: "LOC_MAIN",
        action: "伙伴指出关键线索，主角起初拒绝，随后看到错误带来的直接后果。",
        dialogue: [
          { characterId: "CHAR_PROTAGONIST", text: "等等，原来真正的问题在这里。" },
          { characterId: "CHAR_COMPANION", text: "一起试一次，会更快。" },
        ],
      },
      {
        id: "SCENE_03",
        startMs: 50_000,
        endMs: 75_000,
        locationId: "LOC_MAIN",
        action: "两人分工完成目标，主角主动复述新的做法，结尾用视觉回环落题。",
        dialogue: [
          { characterId: "CHAR_PROTAGONIST", text: `我明白了，${request.state.input.theme}要从行动开始。` },
          { characterId: "CHAR_COMPANION", text: "这次我们真的做到了。" },
        ],
      },
    ],
    totalDurationMs: 75_000,
    endingBeat: "开场中失败的动作在结尾被正确完成，形成视觉回环。",
    rhythm: "0–25 秒建立目标，25–50 秒升级与反转，50–75 秒解决并落题。",
    reversal: "主角以为速度最重要，最终发现协作和观察才是解决问题的关键。",
    continuityNotes: ["主角道具始终保持同一侧", "伙伴在反转前后站位保持空间连续", "结尾复用开场构图"],
    automaticReview: {
      passed: true,
      checks: ["时长在 60–90 秒", "角色动机清晰", "反转可视化", "结尾完成主题落点"],
      issues: [],
    },
  };
  return packet(request, contract, "G2 默认剧本草案");
}

function storyboardDraft(request: StageGenerationRequest): GeneratedStageDraft {
  const script = approvedContract(request.state, "script");
  if (script.stage !== "script") throw new WorkflowError("STATE_INVARIANT", "Script contract mismatch.");
  const framings = ["远景", "中景", "近景", "特写", "双人中景"];
  const motions = ["固定", "缓慢推进", "轻微横移", "跟随", "固定后快速推进"];
  const contract: StoryboardStageContract = {
    schemaVersion: 1,
    stage: "storyboard",
    shots: Array.from({ length: 10 }, (_, index) => {
      const shotNumber = index + 1;
      return {
        id: `SHOT_${String(shotNumber).padStart(2, "0")}`,
        durationMs: 7_500,
        framing: framings[index % framings.length] ?? "中景",
        cameraMotion: motions[index % motions.length] ?? "固定",
        action:
          shotNumber <= 3
            ? "建立目标并展示第一次失败"
            : shotNumber <= 7
              ? "发现线索、冲突升级并完成认知反转"
              : "协作解决问题并以视觉回环收束",
        dialogueOrAudio: `承接剧本第 ${Math.min(3, Math.ceil(shotNumber / 4))} 场的对白、环境声和节奏点`,
        transition: shotNumber === 10 ? "淡出" : "动作匹配切换",
        assetIds: ["CHAR_PROTAGONIST", "CHAR_COMPANION", "LOC_MAIN", "PROP_TOKEN"],
        continuityAnchors: ["角色服装与配色不变", "关键道具方向连续", "保持 9:16 安全构图"],
        generationRisk: shotNumber === 5 || shotNumber === 6 ? "medium" : "low",
      } as const;
    }),
    totalDurationMs: script.totalDurationMs,
    assetDefinitions: [
      { id: "CHAR_PROTAGONIST", type: "character", name: "主角" },
      { id: "CHAR_COMPANION", type: "character", name: "伙伴" },
      { id: "LOC_MAIN", type: "location", name: "主要场景" },
      { id: "PROP_TOKEN", type: "prop", name: "关键叙事道具" },
    ],
  };
  return packet(request, contract, "G3 默认分镜草案");
}

function packet(
  request: StageGenerationRequest,
  contract: StageContract,
  title: string,
): GeneratedStageDraft {
  const feedback = request.feedback ? `\n\n## 已应用反馈\n\n${request.feedback}` : "";
  return {
    contract,
    summary: `${title}；等待用户逐阶段审核。`,
    reviewPacketMarkdown:
      `# ${title}\n\n` +
      `- 阶段：${request.stage}\n` +
      `- 生成时间：${request.generatedAt}\n` +
      `- IP：${request.state.input.ip}\n` +
      `- 主题：${request.state.input.theme}\n` +
      `- 决策：approve / revise / regenerate / abort\n\n` +
      `## 结构化契约\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n` +
      feedback,
  };
}

function approvedContract(state: TaskState, stage: "concept" | "script"): StageContract {
  const stageState = state.stages[stage];
  const revision = stageState.approvedRevision
    ? stageState.revisions[stageState.approvedRevision - 1]
    : undefined;
  if (!revision?.stageContract) {
    throw new WorkflowError(
      "STAGE_CONTRACT_INVALID",
      `Approved ${stage} revision lacks a structured contract.`,
    );
  }
  return revision.stageContract;
}
