# AI 漫剧工作流

[English](README.md) | [简体中文](README.zh-CN.md)

这是一个可直接克隆、与具体生成服务解耦、带人工审核门禁的 AI 漫剧生产工作流。它面向 60–90 秒、9:16 竖屏、中文内容的短篇动画，从原创或有充分公版证明的 IP 与主题出发，依次完成策划、剧本、分镜、素材、关键帧、视频片段、音频、剪辑和质检，最终导出带完整版本、审核、权利和生成来源记录的交付包。

项目的重点不是“一键生成视频”，而是让一个真实生产任务具备以下能力：

- 每一步都有结构化输入、输出和质量标准；
- 每个版本、用户反馈和审核决定都可追溯；
- API、MCP、本地工具和人工平台可以进入同一套制品与审核流程；
- 任务中断后可以从磁盘状态安全恢复；
- 权利、费用、模型、provider、文件哈希和生成来源不会因换工具而丢失；
- 未经用户明确批准，工作流不会自动推进到下一阶段。

V1 使用单控制器串行执行，不在生产运行时启用子代理、代理团队或并行编排。

## 适用范围

适合：

- 原创角色、原创世界观和原创故事；
- 已经完成公版核验、并保存了证明材料的作品；
- 需要混合使用本地 FFmpeg、生成 API、MCP 工具或网页平台的团队；
- 需要保留审核、版本、来源、费用和权利证据的生产流程。

不适合：

- 未经授权使用受版权保护的影视、动漫、游戏或文学 IP；
- 未经授权模仿真实人物的声音或形象；
- 模仿仍在世艺术家、导演的特定个人风格；
- 希望绕过审核、权利检查或费用确认的全自动批量生成。

声音克隆默认关闭，不能通过提示词、provider 参数或聊天上下文隐式开启。

## 工作流总览

生产阶段固定且只能按顺序执行：

| 门禁 | 阶段 ID | 主要产出 | 审核重点 |
| --- | --- | --- | --- |
| G1 | `concept` | 概念、受众、主题、方向方案 | IP 权利、故事前提、范围 |
| G2 | `script` | 角色、场景、对白、旁白、时间轴 | 故事、节奏、安全、可制作性 |
| G3 | `storyboard` | 8–12 个镜头及素材依赖 | 时长、构图、运镜、连续性 |
| Freeze | providers | 完整 provider/model 路由 | 能力覆盖、健康状态、模型选择 |
| G4 | `assets` | 角色、场景、道具、风格图 | 一致性、清晰度、权利 |
| G5 | `keyframes` | 每个镜头的关键帧 | 身份、服装、空间和光线连续性 |
| G6 | `clips` | 每个镜头的视频片段 | 动作、时长、变形、闪烁和可剪辑性 |
| G7 | `audio` | 对白/旁白、音乐、音效、字幕内容 | 发音、混音、同步和音频权利 |
| G8 | `edit` | MP4、SRT、ASS、时间线和同步报告 | 节奏、转场、字幕安全区、交付规格 |
| G9 | `qc` | 最终质检报告 | 创意、技术、无障碍、安全、权利和 AI 标识 |

简化流程如下：

```text
用户 / 编码代理
      |
      v
CLI 或 MCP
      |
      v
串行工作流状态机 ---> 审核与反馈记录
      |                    |
      v                    v
Provider 注册表 ------> output/<task-id>/ 持久化任务目录
  本地 / API / MCP / 人工
      |
      v
生成或导入媒体 ---> FFmpeg 检查、剪辑、QC 和导出
```

## 项目结构

