import { motion } from 'framer-motion'
import { FolderOpen, KeyRound } from 'lucide-react'

const SUGGESTIONS = [
  { title: 'Map this codebase', text: 'Give me a tour of this project: its structure, main entry points, and how the pieces fit together.' },
  { title: 'Run the tests', text: 'Find out how to run the tests in this project, run them, and fix any failures you find.' },
  { title: 'Review my changes', text: 'Review the uncommitted git changes in this repository for bugs and suggest improvements.' },
  { title: 'Add a feature', text: 'Help me add a new feature. First ask me what it should do, then plan it before writing code.' }
]

interface Props {
  hasKey: boolean
  hasProject: boolean
  onOpenSettings(): void
  onPickProject(): void
  onSuggestion(text: string): void
}

export function Welcome({ hasKey, hasProject, onOpenSettings, onPickProject, onSuggestion }: Props) {
  return (
    <div className="welcome">
      <motion.div className="welcome-inner" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: 'easeOut' }}>
        <div className="orb" />
        <h1>What are we building?</h1>
        <p>Forge runs Claude as a coding agent on your machine: it reads your project, edits files, runs commands and tests, and works with git, billed straight to your Anthropic API key.</p>
        {(!hasKey || !hasProject) && (
          <div className="setup-steps">
            {!hasKey && (
              <button className="btn primary" onClick={onOpenSettings}>
                <KeyRound size={15} /> Add your API key
              </button>
            )}
            {!hasProject && (
              <button className="btn" onClick={onPickProject}>
                <FolderOpen size={15} /> Choose a project folder
              </button>
            )}
          </div>
        )}
        <div className="suggestions">
          {SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s.title}
              className="suggestion"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.06 }}
              onClick={() => onSuggestion(s.text)}
              disabled={!hasKey}
            >
              <strong>{s.title}</strong>
              {s.text}
            </motion.button>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
