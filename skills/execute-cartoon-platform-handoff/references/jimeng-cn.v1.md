# 即梦 AI 中国大陆站 playbook — `jimeng-cn.v1`

Use Chrome only. Permit exactly `https://jimeng.jianying.com`.

## Supported operations

- `image.generate`: fill a text prompt and approved image parameters.
- `image.edit`: upload only manifest reference images, then fill prompt and parameters.
- `video.t2v`: fill a video prompt, aspect ratio, duration, and frozen model.
- `video.i2v` / `video.r2v`: upload only declared reference/first/last frames, then fill motion prompt and parameters.

## Semantic evidence

Identify controls from visible labels such as 图片生成、视频生成、提示词、描述你想生成的内容、上传、参考图、首帧、尾帧、模型、画幅、时长、积分、灵感值、消耗、生成、生成中、作品、下载、原图 or 原视频. Labels may vary slightly; require an unambiguous role plus visible text.

If login controls appear, record `awaiting_login` or `blocked_login` and ask the user to sign in in Chrome. Hand off SMS, QR confirmation, CAPTCHA, recharge, and new terms.

Before submit, capture the visible model and exact displayed credit quote. Do not infer credits from prior runs. After submit, record the visible task ID when available. Download the original image/video rather than a preview, screenshot, or share page.
