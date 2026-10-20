import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { estimateCost, findModel, ZERO_USAGE, addUsage, type Effort, type TokenUsage } from '@shared/models'
import type {
  AgentEvent,
  ApiBlock,
  ApiMessage,
  ApprovalDecision,
  ApprovalRequest,
  MessageUsageRecord,
  RunEndStatus,
  Session,
  ToolMeta
} from '@shared/types'
import type { SettingsStore } from '../store/settings'
import type { SessionStore } from '../store/sessions'
import type { Ledger } from '../store/ledger'
import { systemPrompt } from './prompt'
import { ALL_TOOLS, SUBAGENT_TOOLS, apiToolDefs, approvalPolicy, executeTool, toolByName, type AnyTool, type ToolOutput } from './tools'

type BetaMessage = Anthropic.Beta.BetaMessage
type BetaParams = Anthropic.Beta.MessageCreateParamsNonStreaming

/** What the agent loop needs from the Messages API. Real code uses the SDK; tests pass a fake. */
export interface MessageStreamer {
  stream(
    params: BetaParams,
    signal: AbortSignal,
    onEvent: (ev: Anthropic.Beta.BetaRawMessageStreamEvent) => void
  ): Promise<BetaMessage>
}

export function sdkStreamer(client: Anthropic): MessageStreamer {
  return {
    async stream(params, signal, onEvent) {
      const stream = client.beta.messages.stream(params, { signal })
      for await (const ev of stream) onEvent(ev)
      return stream.finalMessage()
    }
  }
}

export interface AgentDeps {
  settings: SettingsStore
  sessions: SessionStore
  ledger: Ledger
  /** Returns null when no API key is configured. */
  streamer(): MessageStreamer | null
  emit(sessionId: string, ev: AgentEvent): void
  platform?: string
}

interface ActiveRun {
  abort: AbortController
  approvals: Map<string, (ok: boolean) => void>
}

export class LimitError extends Error {}

export function toTokenUsage(u: Anthropic.Beta.BetaUsage | undefined): TokenUsage {
  if (!u) return { ...ZERO_USAGE }
  const cc = u.cache_creation
  const w5 = cc?.ephemeral_5m_input_tokens ?? null
  const w1 = cc?.ephemeral_1h_input_tokens ?? null
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: w5 ?? (w1 === null ? (u.cache_creation_input_tokens ?? 0) : 0),
    cacheWrite1h: w1 ?? 0
  }
}

/** Human-readable explanation for an API failure, using the SDK's typed errors. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Authentication failed (401): the API key was rejected. Check it in Settings.'
  if (err instanceof Anthropic.PermissionDeniedError) return `Permission denied (403): ${err.message}`
  if (err instanceof Anthropic.NotFoundError) return `Not found (404): ${err.message}. The selected model may not be available to your organization.`
  if (err instanceof Anthropic.RateLimitError) return `Rate limited (429) after automatic retries: ${err.message}`
  if (err instanceof Anthropic.BadRequestError) {
    const hint = /credit balance/i.test(err.message)
      ? ' Your Console organization has no usable credits for this request. Check Billing at platform.claude.com.'
      : ''
    return `Request rejected (400): ${err.message}.${hint}`
  }
  if (err instanceof Anthropic.InternalServerError) return `Anthropic API error (${err.status}): ${err.message}. Try again shortly.`
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'The request to the Anthropic API timed out.'
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${err.message}`
  if (err instanceof Anthropic.APIError) return `Anthropic API error${err.status ? ` (${err.status})` : ''}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || err instanceof Anthropic.APIUserAbortError || (err as Error)?.name === 'AbortError'
}


interface LoopOptions {
  sessionId: string
  model: string
  effort: Effort
  messages: ApiMessage[]
  tools: AnyTool[]
  system: string
  projectDir: string | null
  signal: AbortSignal
  maxSteps: number
  parentToolUseId?: string
  /** persist appended messages (main loop) */
  onAppend(msgs: ApiMessage[], usage?: MessageUsageRecord): Promise<void>
  onToolMeta(id: string, meta: ToolMeta): Promise<void>
  requestApproval(toolUseId: string, tool: AnyTool, input: Record<string, unknown>, summary: string, diff?: string): Promise<boolean>
}

