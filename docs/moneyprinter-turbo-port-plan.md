# MoneyPrinterTurbo 能力重写方案

> 定位：不移植 MPT 的 Python 代码，**完全重写**一份 Node.js 实现，只借鉴其五阶段流水线的设计思路。
> 剧本生成：AI 按契约生成脚本落盘，编排器读文件——复用现有 `/run` 链路，不新增通道。
> ffmpeg / ffprobe **假设可用**，方案只定义调用命令，不自研合成引擎。

## 一、关键取舍

- **剧本生成**：走「AI 生成脚本落盘 + 编排器读文件」，不驱动 headless、不改动油猴、不新增端点
- **ffmpeg**：假设可用，compositor 只写命令，不做编解码实现
- **重写 vs 移植**：不搬运 MPT 的 py 代码，只对齐能力边界

## 二、剧本生成：AI 生成脚本落盘（复用现有链路）

1. **提需求**：向 AI 发送提示，要求其为给定主题写口播稿，并生成把稿子写入目标路径的脚本。
2. **AI 回脚本**：AI 按契约生成 `js` 脚本（`// @desc` / `// @why` 头），脚本体调用 `__AI__.writeText(targetPath, scriptText)`。
3. **脚本执行**：走现有 `/run` 沙箱 + overlay 链路，剧本落盘。
4. **编排器读取**：后续阶段（TTS / 素材 / 合成）从该文件读取剧本。

**约定**

- 剧本路径：`.ai-runner/video/tasks/{taskId}/script.txt`
- 搜索词路径：同目录 `terms.json`
- 提示词模板：`providers/llm/prompts/script.md` / `terms.md`，描述输出脚本的形状与落盘契约
- 编排器只读文件，不解析 AI 回复文本

**边界**

- 编排器不直调 LLM API、不驱动 headless、不参与 fill 通道
- 剧本生成的触发由用户/上层发起（与「给 AI 下任务」是同一动作）
- 文件不存在或过期时报错，由上层决定是否重新提需求；编排器不做自动重试

**为什么不用 headless 直调**

`detectReplyInPage` 的 plain 分支有硬门禁（`headless-inject.ts:620`）：无 js 围栏且无 ASK/HANDOFF/TEXT 标记的纯文本回复直接 `return null`，永不推送。
该语义面向协议脚本而非通用问答，绕开需改四处同构的注入代码并同步守门测试，代价与风险都不划算。

## 三、五阶段流水线（`orchestrator.ts`）

- 阶段 1 剧本获取（10%）：读 `script.txt`（缺失则报错，见 §二边界）
- 阶段 2 搜索词获取（20%）：读 `terms.json`
- 阶段 3 音频与字幕（50%）：`tts.synthesize()` → `subtitle.generate()`
- 阶段 4 素材获取（70%）：`material.search()` → `material.download()`
- 阶段 5 最终合成（100%）：`compositor.combineVideos()` → `compositor.generateVideo()`

`stopAt` 检查点保留（script / terms / audio / materials），用于中途审查。

## 四、合成层（假设 ffmpeg 可用）

`compositor.ts` 只定义 ffmpeg 命令，不实现编解码：

- 标准化片段：`ffmpeg -i in.mp4 -t <sec> -vf scale=W:H:force_original_aspect_ratio=increase,crop=W:H -r 30 -c:v libx264 -pix_fmt yuv420p out.mp4`
- 拼接：`ffmpeg -f concat -safe 0 -i list.txt -c copy combined.mp4`
- 混音 + 字幕：`ffmpeg -i combined.mp4 -i audio.mp3 -i bgm.mp3 -vf subtitles=sub.srt -filter_complex [1:a]volume=1[a1];[2:a]volume=0.3[a2];[a1][a2]amix=inputs=2:duration=first[ao] -map 0:v -map [ao] -c:v libx264 -c:a aac -shortest final.mp4`
- 编码器检测：`ffmpeg -encoders | grep nvenc` 判断硬件加速，不可用降级 `libx264`

## 五、其余模块

- `task-state.ts`：`FileTaskStore`，状态落 `.ai-runner/video/tasks/{id}/state.json`
- `subtitle.ts`：Edge（词边界，`msedge-tts`）与 Whisper（CLI）双引擎
- `providers/material/`：`pexels-adapter` / `pixabay-adapter` / `local-adapter`
- `providers/tts/`：`edge-adapter` / `azure-adapter`
- `config.ts`：`config.json` 读写 + 敏感字段脱敏

## 六、路由（`routes/video.ts`）

前缀 `/video`，端点：`POST /tasks`、`GET /tasks`、`GET /tasks/:id`、`DELETE /tasks/:id`、`GET /tasks/:id/download`、`POST /scripts`、`POST /terms`、`POST /audio`、`POST /subtitle`、`GET /musics`、`POST /musics`、`GET /materials`、`POST /materials`。

在 `routes/index.ts` 的 `HONO_SUB_APPS` 加入 `videoHono`，`HONO_PREFIXES` 加入前缀 `/video`。

## 七、存储

- `.ai-runner/video/config.json`（权限 0600）
- `.ai-runner/video/tasks/{id}/`：`state.json`、`script.txt`、`terms.json`、`audio.mp3`、`subtitle.srt`、`materials/`、`combined.mp4`、`final.mp4`
- `.ai-runner/video/bgm/`、`.ai-runner/video/cache/`

## 八、分阶段实施

- 阶段一：orchestrator（读剧本文件）+ compositor + FileTaskStore。前置剧本已由 AI 脚本落盘 → CLI 输出 MP4
- 阶段二：字幕双引擎、config、路由、素材缓存
- 阶段三：Vue 面板（`VideoGenerationPanel.vue` + `VideoTaskList.vue`）
- 阶段四：AI 生成素材（CogVideoX，作为可选素材源）

## 九、关键风险

- **剧本依赖外部动作**：剧本由 AI 落盘，编排器只读；缺失或过期需上层重新提需求，编排器不自动重试
- **素材匹配质量**：搜索词质量决定素材相关性，需在提示词模板中约束输出格式
- **ffmpeg 拼接音画同步**：拼接前统一分辨率 / 帧率 / 采样率
- **HCLC 约束**：新模块单文件 import ≤ 5，文件 ≤ 800 行

## 十、能力边界

- 对齐 MPT：脚本、搜索词、Pexels/Pixabay 素材、Edge TTS、字幕、拼接、混音、路由、UI
- 差异化：剧本由 AI 生成脚本落盘（无需 API Key）、AI 生成素材作为可选素材源
- 不实现：MPT 的 Redis 状态后端、Streamlit UI、跨平台发布
