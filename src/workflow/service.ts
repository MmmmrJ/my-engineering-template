import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  extname,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  ArtifactRecord,
  CreateTaskInput,
  CreateTaskResult,
  ExportResult,
  ImportArtifactInput,
  ImportArtifactResult,
  ListArtifactsFilter,
  NewWorkflowEvent,
  ProviderCapability,
  ProviderFacade,
  ResumeResult,
  ReviewRevisionInput,
  SelectProviderInput,
  TaskCreatedEvent,
  TaskState,
  StageState,
  WorkflowEvent,
  WorkflowStage,
} from "../contracts/index.js";
import {
  PROVIDER_CAPABILITIES,
  REQUIRED_PROVIDER_CAPABILITIES,
  STAGE_DIRECTORIES,
  WORKFLOW_STAGES,
  dependentStages,
  isProviderCapability,
  stageIndex,
} from "../contracts/stages.js";
import {
  validateFinalDelivery,
  type FinalDeliveryValidationInput,
  type FinalDeliveryValidationResult,
} from "../media/index.js";
import { WorkflowError, invariant } from "./errors.js";
import { approvedArtifacts, missingProviders } from "./reducer.js";
import { validateConceptRights, validateRightsRecord } from "./rights.js";
import { FileEventStore, TASK_FILES, pathExists, projectManifest } from "./store.js";
import {
  type Clock,
  type IdGenerator,
  assertNoResolvedCredentials,
  cleanText,
  randomId,
  safeFileName,
  sha256File,
  sha256Text,
  sanitizeProvenanceUri,
  stableJson,
  systemClock,
  versionLabel,
} from "./util.js";

export interface WorkflowServiceOptions {
  defaultRoot?: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  providerFacade?: ProviderFacade;
  deliveryValidator?: (
    input: FinalDeliveryValidationInput,
  ) => Promise<FinalDeliveryValidationResult>;
}

export class WorkflowService {
  readonly defaultRoot: string;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly providerFacade?: ProviderFacade;
  private readonly deliveryValidator: (
    input: FinalDeliveryValidationInput,
  ) => Promise<FinalDeliveryValidationResult>;

  constructor(options: WorkflowServiceOptions = {}) {
    this.defaultRoot = resolve(
      options.defaultRoot ?? process.env.AI_CARTOON_OUTPUT_ROOT ?? join(process.cwd(), "output"),
    );
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? randomId;
    this.providerFacade = options.providerFacade;
    this.deliveryValidator = options.deliveryValidator ?? validateFinalDelivery;
  }

  async createTask(input: CreateTaskInput, root = this.defaultRoot): Promise<CreateTaskResult> {
    const normalizedInput = {
      ip: cleanText(input.ip, "ip"),
      theme: cleanText(input.theme, "theme"),
    };
    const createdAt = this.now();
    const taskId = makeTaskId(new Date(createdAt), normalizedInput.ip, this.idGenerator("task"));
    const taskDirectory = resolve(root, taskId);
    const event: TaskCreatedEvent = {
      type: "task.created",
      eventId: safeIdentifier(this.idGenerator("event")),
      at: createdAt,
      taskId,
      input: normalizedInput,
    };
    const state = await new FileEventStore(taskDirectory).initialize(event);
    return { taskDirectory, manifest: projectManifest(event), state };
  }

  async getState(task: string): Promise<TaskState> {
    return new FileEventStore(this.resolveTaskDirectory(task)).getState();
  }

  async resume(task: string): Promise<ResumeResult> {
    const state = await this.getState(task);
    if (state.status === "cancelled" || state.status === "failed") {
      return {
        taskId: state.taskId,
        status: state.status,
        action: { type: "stopped", reason: state.status },
      };
    }
    if (state.status === "completed") {
      return { taskId: state.taskId, status: state.status, action: { type: "export" } };
    }

    const activeStage = state.activeStage;
    invariant(activeStage, "An unfinished task must have an active stage.");
    const stage = state.stages[activeStage];
    if (stage.status === "blocked") {
      return {
        taskId: state.taskId,
        status: state.status,
        action: { type: "select-providers", missing: missingProviders(state) },
      };
    }
    if (stage.status === "awaiting_review") {
      invariant(stage.currentRevision, "An awaiting-review stage must have a revision.");
      return {
        taskId: state.taskId,
        status: state.status,
        action: { type: "review", stage: activeStage, revision: stage.currentRevision },
      };
    }
    if (stage.status === "revision_requested") {
      invariant(stage.currentRevision && stage.requestedChange, "Revision request metadata is missing.");
      return {
        taskId: state.taskId,
        status: state.status,
        action: {
          type: stage.requestedChange,
          stage: activeStage,
          previousRevision: stage.currentRevision,
        },
      };
    }
    if (stage.status === "stale") {
      invariant(stage.stale, "A stale stage must identify the invalidating target.");
      return {
        taskId: state.taskId,
        status: state.status,
        action: { type: "replace-stale", stage: activeStage, target: stage.stale },
      };
    }
    return {
      taskId: state.taskId,
      status: state.status,
      action: { type: "work", stage: activeStage },
    };
  }