```text
.
|-- .agents/skills/        # Codex 工作流技能的唯一源文件
|-- .codex-plugin/         # Codex 插件清单
|-- .github/workflows/     # CI 工作流
|-- config/                # provider 示例配置和可选 ComfyUI 工作流
|-- docs/                  # 架构、阶段合约、审核、合规和部署文档
|-- integrations/          # 第三方集成锁定信息与声明
|-- scripts/               # 仓库校验、技能镜像同步等脚本
|-- skills/                # 自动生成的插件技能镜像，请勿直接编辑
|-- src/
|   |-- cli/               # cartoon 命令行入口与参数解析
|   |-- contracts/         # 状态、事件、制品、阶段和 provider 合约
|   |-- mcp/               # MCP 服务端适配层
|   |-- media/             # FFmpeg、媒体探测、字幕和交付检查
|   |-- providers/         # provider 注册、执行、归档和任务 ledger
|   `-- workflow/          # 状态机、事件存储、审核、导入和导出逻辑
|-- tests/                 # 单元、CLI、MCP、provider 和端到端测试
|-- output/                # 本地生产任务数据，默认不进入 Git
|-- package.json
|-- README.md
`-- README.zh-CN.md
```

每个任务位于 `output/<task-id>/`：

```text
output/<task-id>/
|-- project.json              # 不可变的任务输入与基础配置
|-- state.json                # 当前状态投影
|-- events.jsonl              # 追加写入的工作流事件
|-- artifacts.jsonl           # 追加写入的制品、哈希、权利和来源记录
|-- provider-jobs.jsonl       # provider attempt、费用和远程任务状态
|-- provider-bindings.json    # 冻结的 provider/model 路由
|-- generation/               # G1–G3 内置生成器的审阅材料
|-- reviews/                  # 用户审核、反馈和目标 ID
|-- 01-concept/v001/
|-- 02-script/v001/
|-- 03-storyboard/v001/
|-- 04-assets/v001/
|-- 05-keyframes/v001/
|-- 06-clips/v001/
|-- 07-audio/v001/
|-- 08-edit/v001/
|-- 09-qc/v001/
`-- final/v001/               # 最终视频、字幕、清单和来源记录
```

不要手工修改 `state.json`、JSONL ledger、审核文件、provider 绑定或批准标记。所有状态变更都应通过 CLI 或等价 MCP 操作完成。

## 环境要求

- Node.js `>=22 <25`；Node.js 24.18.0 可正常使用；
- npm；
- 安装可选托管 FFmpeg/ffprobe 所需的磁盘与网络，或者可信的外部 FFmpeg 工具链；
- 用户控制的原创 IP，或适用于目标地区和用途的完整公版证明。

正常安装会带上固定版本的可选 FFmpeg/ffprobe：

```bash
git clone <repo-url> ai-cartoon-workflow
cd ai-cartoon-workflow
npm ci
npm run cartoon -- doctor
```

工具发现顺序为：provider 显式路径、`AI_CARTOON_FFMPEG_PATH` / `AI_CARTOON_FFPROBE_PATH`、npm 托管二进制、系统 `PATH`。只有组织已经提供可信工具链时，才使用：

```bash
npm ci --omit=optional
```

开发或提交修改前运行：

```bash
npm run check
```

## 快速开始

### 1. 准备权利声明

G1 必须提供原创或公版权利证据。原创项目可以创建 `rights-metadata.json`：

```json
{
  "rights": {
    "basis": "original",
    "creator": "你的姓名或团队名称",
    "declaration": "该 IP、角色和故事由我方原创并控制相关权利。",
    "evidence": "可选：内部立项或创作记录编号"
  }
}
```

公版项目不能只写“已进入公版”，需要记录来源、证明、适用地区、作者/出版事实、法律依据和核验时间。准确字段参见 [合规文档](docs/COMPLIANCE.md)。

### 2. 创建任务

严格模式会在九个阶段逐阶段等待用户决定：

```bash
npm run cartoon -- start --ip "纸灯镇" --theme "勇气是愿意求助"
```

快速模式只减少用户被打断的次数，不会跳过结构、权利、费用或 provider 校验：

```bash
npm run cartoon -- start --ip "纸灯镇" --theme "勇气是愿意求助" --review-mode quick
```

保存命令返回的 `<task-id>`。以后所有生产命令都使用这个 ID。

### 3. 生成并审核 G1–G3

内置可替换生成器只创建 `concept`、`script` 和 `storyboard` 的确定性基线，不负责生成最终图片、视频或音频。

```bash
npm run cartoon -- generate <task-id> --metadata @rights-metadata.json
npm run cartoon -- status <task-id>
```

查看当前版本后记录决定：

```bash
npm run cartoon -- review <task-id> --stage concept --decision approve
npm run cartoon -- review <task-id> --stage storyboard --decision revise --feedback "缩短 S04，并保持灯笼视线方向" --targets "S04"
npm run cartoon -- review <task-id> --stage storyboard --decision regenerate --feedback "重新设计结尾反转" --targets "S10"
npm run cartoon -- review <task-id> --stage storyboard --decision abort --feedback "停止该制作任务"
```

可用决定：

- `approve`：批准当前修订；
- `revise`：按反馈制作新修订；
- `regenerate`：重新生成指定内容的新修订；
- `abort`：停止任务，但保留已有记录。

批准永远不会根据聊天沉默自动推断。已批准修订不可修改；反馈必须生成新的 `v002`、`v003` 等版本。

### 4. 检查并冻结 provider

G3 批准后、开始 G4 前执行：

```bash
npm run cartoon -- providers list
npm run cartoon -- providers check
npm run cartoon -- providers select <task-id> --provider manual --mode manual
```

`manual` 是最简单的完整人工路线。实际项目可以通过重复 `--binding` 混合路由，例如让图片、视频和音频使用不同 provider，同时把确定性渲染交给本地 FFmpeg：

```bash
npm run cartoon -- providers select <task-id> \
  --binding image.generate=jimeng-manual:manual \
  --binding video.i2v=kling-manual:manual \
  --binding audio.tts=manual:manual \
  --binding audio.music=manual:manual \
  --binding audio.sfx=manual:manual \
  --binding render.timeline=local-ffmpeg:api \
  --binding quality.inspect=local-ffmpeg:api
