# FFmpeg deployment

FFmpeg is the final local trust boundary even when a third-party platform performs timeline rendering. The workflow downloads the immutable MP4/SRT/ASS, hashes them, then uses FFmpeg/ffprobe to verify the real delivery instead of trusting a remote QC claim.

## Recommended default

```powershell
npm ci
npm run cartoon -- doctor --json
```

The optional `ffmpeg-static` and `@derhuerst/ffprobe-static` packages install platform-specific portable executables. No administrator access or global `PATH` change is required. `doctor` prints the selected executable and one of these sources:

1. `explicit`: `ffmpegPath` / `ffprobePath` in the ignored local provider profile.
2. `environment`: `AI_CARTOON_FFMPEG_PATH` / `AI_CARTOON_FFPROBE_PATH`.
3. `managed`: pinned optional npm binaries.
4. `system`: `ffmpeg` / `ffprobe` on `PATH`.

The selected build must expose libx264, AAC, and subtitle filters. Installation is not considered healthy until `doctor` passes all feature checks.

## Enterprise, offline, and container installations

Skip the managed packages when policy, bandwidth, architecture, or GPL redistribution requirements favor an organization-managed build:

```powershell
npm ci --omit=optional
$env:AI_CARTOON_FFMPEG_PATH = "C:\trusted-tools\ffmpeg.exe"
$env:AI_CARTOON_FFPROBE_PATH = "C:\trusted-tools\ffprobe.exe"
npm run cartoon -- doctor --json
```

On Linux/macOS, use absolute executable paths in the same variables. A container image may install distribution packages and set the variables or place the tools on `PATH`. Mount `output/` on durable storage and run one controller per task; do not share a writable task directory between workers.

To ignore managed binaries that are already present:

```powershell
$env:AI_CARTOON_DISABLE_MANAGED_FFMPEG = "1"
```

## Third-party rendering

Freeze `render.timeline` to the chosen API, MCP, or manual provider after G3. Freeze `quality.inspect` to a remote provider only when its report preserves task/model/job identity and binds the exact MP4/SRT/ASS SHA-256 values. Download and import every remote result before review.

Keep local FFmpeg available for final export validation. This is lightweight compared with generation and rendering: it probes the file and analyzes black/freeze/silence/loudness evidence without creating another paid remote job. If a deployment cannot run local processes, place this same trusted validator in a controlled sidecar/worker and expose it through a purpose-built adapter; do not accept an unbound remote JSON report as final evidence.

## Licensing and distribution

FFmpeg publishes source and links to platform builds rather than shipping one universal executable. The managed npm packages are GPL-3.0-or-later and are optional subprocess dependencies. They are downloaded into `node_modules/`, never committed to this repository. Review [third-party notices](../integrations/THIRD_PARTY_NOTICES.md) before redistributing an image, desktop bundle, or archive that includes those binaries.
