'use strict'
/* eslint-disable no-console -- 日志模块本身 */

// [logger] 服务端统一日志 v2：时间轴对齐 + 标签系统 + 克制配色 + 跨平台安全
const chalk = require('chalk')

const useColor
  = process.stdout.isTTY
    && !process.env.NO_COLOR
    && process.env.FORCE_COLOR !== '0'

const c = useColor ? chalk : new chalk.Instance({ level: 0 })

const isLegacyWin
  = process.platform === 'win32'
    && !process.env.WT_SESSION
    && !process.env.TERMINUS_SUBLIME

// 将样式与逻辑分离，后续调整主题只改这里
const THEME = {
  time: c.gray,
  tag: t => c.bold.bgBlack.white(` ${t} `),
  ok: { icon: isLegacyWin ? '[OK]' : '✔', color: c.green },
  skip: { icon: isLegacyWin ? '[!!]' : '⏭', color: c.yellow },
  warn: { icon: isLegacyWin ? '[WW]' : '⚠', color: c.yellow },
  err: { icon: isLegacyWin ? '[XX]' : '✖', color: c.red },
  info: { icon: isLegacyWin ? '[..]' : 'ℹ', color: c.cyan },
  head: { icon: isLegacyWin ? '==' : '▌', color: c.bold.cyan },
  divider: c.gray('─'.repeat(60)),
}

function padTime() {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}

// 统一前缀格式：[HH:MM:SS] [TAG] ICON
// 固定宽度确保多行消息自动对齐
function prefix(tag, style) {
  const time = THEME.time(padTime())
  const t = tag ? THEME.tag(tag) : '      ' // 无 tag 时用等宽空格占位
  const icon = style.color(style.icon)
  return `${time} ${t} ${icon}`
}

const L = {
  // 基础方法保持向后兼容，默认无 tag
  ok(m) { console.log(`${prefix('', THEME.ok)}   ${m}`) },
  skip(m) { console.log(`${prefix('', THEME.skip)} ${m}`) },
  warn(m) { console.log(`${prefix('', THEME.warn)} ${m}`) },
  err(m) { console.error(`${prefix('', THEME.err)}  ${m}`) },
  info(m) { console.log(`${prefix('', THEME.info)} ${m}`) },

  // 🆕 带标签的版本：用于区分模块/阶段
  // 用法: L.tagged('DB').ok('连接成功')
  tagged(tag) {
    return {
      ok: m => console.log(`${prefix(tag, THEME.ok)}   ${m}`),
      skip: m => console.log(`${prefix(tag, THEME.skip)} ${m}`),
      warn: m => console.log(`${prefix(tag, THEME.warn)} ${m}`),
      err: m => console.error(`${prefix(tag, THEME.err)}  ${m}`),
      info: m => console.log(`${prefix(tag, THEME.info)} ${m}`),
    }
  },

  // 章节标题 + 分隔线
  head(t) {
    console.log('')
    console.log(THEME.divider)
    console.log(`  ${THEME.head.icon} ${THEME.head.color(t)}`)
    console.log(THEME.divider)
  },

  // 安全透传
  raw: console.log.bind(console),
  errRaw: console.error.bind(console),
  chalk: c,
}

L.c = function (n, s) {
  if (typeof n !== 'number' || n < 0 || n > 255) return String(s)
  return c.ansi256(n)(String(s))
}

module.exports = L
