import { memo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight, Clock } from 'lucide-react'
import type { ToolMeta } from '@shared/types'
import { DiffView } from './DiffView'
import { toolDisplay } from './toolInfo'
import { diffStats, fmtCost, str } from '../lib'

export interface ToolCardProps {
  name: string
  input: Record<string, unknown>
  /** Raw partial JSON while the input is still streaming */
  partialInput?: string
  result?: { text: string; isError: boolean }
  meta?: ToolMeta
  state: 'streaming' | 'running' | 'waiting' | 'done' | 'orphan'
  progress?: string[]
}

function inputPreview(name: string, input: Record<string, unknown>): string | null {
  if (name === 'write_file') return null
  if (name === 'edit_file') return null
  if (name === 'run_command') return str(input.command)
  if (name === 'task') return str(input.prompt)
  const keys = Object.keys(input)
  return keys.length ? JSON.stringify(input, null, 2) : null
}

export const ToolCard = memo(function ToolCard({ name, input, partialInput, result, meta, state, progress }: ToolCardProps) {
  const d = toolDisplay(name, input)
  const status = state === 'done' ? (meta?.status ?? (result?.isError ? 'error' : 'ok')) : state
  const autoOpen = (name === 'edit_file' || name === 'write_file') && !!meta?.diff
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? (autoOpen || state === 'running' || state === 'streaming')
  const stats = meta?.diff ? diffStats(meta.diff) : null
  const preview = inputPreview(name, input)

  const badge = (() => {
    switch (status) {
      case 'streaming':
        return <span className="badge running"><span className="pulse-dot" /> writing</span>
      case 'running':
        return <span className="badge running"><span className="pulse-dot" /> running</span>
      case 'waiting':
        return <span className="badge denied"><span className="pulse-dot" /> needs approval</span>
      case 'ok':
        return <span className="badge ok">done</span>
      case 'error':
        return <span className="badge error">error</span>
      case 'denied':
        return <span className="badge denied">denied</span>
      case 'interrupted':
        return <span className="badge interrupted">interrupted</span>
      default:
        return <span className="badge">no result</span>
    }
  })()

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className={`tool ${status === 'running' || status === 'streaming' ? 'running' : ''} ${status === 'error' ? 'error' : ''} ${status === 'denied' ? 'denied' : ''}`}
    >
      <button className="tool-head" onClick={() => setOpen(!isOpen)}>
        <span className={`tool-icon ${d.category}`}>{d.icon}</span>
        <span className="tool-title">{d.title}</span>
        {stats && (
          <span className="tool-name">
            <span className="diff-stat-add">+{stats.add}</span> <span className="diff-stat-del">−{stats.del}</span>
          </span>
        )}
        {meta?.durationMs !== undefined && meta.durationMs > 900 && (
          <span className="tool-name" title="duration">
            <Clock size={11} style={{ verticalAlign: -1 }} /> {(meta.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {badge}
        <ChevronRight size={14} style={{ color: 'var(--text-3)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} style={{ overflow: 'hidden' }}>
            <div className="tool-body">
              {state === 'streaming' && partialInput !== undefined && (
                <pre className="codeblock">{partialInput.slice(-4000) || '…'}</pre>
              )}
              {state !== 'streaming' && preview && (
                <>
                  <div className="tool-label">{name === 'task' ? 'Prompt' : name === 'run_command' ? 'Command' : 'Input'}</div>
                  <pre className="codeblock">{preview}</pre>
                </>
              )}
              {meta?.diff && <DiffView diff={meta.diff} title={meta.path} maxHeight={380} />}
              {!meta?.diff && name === 'write_file' && state !== 'streaming' && (
                <pre className="codeblock">{str(input.content).slice(0, 20000)}</pre>
              )}
              {progress && progress.length > 0 && (
                <>
                  <div className="tool-label">Subagent activity</div>
                  <div className="subagent-log">{progress.map((p, i) => <div key={i}>{p}</div>)}</div>
                </>
              )}
              {meta?.subagent && (
                <div className="muted">
                  {meta.subagent.model} · {meta.subagent.steps} steps · {fmtCost(meta.subagent.cost)} est.
                </div>
              )}
              {result && !(meta?.diff && !result.isError) && (
                <>
                  <div className="tool-label">{result.isError ? 'Error' : 'Output'}</div>
                  <pre className="codeblock" style={result.isError ? { color: '#ffc2cc' } : undefined}>{result.text}</pre>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
})
