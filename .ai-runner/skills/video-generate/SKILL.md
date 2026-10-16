---
name: video-generate
description: 使用智谱 CogVideoX 生成 AI 视频。当用户要求生成视频、文生视频、图生视频时使用
keywords: 视频 生成视频 文生视频 图生视频 智谱 zhipu cogvideox AI视频
---

# AI 视频生成（智谱 CogVideoX）

通过智谱开放平台 API 生成 AI 视频。已验证模型：cogvideox-3（cogvideox-flash 常报 1305 过载）。

## 凭据

API Key 存放在环境变量或直接内联。调用前先确认 Key 可用（401 = Key 无效）。

## 提交任务

    curl -sS -X POST "https://open.bigmodel.cn/api/paas/v4/videos/generations" \
      -H "Authorization: Bearer <API_KEY>" \
      -H "Content-Type: application/json" \
      -d '{"model":"cogvideox-3","prompt":"<提示词>"}'

返回 task_status=PROCESSING 与任务 id。

## 轮询结果

    curl -sS "https://open.bigmodel.cn/api/paas/v4/async-result/<id>" \
      -H "Authorization: Bearer <API_KEY>"

task_status 流转：PROCESSING → SUCCESS / FAIL。
SUCCESS 时 video_result[0].url 即视频地址（带水印版），cover_image_url 为封面。
生成耗时约 2~4 分钟，必须用后台轮询，不要在前台空等（沙箱 180s 上限）。

## 下载视频

URL 含签名参数（&、?、%），**不能用 sh -c 字符串传递**，会因 shell 元字符失败。
必须用数组参数直传：

    await __AI__.shell(["curl","-sS","-L","-m","120","-o","output/video.mp4", url])

## 沙箱注意事项

- 视频生成 2~4 分钟，超过 /run 的 180s 上限：提交后用 shell(cmd,{background:true}) 起后台轮询
- 下载 URL 含签名参数，必须用数组形式传参，不要拼进 sh -c 字符串
- 视频 URL 有 Expires 时效（约 24 小时），生成后应及时下载到工作区
- cogvideox-flash 常返回 1305（访问量过大），改用 cogvideox-3 更稳定
