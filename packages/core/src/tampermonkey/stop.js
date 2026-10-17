
  function bodySignature() {
    // [assistant-root-v1] 优先用「最后一条 AI 回复」容器的文本做签名
    // WHY: 整页末 300 字符在千问这类站点是输入框/页脚，AI 流式期间恒定 → 无法触发回传
    // CONSTRAINT: 容器存在且文本非空才用其签名；否则退回整页末 300 字符（旧行为，保证其他站点不回归）
    const root = latestAssistantRoot()
    const rootText = root ? (root.textContent || '').replace(/\s+/g, ' ').trim() : ''
    const t = rootText || (document.body.textContent || '').replace(/\s+/g, ' ')
    return hash32(t.slice(-300))
  }

  // [debounce-flatten-v1] 单级 350ms 节流：原 replyObserver 与 classifyAndPost 共用 replyDebounce，
  //   每次 DOM 变化都重设 2000ms；AI 流式期间 DOM 持续抖动 → 核心逻辑永远被推迟到"最后一次变化后再 2s"才执行。
  // [CONSTRAINT] 350ms 是合并流式抖动的下限；lastBodySig / seenHashes / seenDoneMarkers 已保证同内容不重复 post。
  // [CHANGE-IMPACT] 弹窗感知延迟 ~2s → ~0.35s；classifyAndPost 改为同步执行，节流由 observerDebounce 单点承担。
  // [generating-gate-v1] 生成中不发送 script/plain
  // WHY: 千问等站点流式输出（打字机），350ms 防抖间隙内脚本只出了一半；partial 的 hash 每次都变 → seenHashes 失效，连发多条残缺脚本
  // CONSTRAINT: 以「停止生成」按钮可见且可用为"仍在生成"信号；生成结束后按钮消失 → DOM 变化再触发 classifyAndPost，此时取到完整内容
  // CHANGE-IMPACT: script/plain 延迟到生成结束；DONE 整行匹配不受影响（流式中不会误出 DONE 首行）
  // [stop-btn-widen-v1] 与 findSendButton 同构：把查询范围从 'button' 扩到
  //   'button, div[role="button"]'，并纳入 data-testid。原实现只查 button，
  //   若站点把「停止生成」渲染成 div[role=button] 则必然 miss ⇒ clickStopGenerating
  //   的 Esc 兜底又未必被站点响应 ⇒ 用户实测「AI 端暂停没起作用」。
  // [stop-btn-widen-v2] 无真实 DOM 时的最宽匹配：
  //   范围扩到 button / div|span|a[role] / [role=switch|menuitem]（站点渲染成哪种都覆盖）；
  //   属性加 class / data-state；正则补 cancel|abort|interrupt|halt|终止|取消|暂停。
  //   误伤风险：class 含 stop 的普通容器可能被选中——故保留「必须可点击（非 disabled）」这一层。
  const STOP_LABEL_RE = /停止生成|停止回答|停止输出|终止|取消生成|停止|中断|暂停生成|stop\s*generat|stop\s*stream|stop\s*response|stop\s*answer|stop\s*cancel|\bcancel\b|\babort\b|\binterrupt\b|\bhalt\b/i
  // [stop-btn-scope-v1] collectStopCandidates 只搜「输入区」：页面上任何瞬态可点击元素，只要
  //   文本/属性命中 STOP_LABEL_RE（上传 Cancel、对话框「取消生成」…），都会让 isGenerating()
  //   假 true；其消失又伪造「按钮从有到无」+ roots 冻结 ⇒ 误推 kind:'stopped' 杀整个循环
  //   （2026-10-16 复检实测：空闲页一个 <button>Cancel</button> 即可走通整条链）。
  //   各站点的停止/发送按钮都位于输入区（与 findStopGeneratingBtnStructural 同 scope），
  //   取不到输入框时退回 document（无输入框页面行为不变）。
  // [RESIDUAL-RISK] 输入区**内部**的瞬态停止词元素（如附件预览里的 Cancel）仍会命中——
  //   范围收敛把面从「整页」缩到「输入区」，未清零；DeepSeek 已由图签名兜底另辟通道
  //   （[stop-btn-deepseek-icon-v1]），其余站点真清零仍需各自的发送/停止态可区分特征。
  function collectStopCandidates() {
    const sel = 'button, div[role], span[role], a[role], [role="switch"], [role="menuitem"]'
    // scope 从 parentElement 起找（不用 input.closest：输入框自身 class 含 input 时会命中自己，
    //   而 textarea 无子节点 ⇒ 停止按钮永远找不到 ⇒ generating gate 失效）
    let scope = document
    const box = findInputBox()
    const pe = box ? box.parentElement : null
    if (pe) {
      scope = pe.closest('form, [class*="input"], [class*="composer"], [class*="chat-input"], [class*="input-area"], [class*="input-box"], [class*="input_wrap"], [class*="chat-foot"], [class*="dialog-footer"]') || pe
    }
    const out = []
    for (const el of scope.querySelectorAll(sel)) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
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
    // [generating-gate-v3] 全文档兜底：智谱等站点的停止按钮可能不在输入框 scope 内，导致漏判生成中
    if (out.length === 0) {
      const docBtns = document.querySelectorAll('button, div[role="button"], span[role="button"]')
      for (const el of docBtns) {
        if (el.offsetParent === null) continue
        const txt = (el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '') + (el.textContent || '')
        if (/停止生成|停止回答|停止输出/.test(txt)) out.push(el)
      }
    }
    return out
  }
  // [stop-btn-deepseek-fallback-v1] DeepSeek 的「停止/发送」按钮实测无 aria-label/title/data-testid/textContent，
  //   仅 <div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle ..."> 可识别。
  //   STOP_LABEL_RE 的文本匹配对它恒 miss ⇒ 必须补结构化兜底。
  //   [WHY] 发送态与停止态共用同一元素，故仅凭「圆形按钮存在」**不能**判生成中（发送态恒真会把
  //   generating gate 钉死）；区分两态要靠图标，见 [stop-btn-deepseek-icon-v1]。
  //   [CHANGE-IMPACT] 仅当标签匹配全 miss 时启用；对千问等已有 aria-label 的站点零影响。
  function findStopGeneratingBtnStructural() {
    const input = findInputBox()
    if (!input) return null
    let root = input.closest('form')
    if (!root) {
      let p = input.parentElement
      for (let i = 0; i < 8 && p; i++) {
        if (p.querySelector('[role="button"].ds-button--circle, button.ds-button--circle')) { root = p; break }
        p = p.parentElement
      }
    }
    const scope = root || document
    const cand = scope.querySelectorAll('[role="button"].ds-button--circle, button.ds-button--circle')
    for (const el of cand) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
      return el
    }
    return null
  }
  // [stop-btn-deepseek-icon-v1] DeepSeek 发送/停止同元素且无标签（[stop-btn-deepseek-fallback-v1]），
  //   但两态图标不同（bundle 实证：chat.deepseek.com main.a0ce88b684.js，commit-id fd5d6ec3）：
  //   停止态 = 圆角方块（16x16，单 path，d 以 "M2 4.88C2 3.68009" 开头、含 "V11.12C14 12.3199"），
  //   发送态 = 上箭头（d 以 "M8.3125 0.980206" 开头）。
  //   判据：圆形按钮内 svg path 的 d 命中停止方块签名 ⇒ 生成中。
  // [WHY] 不用「按钮存在」直接判：发送态同元素也存在 ⇒ 恒真会让 generating gate 永不释放、脚本全卡死。
  // [FAIL-OPEN] 锚点是坐标字面量，DeepSeek 改版图标后本分支静默失效（退回修复前行为：该站点
  //   isGenerating() 恒 false），**不会**误判生成中；锚点由 stopped-btn-guard.node-test.ts 假 DOM 钉住。
  const DS_STOP_ICON_ANCHORS = ['M2 4.88C2 3.68009', 'V11.12C14 12.3199']
  function hasDeepSeekStopIcon(btn) {
    try {
      const paths = btn.querySelectorAll('svg path')
      for (let i = 0; i < paths.length; i++) {
        const d = paths[i].getAttribute('d') || ''
        if (DS_STOP_ICON_ANCHORS.some(a => d.includes(a))) return true
      }
    } catch { /* 假 DOM / 站点结构异常：按非停止态处理（fail-open） */ }
    return false
  }
  function findStopGeneratingBtn() {
    return collectStopCandidates()[0] || null
  }
  function isGenerating() {
    const btn = findStopGeneratingBtn()
    if (btn && !btn.disabled) return true
    // [site-generating-selector-v1] 智谱：生成中发送键带 .searching 类（纯图标无文本，标签通道恒 miss）；
    //   仅 chatglm.cn 命中，DeepSeek 分支（下方图签名）保持原样不受影响
    if (typeof location !== 'undefined' && /chatglm\.cn$/.test(location.hostname) && document.querySelector('.enter.is-main-chat.searching')) return true
    // [stop-btn-deepseek-icon-v1] DeepSeek 圆形按钮无标签 ⇒ 标签匹配恒 miss，用停止方块图签名名兜底