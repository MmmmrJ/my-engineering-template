export const WORKFLOW_STAGES = [
  "concept",
  "script",
  "storyboard",
  "assets",
  "keyframes",
  "clips",
  "audio",
  "edit",
  "qc",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const PROVIDER_CAPABILITIES = [
  "image.generate",
  "image.edit",
  "video.i2v",
  "video.r2v",
  "video.t2v",
  "audio.tts",
  "audio.music",
  "audio.sfx",
  "speech.transcribe",
  "render.timeline",
  "quality.inspect",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const REQUIRED_PROVIDER_CAPABILITIES = [
  "image.generate",
  "video.i2v",
  "audio.tts",
  "audio.music",
  "audio.sfx",
  "render.timeline",
] as const satisfies readonly ProviderCapability[];

export const PROVIDER_CHECKPOINT_STAGE: WorkflowStage = "storyboard";

export const STAGE_DIRECTORIES: Readonly<Record<WorkflowStage, string>> = {
  concept: "01-concept",
  script: "02-script",
  storyboard: "03-storyboard",
  assets: "04-assets",
  keyframes: "05-keyframes",
  clips: "06-clips",
  audio: "07-audio",
  edit: "08-edit",
  qc: "09-qc",
};

export function isWorkflowStage(value: string): value is WorkflowStage {
  return (WORKFLOW_STAGES as readonly string[]).includes(value);
}

export function isProviderCapability(value: string): value is ProviderCapability {
  return (PROVIDER_CAPABILITIES as readonly string[]).includes(value);
}

export function stageIndex(stage: WorkflowStage): number {
  return WORKFLOW_STAGES.indexOf(stage);
}

export function downstreamStages(stage: WorkflowStage): readonly WorkflowStage[] {
  return WORKFLOW_STAGES.slice(stageIndex(stage) + 1);
}

/** Actual production dependencies; visual-only rework does not invalidate approved audio. */
const DEPENDENT_STAGES: Readonly<Record<WorkflowStage, readonly WorkflowStage[]>> = {
  concept: ["script", "storyboard", "assets", "keyframes", "clips", "audio", "edit", "qc"],
  script: ["storyboard", "assets", "keyframes", "clips", "audio", "edit", "qc"],
  storyboard: ["assets", "keyframes", "clips", "audio", "edit", "qc"],
  assets: ["keyframes", "clips", "edit", "qc"],
  keyframes: ["clips", "edit", "qc"],
  clips: ["edit", "qc"],
  audio: ["edit", "qc"],
  edit: ["qc"],
  qc: [],
};

export function dependentStages(stage: WorkflowStage): readonly WorkflowStage[] {
  return DEPENDENT_STAGES[stage];
}

export function nextStage(stage: WorkflowStage): WorkflowStage | undefined {
  return WORKFLOW_STAGES[stageIndex(stage) + 1];
}