  async importArtifact(task: string, input: ImportArtifactInput): Promise<ImportArtifactResult> {
    const taskDirectory = this.resolveTaskDirectory(task);
    assertNoResolvedCredentials(input.metadata, "artifact metadata");
    if (input.sourceFiles.length === 0) {
      throw new WorkflowError("INVALID_INPUT", "At least one source file is required.");
    }
    const sourceFiles = input.sourceFiles.map((path) => resolve(cleanText(path, "sourceFiles")));
    const defaultTargetIds = normalizeIds(input.targetIds, "targetIds");
    const defaultDependsOnIds = normalizeIds(input.dependsOnIds, "dependsOnIds");
    const fileScopes = normalizeFileScopes(input.fileScopes);
    const voiceCloneMarked =
      input.metadata?.voiceClone === true || input.metadata?.voice_clone === true;
    if (voiceCloneMarked && !input.voiceCloneConsent) {
      throw new WorkflowError(
        "INVALID_INPUT",
        "Voice-clone artifacts require a complete, separate consent record.",
      );
    }
    if (input.voiceCloneConsent) {
      if (!voiceCloneMarked || input.stage !== "audio") {
        throw new WorkflowError(
          "INVALID_INPUT",
          "Voice-clone consent may only accompany an audio artifact marked metadata.voiceClone=true.",
        );
      }
      cleanText(input.voiceCloneConsent.subject, "voiceCloneConsent.subject");
      cleanText(input.voiceCloneConsent.evidence, "voiceCloneConsent.evidence");
      cleanText(input.voiceCloneConsent.scope, "voiceCloneConsent.scope");
      cleanText(input.voiceCloneConsent.confirmation, "voiceCloneConsent.confirmation");
      if (input.voiceCloneConsent.reviewEventId !== undefined) {
        cleanText(input.voiceCloneConsent.reviewEventId, "voiceCloneConsent.reviewEventId");
      }
      const grantedAt = Date.parse(input.voiceCloneConsent.grantedAt);
      const confirmedAt = Date.parse(input.voiceCloneConsent.userConfirmedAt);
      if (Number.isNaN(grantedAt) || Number.isNaN(confirmedAt) || confirmedAt < grantedAt) {
        throw new WorkflowError(
          "INVALID_INPUT",
          "Voice-clone consent needs valid authorization and user-confirmation timestamps.",
        );
      }
    }
    if (input.aiLabel) {
      cleanText(input.aiLabel.label, "aiLabel.label");
      cleanText(input.aiLabel.method, "aiLabel.method");
    }
    const rights =
      input.stage === "concept"
        ? validateConceptRights(input.rights)
        : input.rights
          ? validateRightsRecord(input.rights)
          : undefined;
    const store = new FileEventStore(taskDirectory);

    const transaction = await store.transact(async (state) => {
      assertCanImport(state, input.stage);
      if (input.voiceCloneConsent?.reviewEventId) {
        assertVoiceCloneReviewEventExists(state, input.voiceCloneConsent.reviewEventId);
      }
      if (stageIndex(input.stage) >= stageIndex("assets")) {
        const missing = missingProviders(state);
        if (missing.length > 0) {
          throw new WorkflowError(
            "PROVIDER_SELECTION_REQUIRED",
            `Select or manually confirm providers before importing ${input.stage}.`,
            { missing },
          );
        }
      }
      if (input.provider) {
        assertProviderMatchesBinding(state, input.provider.capability, input.provider.providerId);
      }

      const stage = state.stages[input.stage];
      const revision = stage.revisions.length + 1;
      if (revision > 999) {
        throw new WorkflowError("INVALID_TRANSITION", `${input.stage} has reached v999.`);
      }
      const revisionDirectory = join(
        taskDirectory,
        STAGE_DIRECTORIES[input.stage],
        versionLabel(revision),
      );
      await mkdir(revisionDirectory, { recursive: true });

      const importedAt = this.now();
      const artifacts: ArtifactRecord[] = [];
      for (const [index, sourceFile] of sourceFiles.entries()) {
        const sourceStat = await statFile(sourceFile);
        const fileName = `${String(index + 1).padStart(2, "0")}-${safeFileName(sourceFile)}`;
        const destination = join(revisionDirectory, fileName);
        const sourceHash = await sha256File(sourceFile);
        await copyImmutable(sourceFile, destination, sourceHash);
        const artifactId = safeIdentifier(this.idGenerator("artifact"));
        const relativePath = relative(taskDirectory, destination).split(sep).join("/");
        const provider = input.provider;
        const scope = fileScopes.get(sourceFile) ?? fileScopes.get(basename(sourceFile));
        const targetIds = scope?.targetIds ?? defaultTargetIds;
        const dependsOnIds = scope?.dependsOnIds ?? defaultDependsOnIds;
        artifacts.push({
          artifactId,
          stage: input.stage,
          revision,
          fileName,
          relativePath,
          mediaType: input.mediaType ?? inferMediaType(sourceFile),
          bytes: sourceStat.size,
          sha256: sourceHash,
          ...(provider?.providerId ? { providerId: provider.providerId } : {}),
          ...(provider?.model ? { model: provider.model } : {}),
          ...(provider?.jobId ? { jobId: provider.jobId } : {}),
          ...(provider?.promptHash ? { promptHash: provider.promptHash } : {}),
          ...(provider?.seed !== undefined ? { seed: provider.seed } : {}),
          ...(provider?.cost ? { cost: { ...provider.cost } } : {}),
          ...(rights ? { rights: structuredClone(rights) } : {}),
          provenance: {
            source: provider
              ? {
                  kind: "provider-output",
                  providerId: provider.providerId,
                  capability: provider.capability,
                  ...(provider.jobId ? { jobId: provider.jobId } : {}),
                  ...(provider.model ? { model: provider.model } : {}),
                  sourceUri: provider.sourceUri
                    ? sanitizeProvenanceUri(provider.sourceUri)
                    : sourceFile,
                }
              : { kind: "local-file", sourceUri: sourceFile },
            importedAt,
            ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
          },
          ...(input.aiLabel ? { aiLabel: structuredClone(input.aiLabel) } : {}),
          ...(input.voiceCloneConsent
            ? { voiceCloneConsent: structuredClone(input.voiceCloneConsent) }
            : {}),
          ...(targetIds?.length ? { targetIds } : {}),
          ...(dependsOnIds?.length ? { dependsOnIds } : {}),
        });
      }

      const replacementTargetIds = requestedTargetIds(stage);
      const previousRevision = stage.currentRevision
        ? stage.revisions[stage.currentRevision - 1]
        : undefined;
      if (previousRevision && replacementTargetIds?.length) {
        for (const previousArtifactId of previousRevision.artifactIds) {
          const previous = state.artifacts[previousArtifactId];
          invariant(previous, `Previous artifact ${previousArtifactId} is missing.`);
          if (isArtifactAffected(previous, replacementTargetIds)) continue;

          const previousPath = resolveTaskPath(taskDirectory, previous.relativePath);
          const fileName = `${String(artifacts.length + 1).padStart(2, "0")}-${safeFileName(
            previous.fileName.replace(/^\d+-/, ""),
          )}`;
          const destination = join(revisionDirectory, fileName);
          await copyImmutable(previousPath, destination, previous.sha256);
          const artifactId = safeIdentifier(this.idGenerator("artifact"));
          const carried = structuredClone(previous);
          carried.artifactId = artifactId;
          carried.revision = revision;
          carried.fileName = fileName;
          carried.relativePath = relative(taskDirectory, destination).split(sep).join("/");
          carried.derivedFromArtifactId = previous.artifactId;
          carried.provenance = {
            source: { kind: "local-file", sourceUri: previous.relativePath },
            importedAt,
            metadata: {
              ...(previous.provenance.metadata ?? {}),
              derivedFromArtifactId: previous.artifactId,
            },
          };
          delete carried.stale;
          artifacts.push(carried);
        }
      }

      const events: WorkflowEvent[] = artifacts.map((artifact) =>
        this.event({ type: "artifact.imported", artifact }),
      );
      events.push(
        this.event({
          type: "revision.created",
          stage: input.stage,
          revision,
          artifactIds: artifacts.map((artifact) => artifact.artifactId),
          ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
          ...(replacementTargetIds?.length
            ? { targetIds: replacementTargetIds }
            : defaultTargetIds?.length
              ? { targetIds: defaultTargetIds }
              : {}),
        }),
      );
      return { events, result: { revision, artifacts } };
    });

    return {
      state: transaction.state,
      revision: transaction.result.revision,
      artifacts: transaction.result.artifacts,
    };
  }

