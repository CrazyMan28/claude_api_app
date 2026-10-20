import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { Check, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { DiffView } from './DiffView'
import { toolDisplay } from './toolInfo'
import { str } from '../lib'

export function ApprovalCard({ request, onDecide }: { request: ApprovalRequest; onDecide(d: ApprovalDecision): void }) {
  const d = toolDisplay(request.tool, request.input)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (e.key === 'y' || (e.key === 'Enter' && e.ctrlKey)) onDecide('approve')
      if (e.key === 'n') onDecide('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide])

  const always = request.tool === 'run_command' ? 'Always allow commands' : 'Always allow edits'
  return (
    <motion.div className="approval" initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
      <div className="approval-head">
        <ShieldAlert size={18} />
        <span style={{ flex: 1 }}>Claude wants to {request.tool === 'run_command' ? 'run a command' : request.tool === 'write_file' ? 'write a file' : 'edit a file'}</span>
        <span className={`tool-icon ${d.category}`}>{d.icon}</span>
      </div>
      {request.tool === 'run_command' ? (
        <pre className="codeblock">{str(request.input.command)}</pre>
      ) : request.diff ? (
        <DiffView diff={request.diff} title={request.summary} maxHeight={280} />
      ) : (
        <div className="muted">{request.summary}</div>
      )}
      <div className="approval-actions">
        <button className="btn danger" onClick={() => onDecide('deny')}>
          <X size={14} /> Deny <kbd>N</kbd>
        </button>
        <button className="btn" onClick={() => onDecide('always')} title="Approve this and future calls of this tool in this session">
          <ShieldCheck size={14} /> {always}
        </button>
        <button className="btn ok" onClick={() => onDecide('approve')}>
          <Check size={14} /> Approve <kbd>Y</kbd>
        </button>
      </div>
    </motion.div>
  )
}
