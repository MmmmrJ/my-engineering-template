# 可灵 AI 中国大陆站 playbook — `kling-cn.v1`

Use Chrome only. Permit exactly `https://klingai.kuaishou.com`.

## Supported operations

Execute approved image generation/editing and text/image/reference-to-video jobs. Preserve the frozen model/mode, aspect ratio, duration, camera intent, first/last frame roles, and prompt parameters.

## Semantic evidence

Identify controls from visible labels such as 图片、视频、创意描述、提示词、上传、参考图、首尾帧、模型、高品质、高性能、时长、灵感值、积分、消耗、立即生成、任务、生成中、已完成、下载 or 无水印. Require role and text evidence; do not rely on a single CSS selector or coordinate.

Hand off login, QR/SMS verification, CAPTCHA, recharge, permission escalation, and changed terms. Confirm the exact visible credit quote in Codex. Record the external task ID and observed model after submission. Download the permitted original result; do not claim watermark removal beyond the user's platform entitlement.
