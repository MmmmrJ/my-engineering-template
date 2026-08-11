#!/usr/bin/env node

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ConceptRightsMetadata,
  DoctorRunner,
  ProviderFacade,
  SelectProviderInput,
  WorkflowStage,
} from "../contracts/index.js";
import {
  REQUIRED_PROVIDER_CAPABILITIES,
  isProviderCapability,
  isReviewDecision,
  isReviewMode,
  isWorkflowStage,
  stageContractSchema,
} from "../contracts/index.js";
import {
  ProviderExecutionManager,
  ProviderError,
  ProviderRegistryFacade,
  loadProviderFacade,
  loadProviderRegistry,
  type ProviderEstimate,
  type ProviderRegistry,
  type StoredProviderAttempt,
} from "../providers/index.js";
import {
  DefaultDoctorRunner,
  WorkflowError,
  WorkflowService,
  parseRevision,
  versionLabel,
} from "../workflow/index.js";
import {
  assertAllowedOptions,
  assertPositionalCount,
  flag,
  option,
  options,
  parseArguments,
  positional,
} from "./args.js";
import { readImportMetadata } from "./metadata.js";
import {
  manualCompletionInputSchema,
  paidSubmitConfirmationSchema,
  providerEstimateRequestSchema,
  providerSubmitRequestSchema,
  readJsonFile,
  requireProviderResumeEligibility,
  requireProviderSubmitEligibility,
} from "./provider-execution.js";

export interface CliDependencies {
  workflow?: WorkflowService;
  providerFacade?: ProviderFacade;
  providerRegistry?: ProviderRegistry;
  doctor?: DoctorRunner;
  cwd?: string;
  outputRoot?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  let providerFacade = dependencies.providerFacade;
  let providerRegistry = dependencies.providerRegistry;
  let workflow = dependencies.workflow;

  const getProviderRegistry = async (): Promise<ProviderRegistry> => {
    providerRegistry ??= await loadProviderRegistry(undefined, { cwd });
    return providerRegistry;
  };
  const getProviders = async (): Promise<ProviderFacade> => {
    providerFacade ??= providerRegistry
      ? new ProviderRegistryFacade(providerRegistry)
      : await loadProviderFacade(undefined, { cwd });
    return providerFacade;
  };
  const getWorkflow = async (withProviders = false): Promise<WorkflowService> => {
    if (!workflow) {
      workflow = new WorkflowService({
        ...(dependencies.outputRoot ? { defaultRoot: resolve(cwd, dependencies.outputRoot) } : {}),
        ...(withProviders ? { providerFacade: await getProviders() } : {}),
      });
    }
    return workflow;
  };

