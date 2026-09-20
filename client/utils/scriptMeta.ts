// 脚本头元数据解析（@desc / @why / @plan / @done）与语言识别。
// 兼容 // 与 # 两种注释前缀（js / bash / cjs）。

export interface ScriptMeta {
  desc: string
  why: string
  plan: string
  done: string
}

export function parseScriptMeta(code: string): ScriptMeta {
  const pick = (name: string): string => {
    const re = new RegExp(`^[ \\t]*(?://|#)[ \\t]*@${name}[ \\t]*:[ \\t]*(.+)$`, 'm')
    const m = code.match(re)
    return m ? m[1].trim() : ''
  }
  return {
    desc: pick('desc'),
    why: pick('why'),
    plan: pick('plan'),
    done: pick('done'),
  }
}

export function detectLang(code: string): 'js' | 'bash' {
  return /^[ \t]*#[ \t]*@(?:desc|why)/m.test(code) ? 'bash' : 'js'
}