```

必需能力全部绑定后，profile 会被显式冻结。冻结后不能增加、替换或静默故障转移；可选能力（例如 `quality.inspect`）必须在最后一个必需能力写入前选好。provider 不可用时只能重试、等待、使用已经冻结的人工路径，或新建替代任务。

本地覆盖配置放在 Git 忽略的 `config/providers.local.json`。配置文件只能保存环境变量名称，不能保存真实密钥：

```bash
cp config/providers.example.json config/providers.local.json
```

Windows PowerShell 可使用：

```powershell
Copy-Item config/providers.example.json config/providers.local.json
```

### 5. 创建 provider 任务

每个新的 provider 提交都要先估价，并与一次明确的用户费用确认绑定。示例 `request.json`：

```json
{
  "capability": "image.generate",
  "input": {
    "prompt": "原创纸灯镇主角角色三视图，暖色赛璐璐风格",
    "seed": 42,
    "width": 1080,
    "height": 1920
  }
}
```

估价：

```bash
npm run cartoon -- providers estimate <task-id> --provider <provider-id> --request @request.json --json
```

已知价格的 `confirmation.json`：

```json
{
  "confirmedAt": "2026-08-10T01:02:03.000Z",
  "confirmedBy": "user",
  "confirmationReference": "review:assets:v001:cost-1",
  "pricingStatus": "known",
  "estimatedCost": 0.2,
  "maximumCost": 0.25,
  "currency": "USD"
}
```

未知价格必须明确确认未知定价，并且不能填写 `estimatedCost`。人工 provider 使用 `maximumCost: 0`：

```json
{
  "confirmedAt": "2026-08-10T01:02:03.000Z",
  "confirmedBy": "user",
  "confirmationReference": "review:assets:v001:unknown-price-1",
  "pricingStatus": "unknown",
  "unknownPricingAcknowledged": true,
  "maximumCost": 0,
  "currency": "USD"
}
```

提交：

```bash
npm run cartoon -- providers submit <task-id> --provider <provider-id> --stage assets --request @request.json --confirmation @confirmation.json --json
```

同一控制器一次只允许一个未结束的 attempt。必须先完成、轮询、恢复、失败或取消当前 attempt，才能提交新的 attempt。轮询或恢复同一个 durable job 不需要再次确认费用；新建替代 job 需要重新估价和确认。

### 6. 由 Codex 执行即梦、可灵、LibLibAI 或剪映交接

四个平台不需要 API Key。G3 后先在 Codex 中选择并冻结具体能力映射。即梦、可灵和 LibLibAI 使用 Chrome 的现有登录态；macOS 剪映专业版使用 Computer Use。Node 工作流只维护 durable 状态，浏览器或桌面技能只能通过公开命令追加记录。

准备任务包不会上传文件或消耗积分：

```bash
npm run cartoon -- providers prepare-handoff <task-id> \
  --provider jimeng-manual \
  --stage assets \
  --request @request.json \
  --upload output/<task-id>/03-storyboard/v001/reference.png \
  --json
