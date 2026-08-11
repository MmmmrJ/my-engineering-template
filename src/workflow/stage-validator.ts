import { basename, extname } from "node:path";

import { z } from "zod/v4";

import {
  stageContractSchema,
  type AssetsStageContract,
  type AudioStageContract,
  type ClipsStageContract,
  type EditStageContract,
  type KeyframesStageContract,
  type QcStageContract,
  type ScriptStageContract,
  type StageContract,
  type StoryboardStageContract,
  type TaskState,
  type WorkflowStage,
} from "../contracts/index.js";
import { WorkflowError } from "./errors.js";

export interface StageContractValidationInput {
  readonly stage: WorkflowStage;
  readonly contract: unknown;
  readonly state: TaskState;
  readonly sourceFiles: readonly string[];
}

export function validateStageContract(input: StageContractValidationInput): StageContract {
  const parsed = stageContractSchema.safeParse(input.contract);
  if (!parsed.success) {
    throw invalidContract(`Stage contract schema is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const contract = parsed.data;
  if (contract.stage !== input.stage) {
    throw invalidContract(
      `Stage contract declares ${contract.stage}, but the import targets ${input.stage}.`,
    );
  }
  const files = new Set(input.sourceFiles.map((path) => basename(path).toLowerCase()));

  switch (contract.stage) {
    case "concept":
      if (contract.ip !== input.state.input.ip || contract.theme !== input.state.input.theme) {
        throw invalidContract("Concept IP and theme must exactly match the task input.");
      }
      uniqueIds(contract.directions.map((direction) => direction.id), "concept direction");
      break;
    case "script":
      validateScript(contract, approvedContract(input.state, "concept"));
      break;
    case "storyboard":
      validateStoryboard(contract, approvedContract(input.state, "script"));
      break;
    case "assets":
      validateAssets(contract, approvedContract(input.state, "storyboard"), files);
      break;
    case "keyframes":
      validateKeyframes(
        contract,
        approvedContract(input.state, "storyboard"),
        approvedContract(input.state, "assets"),
        files,
      );
      break;
    case "clips":
      validateClips(contract, approvedContract(input.state, "storyboard"), files);
      break;
    case "audio":
      validateAudio(contract, approvedContract(input.state, "script"), files);
      break;
    case "edit":
      validateEdit(contract, files);
      break;
    case "qc":
      validateQc(contract, files);
      break;
  }
  return structuredClone(contract);
}

function validateScript(
  contract: ScriptStageContract,
  concept: StageContract,
): void {
  if (concept.stage !== "concept") throw invalidContract("Approved concept contract is invalid.");
  if (contract.totalDurationMs !== concept.format.durationSeconds * 1_000) {
    throw invalidContract("Script duration must match the approved concept duration.");
  }
  uniqueIds(contract.characters.map((character) => character.id), "character");
  uniqueIds(contract.scenes.map((scene) => scene.id), "scene");
  const characterIds = new Set(contract.characters.map((character) => character.id));
  let priorEnd = 0;
  for (const scene of contract.scenes) {
    if (scene.startMs !== priorEnd) {
      throw invalidContract(`Scene ${scene.id} must start exactly when the prior scene ends.`);
    }
    if (scene.endMs > contract.totalDurationMs) {
      throw invalidContract(`Scene ${scene.id} ends after the declared script duration.`);
    }
    for (const line of scene.dialogue) {
      if (!characterIds.has(line.characterId)) {
        throw invalidContract(`Scene ${scene.id} references unknown character ${line.characterId}.`);
      }
    }
    priorEnd = scene.endMs;
  }
  if (priorEnd !== contract.totalDurationMs) {
    throw invalidContract("The final scene must end at totalDurationMs.");
  }
  if (!contract.automaticReview.passed || contract.automaticReview.issues.length > 0) {
    throw invalidContract("Script automatic review must pass with no unresolved issues.");
  }
}

function validateStoryboard(
  contract: StoryboardStageContract,
  script: StageContract,
): void {
  if (script.stage !== "script") throw invalidContract("Approved script contract is invalid.");
  uniqueIds(contract.shots.map((shot) => shot.id), "shot");
  uniqueIds(contract.assetDefinitions.map((asset) => asset.id), "storyboard asset");
  const duration = contract.shots.reduce((total, shot) => total + shot.durationMs, 0);
  if (duration !== contract.totalDurationMs || duration !== script.totalDurationMs) {
    throw invalidContract("Storyboard shot durations must sum to the approved script duration.");
  }
  const assets = new Set(contract.assetDefinitions.map((asset) => asset.id));
  for (const shot of contract.shots) {
    for (const assetId of shot.assetIds) {
      if (!assets.has(assetId)) {
        throw invalidContract(`Shot ${shot.id} references undefined asset ${assetId}.`);
      }
    }
  }
}

function validateAssets(
  contract: AssetsStageContract,
  storyboard: StageContract,
  files: ReadonlySet<string>,
): void {
  if (storyboard.stage !== "storyboard") {
    throw invalidContract("Approved storyboard contract is invalid.");
  }
  uniqueIds(contract.assets.map((asset) => asset.id), "asset");
  sameIds(
    storyboard.assetDefinitions.map((asset) => asset.id),
    contract.assets.map((asset) => asset.id),
    "asset inventory must exactly match the approved storyboard asset IDs",
  );
  const supplied = new Map(contract.assets.map((asset) => [asset.id, asset]));
  for (const expected of storyboard.assetDefinitions) {
    const actual = supplied.get(expected.id);
    if (!actual) {
      throw invalidContract(`Asset inventory is missing storyboard asset ${expected.id}.`);
    }
    if (actual.type !== expected.type || actual.name !== expected.name) {
      throw invalidContract(
        `Asset ${expected.id} must preserve storyboard type ${expected.type} and name ${expected.name}.`,
      );
    }
  }
  const assetFiles = contract.assets.map((asset) => asset.file);
  uniqueFiles(assetFiles, "asset source");
  uniqueFiles(contract.contactSheetFiles, "asset contact sheet");
  disjointFiles(assetFiles, contract.contactSheetFiles, "Asset contact sheets must be separate files.");
  requireFileRole(assetFiles, files, "asset image", IMAGE_EXTENSIONS);
  requireFileRole(contract.contactSheetFiles, files, "asset contact sheet", IMAGE_EXTENSIONS);
}

function validateKeyframes(
  contract: KeyframesStageContract,
  storyboard: StageContract,
  assets: StageContract,
  files: ReadonlySet<string>,
): void {
  if (storyboard.stage !== "storyboard" || assets.stage !== "assets") {
    throw invalidContract("Approved storyboard/assets contracts are invalid.");
  }
  uniqueIds(contract.frames.map((frame) => frame.shotId), "keyframe shot");
  sameIds(
    storyboard.shots.map((shot) => shot.id),
    contract.frames.map((frame) => frame.shotId),
    "keyframes must cover every approved storyboard shot exactly once",
  );
  const assetIds = new Set(assets.assets.map((asset) => asset.id));
  const plannedAssets = new Map(storyboard.shots.map((shot) => [shot.id, shot.assetIds]));
  for (const frame of contract.frames) {
    if (!frame.continuityPassed) {
      throw invalidContract(`Keyframe ${frame.shotId} has an unresolved continuity failure.`);
    }
    for (const assetId of frame.assetIds) {
      if (!assetIds.has(assetId)) {
        throw invalidContract(`Keyframe ${frame.shotId} references unknown asset ${assetId}.`);
      }
    }
    sameIds(
      plannedAssets.get(frame.shotId) ?? [],
      frame.assetIds,
      `Keyframe ${frame.shotId} must preserve the storyboard shot-to-asset dependency map`,
    );
  }
  const frameFiles = contract.frames.map((frame) => frame.file);
  uniqueFiles(frameFiles, "keyframe image");
  uniqueFiles([contract.contactSheetFile, contract.consistencyReportFile], "keyframe aggregate");
  disjointFiles(
    frameFiles,
    [contract.contactSheetFile, contract.consistencyReportFile],
    "Keyframe contact sheet and consistency report must be separate from shot images.",
  );
  requireFileRole(frameFiles, files, "keyframe image", IMAGE_EXTENSIONS);
  requireFileRole([contract.contactSheetFile], files, "keyframe contact sheet", IMAGE_EXTENSIONS);
  requireFileRole(
    [contract.consistencyReportFile],
    files,
    "keyframe consistency report",
    REPORT_EXTENSIONS,
  );
}

function validateClips(
  contract: ClipsStageContract,
  storyboard: StageContract,
  files: ReadonlySet<string>,
): void {
  if (storyboard.stage !== "storyboard") {
    throw invalidContract("Approved storyboard contract is invalid.");
  }
  uniqueIds(contract.clips.map((clip) => clip.shotId), "clip shot");
  sameIds(
    storyboard.shots.map((shot) => shot.id),
    contract.clips.map((clip) => clip.shotId),
    "clips must cover every approved storyboard shot exactly once",
  );
  const plannedDuration = new Map(storyboard.shots.map((shot) => [shot.id, shot.durationMs]));
  for (const clip of contract.clips) {
    if (!clip.file && !clip.exception) {
      throw invalidContract(`Clip ${clip.shotId} needs a file or documented exception.`);
    }
    if (!clip.file && clip.technicalPassed) {
      throw invalidContract(`Clip ${clip.shotId} cannot pass technical inspection without a file.`);
    }
    if (!clip.technicalPassed && !clip.exception) {
      throw invalidContract(`Clip ${clip.shotId} needs a passed check or documented exception.`);
    }
    if (Math.abs(clip.durationMs - (plannedDuration.get(clip.shotId) ?? 0)) > 500) {
      throw invalidContract(`Clip ${clip.shotId} duration differs from its storyboard by over 500ms.`);
    }
  }
  const clipFiles = contract.clips.flatMap((clip) => (clip.file ? [clip.file] : []));
  uniqueFiles(clipFiles, "shot clip");
  uniqueFiles([contract.proxyAssemblyFile, contract.technicalReportFile], "clip aggregate");
  disjointFiles(
    clipFiles,
    [contract.proxyAssemblyFile, contract.technicalReportFile],
    "Proxy assembly and technical report must be separate from shot clips.",
  );
  requireFileRole(clipFiles, files, "shot video clip", VIDEO_EXTENSIONS);
  requireFileRole([contract.proxyAssemblyFile], files, "proxy assembly", VIDEO_EXTENSIONS);
  requireFileRole(
    [contract.technicalReportFile],
    files,
    "clip technical report",
    REPORT_EXTENSIONS,
  );
}

function validateAudio(
  contract: AudioStageContract,
  script: StageContract,
  files: ReadonlySet<string>,
): void {
  if (script.stage !== "script") throw invalidContract("Approved script contract is invalid.");
  uniqueIds(contract.dialogueVoiceMap.map((entry) => entry.characterId), "dialogue voice character");
  const characters = new Set(script.characters.map((character) => character.id));
  const speakingCharacters = [
    ...new Set(
      script.scenes.flatMap((scene) => scene.dialogue.map((line) => line.characterId)),
    ),
  ];
  sameIds(
    speakingCharacters,
    contract.dialogueVoiceMap.map((entry) => entry.characterId),
    "dialogue voice map must cover every speaking script character exactly once",
  );
  const hasNarration = script.scenes.some((scene) => Boolean(scene.narration?.trim()));
  if (hasNarration !== Boolean(contract.narrationVoice)) {
    throw invalidContract(
      hasNarration
        ? "Audio contract requires a narration voice for narrated script scenes."
        : "Audio contract must not add a narration voice when the script has no narration.",
    );
  }
  for (const entry of contract.dialogueVoiceMap) {
    if (!characters.has(entry.characterId)) {
      throw invalidContract(`Dialogue voice map references unknown character ${entry.characterId}.`);
    }
  }
  uniqueIds(contract.musicCues.map((cue) => cue.id), "music cue");
  uniqueIds(contract.sfxCues.map((cue) => cue.id), "SFX cue");
  for (const cue of [...contract.musicCues, ...contract.sfxCues]) {
    if (cue.startMs >= script.totalDurationMs) {
      throw invalidContract(`Audio cue ${cue.id} starts outside the approved script duration.`);
    }
  }
  const audioFiles = [
    ...contract.dialogueVoiceMap.map((entry) => entry.file),
    ...(contract.narrationVoice ? [contract.narrationVoice.file] : []),
    ...contract.musicCues.map((cue) => cue.file),
    ...contract.sfxCues.map((cue) => cue.file),
    contract.mixPreviewFile,
  ];
  uniqueFiles(audioFiles, "audio source");
  disjointFiles(audioFiles, [contract.subtitleContentFile], "Subtitle content must be separate from audio files.");
  requireFileRole(audioFiles, files, "audio source", AUDIO_EXTENSIONS);
  requireFileRole(
    [contract.subtitleContentFile],
    files,
    "subtitle content",
    SUBTITLE_EXTENSIONS,
  );
}

function validateEdit(contract: EditStageContract, files: ReadonlySet<string>): void {
  const named = [
    contract.videoFile,
    contract.srtFile,
    contract.assFile,
    contract.timelineFile,
    contract.syncReportFile,
  ];
  uniqueFiles(named, "edit deliverable");
  requireFileRole([contract.videoFile], files, "edit master", new Set([".mp4"]));
  requireFileRole([contract.srtFile], files, "SRT subtitle", new Set([".srt"]));
  requireFileRole([contract.assFile], files, "ASS subtitle", new Set([".ass"]));
  requireFileRole([contract.timelineFile], files, "edit timeline", TIMELINE_EXTENSIONS);
  requireFileRole([contract.syncReportFile], files, "sync report", REPORT_EXTENSIONS);
}

function validateQc(contract: QcStageContract, files: ReadonlySet<string>): void {
  requireFileRole([contract.reportFile], files, "QC report", new Set([".json"]));
  const required = new Set([
    "creative",
    "continuity",
    "technical",
    "accessibility",
    "safety",
    "provider",
    "rights",
    "ai-label",
  ]);
  for (const check of contract.checks) {
    if (!check.passed) throw invalidContract(`QC category ${check.category} has not passed.`);
    required.delete(check.category);
  }
  if (required.size > 0) {
    throw invalidContract(`QC is missing categories: ${[...required].join(", ")}.`);
  }
  if (contract.blockingIssues.length > 0) {
    throw invalidContract("QC contains unresolved blocking issues.");
  }
}

function approvedContract(state: TaskState, stage: WorkflowStage): StageContract {
  const stageState = state.stages[stage];
  const revision = stageState.approvedRevision
    ? stageState.revisions[stageState.approvedRevision - 1]
    : undefined;
  if (!revision?.stageContract) {
    throw invalidContract(`Approved ${stage} revision has no structured stage contract.`);
  }
  return revision.stageContract;
}

function requireFiles(names: readonly string[], files: ReadonlySet<string>): void {
  for (const name of names) {
    if (!files.has(name.toLowerCase())) {
      throw invalidContract(`Contract file ${name} is not present in this imported revision.`);
    }
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a"]);
const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".txt"]);
const REPORT_EXTENSIONS = new Set([".json", ".md", ".txt"]);
const TIMELINE_EXTENSIONS = new Set([".json", ".xml", ".edl", ".fcpxml", ".md"]);

function requireFileRole(
  names: readonly string[],
  files: ReadonlySet<string>,
  label: string,
  allowedExtensions: ReadonlySet<string>,
): void {
  requireFiles(names, files);
  for (const name of names) {
    const extension = extname(name).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      throw invalidContract(
        `${label} ${name} must use one of: ${[...allowedExtensions].join(", ")}.`,
      );
    }
  }
}

function uniqueFiles(names: readonly string[], label: string): void {
  const normalized = names.map((name) => name.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw invalidContract(`Each ${label} must reference a distinct file.`);
  }
}

function disjointFiles(left: readonly string[], right: readonly string[], message: string): void {
  const occupied = new Set(left.map((name) => name.toLowerCase()));
  if (right.some((name) => occupied.has(name.toLowerCase()))) throw invalidContract(message);
}

function uniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw invalidContract(`Duplicate ${label} IDs are not allowed.`);
}

function sameIds(expected: readonly string[], actual: readonly string[], message: string): void {
  const left = [...new Set(expected)].sort();
  const right = [...new Set(actual)].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw invalidContract(message);
  }
}

function invalidContract(message: string): WorkflowError {
  return new WorkflowError("STAGE_CONTRACT_INVALID", message);
}