  async review(task: string, input: ReviewRevisionInput): Promise<TaskState> {
    const taskDirectory = this.resolveTaskDirectory(task);
    const feedback = input.feedback?.trim();
    if (input.decision !== "approve" && !feedback) {
      throw new WorkflowError("INVALID_INPUT", `${input.decision} requires review feedback.`);
    }
    const targetIds = input.targetIds?.map((id) => cleanText(id, "targetIds"));
    const store = new FileEventStore(taskDirectory);
    const transaction = await store.transact((state) => {
      const stage = state.stages[input.target.stage];
      const revision = stage.revisions[input.target.revision - 1];
      if (!revision) {
        throw new WorkflowError("INVALID_TRANSITION", "Review target does not exist.");
      }
      if (input.target.stage === "concept") {
        for (const artifactId of revision.artifactIds) {
          validateConceptRights(state.artifacts[artifactId]?.rights);
        }
      }

      const normalizedTargets = targetIds?.length ? [...new Set(targetIds)] : undefined;
      let decisionEvent: WorkflowEvent;
      if (
        stage.status === "approved" &&
        stage.approvedRevision === input.target.revision &&
        (input.decision === "revise" || input.decision === "regenerate")
      ) {
        invariant(feedback, "A revision request requires feedback.");
        decisionEvent = this.event({
          type: "revision.requested",
          target: { ...input.target },
          decision: input.decision,
          feedback,
          ...(normalizedTargets ? { targetIds: normalizedTargets } : {}),
        });
      } else {
        if (stage.currentRevision !== input.target.revision) {
          throw new WorkflowError("INVALID_TRANSITION", "Review target is not the current revision.");
        }
        if (stage.status !== "awaiting_review" || revision.review) {
          throw new WorkflowError("REVIEW_REQUIRED", "The target is not awaiting an explicit review.");
        }
        decisionEvent = this.event({
          type: "review.recorded",
          target: { ...input.target },
          decision: input.decision,
          ...(feedback ? { feedback } : {}),
          ...(normalizedTargets ? { targetIds: normalizedTargets } : {}),
        });
      }

      const events: WorkflowEvent[] = [decisionEvent];
      if (input.decision === "approve" || decisionEvent.type === "revision.requested") {
        const invalidationTargets = normalizedTargets ?? revision.targetIds;
        for (const downstream of dependentStages(input.target.stage)) {
          if (state.stages[downstream].revisions.length === 0) continue;
          events.push(
            this.event({
              type: "stage.invalidated",
              stage: downstream,
              target: {
                kind: "revision",
                eventId: decisionEvent.eventId,
                stage: input.target.stage,
                revision: input.target.revision,
                ...(invalidationTargets?.length ? { targetIds: invalidationTargets } : {}),
              },
            }),
          );
        }
      }
      return { events, result: undefined };
    });
    return transaction.state;
  }

  async selectProvider(task: string, input: SelectProviderInput): Promise<TaskState> {
    return this.selectProviders(task, [input]);
  }

