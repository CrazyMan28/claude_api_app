import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, ExternalLink, FileDiff, GitBranch, RefreshCw } from 'lucide-react'
import type { GitCommit, GitStatus, PublicSettings, Session, UsageSummary } from '@shared/types'
import { addUsage, ZERO_USAGE } from '@shared/models'
import { DiffView } from './DiffView'
import { diffStats, fmtCost, fmtTokens, totalIn } from '../lib'

type Tab = 'changes' | 'git' | 'usage'

interface Props {
  session: Session | null
  settings: PublicSettings | null
  running: boolean
  refreshKey: number
}

export function SidePanel({ session, settings, running, refreshKey }: Props) {
  const [tab, setTab] = useState<Tab>('changes')
  const changes = useMemo(() => {
    if (!session) return []
    // latest diff per file, in order of first change
    const byPath = new Map<string, { path: string; diffs: string[] }>()
    for (const m of session.messages) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue
      for (const b of m.content) {
        if (b.type !== 'tool_use') continue
        const meta = session.toolMeta[String(b.id)]
        if (!meta?.diff || meta.status !== 'ok' || !meta.path) continue
        const row = byPath.get(meta.path) ?? { path: meta.path, diffs: [] }
        row.diffs.push(meta.diff)
        byPath.set(meta.path, row)
      }
    }
    return [...byPath.values()]
  }, [session])

  return (
    <aside className="side-panel">
      <div className="tabs">
        <button className={`tab ${tab === 'changes' ? 'on' : ''}`} onClick={() => setTab('changes')}>
          <FileDiff size={14} /> Changes {changes.length > 0 && <span className="count">{changes.length}</span>}
        </button>
        <button className={`tab ${tab === 'git' ? 'on' : ''}`} onClick={() => setTab('git')}>
          <GitBranch size={14} /> Git
        </button>
        <button className={`tab ${tab === 'usage' ? 'on' : ''}`} onClick={() => setTab('usage')}>
          <BarChart3 size={14} /> Usage
        </button>
      </div>
      <div className="panel-body">
        {tab === 'changes' && <ChangesTab changes={changes} />}
        {tab === 'git' && <GitTab dir={session?.projectDir ?? null} running={running} refreshKey={refreshKey} />}
        {tab === 'usage' && <UsageTab session={session} settings={settings} refreshKey={refreshKey} />}
      </div>
    </aside>
  )
}

function ChangesTab({ changes }: { changes: { path: string; diffs: string[] }[] }) {
  const [sel, setSel] = useState<string | null>(null)
  const current = changes.find((c) => c.path === sel) ?? changes[changes.length - 1]
  if (!changes.length) return <div className="empty">Files Claude edits in this session appear here with their diffs.</div>
  return (
    <>
      <div className="panel-section">
        <div className="panel-title">Edited this session</div>
        {changes.map((c) => {
          const st = c.diffs.map(diffStats).reduce((a, b) => ({ add: a.add + b.add, del: a.del + b.del }), { add: 0, del: 0 })
          return (
            <button key={c.path} className={`file-row ${current?.path === c.path ? 'on' : ''}`} onClick={() => setSel(c.path)}>
              <span className="path">{c.path}</span>
              <span className="diff-stat-add">+{st.add}</span>
              <span className="diff-stat-del">−{st.del}</span>
            </button>
          )
        })}
      </div>
      {current && (
        <div className="panel-section">
          <div className="panel-title">
            {current.diffs.length > 1 ? `${current.diffs.length} edits` : 'Diff'}
          </div>
          {current.diffs.map((d, i) => (
            <DiffView key={i} diff={d} title={`${current.path}${current.diffs.length > 1 ? ` · edit ${i + 1}` : ''}`} />
          ))}
        </div>
      )}
    </>
  )
}

