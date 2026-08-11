import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod/v4";

import {
  PROVIDER_CAPABILITIES,
  WORKFLOW_STAGES,
  type ProviderCapability,
  type TaskState,
  type WorkflowStage,
} from "../contracts/index.js";
import type {
  AttemptContext,
  HandoffRecordInput,
  HandoffSpendConfirmation,
  JsonObject,
  JsonValue,
  ManualCompletionInput,
  PaidSubmitConfirmation,
  ProviderEstimateRequest,
  ProviderSubmitRequest,
} from "../providers/index.js";
import {
  MANUAL_PLATFORM_ADAPTERS,
  PROVIDER_HANDOFF_BLOCK_REASONS,
} from "../providers/index.js";
import type { WorkflowService } from "../workflow/index.js";
import { WorkflowError } from "../workflow/index.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const providerEstimateRequestSchema: z.ZodType<ProviderEstimateRequest> = z
  .object({
    capability: z.enum(PROVIDER_CAPABILITIES),
    model: z.string().trim().min(1).optional(),
    input: jsonObjectSchema,
    region: z.string().trim().min(1).optional(),
  })
  .strict();

export const providerSubmitRequestSchema: z.ZodType<ProviderSubmitRequest> = z
  .object({
    capability: z.enum(PROVIDER_CAPABILITIES),
    model: z.string().trim().min(1).optional(),
    input: jsonObjectSchema,
    region: z.string().trim().min(1).optional(),
    idempotencyKey: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
      .optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const cloneIntentPath = findVoiceCloneIntent(request);
    if (cloneIntentPath) {
      context.addIssue({
        code: "custom",
        path: cloneIntentPath,
        message: VOICE_CLONE_REJECTION_MESSAGE,
      });
    }
  });

const paidSubmitConfirmationBase = {
  confirmedAt: z.iso.datetime({ offset: true }),
  confirmedBy: z.literal("user"),
  confirmationReference: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,255}$/),
  maximumCost: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
};

export const paidSubmitConfirmationSchema: z.ZodType<PaidSubmitConfirmation> = z
  .discriminatedUnion("pricingStatus", [
    z
      .object({
        ...paidSubmitConfirmationBase,
        pricingStatus: z.literal("known"),
        estimatedCost: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        ...paidSubmitConfirmationBase,
        pricingStatus: z.literal("unknown"),
        unknownPricingAcknowledged: z.literal(true),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.pricingStatus === "known" && value.estimatedCost > value.maximumCost) {
      context.addIssue({
        code: "custom",
        path: ["estimatedCost"],
        message: "estimatedCost exceeds the explicitly approved maximumCost",
      });
    }
  });

export const providerEstimateMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    request: providerEstimateRequestSchema,
  })
  .strict();

export const providerSubmitMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    stage: z.enum(WORKFLOW_STAGES),
    request: providerSubmitRequestSchema,
    confirmation: paidSubmitConfirmationSchema,
  })
  .strict();

export const providerResumeMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    attemptId: z.string().uuid(),
    request: providerSubmitRequestSchema,
  })
  .strict();

export const providerAttemptMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    attemptId: z.string().uuid(),
  })
  .strict();

export const providerJobsMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    resumableOnly: z.boolean().default(false),
  })
  .strict();

export const manualCompletionInputSchema: z.ZodType<ManualCompletionInput> = z
  .object({
    outputs: z
      .array(
        z
          .object({
            kind: z.enum(["image", "video", "audio", "subtitle", "text", "json", "other"]),
            sourcePath: z.string().trim().min(1),
            expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const manualCompletionMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    attemptId: z.string().uuid(),
    result: manualCompletionInputSchema,
  })
  .strict();

const handoffSpendConfirmationBase = {
  confirmedAt: z.iso.datetime({ offset: true }),
  confirmedBy: z.literal("user"),
  confirmationReference: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,255}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  providerId: z.enum(MANUAL_PLATFORM_ADAPTERS),
  model: z.string().trim().min(1).max(128).optional(),
  creditUnit: z.string().trim().min(1).max(32),
  maximumCredits: z.number().finite().nonnegative(),
};

export const handoffSpendConfirmationSchema: z.ZodType<HandoffSpendConfirmation> = z
  .discriminatedUnion("pricingStatus", [
    z
      .object({
        ...handoffSpendConfirmationBase,
        pricingStatus: z.literal("known"),
        estimatedCredits: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        ...handoffSpendConfirmationBase,
        pricingStatus: z.literal("unknown"),
        unknownPricingAcknowledged: z.literal(true),
      })
      .strict(),
  ])
  .superRefine((confirmation, context) => {
    if (
      confirmation.pricingStatus === "known" &&
      confirmation.estimatedCredits > confirmation.maximumCredits
    ) {
      context.addIssue({
        code: "custom",
        path: ["estimatedCredits"],
        message: "estimatedCredits exceeds the approved maximumCredits",
      });
    }
  });

const handoffReceiptSchema = z
  .object({
    externalTaskId: z.string().trim().min(1).max(128).optional(),
    observedModel: z.string().trim().min(1).max(128).optional(),
    observedCredits: z.number().finite().nonnegative().optional(),
    creditUnit: z.string().trim().min(1).max(32).optional(),
    generationUuid: z.string().trim().min(1).max(128).optional(),
    seed: z.union([z.string().trim().min(1).max(128), z.number().finite()]).optional(),
    workflowId: z.string().trim().min(1).max(128).optional(),
    workflowVersion: z.string().trim().min(1).max(128).optional(),
    outputCount: z.number().int().nonnegative().optional(),
    evidence: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const handoffRecordSchema: z.ZodType<HandoffRecordInput> = z
  .object({
    state: z.enum([
      "awaiting_login",
      "awaiting_confirmation",
      "submitted",
      "running",
      "download_ready",
      "blocked",
      "cancelled",
    ]),
    receipt: handoffReceiptSchema.optional(),
    blockedReason: z.enum(PROVIDER_HANDOFF_BLOCK_REASONS).optional(),
    failureReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.state === "blocked" && (!record.blockedReason || !record.failureReason)) {
      context.addIssue({
        code: "custom",
        message: "blocked handoff requires blockedReason and failureReason",
      });
    }
    if (
      record.state !== "blocked" &&
      (record.blockedReason !== undefined || record.failureReason !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "blockedReason and failureReason are only valid for blocked handoffs",
      });
    }
  });

export const providerPrepareHandoffMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    providerId: z.enum(MANUAL_PLATFORM_ADAPTERS),
    stage: z.enum(WORKFLOW_STAGES),
    request: providerSubmitRequestSchema,
    uploadPaths: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const providerConfirmHandoffMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    attemptId: z.string().uuid(),
    confirmation: handoffSpendConfirmationSchema,
  })
  .strict();