  async selectProviders(
    task: string,
    inputs: readonly SelectProviderInput[],
  ): Promise<TaskState> {
    if (inputs.length === 0) {
      throw new WorkflowError("INVALID_INPUT", "At least one provider binding is required.");
    }
    const seen = new Set<ProviderCapability>();
    const selections: SelectProviderInput[] = [];
    for (const input of inputs) {
      assertNoResolvedCredentials(input.metadata, "provider binding metadata");
      if (!isProviderCapability(input.capability)) {
        throw new WorkflowError(
          "INVALID_INPUT",
          `Unknown provider capability: ${String(input.capability)}`,
        );
      }
      if (seen.has(input.capability)) {
        throw new WorkflowError("INVALID_INPUT", `Duplicate binding for ${input.capability}.`);
      }
      seen.add(input.capability);
      cleanText(input.providerId, "providerId");
      const mode = input.mode ?? "api";
      if (mode !== "api" && mode !== "mcp" && mode !== "manual") {
        throw new WorkflowError("INVALID_INPUT", `Unknown provider binding mode: ${String(mode)}`);
      }
      if (mode === "api") {
        const snapshot = await this.validateProvider(input.capability, input.providerId);
        selections.push({
          ...input,
          mode,
          metadata: {
            ...(input.metadata ?? {}),
            ...(snapshot.descriptor.metadata ?? {}),
            providerName: snapshot.descriptor.name ?? snapshot.descriptor.id,
            configured: snapshot.descriptor.configured ?? true,
            checkedAt: snapshot.health.metadata?.checkedAt ?? this.now(),
            health: snapshot.health.ok ? "healthy" : "unavailable",
          },
        });
      } else if (mode === "mcp") {
        assertMcpBindingEvidence(input);
        selections.push({ ...input, mode });
      } else {
        selections.push({ ...input, mode });
      }
    }

    const store = new FileEventStore(this.resolveTaskDirectory(task));
    const transaction = await store.transact((state) => {
      if (state.stages.storyboard.status !== "approved") {
        throw new WorkflowError(
          "INVALID_TRANSITION",
          "Provider bindings may only be frozen after storyboard approval.",
        );
      }
      const events: WorkflowEvent[] = [];
      for (const input of selections) {
        if (state.providers[input.capability]) {
          throw new WorkflowError(
            "INVALID_TRANSITION",
            `Provider binding for ${input.capability} is already frozen.`,
          );
        }
        events.push(
          this.event({
            type: "provider.selected",
            capability: input.capability,
            providerId: input.providerId.trim(),
            mode: input.mode ?? "api",
            ...(input.model?.trim() ? { model: input.model.trim() } : {}),
            ...(input.profile?.trim() ? { profile: input.profile.trim() } : {}),
            ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
          }),
        );
      }
      return { events, result: undefined };
    });
    return transaction.state;
  }

  async listArtifacts(
    task: string,
    filter: ListArtifactsFilter = {},
  ): Promise<readonly ArtifactRecord[]> {
    const state = await this.getState(task);
    return Object.values(state.artifacts)
      .filter((artifact) => !filter.stage || artifact.stage === filter.stage)
      .filter((artifact) => filter.includeStale || !artifact.stale)
      .sort((left, right) => {
        return (
          stageIndex(left.stage) - stageIndex(right.stage) ||
          left.revision - right.revision ||
          left.fileName.localeCompare(right.fileName)
        );
      });
  }

