// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 三条推送路径：script / plain / error。
 * [WHY] 噪音抑制条件集中在调用方（classifyAndPost），但每条路径各自的守卫
 *   （去重、停止后不补发、标记行剥离）落在这里，便于逐条核对。
 * [CONSTRAINT] 所有推送都要带 site 与 sessionId：工作台按 (site, sessionId) 归窗，
 *   缺任一项都会让回传落到错误窗口。
 */

/**
 * 推送脚本块。
 * [CONSTRAINT] 调用方必须已确认 !seenHashes.has(hash)；此处仍再查一次，
 *   因为多块续推路径会在同一 tick 内连调，去重集合是唯一可靠的交汇点。
 * @returns 是否真的推送了（调用方据此决定要不要继续找下一块）
 */
function emitScript(item: ScriptItem): boolean {
  if (seenHashes.has(item.hash)) return false
  seenHashes.add(item.hash)
  post({
    type: 'ai-runner:reply',
    kind: 'script',
    code: item.code,
    lang: item.lang,
    hash: item.hash,
    site: location.origin,
    sessionId: extractSidFromHash(),
  })
  lastBodySig = bodySignature()
  return true
}

/**
 * 推送纯文本回复。
 * [WHY] TEXT 标记的回复要剥掉首行标记只留正文，否则工作台会把「TEXT」这个词
 *   渲染进正文卡片（首行是标记不是内容）。
 */
function emitPlain(md: string, marks: ReplyMarks): void {
  const text = marks.text > 0 ? md.split(/\r?\n/).slice(marks.text).join('\n').trim() : md
  post({
    type: 'ai-runner:reply',
    kind: 'plain',
    site: location.origin,
    sessionId: extractSidFromHash(),
    text,
  })
}

// [script-fence-guess-removed-v1] emitFenceError 已删：无围栏不再视为异常。