function GitTab({ dir, running, refreshKey }: { dir: string | null; running: boolean; refreshKey: number }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!dir) return
    setLoading(true)
    try {
      const [s, l] = await Promise.all([window.forge.gitStatus(dir), window.forge.gitLog(dir)])
      setStatus(s)
      setLog(l)
    } finally {
      setLoading(false)
    }
  }, [dir])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey, running])

  useEffect(() => {
    if (!dir || !sel) {
      setDiff('')
      return
    }
    window.forge
      .gitDiff(dir, sel.path, sel.staged)
      .then(setDiff)
      .catch((e: Error) => setDiff(`error: ${e.message}`))
  }, [dir, sel, refreshKey])

  if (!dir) return <div className="empty">Choose a project folder to see its git status.</div>
  if (status && !status.isRepo) return <div className="empty">This folder is not a git repository.<br />Ask Claude to run <code>git init</code> if you want one.</div>

  return (
    <>
      <div className="panel-section">
        <div className="panel-title">
          <GitBranch size={12} /> <span className="grow">{status?.branch ?? '…'}</span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span>
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
          <button className="icon-btn sm" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>
        {status?.files.length === 0 && <div className="muted">Working tree clean.</div>}
        {status?.files.map((f) => {
          const staged = f.index !== ' ' && f.index !== '?'
          const letter = f.index === '?' ? 'U' : (staged ? f.index : f.worktree).trim() || 'M'
          return (
            <button key={f.path} className={`file-row ${sel?.path === f.path ? 'on' : ''}`} onClick={() => setSel({ path: f.path, staged: staged && f.worktree === ' ' })}>
              <span className={`status-letter ${letter}`}>{letter}</span>
              <span className="path">{f.path}</span>
              {staged && <span className="muted">staged</span>}
            </button>
          )
        })}
      </div>
      {sel && (
        <div className="panel-section">
          <div className="panel-title">Diff</div>
          {diff ? <DiffView diff={diff} title={sel.path} /> : <div className="muted">{status?.files.find((f) => f.path === sel.path)?.index === '?' ? 'Untracked file (no diff yet).' : 'No diff.'}</div>}
        </div>
      )}
      <div className="panel-section">
        <div className="panel-title">Recent commits</div>
        {log.length === 0 && <div className="muted">No commits yet.</div>}
        {log.map((c) => (
          <div key={c.hash} className="commit">
            <span className="subject">{c.subject}</span>
            <span className="by">
              <span className="hash">{c.hash}</span> · {c.author} · {new Date(c.date).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

function Limit({ label, spent, limit }: { label: string; spent: number; limit: number }) {
  if (!limit) {
    return (
      <div className="kv">
        <span>{label} limit</span>
        <span className="muted">none</span>
      </div>
    )
  }
  const pct = Math.min(100, (spent / limit) * 100)
  return (
    <div className="panel-section" style={{ gap: 4 }}>
      <div className="kv">
        <span>{label} limit</span>
        <span>
          {fmtCost(spent, 2)} / {fmtCost(limit, 2)}
        </span>
      </div>
      <div className={`meter ${pct > 80 ? 'hot' : ''}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function UsageTab({ session, settings, refreshKey }: { session: Session | null; settings: PublicSettings | null; refreshKey: number }) {
  const [sum, setSum] = useState<UsageSummary | null>(null)
  useEffect(() => {
    void window.forge.usageSummary().then(setSum)
  }, [refreshKey, session?.usage.length])

  const sess = useMemo(() => {
    let usage = ZERO_USAGE
    let cost = 0
    let unpriced = false
    for (const r of session?.usage ?? []) {
      usage = addUsage(usage, r.usage)
      if (r.cost === null) unpriced = true
      else cost += r.cost
    }
    for (const meta of Object.values(session?.toolMeta ?? {})) {
      if (meta.subagent) {
        usage = addUsage(usage, meta.subagent.usage)
        cost += meta.subagent.cost ?? 0
      }
    }
    return { usage, cost, unpriced, requests: session?.usage.length ?? 0 }
  }, [session])

  return (
    <>
      <div className="info-box">
        <span>
          Costs are <strong>estimates</strong> from the token counts the API reports × Anthropic's published prices. Forge cannot see your credit balance;
          check it in the Console.{' '}
          <button className="link" onClick={() => void window.forge.openExternal('https://platform.claude.com/settings/billing')}>
            Open billing <ExternalLink size={11} />
          </button>
        </span>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <span className="muted">This session</span>
          <span className="big">{fmtCost(sess.cost, 3)}</span>
          <span className="sub">
            {sess.requests} req · {fmtTokens(totalIn(sess.usage))} in · {fmtTokens(sess.usage.output)} out
          </span>
        </div>
        <div className="stat-card">
          <span className="muted">Today</span>
          <span className="big">{fmtCost(sum?.today.cost ?? 0, 3)}</span>
          <span className="sub">{sum?.today.requests ?? 0} requests</span>
        </div>
        <div className="stat-card">
          <span className="muted">This month</span>
          <span className="big">{fmtCost(sum?.month.cost ?? 0, 2)}</span>
          <span className="sub">{sum?.month.requests ?? 0} requests</span>
        </div>
        <div className="stat-card">
          <span className="muted">Cache hits</span>
          <span className="big">{totalIn(sess.usage) ? Math.round((sess.usage.cacheRead / totalIn(sess.usage)) * 100) : 0}%</span>
          <span className="sub">{fmtTokens(sess.usage.cacheRead)} cached input</span>
        </div>
      </div>
      {settings && (
        <div className="panel-section">
          <div className="panel-title">Spending limits (estimated)</div>
          <Limit label="Session" spent={sess.cost} limit={settings.limitPerSession} />
          <Limit label="Daily" spent={sum?.today.cost ?? 0} limit={settings.limitDaily} />
          <Limit label="Monthly" spent={sum?.month.cost ?? 0} limit={settings.limitMonthly} />
        </div>
      )}
      <div className="panel-section">
        <div className="panel-title">Session tokens</div>
        <div className="kv">
          <span>Uncached input</span>
          <span>{sess.usage.input.toLocaleString()}</span>
          <span>Cache reads</span>
          <span>{sess.usage.cacheRead.toLocaleString()}</span>
          <span>Cache writes</span>
          <span>{(sess.usage.cacheWrite5m + sess.usage.cacheWrite1h).toLocaleString()}</span>
          <span>Output (incl. thinking)</span>
          <span>{sess.usage.output.toLocaleString()}</span>
        </div>
      </div>
      {sum && sum.byModel.length > 0 && (
        <div className="panel-section">
          <div className="panel-title">All time by model</div>
          <div className="kv">
            {sum.byModel.map((m) => (
              <FragmentRow key={m.model} label={`${m.model} · ${m.requests} req`} value={fmtCost(m.cost, 3)} />
            ))}
          </div>
          {sum.unpricedRequests > 0 && <div className="muted">{sum.unpricedRequests} request(s) used a model without a known price and are not included.</div>}
        </div>
      )}
    </>
  )
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span>{label}</span>
      <span>{value}</span>
    </>
  )
}