  async export(task: string, output?: string): Promise<ExportResult> {
    const taskDirectory = this.resolveTaskDirectory(task);
    const store = new FileEventStore(taskDirectory);
    const transaction = await store.transact(async (state) => {
      assertExportable(state);
      const delivery = selectFinalDelivery(state);
      let deliveryValidation: FinalDeliveryValidationResult;
      try {
        deliveryValidation = await this.deliveryValidator({
          videoPath: resolveTaskPath(taskDirectory, delivery.video.relativePath),
          srtPath: resolveTaskPath(taskDirectory, delivery.srt.relativePath),
          assPath: resolveTaskPath(taskDirectory, delivery.ass.relativePath),
          qcReportPath: resolveTaskPath(taskDirectory, delivery.qcReport.relativePath),
          aiLabel: {
            visible: delivery.video.aiLabel?.visibleLabel === true,
            evidence:
              delivery.video.aiLabel?.disclosure ?? delivery.video.aiLabel?.method ?? "",
          },
        });
      } catch (error) {
        throw new WorkflowError(
          "EXPORT_NOT_READY",
          `Final delivery inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!deliveryValidation.ok) {
        throw new WorkflowError(
          "EXPORT_NOT_READY",
          "Final delivery media or QC validation failed.",
          { checks: deliveryValidation.checks },
        );
      }
      const exportRevision = state.exports.length + 1;
      if (exportRevision > 999) {
        throw new WorkflowError("INVALID_TRANSITION", "Final export has reached v999.");
      }
      const outputDirectory = resolve(
        output ?? join(taskDirectory, TASK_FILES.final, versionLabel(exportRevision)),
      );
      const files = approvedArtifacts(state);
      const deliveryNames = new Map<string, string>([
        [delivery.video.artifactId, "episode.mp4"],
        [delivery.srt.artifactId, "subtitles.srt"],
        [delivery.ass.artifactId, "subtitles.ass"],
        [delivery.qcReport.artifactId, "qc-report.json"],
      ]);
      const expectedFiles = files.map((artifact) => ({
        artifact,
        exportPath:
          deliveryNames.get(artifact.artifactId) ??
          join(artifact.stage, versionLabel(artifact.revision), artifact.fileName),
      }));

      if (await pathExists(outputDirectory)) {
        const adopted = await adoptCompletedExport(
          outputDirectory,
          state,
          expectedFiles,
          deliveryValidation,
        );
        const event = this.event({
          type: "task.exported",
          exportId: adopted.exportId,
          outputPath: outputDirectory,
          manifestSha256: adopted.manifestSha256,
        });
        return {
          events: [event],
          result: {
            exportId: adopted.exportId,
            outputDirectory,
            manifestPath: adopted.manifestPath,
            manifestSha256: adopted.manifestSha256,
            files,
          } satisfies ExportResult,
        };
      }

      const exportId = safeIdentifier(this.idGenerator("export"));
      const stagingDirectory = `${outputDirectory}.staging-${exportId}`;
      if (await pathExists(stagingDirectory)) {
        throw new WorkflowError(
          "EXPORT_EXISTS",
          `Export staging destination already exists: ${stagingDirectory}`,
        );
      }
      await mkdir(dirname(outputDirectory), { recursive: true });
      await mkdir(stagingDirectory, { recursive: false });

      const exportedFiles: Array<{ artifact: ArtifactRecord; exportPath: string }> = [];
      let manifestSha256: string;
      const manifestPath = join(outputDirectory, "manifest.json");
      try {
        for (const { artifact, exportPath } of expectedFiles) {
          const source = resolveTaskPath(taskDirectory, artifact.relativePath);
          const actualHash = await sha256File(source);
          invariant(actualHash === artifact.sha256, `Artifact hash mismatch: ${artifact.artifactId}.`);
          const destination = join(stagingDirectory, exportPath);
          await mkdir(resolve(destination, ".."), { recursive: true });
          await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
          invariant((await sha256File(destination)) === artifact.sha256, "Export copy hash mismatch.");
          exportedFiles.push({
            artifact: structuredClone(artifact),
            exportPath: exportPath.split(sep).join("/"),
          });
        }

        const exportedAt = this.now();
        const exportManifest = {
          schemaVersion: 1,
          exportId,
          taskId: state.taskId,
          input: state.input,
          exportedAt,
          approvedRevisions: approvedRevisionMap(state),
          providerBindings: REQUIRED_PROVIDER_CAPABILITIES.map((capability) => state.providers[capability]),
          reviewHistory: Object.fromEntries(
            WORKFLOW_STAGES.map((stage) => [
              stage,
              state.stages[stage].revisions.map((revision) => ({
                version: revision.version,
                ...(revision.review ? { review: revision.review } : {}),
                ...(revision.changeRequests ? { changeRequests: revision.changeRequests } : {}),
                ...(revision.stale ? { stale: revision.stale } : {}),
              })),
            ]),
          ),
          deliveryValidation: deliveryValidation.report,
          files: exportedFiles,
        };
        const manifestContent = stableJson(exportManifest);
        await writeFile(join(stagingDirectory, "manifest.json"), manifestContent, {
          encoding: "utf8",
          flag: "wx",
        });
        manifestSha256 = sha256Text(manifestContent);
        await rename(stagingDirectory, outputDirectory);
      } catch (error) {
        if (await pathExists(stagingDirectory)) {
          await rm(stagingDirectory, { recursive: true, force: true });
        }
        throw error;
      }
      const event = this.event({
        type: "task.exported",
        exportId,
        outputPath: outputDirectory,
        manifestSha256,
      });
      return {
        events: [event],
        result: {
          exportId,
          outputDirectory,
          manifestPath,
          manifestSha256,
          files,
        } satisfies ExportResult,
      };
    });
    return transaction.result;
  }

  resolveTaskDirectory(task: string): string {
    const value = cleanText(task, "task");
    if (isAbsolute(value)) {
      return resolve(value);
    }
    const candidate = resolve(this.defaultRoot, value);
    const rel = relative(this.defaultRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new WorkflowError("INVALID_INPUT", `Relative task path escapes output root: ${value}`);
    }
    return candidate;
  }

  private event(payload: NewWorkflowEvent): WorkflowEvent {
    return {
      ...payload,
      eventId: safeIdentifier(this.idGenerator("event")),
      at: this.now(),
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async validateProvider(
    capability: ProviderCapability,
    providerId: string,
  ): Promise<{
    descriptor: Awaited<ReturnType<ProviderFacade["list"]>>[number];
    health: Awaited<ReturnType<ProviderFacade["check"]>>[number];
  }> {
    if (!this.providerFacade) {
      throw new WorkflowError(
        "PROVIDER_UNAVAILABLE",
        "No provider facade is configured. Use a manual binding or inject a provider facade.",
      );
    }
    const descriptor = (await this.providerFacade.list()).find((provider) => provider.id === providerId);
    if (!descriptor || !descriptor.capabilities.includes(capability)) {
      throw new WorkflowError(
        "PROVIDER_UNAVAILABLE",
        `${providerId} does not expose ${capability}.`,
      );
    }
    const health = await this.providerFacade.check(providerId);
    const selected = health.find((item) => item.providerId === providerId);
    if (!selected?.ok) {
      throw new WorkflowError(
        "PROVIDER_UNAVAILABLE",
        selected?.message ?? `${providerId} failed its provider check.`,
      );
    }
    return { descriptor, health: selected };
  }
}

function assertCanImport(state: TaskState, stage: WorkflowStage): void {
  if (state.status === "cancelled" || state.status === "failed") {
    throw new WorkflowError("INVALID_TRANSITION", `Cannot import into a ${state.status} task.`);
  }
  const target = state.stages[stage];
  if (target.status === "awaiting_review") {
    throw new WorkflowError("REVIEW_REQUIRED", `${stage} already has a revision awaiting review.`);
  }
  if (target.status === "blocked") {
    throw new WorkflowError("PROVIDER_SELECTION_REQUIRED", `${stage} is blocked by provider selection.`);
  }
  if (target.status === "cancelled" || target.status === "failed") {
    throw new WorkflowError("INVALID_TRANSITION", `Cannot import into ${stage} while it is ${target.status}.`);
  }

  const index = stageIndex(stage);
  if (index > 0) {
    const prerequisiteName = WORKFLOW_STAGES[index - 1];
    invariant(prerequisiteName, `No prerequisite found for ${stage}.`);
    if (state.stages[prerequisiteName].status !== "approved") {
      throw new WorkflowError(
        "INVALID_TRANSITION",
        `${prerequisiteName} must be approved before importing ${stage}.`,
      );
    }
  }

  if (target.status === "approved") {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `Reopen approved ${stage} with a revise or regenerate review decision before importing.`,
    );
  }
  const isCurrent = state.activeStage === stage;
  if (!isCurrent && target.status !== "revision_requested" && target.status !== "stale") {
    throw new WorkflowError("INVALID_TRANSITION", `${stage} is not the current actionable stage.`);
  }
}

function normalizeIds(
  values: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) {
    throw new WorkflowError("INVALID_INPUT", `${field} must be an array of stable IDs.`);
  }
  const entries = values as readonly unknown[];
  const normalized = entries.map((value) => {
    if (typeof value !== "string") {
      throw new WorkflowError("INVALID_INPUT", `${field} must contain only stable string IDs.`);
    }
    return cleanText(value, field);
  });
  return [...new Set(normalized)];
}

function normalizeFileScopes(
  scopes: ImportArtifactInput["fileScopes"],
): ReadonlyMap<string, { targetIds?: readonly string[]; dependsOnIds?: readonly string[] }> {
  const normalized = new Map<
    string,
    { targetIds?: readonly string[]; dependsOnIds?: readonly string[] }
  >();
  if (scopes === undefined) return normalized;
  if (scopes === null || typeof scopes !== "object" || Array.isArray(scopes)) {
    throw new WorkflowError("INVALID_INPUT", "fileScopes must be an object keyed by source file.");
  }
  for (const [file, scope] of Object.entries(scopes)) {
    const key = cleanText(file, "fileScopes key");
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
      throw new WorkflowError("INVALID_INPUT", `fileScopes.${key} must be an object.`);
    }
    const targetIds = normalizeIds(scope.targetIds, `fileScopes.${key}.targetIds`);
    const dependsOnIds = normalizeIds(scope.dependsOnIds, `fileScopes.${key}.dependsOnIds`);
    normalized.set(key, {
      ...(targetIds?.length ? { targetIds } : {}),
      ...(dependsOnIds?.length ? { dependsOnIds } : {}),
    });
  }
  return normalized;
}

function requestedTargetIds(stage: StageState): readonly string[] | undefined {
  if (stage.stale?.kind === "revision" && stage.stale.targetIds?.length) {
    return stage.stale.targetIds;
  }
  const current = stage.currentRevision ? stage.revisions[stage.currentRevision - 1] : undefined;
  const changeRequest = current?.changeRequests?.at(-1);
  if (changeRequest?.targetIds?.length) return changeRequest.targetIds;
  if (
    current?.review &&
    current.review.decision !== "approve" &&
    current.review.decision !== "abort" &&
    current.review.targetIds?.length
  ) {
    return current.review.targetIds;
  }
  return undefined;
}

function isArtifactAffected(
  artifact: ArtifactRecord,
  targetIds: readonly string[],
): boolean {
  const scope = [...(artifact.targetIds ?? []), ...(artifact.dependsOnIds ?? [])];
  if (scope.length === 0) return true;
  const changed = new Set(targetIds);
  return scope.some((id) => changed.has(id));
}

function assertProviderMatchesBinding(
  state: TaskState,
  capability: ProviderCapability,
  providerId: string,
): void {
  const binding = state.providers[capability];
  if (!binding) {
    throw new WorkflowError("PROVIDER_SELECTION_REQUIRED", `No frozen binding for ${capability}.`);
  }
  if (binding.mode !== "manual" && binding.providerId !== providerId) {
    throw new WorkflowError(
      "INVALID_TRANSITION",
      `Artifact provider ${providerId} does not match frozen binding ${binding.providerId}.`,
    );
  }
}

interface ExpectedExportFile {
  readonly artifact: ArtifactRecord;
  readonly exportPath: string;
}

interface AdoptedExport {
  readonly exportId: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
}

function approvedRevisionMap(state: TaskState): Readonly<Record<string, string>> {
  return Object.fromEntries(
    WORKFLOW_STAGES.map((stage) => {
      const approvedRevision = state.stages[stage].approvedRevision;
      invariant(approvedRevision, `${stage} is missing its approved revision.`);
      return [stage, versionLabel(approvedRevision)];
    }),
  );
}

/**
 * Recover the narrow crash window after an atomic directory rename but before
 * `task.exported` reaches the event log. Existing user directories are never
 * overwritten: adoption succeeds only for an exact, hash-verified export of
 * the currently approved revisions.
 */
async function adoptCompletedExport(
  outputDirectory: string,
  state: TaskState,
  expectedFiles: readonly ExpectedExportFile[],
  deliveryValidation: FinalDeliveryValidationResult,
): Promise<AdoptedExport> {
  const manifestPath = join(outputDirectory, "manifest.json");
  let content: string;
  let manifest: Record<string, unknown>;
  try {
    content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("manifest is not an object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw new WorkflowError(
      "EXPORT_EXISTS",
      `Export destination exists but has no adoptable manifest: ${outputDirectory}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const fail = (reason: string): never => {
    throw new WorkflowError(
      "EXPORT_EXISTS",
      `Export destination exists but cannot be adopted: ${reason}.`,
      { outputDirectory },
    );
  };
  if (manifest.schemaVersion !== 1 || manifest.taskId !== state.taskId) {
    fail("manifest task identity does not match");
  }
  if (stableJson(manifest.approvedRevisions) !== stableJson(approvedRevisionMap(state))) {
    fail("approved revisions do not match");
  }
  const exportIdValue = manifest.exportId;
  if (typeof exportIdValue !== "string") {
    return fail("export identifier is invalid");
  }
  const exportId = exportIdValue;
  if (safeIdentifier(exportId) !== exportId) {
    fail("export identifier is invalid");
  }

  const report = manifest.deliveryValidation;
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    fail("delivery validation report is missing");
  }
  const deliveryReport = report as Record<string, unknown>;
  const subtitleHashes = deliveryReport.subtitleSha256;
  const currentSubtitles = deliveryValidation.report.subtitleSha256;
  if (
    deliveryReport.status !== "passed" ||
    deliveryReport.mediaSha256 !== deliveryValidation.mediaSha256 ||
    subtitleHashes === null ||
    typeof subtitleHashes !== "object" ||
    Array.isArray(subtitleHashes) ||
    (subtitleHashes as Record<string, unknown>).srt !== currentSubtitles.srt ||
    (subtitleHashes as Record<string, unknown>).ass !== currentSubtitles.ass
  ) {
    fail("delivery validation hashes do not match current approved media");
  }

  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedFiles.length) {
    fail("artifact inventory does not match");
  }
  const manifestFiles = manifest.files as unknown[];
  for (const { artifact, exportPath } of expectedFiles) {
    const normalizedPath = exportPath.split(sep).join("/");
    const matched = manifestFiles.find((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      const recordedArtifact = record.artifact;
      return (
        record.exportPath === normalizedPath &&
        recordedArtifact !== null &&
        typeof recordedArtifact === "object" &&
        !Array.isArray(recordedArtifact) &&
        (recordedArtifact as Record<string, unknown>).artifactId === artifact.artifactId &&
        (recordedArtifact as Record<string, unknown>).sha256 === artifact.sha256
      );
    });
    if (!matched) fail(`artifact ${artifact.artifactId} is not represented exactly`);
    const destination = join(outputDirectory, exportPath);
    try {
      if ((await sha256File(destination)) !== artifact.sha256) {
        fail(`artifact ${artifact.artifactId} hash differs`);
      }
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      fail(`artifact ${artifact.artifactId} is missing or unreadable`);
    }
  }

  return {
    exportId,
    manifestPath,
    manifestSha256: sha256Text(content),
  };
}

function assertExportable(state: TaskState): void {
  if (state.status !== "completed") {
    throw new WorkflowError("EXPORT_NOT_READY", `Task status is ${state.status}; all stages need approval.`);
  }
  for (const stageName of WORKFLOW_STAGES) {
    const stage = state.stages[stageName];
    if (stage.status !== "approved" || !stage.approvedRevision || stage.stale) {
      throw new WorkflowError("EXPORT_NOT_READY", `${stageName} is not cleanly approved.`);
    }
    const revision = stage.revisions[stage.approvedRevision - 1];
    if (!revision?.review || revision.review.decision !== "approve" || revision.stale) {
      throw new WorkflowError("EXPORT_NOT_READY", `${stageName} lacks an explicit, current approval.`);
    }
  }
  const missing = missingProviders(state);
  if (missing.length > 0) {
    throw new WorkflowError("EXPORT_NOT_READY", "Required provider bindings are incomplete.", { missing });
  }

  const concept = state.stages.concept;
  const conceptRevision = concept.approvedRevision
    ? concept.revisions[concept.approvedRevision - 1]
    : undefined;
  invariant(conceptRevision, "Approved concept revision is missing.");
  for (const artifactId of conceptRevision.artifactIds) {
    validateConceptRights(state.artifacts[artifactId]?.rights);
  }

  const validatedRights = new Set<string>();
  for (const stageName of ["assets", "keyframes", "clips", "audio", "edit"] as const) {
    const stage = state.stages[stageName];
    const revision = stage.approvedRevision
      ? stage.revisions[stage.approvedRevision - 1]
      : undefined;
    invariant(revision, `${stageName} approved revision is missing.`);
    for (const artifactId of revision.artifactIds) {
      validateArtifactRightsChain(state, artifactId, new Set(), validatedRights);
    }
  }

  for (const stageName of ["edit", "qc"] as const) {
    const stage = state.stages[stageName];
    const revision = stage.approvedRevision ? stage.revisions[stage.approvedRevision - 1] : undefined;
    invariant(revision, `${stageName} approval is missing.`);
    const hasLabelEvidence = revision.artifactIds.some((artifactId) => {
      const label = state.artifacts[artifactId]?.aiLabel;
      return Boolean(
        label?.aiGenerated &&
          label.label.trim() &&
          label.method.trim() &&
          label.visibleLabel &&
          label.metadataEmbedded &&
          label.provenanceIncluded,
      );
    });
    if (!hasLabelEvidence) {
      throw new WorkflowError(
        "EXPORT_NOT_READY",
        `${stageName} lacks visible AI labeling, embedded metadata, and provenance evidence.`,
      );
    }
  }
}

function assertVoiceCloneReviewEventExists(state: TaskState, reviewEventId: string): void {
  const exists = WORKFLOW_STAGES.some((stageName) =>
    state.stages[stageName].revisions.some(
      (revision) =>
        revision.review?.eventId === reviewEventId ||
        revision.changeRequests?.some((request) => request.eventId === reviewEventId),
    ),
  );
  if (!exists) {
    throw new WorkflowError(
      "INVALID_INPUT",
      `voiceCloneConsent.reviewEventId does not identify a review event in task ${state.taskId}.`,
    );
  }
}

function validateArtifactRightsChain(
  state: TaskState,
  artifactId: string,
  visiting: Set<string>,
  validated: Set<string>,
): void {
  if (validated.has(artifactId)) return;
  const artifact = state.artifacts[artifactId];
  if (!artifact) {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      `Rights lineage references missing artifact ${artifactId}.`,
    );
  }
  if (artifact.stale) {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      `Rights lineage source ${artifactId} is stale and cannot support export.`,
    );
  }
  if (visiting.has(artifactId)) {
    throw new WorkflowError(
      "RIGHTS_REQUIRED",
      `Rights lineage contains a circular workflow-derived chain at ${artifactId}.`,
    );
  }

  const rights = validateRightsRecord(artifact.rights);
  if (rights.basis === "workflow-derived") {
    if (rights.sourceArtifactIds.includes(artifactId)) {
      throw new WorkflowError(
        "RIGHTS_REQUIRED",
        `Workflow-derived artifact ${artifactId} cannot cite itself as a rights source.`,
      );
    }
    visiting.add(artifactId);
    for (const sourceArtifactId of rights.sourceArtifactIds) {
      validateArtifactRightsChain(state, sourceArtifactId, visiting, validated);
    }
    visiting.delete(artifactId);
  }
  validated.add(artifactId);
}

interface SelectedFinalDelivery {
  video: ArtifactRecord;
  srt: ArtifactRecord;
  ass: ArtifactRecord;
  qcReport: ArtifactRecord;
}

function selectFinalDelivery(state: TaskState): SelectedFinalDelivery {
  const edit = approvedStageArtifacts(state, "edit");
  const qc = approvedStageArtifacts(state, "qc");
  const video = exactlyOneArtifact(
    edit,
    (artifact) => artifact.mediaType === "video/mp4" && artifact.fileName.toLowerCase().endsWith(".mp4"),
    "approved edit MP4 master",
  );
  const srt = exactlyOneArtifact(
    edit,
    (artifact) => artifact.fileName.toLowerCase().endsWith(".srt"),
    "approved edit SRT sidecar",
  );
  const ass = exactlyOneArtifact(
    edit,
    (artifact) => artifact.fileName.toLowerCase().endsWith(".ass"),
    "approved edit ASS sidecar",
  );
  const qcReport = exactlyOneArtifact(
    qc,
    (artifact) =>
      artifact.mediaType === "application/json" && artifact.fileName.toLowerCase().endsWith(".json"),
    "approved QC JSON report",
  );
  assertCompleteAiLabel(video, "approved edit MP4 master");
  assertCompleteAiLabel(qcReport, "approved QC JSON report");
  return { video, srt, ass, qcReport };
}

function approvedStageArtifacts(state: TaskState, stageName: "edit" | "qc"): ArtifactRecord[] {
  const stage = state.stages[stageName];
  const revision = stage.approvedRevision
    ? stage.revisions[stage.approvedRevision - 1]
    : undefined;
  invariant(revision, `${stageName} approved revision is missing.`);
  return revision.artifactIds.map((artifactId) => {
    const artifact = state.artifacts[artifactId];
    invariant(artifact, `${stageName} artifact ${artifactId} is missing.`);
    return artifact;
  });
}

function exactlyOneArtifact(
  artifacts: readonly ArtifactRecord[],
  predicate: (artifact: ArtifactRecord) => boolean,
  label: string,
): ArtifactRecord {
  const matches = artifacts.filter(predicate);
  if (matches.length !== 1) {
    throw new WorkflowError(
      "EXPORT_NOT_READY",
      `Final delivery requires exactly one ${label}; found ${matches.length}.`,
    );
  }
  return matches[0] as ArtifactRecord;
}

function assertCompleteAiLabel(artifact: ArtifactRecord, label: string): void {
  const aiLabel = artifact.aiLabel;
  if (
    !aiLabel?.aiGenerated ||
    !aiLabel.label.trim() ||
    !aiLabel.method.trim() ||
    !aiLabel.visibleLabel ||
    !aiLabel.metadataEmbedded ||
    !aiLabel.provenanceIncluded
  ) {
    throw new WorkflowError(
      "EXPORT_NOT_READY",
      `${label} lacks complete visible, metadata, and provenance AI-label evidence.`,
    );
  }
}

async function statFile(path: string): Promise<{ size: number }> {
  try {
    const details = await stat(path);
    if (!details.isFile()) {
      throw new WorkflowError("ARTIFACT_NOT_FOUND", `Artifact source is not a file: ${path}`);
    }
    return { size: details.size };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new WorkflowError("ARTIFACT_NOT_FOUND", `Artifact source does not exist: ${path}`);
    }
    throw error;
  }
}

