// [worklog-pane-helpers-v1] WorklogPane 的纯函数助手：从 996 行的组件中抽出，
//   降低单文件体积（§4 组件 ≤ 1000 行）。
// [CONSTRAINT] 只装「无状态纯函数」：给输入即得输出，不引用任何 ref / computed / window。
//   有状态的 git/svn 交互仍留在 worklog-git-actions.ts / worklog-svn.ts / worklog-commit.ts。

/** 工作日志变更行的展示结构（staged / unstaged 两栏共用） */
export interface WorklogRow {
  path: string
  status: string
  name: string
  dir: string
  stCls: string
  stLetter: string
  added: number
  removed: number
  diff: string
}

/** 状态字母：M=modified A=added D=deleted R=renamed C=copied（默认 M） */
export function statusLetter(s: string): string {
  if (s === 'added') return 'A'
  if (s === 'deleted') return 'D'
  if (s === 'renamed') return 'R'
  if (s === 'copied') return 'C'
  return 'M'
}

/** 状态颜色分类（供 CSS 选择 st-add / st-del / st-move / st-mod） */
export function statusClass(s: string): string {
  if (s === 'added') return 'st-add'
  if (s === 'deleted') return 'st-del'
  if (s === 'renamed' || s === 'copied') return 'st-move'
  return 'st-mod'
}

/** 拆分路径为目录段与文件名（保留目录末尾 `/`，与 VSCode 展示一致） */
export function splitPath(p: string): { dir: string, name: string } {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}

/**
 * 按暂存方向过滤文件为行数据。
 * [WHY] 一个文件可同时出现在两栏（MM 状态：部分改动已暂存、部分未暂存），与 VSCode 一致。
 * @param files status 源
 * @param wantStaged true=取已暂存栏，false=取未暂存栏
 * @param stats 按路径取增删行数的映射（组件侧从 computed 传入）
 */
export function rowsFor(
  files: Array<{ path: string, status: string, staged: boolean, unstaged: boolean }>,
  wantStaged: boolean,
  stats: Map<string, { added: number, removed: number, diff: string }>,
): WorklogRow[] {
  const out: WorklogRow[] = []
  for (const f of files) {
    const inThis = wantStaged ? f.staged : f.unstaged
    if (!inThis) continue
    const sp = splitPath(f.path)
    const st = stats.get(f.path)
    out.push({
      path: f.path,
      status: f.status,
      name: sp.name,
      dir: sp.dir,
      stCls: statusClass(f.status),
      stLetter: statusLetter(f.status),
      added: st?.added || 0,
      removed: st?.removed || 0,
      diff: st?.diff || '',
    })
  }
  return out
}
