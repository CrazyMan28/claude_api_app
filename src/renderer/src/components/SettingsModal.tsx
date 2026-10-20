import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, Trash2, X, XCircle } from 'lucide-react'
import type { ApiKeyTestResult, ApprovalMode, PublicSettings, Settings } from '@shared/types'
import { EFFORTS, MODELS, type Effort } from '@shared/models'

interface Props {
  settings: PublicSettings
  availableModels: string[] | null
  onClose(): void
  onChange(s: PublicSettings): void
  onModels(ids: string[]): void
}

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  ask: 'Ask before edits and commands',
  'auto-edits': 'Auto-approve edits, ask before commands',
  auto: 'Auto-approve everything (careful)',
  'read-only': 'Read-only (block edits and commands)'
}

export function ModelOptions({ available }: { available: string[] | null }) {
  const known = new Set(MODELS.map((m) => m.id))
  const extra = (available ?? []).filter((id) => !known.has(id) && id.startsWith('claude-'))
  return (
    <>
      {MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
          {available && !available.includes(m.id) ? ' (not listed for your org)' : ''} · ${m.input}/${m.output} per MTok
        </option>
      ))}
      {extra.map((id) => (
        <option key={id} value={id}>
          {id} (price unknown)
        </option>
      ))}
    </>
  )
}

