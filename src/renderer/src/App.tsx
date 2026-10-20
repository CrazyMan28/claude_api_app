import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, CircleDollarSign, FolderOpen, PanelRight, PanelRightClose, ShieldCheck } from 'lucide-react'
import type { AgentEvent, ApprovalDecision, ApprovalRequest, PublicSettings, Session, SessionSummary } from '@shared/types'
import { EFFORTS, findModel, type Effort } from '@shared/models'
import { Sidebar } from './components/Sidebar'
import { Chat, type LiveState } from './components/Chat'
import { Composer } from './components/Composer'
import { ApprovalCard } from './components/ApprovalCard'
import { SidePanel } from './components/SidePanel'
import { ModelOptions, SettingsModal } from './components/SettingsModal'
import { Welcome } from './components/Welcome'
import { basename, fmtCost } from './lib'

interface Notice {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
}

const cleanErr = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [current, setCurrent] = useState<Session | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [live, setLive] = useState<LiveState | null>(null)
  const [runningToolId, setRunningToolId] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [progress, setProgress] = useState<Record<string, string[]>>({})
  const [notices, setNotices] = useState<Notice[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [showPanel, setShowPanel] = useState(() => window.innerWidth >= 1280)
  const [availableModels, setAvailableModels] = useState<string[] | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const currentIdRef = useRef<string | null>(null)
  currentIdRef.current = current?.id ?? null
  const liveRef = useRef<LiveState | null>(null)
  const rafRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const noticeId = useRef(0)

  const pushNotice = useCallback((level: Notice['level'], message: string) => {
    const id = ++noticeId.current
    setNotices((n) => [...n.slice(-4), { id, level, message }])
  }, [])

  const refreshSessions = useCallback(async () => {
    const list = await window.forge.listSessions()
    setSessions(list)
    // keep the open session's title in sync (it is set from the first message in the main process)
    setCurrent((s) => {
      const row = s && list.find((x) => x.id === s.id)
      return s && row && row.title !== s.title ? { ...s, title: row.title } : s
    })
  }, [])

  const openSession = useCallback(async (id: string) => {
    const s = await window.forge.getSession(id)
    setCurrent(s)
    setLive(null)
    liveRef.current = null
    setNotices([])
    stickRef.current = true
  }, [])

  // initial load
  useEffect(() => {
    void (async () => {
      const st = await window.forge.getSettings()
      setSettings(st)
      const list = await window.forge.listSessions()
      setSessions(list)
      if (list[0]) await openSession(list[0].id)
      if (!st.hasApiKey) setShowSettings(true)
    })()
  }, [openSession])

  const flushLive = useCallback(() => {
    rafRef.current = null
    setLive(liveRef.current ? { ...liveRef.current, blocks: liveRef.current.blocks.map((b) => ({ ...b })) } : null)
  }, [])
  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushLive)
  }, [flushLive])

  // agent events
  useEffect(() => {
    return window.forge.onAgentEvent((sessionId: string, ev: AgentEvent) => {
      if (ev.type === 'run_start') setRunningIds((s) => new Set(s).add(sessionId))
      if (ev.type === 'run_end') {
        setRunningIds((s) => {
          const n = new Set(s)
          n.delete(sessionId)
          return n
        })
        setApprovals((a) => a.filter((r) => r.sessionId !== sessionId))
        void refreshSessions()
      }
      if (sessionId !== currentIdRef.current) return
      switch (ev.type) {
        case 'stream_start':
          liveRef.current = { model: ev.model, blocks: [] }
          scheduleFlush()
          break
        case 'block_start':
          liveRef.current?.blocks.push({ index: ev.index, type: ev.blockType, text: '', name: ev.name, id: ev.id })
          scheduleFlush()
          break
        case 'text_delta':
        case 'thinking_delta': {
          const b = liveRef.current?.blocks.find((x) => x.index === ev.index)
          if (b) b.text += ev.text
          scheduleFlush()
          break
        }
        case 'input_delta': {
          const b = liveRef.current?.blocks.find((x) => x.index === ev.index)
          if (b) b.text += ev.partial
          scheduleFlush()
          break
        }
        case 'messages_appended':
          if (ev.messages.length && ev.messages[0]!.role === 'user' && !ev.usage) void refreshSessions()
          if (ev.messages.some((m) => m.role === 'assistant')) {
            liveRef.current = null
            setLive(null)
          }
          setCurrent((s) =>
            s ? { ...s, messages: [...s.messages, ...ev.messages], usage: ev.usage ? [...s.usage, ev.usage] : s.usage, updatedAt: Date.now() } : s
          )
          if (ev.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))) {
            setRefreshKey((k) => k + 1)
          }
          break
        case 'tool_running':
          setRunningToolId(ev.toolUseId)
          break
        case 'tool_meta':
          setCurrent((s) => (s ? { ...s, toolMeta: { ...s.toolMeta, [ev.toolUseId]: ev.meta } } : s))
          setRunningToolId((id) => (id === ev.toolUseId ? null : id))
          break
        case 'subagent_progress':
          setProgress((p) => ({ ...p, [ev.parentToolUseId]: [...(p[ev.parentToolUseId] ?? []), ev.text].slice(-200) }))
          break
        case 'approval':
          setApprovals((a) => [...a, ev.request])
          break
        case 'approval_resolved':
          setApprovals((a) => a.filter((r) => r.requestId !== ev.requestId))
          break
        case 'notice':
          pushNotice(ev.level, ev.message)
          break
        case 'run_end':
          liveRef.current = null
          setLive(null)
          setRunningToolId(null)
          setCurrent((s) => (s ? { ...s, lastStop: ev.status } : s))
          setRefreshKey((k) => k + 1)
          if (ev.error) pushNotice(ev.status === 'stopped' ? 'warn' : ev.status === 'limit' || ev.status === 'max_steps' || ev.status === 'max_tokens' ? 'warn' : 'error', ev.error)
          else if (ev.status === 'stopped') pushNotice('warn', 'Stopped. Press Continue to resume, or send a new message.')
          break
      }
    })
  }, [pushNotice, refreshSessions, scheduleFlush])

  // auto-scroll while the user is at the bottom
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [current?.messages.length, live, approvals.length, notices.length])

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newSession()
      }
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setShowPanel((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const newSession = async (): Promise<void> => {
    const s = await window.forge.createSession()
    await refreshSessions()
    setCurrent(s)
    setLive(null)
    setNotices([])
  }

  const ensureSession = async (): Promise<Session> => {
    if (current) return current
    const s = await window.forge.createSession()
    setCurrent(s)
    await refreshSessions()
    return s
  }

  const send = async (text: string): Promise<void> => {
    try {
      const s = await ensureSession()
      stickRef.current = true
      setNotices([])
      await window.forge.send(s.id, text)
      void refreshSessions()
    } catch (e) {
      pushNotice('error', cleanErr(e))
    }
  }

  const patchSession = async (patch: Partial<Pick<Session, 'model' | 'effort' | 'projectDir'>>): Promise<void> => {
    try {
      const s = await ensureSession()
      const updated = await window.forge.updateSession(s.id, patch)
      if (updated) setCurrent(updated)
      if (patch.projectDir !== undefined) setSettings(await window.forge.getSettings())
      void refreshSessions()
    } catch (e) {
      pushNotice('error', cleanErr(e))
    }
  }

  const pickProject = async (): Promise<void> => {
    const dir = await window.forge.pickDirectory()
    if (dir) await patchSession({ projectDir: dir })
  }

  const decide = useCallback((req: ApprovalRequest, d: ApprovalDecision) => {
    setApprovals((a) => a.filter((r) => r.requestId !== req.requestId))
    void window.forge.respondApproval(req.requestId, d)
  }, [])

  const running = !!current && runningIds.has(current.id)
  const sessionApprovals = approvals.filter((a) => a.sessionId === current?.id)
  const waitingToolIds = new Set(sessionApprovals.map((a) => a.toolUseId))
  const sessionCost = (current?.usage ?? []).reduce((s, u) => s + (u.cost ?? 0), 0) +
    Object.values(current?.toolMeta ?? {}).reduce((s, m) => s + (m.subagent?.cost ?? 0), 0)
  const hasMessages = (current?.messages.length ?? 0) > 0
  const canContinue = !!current && hasMessages && !!current.lastStop && current.lastStop !== 'completed'
  const disabledReason = !settings?.hasApiKey ? 'Add your Anthropic API key in Settings to start' : null
  const modelInfo = current ? findModel(current.model) : undefined
  const isWin = window.forge.platform === 'win32'

  return (
    <>
      <div className="aurora" />
      <div className="grid-overlay" />
      <div className="app">
        <header className={`titlebar ${isWin ? 'win' : ''}`}>
          <div className="brand">
            <div className="brand-mark">F</div>
            Forge <small>· Claude coding agent</small>
          </div>
          <div className="titlebar-spacer" />
          <span className="muted no-drag" title="Approval mode (change in Settings)">
            <ShieldCheck size={13} style={{ verticalAlign: -2 }} /> {settings?.approvalMode === 'auto' ? 'auto-approve' : settings?.approvalMode === 'auto-edits' ? 'auto edits' : settings?.approvalMode === 'read-only' ? 'read-only' : 'ask first'}
          </span>
          <button className={`icon-btn ${showPanel ? 'active' : ''}`} onClick={() => setShowPanel(!showPanel)} title="Toggle side panel (Ctrl+B)">
            {showPanel ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
          </button>
        </header>

        <Sidebar
          sessions={sessions}
          currentId={current?.id ?? null}
          runningIds={runningIds}
          settings={settings}
          onSelect={(id) => void openSession(id)}
          onNew={() => void newSession()}
          onRename={async (id, title) => {
            await window.forge.renameSession(id, title)
            if (current?.id === id) setCurrent({ ...current, title })
            void refreshSessions()
          }}
          onDelete={async (id) => {
            await window.forge.deleteSession(id)
            const list = await window.forge.listSessions()
            setSessions(list)
            if (current?.id === id) {
              if (list[0]) await openSession(list[0].id)
              else setCurrent(null)
            }
          }}
          onSettings={() => setShowSettings(true)}
        />

        <main className="main">
          <div className="toolbar">
            <span className="session-title" title={current?.title}>
              {current?.title ?? 'New session'}
            </span>
            <button className="chip" onClick={() => void pickProject()} title={current?.projectDir ?? 'Choose the folder Claude may read and modify'} disabled={running}>
              <FolderOpen size={13} />
              <span className="truncate">{current?.projectDir ? basename(current.projectDir) : 'Choose project folder'}</span>
            </button>
            <label className="select" title="Model">
              <select value={current?.model ?? settings?.defaultModel ?? ''} disabled={running} onChange={(e) => void patchSession({ model: e.target.value })}>
                <ModelOptions available={availableModels} />
              </select>
              <ChevronDown size={12} />
            </label>
            <div className="segmented" title="Thinking effort">
              {EFFORTS.map((e) => (
                <button key={e} className={(current?.effort ?? settings?.defaultEffort) === e ? 'on' : ''} disabled={running} onClick={() => void patchSession({ effort: e as Effort })}>
                  {e}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <span className="cost-pill" title={modelInfo ? `${modelInfo.label}: $${modelInfo.input}/MTok in, $${modelInfo.output}/MTok out. Estimated from API-reported tokens.` : 'Estimated'}>
              <CircleDollarSign size={13} /> {fmtCost(sessionCost, 3)}
            </span>
          </div>

          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            {!hasMessages && !running ? (
              <Welcome
                hasKey={!!settings?.hasApiKey}
                hasProject={!!current?.projectDir}
                onOpenSettings={() => setShowSettings(true)}
                onPickProject={() => void pickProject()}
                onSuggestion={(t) => void send(t)}
              />
            ) : (
              current && <Chat session={current} live={live} running={running} runningToolId={runningToolId} waitingToolIds={waitingToolIds} progress={progress} />
            )}
          </div>

          <div className="composer-wrap">
            <AnimatePresence>
              {sessionApprovals[0] && <ApprovalCard key={sessionApprovals[0].requestId} request={sessionApprovals[0]} onDecide={(d) => decide(sessionApprovals[0]!, d)} />}
            </AnimatePresence>
            <AnimatePresence>
              {notices.map((n) => (
                <motion.div key={n.id} className={`notice ${n.level}`} style={{ maxWidth: 900, width: '100%', margin: '0 auto' }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <span className="grow">{n.message}</span>
                  <button className="icon-btn sm" onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}>
                    ×
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
            <Composer
              running={running}
              disabledReason={disabledReason}
              canContinue={canContinue}
              focusKey={current?.id ?? 'none'}
              onSend={(t) => void send(t)}
              onStop={() => current && void window.forge.stop(current.id)}
              onContinue={() => {
                if (!current) return
                setNotices([])
                void window.forge.continueRun(current.id).catch((e) => pushNotice('error', cleanErr(e)))
              }}
            />
          </div>
        </main>

        <AnimatePresence initial={false}>
          {showPanel && (
            <motion.div key="panel" initial={{ width: 0, opacity: 0 }} animate={{ width: 'auto', opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.22 }} style={{ display: 'flex', minHeight: 0, overflow: 'hidden' }}>
              <SidePanel session={current} settings={settings} running={running} refreshKey={refreshKey} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showSettings && settings && (
          <SettingsModal settings={settings} availableModels={availableModels} onClose={() => setShowSettings(false)} onChange={setSettings} onModels={setAvailableModels} />
        )}
      </AnimatePresence>
    </>
  )
}