async function copyImmutable(source: string, destination: string, expectedHash: string): Promise<void> {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if ((await sha256File(destination)) !== expectedHash) {
      throw new WorkflowError("ARTIFACT_EXISTS", `Immutable artifact path already exists: ${destination}`);
    }
  }
  if ((await sha256File(destination)) !== expectedHash) {
    throw new WorkflowError("STATE_INVARIANT", `Copied artifact hash mismatch: ${destination}`);
  }
}

function safeIdentifier(value: string): string {
  const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!clean) throw new WorkflowError("INVALID_INPUT", "Generated identifier is empty or unsafe.");
  return clean.slice(0, 120);
}

function makeTaskId(createdAt: Date, ip: string, generated: string): string {
  const timestamp = [
    createdAt.getUTCFullYear().toString().padStart(4, "0"),
    (createdAt.getUTCMonth() + 1).toString().padStart(2, "0"),
    createdAt.getUTCDate().toString().padStart(2, "0"),
  ].join("") +
    "-" +
    [
      createdAt.getUTCHours().toString().padStart(2, "0"),
      createdAt.getUTCMinutes().toString().padStart(2, "0"),
      createdAt.getUTCSeconds().toString().padStart(2, "0"),
    ].join("");
  const ipSlug = ip
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
  const shortId = safeIdentifier(generated).replace(/^task[-_.]?/i, "").slice(-8) || "00000000";
  return `${timestamp}-${ipSlug}-${shortId}`;
}

