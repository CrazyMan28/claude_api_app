import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { KeyRound, Loader2, MessageSquare, Pencil, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type { PublicSettings, SessionSummary } from '@shared/types'
import { dayGroup, fmtCost, relTime } from '../lib'

interface Props {
  sessions: SessionSummary[]
  currentId: string | null
  runningIds: Set<string>
  settings: PublicSettings | null
  onSelect(id: string): void
  onNew(): void
  onRename(id: string, title: string): void
  onDelete(id: string): void
  onSettings(): void
}

export function Sidebar({ sessions, currentId, runningIds, settings, onSelect, onNew, onRename, onDelete, onSettings }: Props) {
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle) || (s.projectDir ?? '').toLowerCase().includes(needle)) : sessions
    const out: { label: string; items: SessionSummary[] }[] = []
    for (const s of filtered) {
      const label = dayGroup(s.updatedAt)
      const g = out.find((x) => x.label === label)
      if (g) g.items.push(s)
      else out.push({ label, items: [s] })
    }
    return out
  }, [sessions, q])

  const commit = (id: string): void => {
    if (draft.trim()) onRename(id, draft.trim())
    setEditing(null)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="btn-new" onClick={onNew} title="New session (Ctrl+N)">
          <Plus size={16} /> New session
        </button>
        <label className="search">
          <Search size={14} />
          <input placeholder="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="session-list">
        {groups.length === 0 && <div className="empty">{q ? 'No matching sessions' : 'No sessions yet'}</div>}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="session-group">{g.label}</div>
            <AnimatePresence initial={false}>
              {g.items.map((s) => (
                <motion.div key={s.id} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}>
                  <div
                    role="button"
                    tabIndex={0}
                    className={`session-item ${s.id === currentId ? 'active' : ''}`}
                    onClick={() => editing !== s.id && onSelect(s.id)}
                    onDoubleClick={() => {
                      setEditing(s.id)
                      setDraft(s.title)
                    }}
                  >
                    {runningIds.has(s.id) ? <Loader2 size={14} className="spin" style={{ color: 'var(--accent-2)', flex: 'none' }} /> : <MessageSquare size={14} style={{ flex: 'none', opacity: 0.6 }} />}
                    {editing === s.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(s.id)
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="title" title={`${s.title}${s.projectDir ? `\n${s.projectDir}` : ''}\n${fmtCost(s.cost)} est.`}>
                        {s.title}
                      </span>
                    )}
                    {editing !== s.id && (
                      <span className="actions">
                        <button
                          className="icon-btn sm"
                          title="Rename"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditing(s.id)
                            setDraft(s.title)
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="icon-btn sm"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (confirm(`Delete "${s.title}"? This cannot be undone.`)) onDelete(s.id)
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    )}
                    <span className="meta">{relTime(s.updatedAt)}</span>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <div className="key-status">
          <KeyRound size={14} style={{ color: settings?.hasApiKey ? 'var(--ok)' : 'var(--warn)', flex: 'none' }} />
          <span>{settings?.hasApiKey ? `API key ${settings.keyHint}` : 'No API key'}</span>
        </div>
        <button className="icon-btn" onClick={onSettings} title="Settings (Ctrl+,)">
          <Settings2 size={16} />
        </button>
      </div>
    </aside>
  )
}
