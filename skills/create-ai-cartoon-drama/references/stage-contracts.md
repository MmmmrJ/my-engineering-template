# Stage contracts

Meet the minimum contract below before requesting review. Keep stable character, location, prop, shot, and revision IDs across stages.

## `concept`

- Identify the original or proven-public-domain IP and record its rights basis.
- Define premise, theme, audience, language, tone, logline, synopsis, and intended use; present one recommended direction and two meaningful alternatives.
- Fit a 60-90 second, 9:16 episode without relying on protected third-party expression.

## `script`

- Provide timed scenes, action, dialogue, narration, and an ending beat.
- Target 75 seconds and make spoken length plausible within the approved duration.
- Preserve theme, character agency, safety, and production feasibility.
- Include the synopsis, character list, scene screenplay, dialogue, rhythm, reversal, continuity notes, and a separate automatic script-review report.

## `storyboard`

- Define 8-12 ordered shot IDs, durations, framing, camera/motion, action, dialogue/audio cues, and transitions.
- Make total shot duration match the episode plan.
- Flag continuity anchors and expensive or fragile generations.
- Decompose every shot into stable character, location, and prop IDs and retain the shot-to-asset dependency map.

## `assets`

- Define approved character turnarounds/expressions, environments, props, palettes, and style rules.
- Preserve asset IDs, prompts, negative constraints, seeds/settings when available, provider provenance, and rights notes.
- Reject watermarked, unlicensed, identity-conflicting, or visually inconsistent assets.
- Provide a style specification, complete asset inventory, and contact sheets for review.

## `keyframes`

- Supply the required visual anchors for every shot using approved assets and framing.
- Check identity, costume, handedness, spatial layout, eyelines, lighting, and aspect ratio.
- Preserve the shot-to-keyframe mapping and generation lineage.
- Provide a contact sheet plus a machine-readable consistency report.

## `clips`

- Supply one traceable motion result for every approved shot or an explicit documented exception.
- Match planned duration, action, camera intent, start/end anchors, frame rate, and continuity.
- Reject severe morphing, extra limbs, text artifacts, flicker, or unusable handles.
- Provide a proxy assembly and per-clip technical inspection report.

## `audio`

- Supply dialogue/narration, music, SFX, timing, mix decisions, and `zh-CN` subtitle content.
- Prefer synthetic catalog voices or recordings with documented rights. Voice cloning remains disabled unless the task contains separate, specific consent evidence and the user explicitly confirms that use.
- Check pronunciation, intelligibility, loudness balance, sync, and music/SFX licenses.
- Provide a dialogue/voice map, music and SFX cue sheet, and mixed preview.

## `edit`

- Assemble the approved clips and audio into 1080x1920, 30 fps H.264 video with AAC at 48 kHz.
- Provide an SRT sidecar and a burned-in subtitle version.
- Verify pacing, transitions, sync, caption safe areas, and absence of accidental black/silent gaps.
- Preserve a deterministic timeline, SRT and ASS sidecars, burned-in rough cut, and sync report.

## `qc`

- Record creative, continuity, technical, accessibility, safety, provider, and rights checks.
- Validate 60-90 seconds, 9:16, expected codecs/pixel format, audio, subtitles, and file integrity.
- List every waiver or known issue. Do not pass QC with an unresolved blocking issue.
- Check continuity, black/frozen frames, silence/clipping, loudness, subtitle readability, asset matching, rights/provenance, and visible plus metadata AI labeling.
