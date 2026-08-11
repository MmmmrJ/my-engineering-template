import { z } from "zod/v4";

import type { WorkflowStage } from "./stages.js";

const idSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9._-]{1,63}$/);
const textSchema = z.string().trim().min(1).max(20_000);
const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^/\\]+$/, "file references must be basenames from the imported revision");

const conceptDirectionSchema = z
  .object({
    id: idSchema,
    title: textSchema,
    summary: textSchema,
    recommended: z.boolean(),
  })
  .strict();

export const conceptStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("concept"),
    ip: textSchema,
    theme: textSchema,
    premise: textSchema,
    audience: textSchema,
    language: z.literal("zh-CN"),
    tone: textSchema,
    logline: textSchema,
    synopsis: textSchema,
    intendedUse: textSchema,
    format: z
      .object({
        aspectRatio: z.literal("9:16"),
        durationSeconds: z.number().int().min(60).max(90),
      })
      .strict(),
    directions: z.array(conceptDirectionSchema).length(3),
  })
  .strict()
  .superRefine((contract, context) => {
    if (contract.directions.filter((direction) => direction.recommended).length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["directions"],
        message: "exactly one concept direction must be recommended",
      });
    }
  });

const dialogueSchema = z
  .object({
    characterId: idSchema,
    text: textSchema,
  })
  .strict();

const scriptSceneSchema = z
  .object({
    id: idSchema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    locationId: idSchema,
    action: textSchema,
    dialogue: z.array(dialogueSchema),
    narration: textSchema.optional(),
  })
  .strict()
  .refine((scene) => scene.endMs > scene.startMs, {
    message: "scene endMs must be greater than startMs",
  });

export const scriptStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("script"),
    synopsis: textSchema,
    characters: z
      .array(
        z
          .object({
            id: idSchema,
            name: textSchema,
            role: textSchema,
            motivation: textSchema,
          })
          .strict(),
      )
      .min(1),
    scenes: z.array(scriptSceneSchema).min(1),
    totalDurationMs: z.number().int().min(60_000).max(90_000),
    endingBeat: textSchema,
    rhythm: textSchema,
    reversal: textSchema,
    continuityNotes: z.array(textSchema).min(1),
    automaticReview: z
      .object({
        passed: z.boolean(),
        checks: z.array(textSchema).min(1),
        issues: z.array(textSchema),
      })
      .strict(),
  })
  .strict();

const storyboardShotSchema = z
  .object({
    id: idSchema,
    durationMs: z.number().int().min(500).max(30_000),
    framing: textSchema,
    cameraMotion: textSchema,
    action: textSchema,
    dialogueOrAudio: textSchema,
    transition: textSchema,
    assetIds: z.array(idSchema).min(1),
    continuityAnchors: z.array(textSchema).min(1),
    generationRisk: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const storyboardStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("storyboard"),
    shots: z.array(storyboardShotSchema).min(8).max(12),
    totalDurationMs: z.number().int().min(60_000).max(90_000),
    assetDefinitions: z
      .array(
        z
          .object({
            id: idSchema,
            type: z.enum(["character", "location", "prop"]),
            name: textSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const assetsStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("assets"),
    styleSpecification: textSchema,
    assets: z
      .array(
        z
          .object({
            id: idSchema,
            type: z.enum(["character", "location", "prop"]),
            name: textSchema,
            file: fileNameSchema,
            prompt: textSchema,
            negativePrompt: textSchema,
            rightsNote: textSchema,
          })
          .strict(),
      )
      .min(1),
    contactSheetFiles: z.array(fileNameSchema).min(1),
    inventoryComplete: z.literal(true),
  })
  .strict();

export const keyframesStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("keyframes"),
    frames: z
      .array(
        z
          .object({
            shotId: idSchema,
            file: fileNameSchema,
            assetIds: z.array(idSchema).min(1),
            prompt: textSchema,
            continuityPassed: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    contactSheetFile: fileNameSchema,
    consistencyReportFile: fileNameSchema,
    consistencyPassed: z.literal(true),
  })
  .strict();

export const clipsStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("clips"),
    clips: z
      .array(
        z
          .object({
            shotId: idSchema,
            file: fileNameSchema,
            durationMs: z.number().int().min(500).max(30_000),
            technicalPassed: z.boolean(),
            exception: textSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    proxyAssemblyFile: fileNameSchema,
    technicalReportFile: fileNameSchema,
  })
  .strict();

export const audioStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("audio"),
    dialogueVoiceMap: z
      .array(
        z
          .object({
            characterId: idSchema,
            voiceId: idSchema,
            file: fileNameSchema,
            catalogVoice: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    musicCues: z
      .array(
        z.object({ id: idSchema, file: fileNameSchema, startMs: z.number().int().nonnegative() }).strict(),
      )
      .min(1),
    sfxCues: z
      .array(
        z.object({ id: idSchema, file: fileNameSchema, startMs: z.number().int().nonnegative() }).strict(),
      )
      .min(1),
    mixPreviewFile: fileNameSchema,
    subtitleContentFile: fileNameSchema,
    pronunciationChecked: z.literal(true),
    rightsChecked: z.literal(true),
  })
  .strict();

export const editStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("edit"),
    videoFile: fileNameSchema,
    srtFile: fileNameSchema,
    assFile: fileNameSchema,
    timelineFile: fileNameSchema,
    syncReportFile: fileNameSchema,
    properties: z
      .object({
        width: z.literal(1080),
        height: z.literal(1920),
        fps: z.literal(30),
        videoCodec: z.literal("h264"),
        pixelFormat: z.literal("yuv420p"),
        audioCodec: z.literal("aac"),
        audioSampleRate: z.literal(48_000),
        subtitlesBurnedIn: z.literal(true),
      })
      .strict(),
  })
  .strict();

const qcCategorySchema = z.enum([
  "creative",
  "continuity",
  "technical",
  "accessibility",
  "safety",
  "provider",
  "rights",
  "ai-label",
]);

export const qcStageContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("qc"),
    reportFile: fileNameSchema,
    checks: z
      .array(
        z
          .object({
            category: qcCategorySchema,
            passed: z.boolean(),
            evidence: textSchema,
          })
          .strict(),
      )
      .min(8),
    waivers: z.array(textSchema),
    blockingIssues: z.array(textSchema),
    aiLabelConfirmed: z.literal(true),
  })
  .strict();

export const stageContractSchema = z.discriminatedUnion("stage", [
  conceptStageContractSchema,
  scriptStageContractSchema,
  storyboardStageContractSchema,
  assetsStageContractSchema,
  keyframesStageContractSchema,
  clipsStageContractSchema,
  audioStageContractSchema,
  editStageContractSchema,
  qcStageContractSchema,
]);

export type ConceptStageContract = z.infer<typeof conceptStageContractSchema>;
export type ScriptStageContract = z.infer<typeof scriptStageContractSchema>;
export type StoryboardStageContract = z.infer<typeof storyboardStageContractSchema>;
export type AssetsStageContract = z.infer<typeof assetsStageContractSchema>;
export type KeyframesStageContract = z.infer<typeof keyframesStageContractSchema>;
export type ClipsStageContract = z.infer<typeof clipsStageContractSchema>;
export type AudioStageContract = z.infer<typeof audioStageContractSchema>;
export type EditStageContract = z.infer<typeof editStageContractSchema>;
export type QcStageContract = z.infer<typeof qcStageContractSchema>;
export type StageContract = z.infer<typeof stageContractSchema>;

export function isStageContractFor(
  stage: WorkflowStage,
  contract: StageContract,
): boolean {
  return contract.stage === stage;
}
