import { basename } from "node:path";

import type { StageContract, TaskState, WorkflowStage } from "../../src/contracts/index.js";
import { DefaultStageGenerator } from "../../src/workflow/index.js";

export async function makeStageContract(
  state: TaskState,
  stage: WorkflowStage,
  sourceFiles: readonly string[],
): Promise<StageContract> {
  if (stage === "concept" || stage === "script" || stage === "storyboard") {
    return (
      await new DefaultStageGenerator().generate({
        state,
        stage,
        generatedAt: "2026-08-10T00:00:00.000Z",
      })
    ).contract;
  }
  const files = sourceFiles.map((path) => basename(path));
  const first = required(files[0]);
  if (stage === "assets") {
    const storyboard = approved(state, "storyboard");
    if (storyboard.stage !== "storyboard") throw new Error("storyboard contract mismatch");
    const images = files.filter(isImage);
    const assetFiles = images.slice(0, storyboard.assetDefinitions.length);
    const contactSheet = required(images[storyboard.assetDefinitions.length]);
    if (assetFiles.length !== storyboard.assetDefinitions.length) {
      throw new Error("assets fixture needs one image per asset plus a contact sheet");
    }
    return {
      schemaVersion: 1,
      stage,
      styleSpecification: "Stable vertical cartoon palette, lighting, line weight, and identity rules.",
      assets: storyboard.assetDefinitions.map((asset, index) => ({
        ...asset,
        file: required(assetFiles[index]),
        prompt: `Approved generation prompt for ${asset.name}`,
        negativePrompt: "watermark, identity drift, extra limbs, text artifacts",
        rightsNote: "Rights and provider terms are attached to the imported artifact.",
      })),
      contactSheetFiles: [contactSheet],
      inventoryComplete: true,
    };
  }
  if (stage === "keyframes") {
    const storyboard = approved(state, "storyboard");
    if (storyboard.stage !== "storyboard") throw new Error("storyboard contract mismatch");
    const images = files.filter(isImage);
    const frameFiles = images.slice(0, storyboard.shots.length);
    if (frameFiles.length !== storyboard.shots.length) {
      throw new Error("keyframes fixture needs one image per shot");
    }
    return {
      schemaVersion: 1,
      stage,
      frames: storyboard.shots.map((shot, index) => ({
        shotId: shot.id,
        file: required(frameFiles[index]),
        assetIds: shot.assetIds,
        prompt: `Approved keyframe prompt for ${shot.id}`,
        continuityPassed: true,
      })),
      contactSheetFile: required(images[storyboard.shots.length]),
      consistencyReportFile: required(files.find(isReport)),
      consistencyPassed: true,
    };
  }
  if (stage === "clips") {
    const storyboard = approved(state, "storyboard");
    if (storyboard.stage !== "storyboard") throw new Error("storyboard contract mismatch");
    const videos = files.filter(isVideo);
    const clipFiles = videos.slice(0, storyboard.shots.length);
    if (clipFiles.length !== storyboard.shots.length) {
      throw new Error("clips fixture needs one video per shot");
    }
    return {
      schemaVersion: 1,
      stage,
      clips: storyboard.shots.map((shot, index) => ({
        shotId: shot.id,
        file: required(clipFiles[index]),
        durationMs: shot.durationMs,
        technicalPassed: true,
      })),
      proxyAssemblyFile: required(videos[storyboard.shots.length]),
      technicalReportFile: required(files.find(isReport)),
    };
  }
  if (stage === "audio") {
    const script = approved(state, "script");
    if (script.stage !== "script") throw new Error("script contract mismatch");
    const audio = files.filter(isAudio);
    const voiceFiles = audio.slice(0, script.characters.length);
    const remaining = audio.slice(script.characters.length);
    if (voiceFiles.length !== script.characters.length || remaining.length < 3) {
      throw new Error("audio fixture needs per-character voices, music, SFX, and a mix preview");
    }
    return {
      schemaVersion: 1,
      stage,
      dialogueVoiceMap: script.characters.map((character, index) => ({
        characterId: character.id,
        voiceId: `VOICE_${character.id}`,
        file: required(voiceFiles[index]),
        catalogVoice: true,
      })),
      musicCues: [{ id: "MUSIC_01", file: required(remaining[0]), startMs: 0 }],
      sfxCues: [{ id: "SFX_01", file: required(remaining[1]), startMs: 0 }],
      mixPreviewFile: required(remaining[2]),
      subtitleContentFile: required(files.find(isSubtitleText)),
      pronunciationChecked: true,
      rightsChecked: true,
    };
  }
  if (stage === "edit") {
    const video = required(files.find((file) => file.toLowerCase().endsWith(".mp4")));
    const srt = required(files.find((file) => file.toLowerCase().endsWith(".srt")));
    const ass = required(files.find((file) => file.toLowerCase().endsWith(".ass")));
    return {
      schemaVersion: 1,
      stage,
      videoFile: video,
      srtFile: srt,
      assFile: ass,
      timelineFile: required(files.find((file) => file.toLowerCase().includes("timeline"))),
      syncReportFile: required(files.find((file) => file.toLowerCase().includes("sync"))),
      properties: {
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        audioCodec: "aac",
        audioSampleRate: 48_000,
        subtitlesBurnedIn: true,
      },
    };
  }
  return {
    schemaVersion: 1,
    stage: "qc",
    reportFile: first,
    checks: [
      "creative",
      "continuity",
      "technical",
      "accessibility",
      "safety",
      "provider",
      "rights",
      "ai-label",
    ].map((category) => ({
      category: category as
        | "creative"
        | "continuity"
        | "technical"
        | "accessibility"
        | "safety"
        | "provider"
        | "rights"
        | "ai-label",
      passed: true,
      evidence: `${category} evidence is recorded in the bound QC report.`,
    })),
    waivers: [],
    blockingIssues: [],
    aiLabelConfirmed: true,
  };
}

function isImage(file: string): boolean {
  return /\.(?:png|jpe?g|webp)$/i.test(file);
}

function isVideo(file: string): boolean {
  return /\.(?:mp4|webm|mov)$/i.test(file);
}

function isAudio(file: string): boolean {
  return /\.(?:mp3|wav|ogg|flac|m4a)$/i.test(file);
}

function isReport(file: string): boolean {
  return /(?:report|consistency).*(?:\.json|\.md|\.txt)$/i.test(file);
}

function isSubtitleText(file: string): boolean {
  return /(?:subtitle|caption).*(?:\.srt|\.ass|\.txt)$/i.test(file);
}

function approved(state: TaskState, stage: WorkflowStage): StageContract {
  const stageState = state.stages[stage];
  const revision = stageState.approvedRevision
    ? stageState.revisions[stageState.approvedRevision - 1]
    : undefined;
  if (!revision?.stageContract) throw new Error(`missing approved ${stage} contract`);
  return revision.stageContract;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required fixture value is missing");
  return value;
}
