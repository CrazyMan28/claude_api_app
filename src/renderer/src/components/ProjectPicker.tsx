import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, FolderOpen, Loader2, X } from 'lucide-react'
import { basename } from '../lib'

interface Props {
  current: string | null
  onPick(dir: string): void
  onClose(): void
}

/** Phone: choose one of the project folders already used on the PC. */
export function ProjectPicker({ current, onPick, onClose }: Props) {
  const [dirs, setDirs] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.forge
      .listProjects()
      .then(setDirs)
      .catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="modal picker" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}>
        <div className="modal-head">
          <h2>Project folder</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {!dirs && !error && <Loader2 size={18} className="spin" />}
          {error && <div className="test-result err">{error}</div>}
          {dirs?.length === 0 && <div className="muted">No project folders yet. Choose a folder once in Forge on your PC and it will show up here.</div>}
          <div className="project-list">
            {dirs?.map((d) => (
              <button key={d} className={`project-row ${d === current ? 'on' : ''}`} onClick={() => onPick(d)}>
                <FolderOpen size={16} />
                <span className="grow">
                  <strong>{basename(d)}</strong>
                  <span className="muted">{d}</span>
                </span>
                {d === current && <Check size={16} style={{ color: 'var(--ok)' }} />}
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            For safety the phone can only use folders that were already opened on the PC.
          </div>
        </div>
      </motion.div>
    </div>
  )
}