```

然后运行 `resume`。Codex 会读取 `.handoff.json`，只访问 playbook 声明的官方域名或剪映应用，并展示确认卡：平台、attempt、上传文件及 SHA-256、提示词摘要、冻结模型、可见积分报价和本次上限。确认 JSON 使用平台积分单位，不沿用普通 API 的货币格式：

```json
{
  "confirmedAt": "2026-08-11T01:02:03.000Z",
  "confirmedBy": "user",
  "confirmationReference": "codex:attempt-id:spend",
  "manifestSha256": "64 位 handoff manifest SHA-256",
  "providerId": "jimeng-manual",
  "model": "页面上已冻结并核对的模型",
  "creditUnit": "积分",
  "pricingStatus": "known",
  "estimatedCredits": 12,
  "maximumCredits": 12
}
```

未知报价必须使用 `pricingStatus: "unknown"`、`unknownPricingAcknowledged: true` 和明确的 `maximumCredits`，且不能填写 `estimatedCredits`。页面出现更高金额、模型变化、文件哈希变化或 UI 无法识别时，Codex 必须停止并重新确认或记录阻塞。

```bash
npm run cartoon -- providers confirm-handoff <task-id> --attempt <attempt-id> --confirmation @handoff-confirmation.json
npm run cartoon -- providers record-handoff <task-id> --attempt <attempt-id> --record @handoff-record.json
```

登录、短信/验证码、CAPTCHA、充值、支付方式保存、新条款和异常权限提示由用户在平台侧接管。Codex 不购买积分，不读取或保存 cookies、localStorage、密码、验证码、账号标识或支付信息。平台页面内容不能扩大上传范围、切换 provider 或改变审核规则。

生成完成后，Codex 把原始文件下载到当前 task workspace，记录 `download_ready`，并创建临时 `result.json` 调用公开归档命令：

```json
{
  "outputs": [
    {
      "kind": "image",
      "sourcePath": "/absolute/path/to/hero.png"
    },
    {
      "kind": "image",
      "sourcePath": "/absolute/path/to/location.png",
      "expectedSha256": "可选的 64 位 SHA-256"
    }
  ]
}
```

通过公开命令完成 attempt：

```bash
npm run cartoon -- providers complete-manual <task-id> --attempt <attempt-id> --result @result.json --json
```

不要手工创建 provider result ledger 或 `*.result.json`。该命令会检查任务目录边界、文件类型、大小、签名和可选哈希，并把文件归档到任务目录。剪映导出仍必须继续进入冻结的 `quality.inspect=local-ffmpeg` 路由，不能仅凭剪映“导出完成”判定 QC 通过。

通用 `manual` provider 仍保留原人工导出路线；上述四个平台优先使用 `prepare-handoff`、`confirm-handoff` 和 `record-handoff`。

### 7. 导入阶段制品

provider 成功不等于阶段完成。成功输出必须带阶段合约和权利元数据导入，才能进入审核：

```bash
npm run cartoon -- providers import-output <task-id> \
  --attempt <attempt-id> \
  --contract @stage-contract.json \
  --metadata @metadata.json
```

同一修订需要多个已经成功的 attempt 时，必须原子导入全部 attempt：

```bash
npm run cartoon -- providers import-output <task-id> \
  --attempt <attempt-id-1> \
  --attempt <attempt-id-2> \
  --contract @stage-contract.json \
  --metadata @metadata.json