function inferMediaType(path: string): string {
  const mediaTypes: Record<string, string> = {
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".srt": "application/x-subrip",
    ".ass": "text/x-ssa",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
  };
  return mediaTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function resolveTaskPath(taskDirectory: string, relativePath: string): string {
  const candidate = resolve(taskDirectory, relativePath);
  const rel = relative(taskDirectory, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkflowError("STATE_INVARIANT", `Artifact path escapes task root: ${relativePath}`);
  }
  return candidate;
}

export const REQUIRED_BINDINGS = REQUIRED_PROVIDER_CAPABILITIES;
export const ALL_PROVIDER_CAPABILITIES = PROVIDER_CAPABILITIES;

function assertMcpBindingEvidence(input: SelectProviderInput): void {
  const checkedAt = input.metadata?.checkedAt;
  const server = input.metadata?.server;
  const tool = input.metadata?.tool;
  const hasRoute =
    (typeof server === "string" && server.trim() && typeof tool === "string" && tool.trim()) ||
    Boolean(input.profile?.trim());
  if (typeof checkedAt !== "string" || !checkedAt.trim() || !hasRoute) {
    throw new WorkflowError(
      "INVALID_INPUT",
      "MCP bindings require metadata.checkedAt and either metadata.server/tool or --profile.",
    );
  }
  if (Number.isNaN(Date.parse(checkedAt))) {
    throw new WorkflowError("INVALID_INPUT", "MCP binding metadata.checkedAt must be an ISO timestamp.");
  }
}