export const providerRecordHandoffMcpSchema = z
  .object({
    taskId: z.string().trim().min(1),
    attemptId: z.string().uuid(),
    record: handoffRecordSchema,
  })
  .strict();

export async function readJsonFile<T>(
  reference: string | undefined,
  cwd: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  if (!reference?.trim()) {
    throw new WorkflowError("USAGE", `${label} JSON file is required.`);
  }
  const path = resolve(cwd, reference.startsWith("@") ? reference.slice(1) : reference);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new WorkflowError(
      "INVALID_INPUT",
      `Could not read ${label} JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw new WorkflowError(
      "INVALID_INPUT",
      `${label} JSON is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export interface EligibleProviderSubmit {
  readonly request: ProviderSubmitRequest;
  readonly context: AttemptContext;
}

export interface EligibleProviderHandoff {
  readonly request: ProviderSubmitRequest;
  readonly context: {
    readonly stage: WorkflowStage;
    readonly stageRevision: number;
  };
}

export async function requireProviderHandoffEligibility(
  workflow: WorkflowService,
  taskId: string,
  providerId: string,
  stage: WorkflowStage,
  request: ProviderSubmitRequest,
): Promise<EligibleProviderHandoff> {
  assertNoDirectVoiceCloneIntent(request);
  const state = await workflow.getState(taskId);
  const binding = requireFrozenProviderBinding(state, providerId, request);
  if (binding.mode !== "manual" || !MANUAL_PLATFORM_ADAPTERS.includes(providerId as never)) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `Provider ${providerId} is not a frozen browser/desktop handoff route.`,
    );
  }
  requireActionableStage(state, stage, request.capability);
  await workflow.assertProviderSubmissionAllowed(taskId, stage);
  return {
    request: binding.request,
    context: {
      stage,
      stageRevision: state.stages[stage].revisions.length + 1,
    },
  };
}

export async function requireProviderSubmitEligibility(
  workflow: WorkflowService,
  taskId: string,
  providerId: string,
  stage: WorkflowStage,
  request: ProviderSubmitRequest,
  confirmation: PaidSubmitConfirmation,
): Promise<EligibleProviderSubmit> {
  assertNoDirectVoiceCloneIntent(request);
  const state = await workflow.getState(taskId);
  const binding = requireFrozenProviderBinding(state, providerId, request);
  requireActionableStage(state, stage, request.capability);
  await workflow.assertProviderSubmissionAllowed(taskId, stage);
  if (
    binding.mode === "manual" &&
    (confirmation.pricingStatus !== "unknown" || confirmation.maximumCost !== 0)
  ) {
    throw new WorkflowError(
      "INVALID_INPUT",
      "Manual request packages have no mechanically calculated price and require pricingStatus=unknown, unknownPricingAcknowledged=true, and maximumCost=0.",
    );
  }
  return {
    request: binding.request,
    context: {
      stage,
      stageRevision: state.stages[stage].revisions.length + 1,
      costConfirmation: confirmation,
    },
  };
}

export async function requireProviderResumeEligibility(
  workflow: WorkflowService,
  taskId: string,
  attemptId: string,
  providerId: string,
  stage: WorkflowStage,
  request: ProviderSubmitRequest,
): Promise<ProviderSubmitRequest> {
  assertNoDirectVoiceCloneIntent(request);
  const state = await workflow.getState(taskId);
  const binding = requireFrozenProviderBinding(state, providerId, request);
  requireActionableStage(state, stage, request.capability);
  await workflow.assertProviderAttemptRevision(taskId, attemptId, stage);
  return binding.request;
}