interface LoopResult {
  status: RunEndStatus
  error?: string
  usage: TokenUsage
  cost: number | null
  steps: number
  finalText: string
}

export class Agent {
  private runs = new Map<string, ActiveRun>()
  private alwaysAllow = new Map<string, Set<string>>()
  private readonly platform: string

  constructor(private readonly deps: AgentDeps) {
    this.platform = deps.platform ?? process.platform
  }

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  async send(sessionId: string, text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    await this.start(sessionId, async (s) => {
      if (s.messages.length === 0 || s.title === 'New session') {
        s.title = trimmed.replace(/\s+/g, ' ').slice(0, 60) || 'New session'
      }
      return [{ role: 'user', content: [{ type: 'text', text: trimmed }] }]
    })
  }

  /** Resume after a stop, max_tokens, limit or error. */
  async continueRun(sessionId: string): Promise<void> {
    await this.start(sessionId, async (s) => {
      const last = s.messages[s.messages.length - 1]
      // If the last turn is ours (tool results / a user message), just re-run the request.
      if (!last || last.role === 'user') return []
      return [{ role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] }]
    })
  }

  stop(sessionId: string): void {
    const run = this.runs.get(sessionId)
    if (!run) return
    run.abort.abort()
    for (const resolve of run.approvals.values()) resolve(false)
    run.approvals.clear()
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    for (const run of this.runs.values()) {
      const resolve = run.approvals.get(requestId)
      if (resolve) {
        run.approvals.delete(requestId)
        resolve(decision !== 'deny')
        if (decision === 'always') {
          // handled by the caller-side closure via pendingAlways
          this.pendingAlways.get(requestId)?.()
        }
        this.pendingAlways.delete(requestId)
        return
      }
    }
  }

  private pendingAlways = new Map<string, () => void>()

  private checkLimits(sessionId: string): void {
    const s = this.deps.settings.get()
    const L = this.deps.ledger
    const fmt = (n: number): string => `$${n.toFixed(2)}`
    if (s.limitPerSession > 0 && L.spentInSession(sessionId) >= s.limitPerSession)
      throw new LimitError(`Session spending limit reached (${fmt(s.limitPerSession)} estimated). Raise it in Settings to continue.`)
    if (s.limitDaily > 0 && L.spentToday() >= s.limitDaily)
      throw new LimitError(`Daily spending limit reached (${fmt(s.limitDaily)} estimated). Raise it in Settings to continue.`)
    if (s.limitMonthly > 0 && L.spentThisMonth() >= s.limitMonthly)
      throw new LimitError(`Monthly spending limit reached (${fmt(s.limitMonthly)} estimated). Raise it in Settings to continue.`)
  }

  private async start(sessionId: string, prepare: (s: Session) => Promise<ApiMessage[]>): Promise<void> {
    if (this.runs.has(sessionId)) throw new Error('This session is already running.')
    const session = await this.deps.sessions.get(sessionId)
    if (!session) throw new Error('Session not found.')
    const streamer = this.deps.streamer()
    if (!streamer) throw new Error('Add your Anthropic API key in Settings first.')

    const run: ActiveRun = { abort: new AbortController(), approvals: new Map() }
    this.runs.set(sessionId, run)
    const emit = (ev: AgentEvent): void => this.deps.emit(sessionId, ev)
    emit({ type: 'run_start' })

    let status: RunEndStatus = 'completed'
    let error: string | undefined
    try {
      const fresh = await prepare(session)
      if (fresh.length) {
        session.messages.push(...fresh)
        await this.deps.sessions.save(session)
        emit({ type: 'messages_appended', messages: fresh })
      }
      if (session.messages.length === 0) return
      const settings = this.deps.settings.get()
      const tools = session.projectDir ? ALL_TOOLS : []
      const result = await this.loop(streamer, {
        sessionId,
        model: session.model,
        effort: session.effort,
        messages: session.messages,
        tools,
        system: systemPrompt({ projectDir: session.projectDir, platform: this.platform }),
        projectDir: session.projectDir,
        signal: run.abort.signal,
        maxSteps: settings.maxStepsPerRun,
        onAppend: async (msgs, usage) => {
          if (usage) session.usage.push(usage)
          await this.deps.sessions.save(session)
          emit({ type: 'messages_appended', messages: msgs, usage })
        },
        onToolMeta: async (id, meta) => {
          session.toolMeta[id] = meta
          emit({ type: 'tool_meta', toolUseId: id, meta })
        },
        requestApproval: (toolUseId, tool, input, summary, diff) =>
          this.approve(sessionId, run, toolUseId, tool, input, summary, diff)
      })
      status = result.status
      error = result.error
    } catch (err) {
      if (err instanceof LimitError) {
        status = 'limit'
        error = err.message
      } else if (isAbort(err, run.abort.signal)) {
        status = 'stopped'
      } else {
        status = 'error'
        error = describeApiError(err)
      }
    } finally {
      this.runs.delete(sessionId)
      session.lastStop = status
      await this.deps.sessions.save(session).catch(() => undefined)
      emit({ type: 'run_end', status, error })
    }
  }

  private async approve(
    sessionId: string,
    run: ActiveRun,
    toolUseId: string,
    tool: AnyTool,
    input: Record<string, unknown>,
    summary: string,
    diff?: string
  ): Promise<boolean> {
    const policy = approvalPolicy(this.deps.settings.get().approvalMode, tool.kind)
    if (policy === 'allow') return true
    if (policy === 'deny') {
      this.deps.emit(sessionId, { type: 'notice', level: 'warn', message: `Read-only mode: blocked ${tool.name}.` })
      return false
    }
    if (this.alwaysAllow.get(sessionId)?.has(tool.name)) return true
    if (run.abort.signal.aborted) return false
    const request: ApprovalRequest = { requestId: randomUUID(), sessionId, toolUseId, tool: tool.name, summary, input, diff }
    const ok = await new Promise<boolean>((resolve) => {
      run.approvals.set(request.requestId, resolve)
      this.pendingAlways.set(request.requestId, () => {
        const set = this.alwaysAllow.get(sessionId) ?? new Set<string>()
        set.add(tool.name)
        this.alwaysAllow.set(sessionId, set)
      })
      this.deps.emit(sessionId, { type: 'approval', request })
    })
    this.deps.emit(sessionId, { type: 'approval_resolved', requestId: request.requestId })
    return ok && !run.abort.signal.aborted
  }

  /** Models for which the API rejected the beta `fallbacks` parameter; we stop sending it. */
  private fallbackRejected = new Set<string>()

  private buildParams(o: LoopOptions): BetaParams {
    const settings = this.deps.settings.get()
    const info = findModel(o.model)
    const fallback = settings.refusalFallback && !!info?.supportsDefaultFallback && !this.fallbackRejected.has(o.model)
    const params: BetaParams = {
      model: o.model,
      max_tokens: 64000,
      system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
      messages: o.messages as Anthropic.Beta.BetaMessageParam[],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: o.effort },
      // Automatic caching of the growing conversation tail.
      cache_control: { type: 'ephemeral' }
    }
    if (o.tools.length) params.tools = apiToolDefs(o.tools)
    if (fallback) {
      params.betas = ['server-side-fallback-2026-07-01']
      params.fallbacks = 'default'
    }
    return params
  }

  /** One streamed request, retrying (max twice) only when a tool input arrived as unparseable JSON. */
  private async request(streamer: MessageStreamer, o: LoopOptions, partial: Map<number, string>): Promise<BetaMessage> {
    const emit = (ev: AgentEvent): void => {
      if (o.parentToolUseId) return // subagents report progress per step instead
      this.deps.emit(o.sessionId, ev)
    }
    for (let attempt = 0; ; attempt++) {
      emit({ type: 'stream_start', model: o.model })
      partial.clear()
      try {
        const msg = await streamer.stream(this.buildParams(o), o.signal, (ev) => {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            partial.set(ev.index, (partial.get(ev.index) ?? '') + ev.delta.text)
          }
          if (ev.type === 'content_block_start') {
            const b = ev.content_block as { type: string; name?: string; id?: string }
            emit({ type: 'block_start', index: ev.index, blockType: b.type, name: b.name, id: b.id })
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta
            if (d.type === 'text_delta') emit({ type: 'text_delta', index: ev.index, text: d.text })
            else if (d.type === 'thinking_delta') emit({ type: 'thinking_delta', index: ev.index, text: d.thinking })
            else if (d.type === 'input_json_delta') emit({ type: 'input_delta', index: ev.index, partial: d.partial_json })
          }
        })
        emit({ type: 'stream_end' })
        return msg
      } catch (err) {
        emit({ type: 'stream_end' })
        // `fallbacks` is a beta parameter: if the API rejects it, drop it rather than failing the run.
        if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message) && !this.fallbackRejected.has(o.model) && this.buildParams(o).fallbacks) {
          this.fallbackRejected.add(o.model)
          this.deps.emit(o.sessionId, { type: 'notice', level: 'warn', message: 'The API rejected the refusal-fallback option for this model; continuing without it.' })
          continue
        }
        if (err instanceof Anthropic.APIError || isAbort(err, o.signal) || attempt >= 2) throw err
        this.deps.emit(o.sessionId, { type: 'notice', level: 'warn', message: 'A tool call arrived malformed; retrying the request.' })
      }
    }
  }

  private async loop(streamer: MessageStreamer, o: LoopOptions): Promise<LoopResult> {
    let usage: TokenUsage = { ...ZERO_USAGE }
    let cost: number | null = 0
    let steps = 0
    let truncatedTools = 0
    let finalText = ''
    const done = (status: RunEndStatus, error?: string): LoopResult => ({ status, error, usage, cost, steps, finalText })

    for (;;) {
      if (o.signal.aborted) return done('stopped')
      if (steps >= o.maxSteps) return done('max_steps', `Stopped after ${o.maxSteps} model requests (the per-run step limit in Settings). Press Continue to keep going.`)
      this.checkLimits(o.sessionId)
      steps++

      const partial = new Map<number, string>()
      let msg: BetaMessage
      try {
        msg = await this.request(streamer, o, partial)
      } catch (err) {
        // Stopped mid-stream: keep the text the user already saw (marked as interrupted)
        // instead of silently discarding it. Thinking and partial tool calls are dropped.
        const text = [...partial.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join('\n\n').trim()
        if (isAbort(err, o.signal) && text && !o.parentToolUseId) {
          const kept: ApiMessage = { role: 'assistant', content: [{ type: 'text', text: `${text}\n\n*[stopped by user]*` }] }
          o.messages.push(kept)
          await o.onAppend([kept])
        }
        throw err
      }
      const u = toTokenUsage(msg.usage)
      const c = estimateCost(msg.model, u)
      usage = addUsage(usage, u)
      cost = cost === null || c === null ? null : cost + c
      await this.deps.ledger.record({ ts: Date.now(), sessionId: o.sessionId, model: msg.model, usage: u, cost: c, subagent: !!o.parentToolUseId })

      const content = msg.content as unknown as ApiBlock[]
      const textNow = content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim()
      if (textNow) finalText = textNow
      const assistant: ApiMessage = { role: 'assistant', content }
      const record: MessageUsageRecord = { index: o.messages.length, model: msg.model, usage: u, cost: c, stopReason: msg.stop_reason }

      if (msg.stop_reason === 'refusal') {
        // A refusal can cut content off mid-block: don't keep it in history.
        const why = msg.stop_details && 'explanation' in msg.stop_details ? msg.stop_details.explanation : null
        return done('refusal', `Claude declined this request${why ? `: ${why}` : '.'}`)
      }

      const toolUses = content.filter((b) => b.type === 'tool_use') as unknown as Anthropic.Beta.BetaToolUseBlock[]
      o.messages.push(assistant)
      await o.onAppend([assistant], record)

      if (msg.stop_reason === 'pause_turn') continue
      if (toolUses.length === 0) {
        if (msg.stop_reason === 'max_tokens') return done('max_tokens', 'The response hit the output token limit. Press Continue to let Claude keep going.')
        return done('completed')
      }

      // Truncated tool input: never run it; tell the model so it can retry with smaller steps.
      if (msg.stop_reason === 'max_tokens') {
        const results = toolUses.map((t) => ({
          type: 'tool_result',
          tool_use_id: t.id,
          is_error: true,
          content: 'This tool call was cut off by the output token limit and was not executed. Retry with a smaller input (e.g. several smaller edits).'
        }))
        const um: ApiMessage = { role: 'user', content: results }
        o.messages.push(um)
        await o.onAppend([um])
        if (++truncatedTools >= 3) return done('max_tokens', 'Tool calls kept exceeding the output token limit.')
        continue
      }

      const results: ApiBlock[] = []
      for (const tu of toolUses) {
        if (o.signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Interrupted by the user before this tool ran.' })
          await o.onToolMeta(tu.id, { status: 'interrupted' })
          continue
        }
        const out = await this.runTool(streamer, o, tu)
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content || '(no output)', ...(out.isError ? { is_error: true } : {}) })
      }
      const um: ApiMessage = { role: 'user', content: results }
      o.messages.push(um)
      await o.onAppend([um])
    }
  }

  private async runTool(streamer: MessageStreamer, o: LoopOptions, tu: Anthropic.Beta.BetaToolUseBlock): Promise<ToolOutput> {
    const started = Date.now()
    const tool = toolByName(o.tools, tu.name)
    if (!o.parentToolUseId) this.deps.emit(o.sessionId, { type: 'tool_running', toolUseId: tu.id, name: tu.name })
    let out: ToolOutput
    if (!tool || !o.projectDir) {
      out = { content: `Unknown tool: ${tu.name}`, isError: true }
    } else {
      const input = (tu.input ?? {}) as Record<string, unknown>
      out = await executeTool(tool, input, {
        projectDir: o.projectDir,
        signal: o.signal,
        toolUseId: tu.id,
        requestApproval: (ask) => o.requestApproval(tu.id, tool, input, ask.summary, ask.diff),
        runSubagent: o.parentToolUseId ? undefined : (prompt, description) => this.subagent(streamer, o, tu.id, prompt, description)
      })
    }
    const meta: ToolMeta = {
      status: out.meta?.status ?? (out.isError ? (o.signal.aborted ? 'interrupted' : 'error') : 'ok'),
      durationMs: Date.now() - started,
      ...(out.meta?.diff ? { diff: out.meta.diff } : {}),
      ...(out.meta?.path ? { path: out.meta.path } : {}),
      ...(out.meta?.subagent ? { subagent: out.meta.subagent } : {})
    }
    await o.onToolMeta(tu.id, meta)
    return out
  }

  private async subagent(streamer: MessageStreamer, parent: LoopOptions, toolUseId: string, prompt: string, description: string): Promise<ToolOutput> {
    const settings = this.deps.settings.get()
    const emit = (text: string): void => this.deps.emit(parent.sessionId, { type: 'subagent_progress', parentToolUseId: toolUseId, text })
    emit(`Subagent started: ${description} (${settings.subagentModel}, ${settings.subagentEffort} effort)`)
    const messages: ApiMessage[] = [{ role: 'user', content: prompt }]
    const res = await this.loop(streamer, {
      sessionId: parent.sessionId,
      model: settings.subagentModel,
      effort: settings.subagentEffort,
      messages,
      tools: SUBAGENT_TOOLS,
      system: systemPrompt({ projectDir: parent.projectDir, platform: this.platform, subagent: true }),
      projectDir: parent.projectDir,
      signal: parent.signal,
      maxSteps: 40,
      parentToolUseId: toolUseId,
      onAppend: async (msgs) => {
        for (const m of msgs) {
          if (m.role !== 'assistant' || typeof m.content === 'string') continue
          for (const b of m.content) {
            if (b.type === 'tool_use') emit(`→ ${String(b.name)} ${JSON.stringify(b.input).slice(0, 140)}`)
          }
        }
      },
      onToolMeta: async () => undefined,
      requestApproval: async () => false
    })
    const meta = { subagent: { model: settings.subagentModel, usage: res.usage, cost: res.cost, steps: res.steps } }
    if (res.status === 'stopped') return { content: 'Subagent was stopped by the user.', isError: true, meta: { ...meta, status: 'interrupted' } }
    if (res.status !== 'completed') {
      return { content: `Subagent ended early (${res.status}): ${res.error ?? ''}\n\nPartial findings:\n${res.finalText}`, isError: true, meta }
    }
    emit(`Subagent finished in ${res.steps} steps`)
    return { content: res.finalText || '(subagent returned no text)', meta }
  }
}