  try {
    const command = argv[0];
    if (!command || command === "help" || argv.includes("--help")) {
      stdout(`${HELP}\n`);
      return 0;
    }

    switch (command) {
      case "start": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, ["ip", "theme", "review-mode", "root", "json"]);
        assertPositionalCount(args, 0);
        const rootOption = option(args, "root");
        const requestedReviewMode = option(args, "review-mode");
        if (requestedReviewMode && !isReviewMode(requestedReviewMode)) {
          throw new WorkflowError("USAGE", "--review-mode must be strict or quick.");
        }
        const reviewMode = requestedReviewMode && isReviewMode(requestedReviewMode)
          ? requestedReviewMode
          : undefined;
        const result = await (await getWorkflow()).createTask(
          {
            ip: option(args, "ip", { required: true }) as string,
            theme: option(args, "theme", { required: true }) as string,
            ...(reviewMode ? { reviewMode } : {}),
          },
          rootOption ? resolve(cwd, rootOption) : undefined,
        );
        writeResult(
          flag(args, "json"),
          result,
          `Created ${result.manifest.taskId}\n${result.taskDirectory}`,
          stdout,
        );
        return 0;
      }
      case "status": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, ["json"]);
        assertPositionalCount(args, 1);
        const state = await (await getWorkflow()).getState(
          positional(args, 0, "task-id") as string,
        );
        writeResult(
          flag(args, "json"),
          state,
          formatStatus(state),
          stdout,
        );
        return 0;
      }
      case "resume": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, ["json"]);
        assertPositionalCount(args, 1);
        const result = await (await getWorkflow()).resume(
          positional(args, 0, "task-id") as string,
        );
        writeResult(flag(args, "json"), result, formatResume(result), stdout);
        return 0;
      }
      case "generate": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, [
          "stage",
          "metadata",
          "rights",
          "creator",
          "declaration",
          "evidence",
          "source",
          "jurisdiction",
          "author-or-publication-facts",
          "legal-basis",
          "verified-at",
          "json",
        ]);
        assertPositionalCount(args, 1);
        const metadata = await readImportMetadata(option(args, "metadata"), cwd);
        const requestedStage = option(args, "stage");
        const stage = requestedStage ? requireStage(requestedStage) : undefined;
        const rights = rightsFromArguments(args) ?? metadata.rights;
        const result = await (await getWorkflow()).generateStage(
          positional(args, 0, "task-id") as string,
          {
            ...(stage ? { stage: requireGeneratableStage(stage) } : {}),
            ...(rights ? { rights } : {}),
          },
        );
        writeResult(
          flag(args, "json"),
          result,
          result.state.stages[result.stageContract.stage].status === "approved"
            ? `Generated ${result.stageContract.stage}/${versionLabel(result.revision)}; accepted by quick policy and retained for bundle review.\n${result.reviewPacketPath}`
            : `Generated ${result.stageContract.stage}/${versionLabel(result.revision)}; explicit review required.\n${result.reviewPacketPath}`,
          stdout,
        );
        return 0;
      }
      case "review": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, [
          "stage",
          "revision",
          "decision",
          "feedback",
          "targets",
          "json",
        ]);
        assertPositionalCount(args, 1);
        const task = positional(args, 0, "task-id") as string;
        const stage = requireStage(option(args, "stage", { required: true }) as string);
        const decisionValue = option(args, "decision", { required: true }) as string;
        if (!isReviewDecision(decisionValue)) {
          throw new WorkflowError("USAGE", `Unknown review decision: ${decisionValue}`);
        }
        const workflowService = await getWorkflow();
        const state = await workflowService.getState(task);
        const revisionValue = option(args, "revision");
        const revision = revisionValue
          ? parseRevision(revisionValue)
          : state.stages[stage].currentRevision ?? state.stages[stage].approvedRevision;
        if (!revision) {
          throw new WorkflowError("INVALID_TRANSITION", `${stage} has no revision to review.`);
        }
        const targets = option(args, "targets")
          ?.split(",")
          .map((target) => target.trim())
          .filter(Boolean);
        const next = await workflowService.review(task, {
          target: { stage, revision },
          decision: decisionValue,
          ...(option(args, "feedback") ? { feedback: option(args, "feedback") } : {}),
          ...(targets?.length ? { targetIds: targets } : {}),
        });
        writeResult(
          flag(args, "json"),
          next,
          `Recorded ${decisionValue} for ${stage}/${versionLabel(revision)}.`,
          stdout,
        );
        return 0;
      }
      case "providers":
        return await runProviders(
          argv.slice(1),
          await getProviders(),
          getProviderRegistry,
          getWorkflow,
          cwd,
          stdout,
        );
      case "import": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, [
          "stage",
          "file",
          "metadata",
          "contract",
          "rights",
          "creator",
          "declaration",
          "evidence",
          "source",
          "jurisdiction",
          "author-or-publication-facts",
          "legal-basis",
          "verified-at",
          "summary",
          "media-type",
          "json",
        ]);
        assertPositionalCount(args, 1);
        const files = options(args, "file");
        if (files.length === 0) throw new WorkflowError("USAGE", "At least one --file is required.");
        const metadata = await readImportMetadata(option(args, "metadata"), cwd);
        const stage = requireStage(option(args, "stage", { required: true }) as string);
        const stageContract = option(args, "contract")
          ? await readJsonFile(
              option(args, "contract"),
              cwd,
              stageContractSchema,
              "stage contract",
            )
          : metadata.stageContract;
        if (!stageContract) {
          throw new WorkflowError(
            "STAGE_CONTRACT_INVALID",
            "A structured stage contract is required via --contract or metadata.stageContract.",
          );
        }
        const rights = rightsFromArguments(args) ?? metadata.rights;
        const result = await (await getWorkflow()).importArtifact(
          positional(args, 0, "task-id") as string,
          {
            stage,
            sourceFiles: files.map((path) => resolve(cwd, path)),
            stageContract,
            ...(rights ? { rights } : {}),
            ...(metadata.fileRights ? { fileRights: metadata.fileRights } : {}),
            ...(metadata.fileNames ? { fileNames: metadata.fileNames } : {}),
            ...(metadata.provider ? { provider: metadata.provider } : {}),
            ...(metadata.aiLabel ? { aiLabel: metadata.aiLabel } : {}),
            ...(metadata.voiceCloneConsent
              ? { voiceCloneConsent: metadata.voiceCloneConsent }
              : {}),
            ...(metadata.targetIds ? { targetIds: metadata.targetIds } : {}),
            ...(metadata.dependsOnIds ? { dependsOnIds: metadata.dependsOnIds } : {}),
            ...(metadata.fileScopes ? { fileScopes: metadata.fileScopes } : {}),
            ...(option(args, "summary") ?? metadata.summary
              ? { summary: option(args, "summary") ?? metadata.summary }
              : {}),
            ...(option(args, "media-type") ?? metadata.mediaType
              ? { mediaType: option(args, "media-type") ?? metadata.mediaType }
              : {}),
            ...(metadata.metadata ? { metadata: metadata.metadata } : {}),
          },
        );
        writeResult(
          flag(args, "json"),
          result,
          `Imported ${result.artifacts.length} artifact(s) as ${versionLabel(result.revision)}; review required.`,
          stdout,
        );
        return 0;
      }
      case "export": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, ["output", "json"]);
        assertPositionalCount(args, 1);
        const output = option(args, "output");
        const result = await (await getWorkflow()).export(
          positional(args, 0, "task-id") as string,
          output ? resolve(cwd, output) : undefined,
        );
        writeResult(
          flag(args, "json"),
          result,
          `Exported ${result.exportId}\n${result.outputDirectory}`,
          stdout,
        );
        return 0;
      }
      case "doctor": {
        const args = parseArguments(argv.slice(1));
        assertAllowedOptions(args, ["json"]);
        assertPositionalCount(args, 0);
        const runner =
          dependencies.doctor ??
          new DefaultDoctorRunner({
            ...(dependencies.outputRoot
              ? { outputRoot: resolve(cwd, dependencies.outputRoot) }
              : {}),
            providerConfigCheck: async () => {
              try {
                const providers = await (await getProviders()).list();
                return {
                  name: "provider-config",
                  ok: true,
                  message: `Parsed ${providers.length} provider descriptor(s).`,
                };
              } catch (error) {
                return {
                  name: "provider-config",
                  ok: false,
                  message: error instanceof Error ? error.message : String(error),
                };
              }
            },
          });
        const report = await runner.run();
        writeResult(flag(args, "json"), report, formatDoctor(report), stdout);
        return report.ok ? 0 : 1;
      }
      default:
        throw new WorkflowError("USAGE", `Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof WorkflowError) {
      stderr(`${error.code}: ${error.message}\n`);
      return error.code === "USAGE" ? 2 : 1;
    }
    if (error instanceof ProviderError) {
      stderr(
        `${error.code.toUpperCase()}: Provider operation failed; inspect the sanitized task provider-job ledger for recovery details.\n`,
      );
      return 1;
    }
    stderr(`UNEXPECTED: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runProviders(
  argv: readonly string[],
  facade: ProviderFacade,
  getProviderRegistry: () => Promise<ProviderRegistry>,
  getWorkflow: (withProviders?: boolean) => Promise<WorkflowService>,
  cwd: string,
  stdout: (text: string) => void,
): Promise<number> {
  const subcommand = argv[0];
  if (!subcommand) {
    throw new WorkflowError(
      "USAGE",
      "providers requires list, check, select, estimate, submit, complete-manual, import-output, resume-job, poll, cancel, or jobs.",
    );
  }
  const args = parseArguments(argv.slice(1));
  if (subcommand === "list") {
    assertAllowedOptions(args, ["json"]);
    assertPositionalCount(args, 0);
    const providers = await facade.list();
    writeResult(
      flag(args, "json"),
      providers,
      providers.length
        ? providers
            .map(
              (provider) =>
                `${provider.id}\t${provider.configured ? "configured" : "unconfigured"}\t${provider.capabilities.join(",")}\t${JSON.stringify(provider.metadata ?? {})}`,
            )
            .join("\n")
        : "No providers configured.",
      stdout,
    );
    return 0;
  }
  if (subcommand === "check") {
    assertAllowedOptions(args, ["provider", "json"]);
    assertPositionalCount(args, 0);
    const health = await facade.check(option(args, "provider"));
    writeResult(
      flag(args, "json"),
      health,
      health.map((entry) => `${entry.providerId}\t${entry.ok ? "ok" : "failed"}\t${entry.message ?? ""}`).join("\n"),
      stdout,
    );
    return health.every((entry) => entry.ok) ? 0 : 1;
  }
  if (subcommand === "select") {
    assertAllowedOptions(args, [
      "binding",
      "capability",
      "provider",
      "mode",
      "model",
      "profile",
      "checked-at",
      "server",
      "tool",
      "json",
    ]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const bindings = selectionInputs(args);
    const state = await (await getWorkflow(true)).selectProviders(task, bindings);
    writeResult(
      flag(args, "json"),
      state.providers,
      state.providerProfileFreeze
        ? `Frozen the complete provider profile for ${state.taskId} with ${bindings.length} new binding(s).`
        : `Recorded ${bindings.length} provider binding(s) for ${state.taskId}; the profile remains open until all required capabilities are selected.`,
      stdout,
    );
    return 0;
  }
  if (subcommand === "estimate") {
    assertAllowedOptions(args, ["provider", "request", "json"]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const providerId = option(args, "provider", { required: true }) as string;
    const request = await readJsonFile(
      option(args, "request"),
      cwd,
      providerEstimateRequestSchema,
      "provider request",
    );
    const workflowService = await getWorkflow();
    await workflowService.getState(task);
    const manager = new ProviderExecutionManager(
      await getProviderRegistry(),
      workflowService.resolveTaskDirectory(task),
    );
    const estimate = await manager.estimate(providerId, request);
    writeResult(
      flag(args, "json"),
      estimate,
      `Estimated ${request.capability} with ${providerId}: ${formatProviderEstimate(estimate)}`,
      stdout,
    );
    return 0;
  }
  if (subcommand === "submit") {
    assertAllowedOptions(args, ["provider", "stage", "request", "confirmation", "json"]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const providerId = option(args, "provider", { required: true }) as string;
    const stage = requireStage(option(args, "stage", { required: true }) as string);
    const request = await readJsonFile(
      option(args, "request"),
      cwd,
      providerSubmitRequestSchema,
      "provider request",
    );
    const confirmation = await readJsonFile(
      option(args, "confirmation"),
      cwd,
      paidSubmitConfirmationSchema,
      "paid-submit confirmation",
    );
    const workflowService = await getWorkflow();
    const eligible = await requireProviderSubmitEligibility(
      workflowService,
      task,
      providerId,
      stage,
      request,
      confirmation,
    );
    const manager = new ProviderExecutionManager(
      await getProviderRegistry(),
      workflowService.resolveTaskDirectory(task),
    );
    const result = await manager.submitConfirmed(
      providerId,
      eligible.request,
      eligible.context,
    );
    writeResult(
      flag(args, "json"),
      result,
      `Submitted ${result.attempt.attemptId}; provider job ${result.job.remoteJobId} is ${result.job.state}.`,
      stdout,
    );
    return 0;
  }
  if (subcommand === "resume-job") {
    assertAllowedOptions(args, ["attempt", "request", "json"]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const attemptId = option(args, "attempt", { required: true }) as string;
    const request = await readJsonFile(
      option(args, "request"),
      cwd,
      providerSubmitRequestSchema,
      "provider request",
    );
    const workflowService = await getWorkflow();
    const manager = new ProviderExecutionManager(
      await getProviderRegistry(),
      workflowService.resolveTaskDirectory(task),
    );
    const attempt = (await manager.resumeCandidates()).find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (!attempt || !attempt.stage || !isWorkflowStage(attempt.stage)) {
      throw new WorkflowError(
        "INVALID_TRANSITION",
        `Provider attempt ${attemptId} is not an eligible prepared submission.`,
      );
    }
    const eligibleRequest = await requireProviderResumeEligibility(
      workflowService,
      task,
      attemptId,
      attempt.providerId,
      attempt.stage,
      request,
    );
    const result = await manager.resumePrepared(attemptId, eligibleRequest);
    writeResult(
      flag(args, "json"),
      result,
      `Resumed ${attemptId}; provider job ${result.job.remoteJobId} is ${result.job.state}.`,
      stdout,
    );
    return 0;
  }
  if (subcommand === "complete-manual") {
    assertAllowedOptions(args, ["attempt", "result", "json"]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const attemptId = option(args, "attempt", { required: true }) as string;
    const input = await readJsonFile(
      option(args, "result"),
      cwd,
      manualCompletionInputSchema,
      "manual completion result",
    );
    const workflowService = await getWorkflow();
    await workflowService.getState(task);
    const manager = new ProviderExecutionManager(
      await getProviderRegistry(),
      workflowService.resolveTaskDirectory(task),
    );
    const job = await manager.completeManual(attemptId, {
      outputs: input.outputs.map((output) => ({
        ...output,
        sourcePath: resolve(cwd, output.sourcePath),
      })),
    });
    writeResult(
      flag(args, "json"),
      job,
      `Completed manual provider attempt ${attemptId}: ${job.state}. Run cartoon resume to import the archived output.`,
      stdout,
    );
    return 0;
  }
  if (subcommand === "import-output") {
    assertAllowedOptions(args, ["attempt", "contract", "metadata", "summary", "json"]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const attemptIds = options(args, "attempt");
    if (attemptIds.length === 0) {
      throw new WorkflowError("USAGE", "providers import-output requires at least one --attempt.");
    }
    if (new Set(attemptIds).size !== attemptIds.length) {
      throw new WorkflowError("USAGE", "providers import-output received a duplicate --attempt.");
    }
    const metadata = await readImportMetadata(option(args, "metadata"), cwd);
    if (metadata.provider) {
      throw new WorkflowError(
        "INVALID_INPUT",
        "providers import-output derives provider metadata from the durable ledger; metadata.provider is not allowed.",
      );
    }
    const stageContract = option(args, "contract")
      ? await readJsonFile(
          option(args, "contract"),
          cwd,
          stageContractSchema,
          "stage contract",
        )
      : metadata.stageContract;
    if (!stageContract) {
      throw new WorkflowError(
        "STAGE_CONTRACT_INVALID",
        "A structured stage contract is required via --contract or metadata.stageContract.",
      );
    }
    const workflowService = await getWorkflow();
    await workflowService.getState(task);
    const manager = new ProviderExecutionManager(
      await getProviderRegistry(),
      workflowService.resolveTaskDirectory(task),
    );
    const ledger = await manager.listAttempts();
    const attempts = attemptIds.map((attemptId) =>
      ledger.find((candidate) => candidate.attemptId === attemptId),
    );
    if (
      attempts.some(
        (attempt) =>
          !attempt ||
          attempt.state !== "succeeded" ||
          !attempt.stage ||
          !isWorkflowStage(attempt.stage),
      )
    ) {
      throw new WorkflowError(
        "INVALID_TRANSITION",
        "Every provider attempt must be a successful importable workflow attempt.",
      );
    }
    const importableAttempts = attempts as StoredProviderAttempt[];
    const stage = importableAttempts[0]?.stage;
    if (!stage || !isWorkflowStage(stage) || importableAttempts.some((attempt) => attempt.stage !== stage)) {
      throw new WorkflowError(
        "INVALID_TRANSITION",
        "All provider attempts in one atomic import must target the same workflow stage.",
      );
    }
    const files = await Promise.all(
      importableAttempts.flatMap((attempt) =>
        (attempt.outputs ?? []).map((output) =>
          firstExistingPath(output.localPath, output.archivedPath),
        ),
      ),
    );
    if (files.length === 0 || files.some((path) => !path)) {
      throw new WorkflowError(
        "INVALID_TRANSITION",
        "One or more provider attempts have no complete archived output set.",
      );
    }
    const result = await workflowService.importArtifact(task, {
      stage,
      sourceFiles: files as string[],
      stageContract,
      ...(metadata.rights ? { rights: metadata.rights } : {}),
      ...(metadata.fileRights ? { fileRights: metadata.fileRights } : {}),
      ...(metadata.fileNames ? { fileNames: metadata.fileNames } : {}),
      providerAttempts: importableAttempts.map((attempt) => {
        const model = attempt.observedModel ?? attempt.model;
        return {
          providerId: attempt.providerId,
          capability: attempt.capability,
          attemptId: attempt.attemptId,
          ...(attempt.externalJobId ? { jobId: attempt.externalJobId } : {}),
          ...(model ? { model } : {}),
        };
      }),
      ...(metadata.aiLabel ? { aiLabel: metadata.aiLabel } : {}),
      ...(metadata.voiceCloneConsent
        ? { voiceCloneConsent: metadata.voiceCloneConsent }
        : {}),
      ...(metadata.targetIds ? { targetIds: metadata.targetIds } : {}),
      ...(metadata.dependsOnIds ? { dependsOnIds: metadata.dependsOnIds } : {}),
      ...(metadata.fileScopes ? { fileScopes: metadata.fileScopes } : {}),
      ...(option(args, "summary") ?? metadata.summary
        ? { summary: option(args, "summary") ?? metadata.summary }
        : {}),
      ...(metadata.mediaType ? { mediaType: metadata.mediaType } : {}),
      ...(metadata.metadata ? { metadata: metadata.metadata } : {}),
    });
    writeResult(
      flag(args, "json"),
      result,
      `Imported ${attemptIds.length} provider attempt(s) as ${stage}/${versionLabel(result.revision)}; review required.`,
      stdout,
    );
    return 0;
  }
  if (subcommand === "poll" || subcommand === "cancel") {
    assertAllowedOptions(args, ["attempt", "json"]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const attemptId = option(args, "attempt", { required: true }) as string;
    const workflowService = await getWorkflow();
    await workflowService.getState(task);
    const manager = new ProviderExecutionManager(
      await getProviderRegistry(),
      workflowService.resolveTaskDirectory(task),
    );
    const job = subcommand === "poll"
      ? await manager.poll(attemptId)
      : await manager.cancel(attemptId);
    writeResult(
      flag(args, "json"),
      job,
      `${subcommand === "poll" ? "Polled" : "Cancelled"} ${attemptId}: ${job.state}.`,
      stdout,
    );
    return 0;
  }
  if (subcommand === "jobs") {
    assertAllowedOptions(args, ["json"]);
    assertPositionalCount(args, 1);
    const task = positional(args, 0, "task-id") as string;
    const workflowService = await getWorkflow();
    await workflowService.getState(task);
    const manager = new ProviderExecutionManager(
      await getProviderRegistry(),
      workflowService.resolveTaskDirectory(task),
    );
    const attempts = await manager.listAttempts();
    writeResult(
      flag(args, "json"),
      attempts,
      attempts.length
        ? attempts
            .map(
              (attempt) =>
                `${attempt.attemptId}\t${attempt.providerId}\t${attempt.capability}\t${attempt.state}`,
            )
            .join("\n")
        : "No provider job attempts recorded.",
      stdout,
    );
    return 0;
  }
  throw new WorkflowError("USAGE", `Unknown providers command: ${subcommand}`);
}

async function firstExistingPath(
  ...candidates: readonly (string | undefined)[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the durable archived path when a provider-local copy is unavailable.
    }
  }
  return undefined;
}

function selectionInputs(
  args: ReturnType<typeof parseArguments>,
): readonly SelectProviderInput[] {
  const encoded = options(args, "binding");
  const auditMetadata = providerAuditMetadata(args);
  if (encoded.length > 0) {
    return encoded.map((value) => ({
      ...parseBinding(value),
      ...(auditMetadata ? { metadata: auditMetadata } : {}),
    }));
  }

  const oneProvider = option(args, "provider");
  const oneCapability = option(args, "capability");
  const mode = parseMode(option(args, "mode"));
  if (oneCapability) {
    if (!oneProvider) throw new WorkflowError("USAGE", "--capability requires --provider.");
    if (!isProviderCapability(oneCapability)) {
      throw new WorkflowError("USAGE", `Unknown provider capability: ${oneCapability}`);
    }
    return [
      {
        capability: oneCapability,
        providerId: oneProvider,
        mode: mode ?? (isManualProviderId(oneProvider) ? "manual" : "api"),
        ...(option(args, "model") ? { model: option(args, "model") } : {}),
        ...(option(args, "profile") ? { profile: option(args, "profile") } : {}),
        ...(auditMetadata ? { metadata: auditMetadata } : {}),
      },
    ];
  }
  if (oneProvider) {
    if (oneProvider !== "manual" && isManualProviderId(oneProvider)) {
      throw new WorkflowError(
        "USAGE",
        `Platform handoff ${oneProvider} covers selected capabilities only; use explicit --binding capability=${oneProvider}:manual entries in the complete frozen map.`,
      );
    }
    return REQUIRED_PROVIDER_CAPABILITIES.map((capability) => ({
      capability,
      providerId: oneProvider,
      mode: mode ?? (isManualProviderId(oneProvider) ? "manual" : "api"),
      ...(option(args, "model") ? { model: option(args, "model") } : {}),
      ...(option(args, "profile") ? { profile: option(args, "profile") } : {}),
      ...(auditMetadata ? { metadata: auditMetadata } : {}),
    }));
  }

  throw new WorkflowError(
    "USAGE",
    "Choose providers explicitly with --provider/--mode or complete --binding values after running providers list and check.",
  );
}

function providerAuditMetadata(
  args: ReturnType<typeof parseArguments>,
): Readonly<Record<string, unknown>> | undefined {
  const checkedAt = option(args, "checked-at");
  const server = option(args, "server");
  const tool = option(args, "tool");
  if (!checkedAt && !server && !tool) return undefined;
  return {
    ...(checkedAt ? { checkedAt } : {}),
    ...(server ? { server } : {}),
    ...(tool ? { tool } : {}),
  };
}

function parseBinding(value: string): SelectProviderInput {
  const [mapping, modeValue, model, profile] = value.split(":");
  const [capability, providerId] = (mapping ?? "").split("=");
  if (!capability || !providerId || !isProviderCapability(capability)) {
    throw new WorkflowError(
      "USAGE",
      `Invalid --binding ${value}; expected capability=provider[:api|mcp|manual[:model[:profile]]].`,
    );
  }
  return {
    capability,
    providerId,
    mode: parseMode(modeValue) ?? (isManualProviderId(providerId) ? "manual" : "api"),
    ...(model ? { model } : {}),
    ...(profile ? { profile } : {}),
  };
}

function parseMode(value: string | undefined): "api" | "mcp" | "manual" | undefined {
  if (!value) return undefined;
  if (value === "api" || value === "mcp" || value === "manual") return value;
  throw new WorkflowError("USAGE", `Unknown provider mode: ${value}`);
}

function isManualProviderId(providerId: string): boolean {
  return providerId === "manual" || providerId.endsWith("-manual");
}

function rightsFromArguments(
  args: ReturnType<typeof parseArguments>,
): ConceptRightsMetadata | undefined {
  const basis = option(args, "rights");
  if (!basis) return undefined;
  if (basis === "original") {
    return {
      basis: "original",
      creator: option(args, "creator", { required: true }) as string,
      declaration: option(args, "declaration", { required: true }) as string,
      ...(option(args, "evidence") ? { evidence: option(args, "evidence") } : {}),
    };
  }
  if (basis === "public-domain") {
    return {
      basis: "public-domain",
      source: option(args, "source", { required: true }) as string,
      evidence: option(args, "evidence", { required: true }) as string,
      jurisdiction: option(args, "jurisdiction", { required: true }) as string,
      authorOrPublicationFacts: option(args, "author-or-publication-facts", {
        required: true,
      }) as string,
      legalBasis: option(args, "legal-basis", { required: true }) as string,
      verifiedAt: option(args, "verified-at", { required: true }) as string,
    };
  }
  throw new WorkflowError("USAGE", "--rights must be original or public-domain.");
}

function requireStage(value: string): WorkflowStage {
  if (!isWorkflowStage(value)) throw new WorkflowError("USAGE", `Unknown workflow stage: ${value}`);
  return value;
}

function requireGeneratableStage(
  stage: WorkflowStage,
): "concept" | "script" | "storyboard" {
  if (stage === "concept" || stage === "script" || stage === "storyboard") return stage;
  throw new WorkflowError(
    "GENERATOR_UNAVAILABLE",
    "The default generator supports concept, script, and storyboard only.",
  );
}

function writeResult(
  json: boolean,
  value: unknown,
  text: string,
  write: (text: string) => void,
): void {
  write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

function formatStatus(state: Awaited<ReturnType<WorkflowService["getState"]>>): string {
  const active = state.activeStage ? `\nactive stage: ${state.activeStage}` : "";
  const stage = state.activeStage ? state.stages[state.activeStage] : undefined;
  const revision = stage?.currentRevision ? `\nrevision: ${versionLabel(stage.currentRevision)}` : "";
  return `${state.taskId}\nstatus: ${state.status}${active}${revision}\nevents: ${state.eventsApplied}`;
}

function formatResume(result: Awaited<ReturnType<WorkflowService["resume"]>>): string {
  switch (result.action.type) {
    case "generate-stage":
      return `Generate the structured ${result.action.stage} draft, then request review.`;
    case "work":
      return `Resume ${result.action.stage}: create or import its next revision.`;
    case "review":
      return result.action.bundle
        ? `Bundle review required (${result.action.bundle.id}): ${result.action.bundle.stages.join(", ")}; checkpoint ${result.action.stage}/${versionLabel(result.action.revision)}.`
        : `Review required: ${result.action.stage}/${versionLabel(result.action.revision)}.`;
    case "revise":
    case "regenerate":
      return `${result.action.type} ${result.action.stage} after ${versionLabel(result.action.previousRevision)}.`;
    case "select-providers":
      return `Provider selection required: ${result.action.missing.join(", ")}.`;
    case "replace-stale":
      return `Replace stale ${result.action.stage}; invalidated by ${result.action.target.kind}.`;
    case "resume-provider-job":
      return `Resume provider attempt ${result.action.attemptId} for ${result.action.stage}.`;
    case "poll-provider-job":
      return `Poll provider attempt ${result.action.attemptId} for ${result.action.stage}.`;
    case "cancel-provider-job":
      return `Cancel obsolete provider attempt ${result.action.attemptId} before continuing ${result.action.stage}.`;
    case "import-provider-output":
      return `Import ${result.action.files.length} archived provider output(s) from ${(result.action.attemptIds ?? [result.action.attemptId]).join(", ")} into ${result.action.stage}.`;
    case "export":
      return "All stages are approved; export is available.";
    case "stopped":
      return `Task stopped: ${result.action.reason}.`;
  }
}

function formatDoctor(report: Awaited<ReturnType<DoctorRunner["run"]>>): string {
  return report.checks
    .map((check) => `${check.ok ? "PASS" : "FAIL"}\t${check.name}\t${check.message}`)
    .join("\n");
}

function formatProviderEstimate(estimate: ProviderEstimate): string {
  const cost = estimate.price
    ? `${estimate.price.amount} ${estimate.price.currency}/${estimate.price.unit}`
    : "cost unavailable";
  const duration = estimate.estimatedSeconds === undefined
    ? "duration unavailable"
    : `${estimate.estimatedSeconds}s estimated`;
  return `${cost}; ${duration}`;
}

const HELP = `AI cartoon workflow

Usage:
  cartoon start --ip <name> --theme <theme> [--review-mode strict|quick] [--root <path>] [--json]
  cartoon status <task-id> [--json]
  cartoon resume <task-id> [--json]
  cartoon generate <task-id> [--stage concept|script|storyboard] [--metadata @metadata.json] [--json]
  cartoon review <task-id> --stage <stage> [--revision vNNN] --decision <decision> [--feedback <text>] [--targets <ids>]
  cartoon providers list [--json]
  cartoon providers check [--provider <id>] [--json]
  cartoon providers select <task-id> [--provider <id> --mode api|mcp|manual] [--binding <capability=provider:mode>]
  cartoon providers estimate <task-id> --provider <id> --request @request.json [--json]
  cartoon providers submit <task-id> --provider <id> --stage <stage> --request @request.json --confirmation @confirmation.json [--json]
  cartoon providers complete-manual <task-id> --attempt <attempt-id> --result @result.json [--json]
  cartoon providers import-output <task-id> --attempt <attempt-id> [--attempt <attempt-id> ...] --contract @stage-contract.json --metadata @metadata.json [--json]
  cartoon providers resume-job <task-id> --attempt <attempt-id> --request @request.json [--json]
  cartoon providers poll|cancel <task-id> --attempt <attempt-id> [--json]
  cartoon providers jobs <task-id> [--json]
  cartoon import <task-id> --stage <stage> --file <path> [--file <path>] --contract @stage-contract.json [--metadata @metadata.json]
    public-domain shortcut: --rights public-domain --source <source> --evidence <proof> --jurisdiction <place> --author-or-publication-facts <facts> --legal-basis <basis> --verified-at <ISO-time>
  cartoon export <task-id> [--output <path>] [--json]
  cartoon doctor [--json]

Paid-submit confirmation JSON must declare either pricingStatus=known with the exact
estimatedCost, or pricingStatus=unknown with unknownPricingAcknowledged=true and no estimatedCost.
Review modes: strict (all 9 gates) or quick (explicit bundle gates at G3/G5/G9).
Review decisions: approve, revise, regenerate, abort.`;

const invokedAsScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  process.exitCode = await runCli(process.argv.slice(2));
}
