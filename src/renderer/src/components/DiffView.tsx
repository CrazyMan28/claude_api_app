import { memo, useMemo } from 'react'

interface Line {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'file'
  text: string
  oldNo?: number
  newNo?: number
}

/** Parse a unified diff (git or jsdiff output) into renderable lines. */
export function parseUnified(diff: string): Line[] {
  const out: Line[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      out.push({ kind: 'file', text: raw.replace(/^diff --git a\/(.*) b\/.*$/, '$1') })
      continue
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('====') || raw.startsWith('Index: ')) continue
    if (raw.startsWith('new file mode') || raw.startsWith('deleted file mode') || raw.startsWith('similarity index') || raw.startsWith('rename ')) continue
    if (raw.startsWith('\\ No newline')) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      out.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ })
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ })
    else if (raw.startsWith(' ')) out.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return out
}

export const DiffView = memo(function DiffView({ diff, title, maxHeight }: { diff: string; title?: string; maxHeight?: number }) {
  const lines = useMemo(() => parseUnified(diff), [diff])
  const stats = useMemo(() => {
    let add = 0
    let del = 0
    for (const l of lines) {
      if (l.kind === 'add') add++
      else if (l.kind === 'del') del++
    }
    return { add, del }
  }, [lines])
  if (!lines.some((l) => l.kind === 'add' || l.kind === 'del')) {
    return <div className="diff" style={{ padding: 12, color: 'var(--text-3)' }}>No changes.</div>
  }
  return (
    <div className="diff" style={maxHeight ? { maxHeight } : undefined}>
      {title && (
        <div className="diff-file">
          <span style={{ flex: 1 }}>{title}</span>
          <span className="diff-stat-add">+{stats.add}</span>
          <span className="diff-stat-del">−{stats.del}</span>
        </div>
      )}
      {lines.map((l, i) =>
        l.kind === 'file' ? (
          <div key={i} className="diff-file">{l.text}</div>
        ) : l.kind === 'hunk' ? (
          <div key={i} className="diff-hunk">{l.text}</div>
        ) : (
          <div key={i} className={`diff-line ${l.kind}`}>
            <span className="ln">{l.oldNo ?? ''}</span>
            <span className="ln">{l.newNo ?? ''}</span>
            <span className="code">{l.text}</span>
          </div>
        )
      )}
    </div>
  )
})
