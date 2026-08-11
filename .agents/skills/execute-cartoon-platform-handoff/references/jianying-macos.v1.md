# macOS 剪映专业版 playbook — `jianying-macos.v1`

Use Computer Use only. Target `剪映专业版`, `剪映`, or bundle identifier `com.lemon.lv` as declared by the manifest.

## Deterministic edit boundary

Import only approved clips, audio, SRT/ASS, and timeline materials listed by the manifest. Recreate the approved deterministic timeline exactly: shot order, in/out points, duration, transitions, audio placement, subtitles, safe areas, and visible AI label. Do not invent edits or repair creative content in the app.

Prefer accessibility elements labeled 导入、媒体、音频、字幕、本地字幕、时间线、导出、1080P、H.264、30fps、AAC、导出完成 or 打开文件夹. Refresh app state after each action. Use coordinates only when accessibility actions are unavailable and the current screenshot makes the target unambiguous; stop on layout ambiguity.

Export MP4 with the approved 1080x1920, 30 fps, H.264/yuv420p and AAC 48 kHz settings, plus SRT/ASS and a project/timeline description when available. Save every output under the task workspace. Record `download_ready`, complete the manual attempt, import the result, then run the frozen `quality.inspect=local-ffmpeg` route. Never approve QC from the 剪映 success dialog alone.

Hand off login, CAPTCHA, account permissions, cloud upgrade, recharge, new terms, or any unexpected system permission. Do not install plugins, fonts, codecs, or templates without a separate explicit user request and confirmation.