export function SettingsModal({ settings, availableModels, onClose, onChange, onModels }: Props) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<ApiKeyTestResult | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = async (patch: Partial<Settings>): Promise<void> => {
    onChange(await window.forge.updateSettings(patch))
  }

  const runTest = async (): Promise<void> => {
    setBusy(true)
    setTest(null)
    try {
      const r = await window.forge.testApiKey()
      setTest(r)
      if (r.models) onModels(r.models)
    } finally {
      setBusy(false)
    }
  }

  const saveKey = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      onChange(await window.forge.setApiKey(key))
      setKey('')
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
      return
    }
    setBusy(false)
    await runTest()
  }

  const num = (v: string): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="modal" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 360, damping: 30 }}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <section className="field-group">
            <h3>
              <KeyRound size={13} /> Anthropic API key
            </h3>
            <div className="key-card">
              {settings.hasApiKey ? (
                <div className="input-row">
                  <ShieldCheck size={16} style={{ color: 'var(--ok)' }} />
                  <span style={{ flex: 1 }}>
                    Saved: <code>{settings.keyHint}</code> <span className="muted">· encrypted with {window.forge.platform === 'win32' ? 'Windows DPAPI' : 'the OS keychain'}</span>
                  </span>
                  <button className="btn" onClick={() => void runTest()} disabled={busy}>
                    {busy ? <Loader2 size={14} className="spin" /> : null} Test
                  </button>
                  <button
                    className="btn danger"
                    onClick={async () => {
                      if (confirm('Remove the saved API key?')) {
                        onChange(await window.forge.clearApiKey())
                        setTest(null)
                      }
                    }}
                  >
                    <Trash2 size={14} /> Remove
                  </button>
                </div>
              ) : (
                <div className="muted">
                  Paste an API key from the Claude Console (API keys page). It is encrypted with your Windows account (DPAPI) and never leaves this computer except to authenticate requests to api.anthropic.com.
                </div>
              )}
              <div className="input-row">
                <input
                  className="input mono"
                  type={show ? 'text' : 'password'}
                  placeholder={settings.hasApiKey ? 'Paste a new key to replace it' : 'sk-ant-api03-…'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && key && void saveKey()}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="icon-btn" onClick={() => setShow(!show)} title={show ? 'Hide' : 'Show'}>
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button className="btn primary" disabled={!key.trim() || busy} onClick={() => void saveKey()}>
                  Save & test
                </button>
              </div>
              {error && (
                <div className="test-result err">
                  <XCircle size={14} /> {error}
                </div>
              )}
              {test && (
                <div className={`test-result ${test.ok ? 'ok' : 'err'}`}>
                  {test.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} <span>{test.message}</span>
                </div>
              )}
              {!settings.encryptionAvailable && <div className="test-result err">OS-level encryption is unavailable, so keys cannot be stored.</div>}
              <div className="muted">
                The test makes one tiny request to Claude Haiku 5.5 (a tiny fraction of a cent) to confirm the key can bill.{' '}
                <button className="link" onClick={() => void window.forge.openExternal('https://platform.claude.com/settings/keys')}>
                  Manage keys <ExternalLink size={11} />
                </button>
              </div>
            </div>
          </section>

          <section className="field-group">
            <h3>Model defaults for new sessions</h3>
            <div className="field">
              <label>Model</label>
              <select className="input" value={settings.defaultModel} onChange={(e) => void update({ defaultModel: e.target.value })}>
                <ModelOptions available={availableModels} />
              </select>
            </div>
            <div className="field">
              <label>Thinking effort</label>
              <select className="input" value={settings.defaultEffort} onChange={(e) => void update({ defaultEffort: e.target.value as Effort })}>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
              <div className="help">Higher effort means deeper reasoning and more output tokens. "high" is a strong default for coding; "xhigh"/"max" for the hardest problems.</div>
            </div>
            <div className="field">
              <label>Refusal fallback</label>
              <button className={`toggle ${settings.refusalFallback ? 'on' : ''}`} onClick={() => void update({ refusalFallback: !settings.refusalFallback })} aria-label="toggle fallback" />
              <div className="help">If a safety classifier declines a request, let the API retry it on Anthropic's recommended fallback model (fallbacks: "default"). Billed at that model's rates.</div>
            </div>
          </section>

          <section className="field-group">
            <h3>Agent</h3>
            <div className="field">
              <label>Approvals</label>
              <select className="input" value={settings.approvalMode} onChange={(e) => void update({ approvalMode: e.target.value as ApprovalMode })}>
                {(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((m) => (
                  <option key={m} value={m}>
                    {APPROVAL_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Max requests per run</label>
              <input className="input" type="number" min={1} max={1000} value={settings.maxStepsPerRun} onChange={(e) => void update({ maxStepsPerRun: num(e.target.value) || 1 })} />
              <div className="help">The agent pauses after this many model requests in one run; press Continue to keep going.</div>
            </div>
            <div className="field">
              <label>Subagent model</label>
              <select className="input" value={settings.subagentModel} onChange={(e) => void update({ subagentModel: e.target.value })}>
                <ModelOptions available={availableModels} />
              </select>
            </div>
            <div className="field">
              <label>Subagent effort</label>
              <select className="input" value={settings.subagentEffort} onChange={(e) => void update({ subagentEffort: e.target.value as Effort })}>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
              <div className="help">Subagents explore the codebase with read-only tools when Claude delegates via the task tool.</div>
            </div>
          </section>

          <section className="field-group">
            <h3>Spending limits (USD, estimated · 0 = no limit)</h3>
            <div className="field">
              <label>Per session</label>
              <input className="input" type="number" min={0} step={0.5} value={settings.limitPerSession} onChange={(e) => void update({ limitPerSession: num(e.target.value) })} />
            </div>
            <div className="field">
              <label>Per day</label>
              <input className="input" type="number" min={0} step={1} value={settings.limitDaily} onChange={(e) => void update({ limitDaily: num(e.target.value) })} />
            </div>
            <div className="field">
              <label>Per month</label>
              <input className="input" type="number" min={0} step={5} value={settings.limitMonthly} onChange={(e) => void update({ limitMonthly: num(e.target.value) })} />
              <div className="help">
                Checked before every request using Forge's own estimates. A single in-flight request can overshoot slightly. For a hard cap enforced by Anthropic, also set a workspace spend limit in the Console.
              </div>
            </div>
          </section>
        </div>
      </motion.div>
    </div>
  )
}
