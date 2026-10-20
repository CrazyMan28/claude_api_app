import type { GitCommit, GitStatus } from '@shared/types'
import { runProcess } from './exec'

export async function git(dir: string, args: string[], signal?: AbortSignal): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await runProcess('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
    cwd: dir,
    timeoutMs: 60_000,
    signal
  })
  return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr.trim() || (r.exitCode === null ? 'git could not be started' : '') }
}

/** Parse `git status --porcelain=v1 -b`. Exported for tests. */
export function parsePorcelain(text: string): Omit<GitStatus, 'isRepo'> {
  const lines = text.split('\n').filter((l) => l.length > 0)
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitStatus['files'] = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      // e.g. "main...origin/main [ahead 1, behind 2]", "No commits yet on main"
      let head = line.slice(3).replace(/^No commits yet on /, '')
      let info = ''
      const bracket = head.indexOf(' [')
      if (bracket >= 0) {
        info = head.slice(bracket + 2, -1)
        head = head.slice(0, bracket)
      }
      branch = head.split('...')[0] ?? head
      ahead = Number(/ahead (\d+)/.exec(info)?.[1] ?? 0)
      behind = Number(/behind (\d+)/.exec(info)?.[1] ?? 0)
      continue
    }
    const index = line[0] ?? ' '
    const worktree = line[1] ?? ' '
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    files.push({ path: path.replace(/^"|"$/g, ''), index, worktree })
  }
  return { branch, ahead, behind, files }
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') {
    return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [], error: inside.err || undefined }
  }
  const st = await git(dir, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
  if (!st.ok) return { isRepo: true, branch: null, ahead: 0, behind: 0, files: [], error: st.err }
  return { isRepo: true, ...parsePorcelain(st.out) }
}

export async function gitDiff(dir: string, file?: string, staged?: boolean): Promise<string> {
  const args = ['diff', '--no-ext-diff']
  if (staged) args.push('--cached')
  if (file) args.push('--', file)
  const r = await git(dir, args)
  if (!r.ok) throw new Error(r.err || 'git diff failed')
  return r.out
}

export async function gitLog(dir: string, n = 30): Promise<GitCommit[]> {
  const r = await git(dir, ['log', `-n${n}`, '--date=iso-strict', '--pretty=format:%h%x1f%s%x1f%an%x1f%ad'])
  if (!r.ok) return []
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, date] = l.split('\x1f')
      return { hash: hash ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '' }
    })
}