const VOICE_CLONE_INTENT_KEYS = new Set([
  "voiceclone",
  "voicecloneid",
  "clonevoice",
  "clonevoiceid",
  "clonespeaker",
  "referenceaudio",
  "referenceaudioid",
  "voicereference",
  "voicereferenceid",
  "referencevoice",
  "referencevoiceid",
  "speakerreference",
  "speakerreferenceid",
  "referencespeaker",
  "speakeraudio",
  "speakeraudioid",
  "voicesample",
  "voicesampleid",
  "voiceembedding",
  "speakerembedding",
]);

const VOICE_CLONE_REJECTION_MESSAGE =
  "Direct provider voice cloning/reference-voice submission is disabled. Create the authorized output outside the direct API path, then use manual import with a complete VoiceCloneConsent record.";

export function assertNoDirectVoiceCloneIntent(request: ProviderSubmitRequest): void {
  if (findVoiceCloneIntent(request)) {
    throw new WorkflowError("INVALID_INPUT", VOICE_CLONE_REJECTION_MESSAGE);
  }
}

function findVoiceCloneIntent(value: unknown): (string | number)[] | undefined {
  return findVoiceCloneIntentAt(value, []);
}

function findVoiceCloneIntentAt(
  value: unknown,
  path: (string | number)[],
): (string | number)[] | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findVoiceCloneIntentAt(item, [...path, index]);
      if (found) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const itemPath = [...path, key];
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (isVoiceCloneIntentKey(normalizedKey) && hasIntentValue(item)) {
      return itemPath;
    }
    const found = findVoiceCloneIntentAt(item, itemPath);
    if (found) return found;
  }
  return undefined;
}

function isVoiceCloneIntentKey(normalizedKey: string): boolean {
  if (VOICE_CLONE_INTENT_KEYS.has(normalizedKey)) return true;
  return [
    "voiceclone",
    "clonevoice",
    "clonespeaker",
    "referenceaudio",
    "voicereference",
    "referencevoice",
    "speakerreference",
    "referencespeaker",
    "speakeraudio",
    "voiceembedding",
    "speakerembedding",
  ].some((prefix) => normalizedKey.startsWith(prefix));
}

function hasIntentValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

interface FrozenProviderBinding {
  readonly mode: "api" | "manual";
  readonly request: ProviderSubmitRequest;
}

function requireFrozenProviderBinding(
  state: TaskState,
  providerId: string,
  request: ProviderSubmitRequest,
): FrozenProviderBinding {
  const binding = state.providers[request.capability];
  if (!binding) {
    throw new WorkflowError(
      "PROVIDER_SELECTION_REQUIRED",
      `${request.capability} has not been frozen for task ${state.taskId}.`,
    );
  }
  if (binding.providerId !== providerId) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `${request.capability} is frozen to ${binding.providerId}, not ${providerId}.`,
    );
  }
  if (binding.mode === "mcp") {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `${request.capability} is frozen in mcp mode; invoke that MCP server and import its output instead of direct provider execution.`,
    );
  }
  if (binding.model && request.model && binding.model !== request.model) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `${request.capability} is frozen to model ${binding.model}, not ${request.model}.`,
    );
  }
  if (!binding.model && request.model) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `${request.capability} has no frozen model; remove request.model or freeze the model during provider selection.`,
    );
  }
  return {
    mode: binding.mode,
    request: binding.model && !request.model ? { ...request, model: binding.model } : request,
  };
}

function requireActionableStage(
  state: TaskState,
  stage: WorkflowStage,
  capability: ProviderCapability,
): void {
  const target = state.stages[stage];
  if (state.activeStage !== stage) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `${stage} is not the active stage for task ${state.taskId}.`,
    );
  }
  if (target.status === "awaiting_review") {
    throw new WorkflowError(
      "REVIEW_REQUIRED",
      `${stage} already has an output awaiting explicit user review.`,
    );
  }
  if (!["pending", "running", "revision_requested", "stale"].includes(target.status)) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `${stage} cannot start a provider request while it is ${target.status}.`,
    );
  }
  if (!STAGE_PROVIDER_CAPABILITIES[stage]?.includes(capability)) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `${capability} is not a valid provider capability for the ${stage} stage.`,
    );
  }
}

const STAGE_PROVIDER_CAPABILITIES: Readonly<
  Partial<Record<WorkflowStage, readonly ProviderCapability[]>>
> = {
  assets: ["image.generate", "image.edit", "render.timeline"],
  keyframes: ["image.generate", "image.edit", "render.timeline"],
  clips: ["video.i2v", "video.r2v", "video.t2v", "render.timeline", "quality.inspect"],
  audio: ["audio.tts", "audio.music", "audio.sfx"],
  edit: ["speech.transcribe", "render.timeline"],
  qc: ["quality.inspect"],
};
