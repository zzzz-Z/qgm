// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] IIFE 物理切分片段，非独立模块；跨片段符号在单文件检查下不可见。
//   全部片段 TS 化完成、按拼回后的联合视图接线后再移除本 pragma。

/**
 * 生成中判定 —— 「现在 AI 是否仍在输出」。
 * [WHY] 这道门是脚本回传的最后一道闸：判错成 false 就会把流式半截脚本推出去，
 *   下游 /run 报 Unexpected end of input，与上游真截断完全同形，排查成本极高。
 *
 * 三条判据按「可靠性从高到低」排列，任一命中即为生成中：
 *   ① 标签通道：输入区内的可点击元素，文本/属性命中停止语义。
 *   ② 站点专属：适配器声明的 generatingSelector（智谱 .enter.is-main-chat.searching）。
 *   ③ 图签名兜底：DeepSeek 圆钮内 svg path 命中停止方块锚点。
 *
 * [CONSTRAINT] 三者必须互相隔离：②③ 只对各自站点生效，不得让某个站点的选择器
 *   影响其它站点的判定结果——否则修一个站点会静默破坏另一个。
 */

/**
 * 停止语义正则。
 * [CONSTRAINT] 必须与 headless-inject.ts 的同名常量同值：两通道对同一按钮给出不同判定，
 *   会让「无头通道认为已结束、油猴通道认为仍在生成」，表现为两条通道回传节奏分叉。
 */
const STOP_LABEL_RE = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i

/**
 * 收集候选停止按钮，范围收敛到「输入区」。
 * [WHY] 早期实现搜整页：页面上任何瞬态可点击元素（上传 Cancel、对话框「取消生成」…）
 *   只要命中正则就让 isGenerating() 假 true；其消失又伪造「按钮从有到无」+ roots 冻结，
 *   于是误推 stopped 杀掉整个循环（实测一个空闲页的 <button>Cancel</button> 即可走通）。
 * [CONSTRAINT] scope 从 parentElement 起 closest，不用 input.closest ——
 *   输入框自身 class 常含 input，会命中自己；而 textarea 无子节点，停止按钮就永远找不到。
 * [RESIDUAL-RISK] 输入区**内部**的瞬态停止词元素（附件预览里的 Cancel）仍会命中；
 *   范围收敛把面从整页缩到输入区，未清零。
 */
function collectStopCandidates(): Element[] {
  const sel = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'
  let scope: ParentNode = document
  const box = findInputBox()
  const pe = box ? box.parentElement : null
  if (pe) {
    scope = pe.closest('form, [class*="input"], [class*="composer"], [class*="chat-input"], [class*="input-area"], [class*="input-box"], [class*="input_wrap"], [class*="chat-foot"], [class*="dialog-footer"]') || pe
  }
  const out: Element[] = []
  for (const el of Array.from(scope.querySelectorAll(sel))) {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue
    const lbl = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-state'),
      el.getAttribute('class'),
      el.textContent,
    ].filter(Boolean).join(' ')
    if (STOP_LABEL_RE.test(lbl)) out.push(el)
  }
  return out
}

/**
 * 结构化兜底：输入区附近的圆形主按钮（无任何可匹配标签）。
 * [WHY] DeepSeek 的停止/发送按钮共用同一元素且无 aria-label/title/textContent，
 *   标签通道对它恒 miss，只能靠结构定位。
 * [CONSTRAINT] 发送态与停止态共用同一元素 ⇒ 仅凭「圆钮存在」不能判生成中，
 *   必须再由 hasDeepSeekStopIcon 区分两态（见下）。
 */
function findStopGeneratingBtnStructural(): Element | null {
  const input = findInputBox()
  if (!input) return null
  let root: Element | null = input.closest('form')
  if (!root) {
    let p: Element | null = input.parentElement
    for (let i = 0; i < 8 && p; i++) {
      if (p.querySelector('[role="button"].ds-button--circle, button.ds-button--circle')) { root = p; break }
      p = p.parentElement
    }
  }
  const scope: ParentNode = root || document
  for (const el of Array.from(scope.querySelectorAll('[role="button"].ds-button--circle, button.ds-button--circle'))) {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue
    return el
  }
  return null
}

/**
 * DeepSeek 停止方块图签名锚点（线上 bundle 实证：commit fd5d6ec3）。
 * 停止态 = 圆角方块（单 path，以 "M2 4.88C2 3.68009" 开头、含 "V11.12C14 12.3199"）；
 * 发送态 = 上箭头（"M8.3125 0.980206"）。
 * [FAIL-OPEN] 锚点是坐标字面量，站点改版后本分支静默失效（该站点 isGenerating 恒 false），
 *   **不会**误判生成中；失效信号可通过 stop 诊断的 dsIcon 字段观测（hit / miss / na）。
 * [CONSTRAINT] 与 headless-inject.ts 的 dsAnchors 同值，改一处必须同步另一处。
 */
const DS_STOP_ICON_ANCHORS = ['M2 4.88C2 3.68009', 'V11.12C14 12.3199']

function hasDeepSeekStopIcon(btn: Element): boolean {
  try {
    const paths = btn.querySelectorAll('svg path')
    for (let i = 0; i < paths.length; i++) {
      const d = paths[i].getAttribute('d') || ''
      if (DS_STOP_ICON_ANCHORS.some(a => d.includes(a))) return true
    }
  } catch { /* 站点结构异常：按非停止态处理（fail-open，宁可不判也不误判） */ }
  return false
}

function findStopGeneratingBtn(): Element | null {
  return collectStopCandidates()[0] || null
}

/**
 * 生成中总判据。
 * [CONSTRAINT] 顺序不可随意调换：标签通道（最可靠、跨站点）先行；
 *   站点专属与图签名兜底各自 fail-open，且互不影响对方的站点。
 */
function isGenerating(): boolean {
  const btn = findStopGeneratingBtn()
  if (btn && !(btn as HTMLButtonElement).disabled) return true

  // [site-generating-selector-v1] 智谱：生成中发送键带 .searching 类（纯图标无文本，标签通道恒 miss）；
  //   仅 chatglm.cn 生效，DeepSeek 分支（下方图签名）保持原样不受影响。
  if (typeof location !== 'undefined'
    && /chatglm\.cn$/.test(location.hostname)
    && document.querySelector('.enter.is-main-chat.searching')) return true

  // DeepSeek 图签名兜底：圆钮存在且图标为停止方块才算生成中
  const dsBtn = findStopGeneratingBtnStructural()
  return Boolean(dsBtn && !(dsBtn as HTMLButtonElement).disabled && hasDeepSeekStopIcon(dsBtn))
}