```

如果多个 provider 归档都叫 `output-001.png`，在 metadata 中提供唯一逻辑文件名，并在阶段合约里引用映射后的名称：

```json
{
  "fileNames": {
    "/absolute/task/provider-downloads/attempt-a/output-001.png": "hero-reference.png",
    "/absolute/task/provider-downloads/attempt-b/output-001.png": "location-reference.png"
  },
  "rights": {
    "basis": "provider-terms",
    "providerId": "example-provider",
    "termsUrl": "https://provider.example/terms",
    "termsReviewedAt": "2026-08-10T01:02:03.000Z",
    "commercialUseConfirmed": true,
    "thirdPartyInputsCleared": true
  }
}
```

非 provider-job 的外部文件使用普通导入：

```bash
npm run cartoon -- import <task-id> --stage <stage-id> --file <path> --contract @stage-contract.json --metadata @metadata.json
```

所有生产导入都需要对应阶段的结构化合约。不同文件权利不同，可使用按源路径或 basename 指定的 `fileRights`。workflow-derived 权利只能引用当前已批准、未失效的直接上游制品。详细字段参见 [阶段合约文档](docs/STAGE_CONTRACTS.md)。

### 8. 恢复中断任务

任何时候都可以运行：

```bash
npm run cartoon -- status <task-id>
npm run cartoon -- status <task-id> --json
npm run cartoon -- resume <task-id>
```

`resume` 会根据磁盘 ledger 返回唯一安全动作，例如：

- 审核当前修订；
- 恢复尚未提交完成的 provider job；
- 轮询远程 job；
- 执行浏览器/桌面 provider handoff；
- 确认本次上传范围和积分上限；
- 轮询或完成外部平台 handoff；
- 取消绑定到旧修订的 attempt；
- 导入已经归档的一个或多个成功 attempt；
- 继续当前阶段；
- 所有阶段完成后导出。

不要根据聊天记录猜测任务进度，也不要删除 ledger 后重新提交。先执行 `resume` 返回的动作。

### 9. 审核 QC 并导出

G9 明确批准后：

```bash
npm run cartoon -- export <task-id>
```

最终目录包含经过检查的视频、字幕、清单、审核记录和来源信息：

```text
output/<task-id>/final/v001/
```

`output/` 默认被 Git 忽略。需要交付、备份或发布时，请通过明确的外部流程复制或上传最终文件。

## 严格模式与快速模式

| 模式 | 用户审核点 | 不会被跳过的内容 |
| --- | --- | --- |
| `strict` | G1–G9 每个阶段 | 全部结构、权利、费用、provider 和 QC 校验 |
| `quick` | G3、G5、G9 三个组合审核点 | 阶段版本、结构校验、policy 审计、权利、费用和 provider 冻结 |

快速模式中的非检查点由 `quick-policy` 记录策略批准，与用户批准使用不同的审计 actor。快速模式不会从用户沉默推断同意。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 环境诊断 | `npm run cartoon -- doctor` |
| 创建任务 | `npm run cartoon -- start --ip "<ip>" --theme "<theme>"` |
| 查看状态 | `npm run cartoon -- status <task-id>` |
| 获取安全恢复动作 | `npm run cartoon -- resume <task-id>` |
| 生成 G1–G3 | `npm run cartoon -- generate <task-id> --metadata @metadata.json` |
| 记录审核 | `npm run cartoon -- review <task-id> --stage <stage> --decision <decision>` |
| 列出 provider | `npm run cartoon -- providers list` |
| 检查 provider | `npm run cartoon -- providers check` |
| 冻结 provider | `npm run cartoon -- providers select <task-id> ...` |
| 估价 | `npm run cartoon -- providers estimate <task-id> --provider <id> --request @request.json` |
| 提交任务 | `npm run cartoon -- providers submit <task-id> ...` |
| 查看 provider jobs | `npm run cartoon -- providers jobs <task-id>` |
| 轮询 attempt | `npm run cartoon -- providers poll <task-id> --attempt <attempt-id>` |
| 完成人工 attempt | `npm run cartoon -- providers complete-manual <task-id> ...` |
| 导入 provider 输出 | `npm run cartoon -- providers import-output <task-id> ...` |
| 导入普通外部文件 | `npm run cartoon -- import <task-id> ...` |
| 导出 | `npm run cartoon -- export <task-id>` |

运行以下命令查看完整 CLI 帮助：

```bash
npm run cartoon -- --help
```

## 重要注意事项

1. **每个任务必须同时提供 IP 和主题。** 不要创建缺少创作边界的空任务。
2. **只接纳用户控制的原创 IP 或有完整证据的公版 IP。** “网上能找到”不等于可商用。
3. **阶段只能串行执行。** 不要跳过阶段或同时让多个控制器写入同一任务。
4. **批准版本不可修改。** 所有反馈都应生成新修订并保留旧版本。
5. **provider 冻结后不可替换。** 不允许静默切换模型、区域或服务商。
6. **每次新提交都要重新估价和确认。** 恢复、轮询同一个 job 不重复确认。
7. **不要伪造 provider 元数据。** provider、attempt、model、job、prompt hash、seed 和安全 receipt 由 ledger 派生。
8. **所有制品都必须有权利记录。** 包括音乐、音效、字体、配音、图片、视频和派生制品。
9. **声音克隆默认关闭。** 只有外部结果具备独立、明确、具体的授权证据与后续用户确认时才允许导入。
10. **不要把密钥写入仓库或任务文件。** 使用环境变量或外部密钥管理器，也不要把密钥粘贴到聊天、日志或反馈里。
11. **不要手工编辑状态文件。** 使用 CLI/MCP，避免破坏 append-only 历史和恢复能力。
12. **任务输出不进入 Git。** `output/` 可能包含提示词、媒体、用户反馈和 provider 信息，需要自行安全备份。
13. **外部平台的分享页不是交付物。** 必须下载原始文件并归档，登录态 URL 或临时 URL 不具备可恢复性。
14. **阶段合约中的文件名是 basename。** 多个 attempt 文件重名时必须使用 `fileNames` 映射。
15. **本地 FFmpeg 零费用也要确认。** 它使用已知价格 `estimatedCost: 0` 的标准确认流程，以保持审计一致。

## Codex Skills 与 MCP

- 使用 `$create-ai-cartoon-drama` 执行完整九阶段生产、恢复、审核和导出；
- 使用 `$configure-ai-cartoon-providers` 配置 provider、检查健康状态并冻结路由；
- `.agents/skills/` 是技能唯一源目录；根目录 `skills/` 是插件要求的字节一致镜像，不要直接编辑；
- 修改技能后运行 `npm run skills:sync` 和 `npm run skills:check`；
- 使用 MCP 前先执行 `npm run build`，MCP 与 CLI 共用同一个状态机和合约，不是第二套实现。

主要 MCP 工具包括：

- 工作流：`cartoon_start`、`cartoon_status`、`cartoon_resume`、`cartoon_generate_stage`、`cartoon_submit_review`、`cartoon_import_artifact`、`cartoon_export`；
- provider：`cartoon_list_providers`、`cartoon_select_providers`、`cartoon_estimate_provider_job`、`cartoon_submit_provider_job`、`cartoon_complete_manual_provider_job`、`cartoon_resume_provider_job`、`cartoon_poll_provider_job`、`cartoon_cancel_provider_job`、`cartoon_list_provider_jobs`。

## 开发与验证

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

`npm run check` 会依次校验技能镜像、仓库结构、代码风格、类型、测试和构建。CI 在支持的操作系统上运行离线 fake-provider/media 端到端测试；Linux 还可以通过 `AI_CARTOON_FULL_MEDIA_E2E=1` 启用完整 1080×1920、60 秒交付渲染测试。

## 延伸文档

- [架构](docs/ARCHITECTURE.md)
- [完整工作流](docs/WORKFLOW.md)
- [阶段合约](docs/STAGE_CONTRACTS.md)
- [Provider 配置与执行](docs/PROVIDERS.md)
- [FFmpeg 部署](docs/FFMPEG_DEPLOYMENT.md)
- [输出目录规范](docs/OUTPUT_SPEC.md)
- [审核策略](docs/REVIEW_POLICY.md)
- [合规与权利](docs/COMPLIANCE.md)
- [第三方声明](integrations/THIRD_PARTY_NOTICES.md)

## 许可证

项目许可证为 Apache-2.0。第三方工具、模型、provider、字体、素材和上游集成仍受各自许可证、服务条款及适用法律约束。
