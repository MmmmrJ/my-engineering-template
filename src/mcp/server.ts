#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import {
  PROVIDER_CAPABILITIES,
  REVIEW_DECISIONS,
  WORKFLOW_STAGES,
  stageContractSchema,
  type SelectProviderInput,
} from "../contracts/index.js";
import {
  ProviderExecutionManager,
  ProviderError,
  ProviderRegistryFacade,
  loadProviderRegistry,
  type ProviderRegistry,
} from "../providers/index.js";
import { WorkflowService } from "../workflow/index.js";
import { WorkflowError } from "../workflow/index.js";
import {
  manualCompletionMcpSchema,
  providerConfirmHandoffMcpSchema,
  providerAttemptMcpSchema,
  providerEstimateMcpSchema,
  providerJobsMcpSchema,
  providerPrepareHandoffMcpSchema,
  providerRecordHandoffMcpSchema,
  providerResumeMcpSchema,
  providerSubmitMcpSchema,
  requireProviderResumeEligibility,
  requireProviderHandoffEligibility,
  requireProviderSubmitEligibility,
} from "../cli/provider-execution.js";

const originalRightsSchema = z
  .object({
    basis: z.literal("original"),
    creator: z.string().trim().min(1),
    declaration: z.string().trim().min(1),
    evidence: z.string().trim().min(1).optional(),
  })
  .strict();

