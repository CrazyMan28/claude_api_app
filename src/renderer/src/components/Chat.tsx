import { memo, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Brain, ChevronRight, Sparkles } from 'lucide-react'
import type { ApiBlock, MessageUsageRecord, Session } from '@shared/types'
import { addUsage, ZERO_USAGE } from '@shared/models'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { blocks, fmtCost, fmtTokens, str, toolResultText, totalIn } from '../lib'

export interface LiveBlock {
  index: number
  type: string
  text: string
  name?: string
  id?: string
}

export interface LiveState {
  model: string
  blocks: LiveBlock[]
}

interface Props {
  session: Session
  live: LiveState | null
  running: boolean
  runningToolId: string | null
  waitingToolIds: Set<string>
  progress: Record<string, string[]>
}

interface UserItem {
  kind: 'user'
  key: string
  text: string
}
interface AssistantItem {
  kind: 'assistant'
  key: string
  blocks: ApiBlock[]
  usage: MessageUsageRecord[]
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <div className="thinking-head" onClick={() => setOpen(!open)}>
        <Brain size={14} />
        <span className={live ? 'shimmer' : ''}>{live ? 'Thinking…' : 'Thought process'}</span>
        <span style={{ flex: 1 }} />
        <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
      </div>
      {open && <div className="thinking-text">{text || '(no summary)'}</div>}
    </div>
  )
}

export const Chat = memo(function Chat({ session, live, running, runningToolId, waitingToolIds, progress }: Props) {
  const { items, results } = useMemo(() => {
    const results = new Map<string, { text: string; isError: boolean }>()
    const usageByIndex = new Map<number, MessageUsageRecord>()
    for (const u of session.usage) usageByIndex.set(u.index, u)
    const items: (UserItem | AssistantItem)[] = []
    session.messages.forEach((m, i) => {
      const bs = blocks(m)
      if (m.role === 'user') {
        for (const b of bs) {
          if (b.type === 'tool_result') results.set(str(b.tool_use_id), { text: toolResultText(b.content), isError: !!b.is_error })
        }
        const text = bs.filter((b) => b.type === 'text').map((b) => str(b.text)).join('\n')
        if (text) items.push({ kind: 'user', key: `u${i}`, text })
        return
      }
      const prev = items[items.length - 1]
      const u = usageByIndex.get(i)
      if (prev && prev.kind === 'assistant') {
        prev.blocks.push(...bs)
        if (u) prev.usage.push(u)
      } else {
        items.push({ kind: 'assistant', key: `a${i}`, blocks: [...bs], usage: u ? [u] : [] })
      }
    })
    return { items, results }
  }, [session.messages, session.usage])

  const lastIsAssistant = items[items.length - 1]?.kind === 'assistant'

  const renderBlocks = (bs: ApiBlock[], keyPrefix: string) =>
    bs.map((b, j) => {
      const key = `${keyPrefix}-${j}`
      if (b.type === 'text') return str(b.text).trim() ? <Markdown key={key} text={str(b.text)} /> : null
      if (b.type === 'thinking') return str(b.thinking).trim() ? <Thinking key={key} text={str(b.thinking)} /> : null
      if (b.type === 'tool_use') {
        const id = str(b.id)
        const result = results.get(id)
        const state = result ? 'done' : waitingToolIds.has(id) ? 'waiting' : runningToolId === id ? 'running' : running ? 'running' : 'orphan'
        return (
          <ToolCard
            key={id || key}
            name={str(b.name)}
            input={(b.input as Record<string, unknown>) ?? {}}
            result={result}
            meta={session.toolMeta[id]}
            state={state}
            progress={progress[id]}
          />
        )
      }
      if (b.type === 'fallback') {
        const to = (b.to as { model?: string } | undefined)?.model
        return <div key={key} className="muted">↪ Continued on fallback model {to ?? ''} after a refusal.</div>
      }
      return null
    })

  const liveTurn = live && live.blocks.length > 0 && (
    <>
      {live.blocks.map((b) => {
        if (b.type === 'text') return <Markdown key={`live-${b.index}`} text={b.text} streaming />
        if (b.type === 'thinking') return <Thinking key={`live-${b.index}`} text={b.text} live />
        if (b.type === 'tool_use') {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(b.text) as Record<string, unknown>
          } catch {
            const m = /"(path|command|pattern|description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(b.text)
            if (m) input = { [m[1]!]: m[2] }
          }
          return <ToolCard key={`live-${b.index}`} name={b.name ?? 'tool'} input={input} partialInput={b.text} state="streaming" />
        }
        return null
      })}
    </>
  )

  return (
    <div className="chat">
      {items.map((it, idx) =>
        it.kind === 'user' ? (
          <motion.div key={it.key} className="msg-user" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {it.text}
          </motion.div>
        ) : (
          <motion.div key={it.key} className="msg-assistant" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            <div className={`avatar ${running && idx === items.length - 1 ? 'live' : ''}`}>
              <Sparkles size={15} />
            </div>
            <div className="assistant-body">
              {renderBlocks(it.blocks, it.key)}
              {idx === items.length - 1 && liveTurn}
              {it.usage.length > 0 && <UsageLine records={it.usage} />}
            </div>
          </motion.div>
        )
      )}
      {!lastIsAssistant && (running || liveTurn) && (
        <motion.div className="msg-assistant" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="avatar live">
            <Sparkles size={15} />
          </div>
          <div className="assistant-body">
            {liveTurn || (
              <div className="thinking-head" style={{ padding: '4px 0' }}>
                <span className="shimmer">Working…</span>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  )
})

function UsageLine({ records }: { records: MessageUsageRecord[] }) {
  let usage = ZERO_USAGE
  let cost: number | null = 0
  for (const r of records) {
    usage = addUsage(usage, r.usage)
    cost = cost === null || r.cost === null ? null : cost + r.cost
  }
  const models = [...new Set(records.map((r) => r.model))].join(', ')
  return (
    <div className="usage-line" title="Token counts reported by the API; cost is an estimate from published prices.">
      <span>{models}</span>
      <span>{records.length} request{records.length === 1 ? '' : 's'}</span>
      <span>in {fmtTokens(totalIn(usage))}{usage.cacheRead ? ` (${fmtTokens(usage.cacheRead)} cached)` : ''}</span>
      <span>out {fmtTokens(usage.output)}</span>
      <span>≈ {fmtCost(cost)}</span>
    </div>
  )
}
