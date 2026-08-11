# Structured stage contracts

Every production revision carries one immutable `schemaVersion: 1` contract. Pass it as `--contract @file.json`, or as `stageContract` in import metadata/MCP input. The contract is validated before files are copied or a review gate is opened.

Common rules:

- `stage` must exactly match the import stage.
- IDs are stable, unique identifiers such as `CHAR_PROTAGONIST`, `LOC_MAIN`, and `SHOT_01`.
- File fields are basenames and must be present in the same imported revision.
- Primary entries use distinct role-correct files: assets/keyframes are PNG/JPEG/WebP, clips are MP4/WebM/MOV, audio is MP3/WAV/OGG/FLAC/M4A, subtitles are SRT/ASS/text, and reports/timelines use their declared document formats. Aggregates cannot reuse a primary media file.
- Approved upstream contracts are the source of truth for duration, shot, character, and asset coverage.
- An automatic review, continuity check, technical check, or QC category with an unresolved failure blocks the revision.

## G1-G3

Use `cartoon generate <task-id>` for a valid baseline. The generator emits:

- `concept`: task IP/theme, premise, audience, language, tone, logline, synopsis, use, 9:16 duration, and exactly three directions with one recommendation;
- `script`: characters, ordered timed scenes, dialogue/narration, 60-90 second total, ending, rhythm, reversal, continuity, and a passing automatic review;
- `storyboard`: 8-12 unique shots whose durations equal the approved script, camera/action/audio/transition fields, stable assets, continuity anchors, and generation risk.

## G4-G9

| Stage | Required structured evidence |
| --- | --- |
| `assets` | style specification, complete storyboard asset inventory, per-asset file/prompt/negative prompt/rights note, contact sheets |
| `keyframes` | exactly one passing frame entry per approved shot, asset IDs, prompts, contact sheet, consistency report |
| `clips` | exactly one clip or documented exception per shot, storyboard-aligned duration, proxy assembly, technical report |
| `audio` | dialogue voice map, catalog-voice flag, music/SFX cues, mix preview, subtitle content, pronunciation and rights checks |
| `edit` | MP4/SRT/ASS, deterministic timeline, sync report, fixed 1080x1920/30fps/H.264/yuv420p/AAC/48k profile and burn-in assertion |
| `qc` | bound QC report, all eight required categories passing, waivers, zero blocking issues, AI-label confirmation |

Example G4 contract:

```json
{
  "schemaVersion": 1,
  "stage": "assets",
  "styleSpecification": "Warm cel shading, stable line weight, 9:16 safe composition.",
  "assets": [
    {
      "id": "CHAR_PROTAGONIST",
      "type": "character",
      "name": "Protagonist",
      "file": "CHAR_PROTAGONIST.png",
      "prompt": "Original protagonist turnaround, neutral pose, cel shaded",
      "negativePrompt": "watermark, text, identity drift, extra limbs",
      "rightsNote": "Original prompt and provider commercial terms recorded in metadata."
    }
  ],
  "contactSheetFiles": ["assets-contact-sheet.png"],
  "inventoryComplete": true
}
```

The runtime requires the full inventory defined by the approved storyboard; the abbreviated example succeeds only when that storyboard contains the one shown asset.