const publicDomainRightsSchema = z
  .object({
    basis: z.literal("public-domain"),
    source: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    jurisdiction: z.string().trim().min(1),
    authorOrPublicationFacts: z.string().trim().min(1),
    legalBasis: z.string().trim().min(1),
    verifiedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const licensedRightsSchema = z
  .object({
    basis: z.literal("licensed"),
    work: z.string().trim().min(1),
    rightsHolder: z.string().trim().min(1),
    license: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    scope: z.string().trim().min(1),
    verifiedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const providerTermsRightsSchema = z
  .object({
    basis: z.literal("provider-terms"),
    providerId: z.string().trim().min(1),
    termsUrl: z
      .url()
      .refine((value) => {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      }, "termsUrl must be a credential-free HTTPS URL"),
    termsReviewedAt: z.iso.datetime({ offset: true }),
    commercialUseConfirmed: z.literal(true),
    thirdPartyInputsCleared: z.literal(true),
  })
  .strict();

const workflowDerivedRightsSchema = z
  .object({
    basis: z.literal("workflow-derived"),
    sourceArtifactIds: z.array(z.string().trim().min(1)).min(1),
    declaration: z.string().trim().min(1),
  })
  .strict();

const rightsRecordSchema = z.discriminatedUnion("basis", [
  originalRightsSchema,
  publicDomainRightsSchema,
  licensedRightsSchema,
  providerTermsRightsSchema,
  workflowDerivedRightsSchema,
]);

export interface CartoonMcpServerOptions {
  workflow?: WorkflowService;
  providers?: ProviderRegistry;
  outputRoot?: string;
  providerConfigPath?: string;
}

export async function createCartoonMcpServer(
  options: CartoonMcpServerOptions = {},
): Promise<McpServer> {
  const providers =
    options.providers ?? (await loadProviderRegistry(options.providerConfigPath));
  const workflow =
    options.workflow ??
    new WorkflowService({
      providerFacade: new ProviderRegistryFacade(providers),
      ...(options.outputRoot ? { defaultRoot: options.outputRoot } : {}),
    });
  const server = new McpServer({ name: "ai-cartoon-workflow", version: "1.0.0" });

  server.registerTool(
    "cartoon_start",
    {
      description:
        "Start a durable AI cartoon task from the only required inputs: IP and theme.",
      inputSchema: {
        ip: z.string().min(1),
        theme: z.string().min(1),
        reviewMode: z.enum(["strict", "quick"]).optional(),
        outputRoot: z.string().min(1).optional(),
      },
    },
    async ({ ip, theme, reviewMode, outputRoot }) => {
      return jsonResult(
        await workflow.createTask(
          { ip, theme, ...(reviewMode ? { reviewMode } : {}) },
          outputRoot,
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_status",
    {
      description: "Read the current durable workflow state for an AI cartoon task.",
      inputSchema: { taskId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => jsonResult(await workflow.getState(taskId)),
  );

  server.registerTool(
    "cartoon_resume",
    {
      description:
        "Return the one safe next action; strict mode has nine user gates and quick mode has three audited bundle gates.",
      inputSchema: { taskId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => jsonResult(await workflow.resume(taskId)),
  );

  server.registerTool(
    "cartoon_generate_stage",
    {
      description:
        "Generate and import a validated default G1-G3 stage contract; quick mode policy-accepts non-checkpoints and retains them for the next bundle review.",
      inputSchema: {
        taskId: z.string().min(1),
        stage: z.enum(["concept", "script", "storyboard"]).optional(),
        rights: rightsRecordSchema.optional(),
      },
    },
    async ({ taskId, stage, rights }) =>
      jsonResult(
        await workflow.generateStage(taskId, {
          ...(stage ? { stage } : {}),
          ...(rights ? { rights } : {}),
        }),
      ),
  );

  server.registerTool(
    "cartoon_submit_review",
    {
      description:
        "Record one explicit approve, revise, regenerate, or abort decision and its feedback.",
      inputSchema: {
        taskId: z.string().min(1),
        stage: z.enum(WORKFLOW_STAGES),
        revision: z.number().int().positive().optional(),
        decision: z.enum(REVIEW_DECISIONS),
        feedback: z.string().optional(),
        targets: z.array(z.string().min(1)).optional(),
      },
    },
    async ({ taskId, stage, revision, decision, feedback, targets }) => {
      const state = await workflow.getState(taskId);
      const selectedRevision =
        revision ?? state.stages[stage].currentRevision ?? state.stages[stage].approvedRevision;
      if (!selectedRevision) {
        throw new Error(`${stage} has no revision to review.`);
      }
      return jsonResult(
        await workflow.review(taskId, {
          target: { stage, revision: selectedRevision },
          decision,
          ...(feedback ? { feedback } : {}),
          ...(targets?.length ? { targetIds: targets } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "cartoon_list_providers",
    {
      description:
        "List configured and optional providers with capabilities, models, regions, and price metadata.",
      inputSchema: {
        checkHealth: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ checkHealth }) => {
      const descriptors = providers.descriptors();
      const health = checkHealth ? await providers.health() : undefined;
      return jsonResult({ descriptors, ...(health ? { health } : {}) });
    },
  );

  server.registerTool(
    "cartoon_select_providers",
    {
      description:
        "Freeze task provider bindings after storyboard approval and before paid media generation.",
      inputSchema: {
        taskId: z.string().min(1),
        bindings: z
          .array(
            z.object({
              capability: z.enum(PROVIDER_CAPABILITIES),
              providerId: z.string().min(1),
              mode: z.enum(["api", "mcp", "manual"]),
              model: z.string().min(1).optional(),
              profile: z.string().min(1).optional(),
              metadata: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ taskId, bindings }) =>
      jsonResult(
        await workflow.selectProviders(taskId, bindings as readonly SelectProviderInput[]),
      ),
  );

  server.registerTool(
    "cartoon_import_artifact",
    {
      description:
        "Import generated or manually created files into an immutable stage revision with provenance.",
      inputSchema: {
        taskId: z.string().min(1),
        stage: z.enum(WORKFLOW_STAGES),
        files: z.array(z.string().min(1)).min(1),
        stageContract: stageContractSchema,
        summary: z.string().optional(),
        mediaType: z.string().optional(),
        rights: rightsRecordSchema.optional(),
        fileRights: z.record(z.string(), rightsRecordSchema).optional(),
        fileNames: z.record(z.string(), z.string().min(1)).optional(),
        provider: z
          .object({
            providerId: z.string().min(1),
            capability: z.enum(PROVIDER_CAPABILITIES),
            attemptId: z.string().uuid().optional(),
            jobId: z.string().optional(),
            model: z.string().optional(),
            promptHash: z.string().optional(),
            seed: z.union([z.string(), z.number()]).optional(),
            sourceUri: z.string().optional(),
            cost: z
              .object({ amount: z.number().nonnegative(), currency: z.string().min(1) })
              .optional(),
          })
          .optional(),
        providerAttempts: z
          .array(
            z.object({
              providerId: z.string().min(1),
              capability: z.enum(PROVIDER_CAPABILITIES),
              attemptId: z.string().uuid(),
              jobId: z.string().optional(),
              model: z.string().optional(),
            }),
          )
          .min(1)
          .optional(),
        aiLabel: z
          .object({
            aiGenerated: z.boolean(),
            label: z.string().min(1),
            visibleLabel: z.boolean(),
            metadataEmbedded: z.boolean(),
            provenanceIncluded: z.boolean(),
            method: z.string().min(1),
            disclosure: z.string().optional(),
          })
          .optional(),
        voiceCloneConsent: z
          .object({
            enabled: z.literal(true),
            subject: z.string().min(1),
            evidence: z.string().min(1),
            scope: z.string().min(1),
            grantedAt: z.iso.datetime(),
            userConfirmedAt: z.iso.datetime(),
            confirmation: z.string().min(1),
            reviewEventId: z.string().min(1).optional(),
          })
          .optional(),
        targetIds: z.array(z.string().min(1)).optional(),
        dependsOnIds: z.array(z.string().min(1)).optional(),
        fileScopes: z
          .record(
            z.string(),
            z.object({
              targetIds: z.array(z.string().min(1)).optional(),
              dependsOnIds: z.array(z.string().min(1)).optional(),
            }),
          )
          .optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ taskId, files, ...input }) =>
      jsonResult(
        await workflow.importArtifact(taskId, {
          ...input,
          sourceFiles: files,
        }),
      ),
  );

  server.registerTool(
    "cartoon_list_artifacts",
    {
      description: "List current or historical task artifacts without reading secret values.",
      inputSchema: {
        taskId: z.string().min(1),
        stage: z.enum(WORKFLOW_STAGES).optional(),
        includeStale: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, stage, includeStale }) =>
      jsonResult(
        await workflow.listArtifacts(taskId, {
          ...(stage ? { stage } : {}),
          includeStale,
        }),
      ),
  );

  server.registerTool(
    "cartoon_export",
    {
      description:
        "Export the immutable approved package only after all nine gates and AI-label evidence pass.",
      inputSchema: {
        taskId: z.string().min(1),
        output: z.string().min(1).optional(),
      },
    },
    async ({ taskId, output }) => jsonResult(await workflow.export(taskId, output)),
  );

  server.registerTool(
    "cartoon_estimate_provider_job",
    {
      description:
        "Estimate one task-scoped provider request before the user confirms a potentially chargeable submission.",
      inputSchema: providerEstimateMcpSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, providerId, request }) => {
      await workflow.getState(taskId);
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).estimate(providerId, request),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_submit_provider_job",
    {
      description:
        "Submit one new provider request after validating its frozen API/manual binding, active stage, and explicit confirmation: known pricing requires exact estimatedCost; unknown pricing requires unknownPricingAcknowledged=true and no estimatedCost.",
      inputSchema: providerSubmitMcpSchema,
    },
    async ({ taskId, providerId, stage, request, confirmation }) => {
      const eligible = await requireProviderSubmitEligibility(
        workflow,
        taskId,
        providerId,
        stage,
        request,
        confirmation,
      );
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).submitConfirmed(
            providerId,
            eligible.request,
            eligible.context,
          ),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_prepare_provider_handoff",
    {
      description:
        "Prepare a hash-bound task package for a frozen 即梦、可灵、LibLibAI or macOS 剪映 manual route without uploading files or consuming platform credits.",
      inputSchema: providerPrepareHandoffMcpSchema,
    },
    async ({ taskId, providerId, stage, request, uploadPaths }) => {
      const eligible = await requireProviderHandoffEligibility(
        workflow,
        taskId,
        providerId,
        stage,
        request,
      );
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).prepareHandoff(
            providerId,
            eligible.request,
            { ...eligible.context, uploadPaths },
          ),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_confirm_provider_handoff",
    {
      description:
        "Persist one attempt-specific Codex confirmation for the exact platform, manifest hash, model, upload list, credit unit, quote, and maximum credit spend.",
      inputSchema: providerConfirmHandoffMcpSchema,
    },
    async ({ taskId, attemptId, confirmation }) => {
      await workflow.getState(taskId);
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).confirmHandoff(
            attemptId,
            confirmation,
          ),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_record_provider_handoff",
    {
      description:
        "Append a sanitized browser/desktop handoff observation such as login required, submitted, running, download ready, blocked, or cancelled.",
      inputSchema: providerRecordHandoffMcpSchema,
    },
    async ({ taskId, attemptId, record }) => {
      await workflow.getState(taskId);
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).recordHandoff(attemptId, record),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_complete_manual_provider_job",
    {
      description:
        "Archive user-exported files into task scope, complete the matching manual provider attempt, and make it recoverable through cartoon_resume.",
      inputSchema: manualCompletionMcpSchema,
    },
    async ({ taskId, attemptId, result }) => {
      await workflow.getState(taskId);
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).completeManual(attemptId, result),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_resume_provider_job",
    {
      description:
        "Retry the exact prepared request after a crash using its persisted confirmation and idempotency key; no new charge confirmation is requested.",
      inputSchema: providerResumeMcpSchema,
    },
    async ({ taskId, attemptId, request }) => {
      await workflow.getState(taskId);
      const manager = providerManager(providers, workflow, taskId);
      const attempt = (await manager.resumeCandidates()).find(
        (candidate) => candidate.attemptId === attemptId,
      );
      if (!attempt || !attempt.stage || !isMcpWorkflowStage(attempt.stage)) {
        throw new WorkflowError(
          "INVALID_TRANSITION",
          `Provider attempt ${attemptId} is not an eligible prepared submission.`,
        );
      }
      const eligibleRequest = await requireProviderResumeEligibility(
        workflow,
        taskId,
        attemptId,
        attempt.providerId,
        attempt.stage,
        request,
      );
      return jsonResult(
        await safeProviderCall(() => manager.resumePrepared(attemptId, eligibleRequest)),
      );
    },
  );

  server.registerTool(
    "cartoon_poll_provider_job",
    {
      description:
        "Poll a durable provider attempt without creating a new paid request or requesting confirmation again.",
      inputSchema: providerAttemptMcpSchema,
    },
    async ({ taskId, attemptId }) => {
      await workflow.getState(taskId);
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).poll(attemptId),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_cancel_provider_job",
    {
      description: "Cancel a durable provider attempt when its frozen provider supports cancellation.",
      inputSchema: providerAttemptMcpSchema,
    },
    async ({ taskId, attemptId }) => {
      await workflow.getState(taskId);
      return jsonResult(
        await safeProviderCall(() =>
          providerManager(providers, workflow, taskId).cancel(attemptId),
        ),
      );
    },
  );

  server.registerTool(
    "cartoon_list_provider_jobs",
    {
      description:
        "List the task's sanitized durable provider attempt ledger, optionally restricted to resumable attempts.",
      inputSchema: providerJobsMcpSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, resumableOnly }) => {
      await workflow.getState(taskId);
      const manager = providerManager(providers, workflow, taskId);
      return jsonResult(
        resumableOnly ? await manager.resumeCandidates() : await manager.listAttempts(),
      );
    },
  );

  return server;
}

function providerManager(
  providers: ProviderRegistry,
  workflow: WorkflowService,
  taskId: string,
): ProviderExecutionManager {
  return new ProviderExecutionManager(providers, workflow.resolveTaskDirectory(taskId));
}

function isMcpWorkflowStage(value: string): value is (typeof WORKFLOW_STAGES)[number] {
  return (WORKFLOW_STAGES as readonly string[]).includes(value);
}

async function safeProviderCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new WorkflowError(
        "PROVIDER_UNAVAILABLE",
        `Provider operation failed (${error.code}); inspect the sanitized task provider-job ledger for recovery details.`,
      );
    }
    throw error;
  }
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function main(): Promise<void> {
  const server = await createCartoonMcpServer();
  await server.connect(new StdioServerTransport());
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
