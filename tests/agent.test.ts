import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent } from '../src/main/agent/agent'
import { SettingsStore } from '../src/main/store/settings'
import { SessionStore } from '../src/main/store/sessions'
import { Ledger } from '../src/main/store/ledger'
import type { AgentEvent } from '../src/shared/types'
import { ScriptedStreamer, fakeCipher, message, tempDir } from './helpers'

let dataDir: string
let projectDir: string
let settings: SettingsStore
let sessions: SessionStore
let ledger: Ledger
let events: AgentEvent[]

function makeAgent(streamer: ScriptedStreamer): Agent {
  return new Agent({ settings, sessions, ledger, streamer: () => streamer, emit: (_id, ev) => events.push(ev), platform: 'linux' })
}

beforeEach(async () => {
  dataDir = tempDir('forge-data-')
  projectDir = tempDir('forge-proj-')
  settings = new SettingsStore(dataDir, fakeCipher)
  await settings.load()
  sessions = new SessionStore(dataDir)
  ledger = new Ledger(dataDir)
  await ledger.load()
  events = []
})

const lastEnd = () => events.filter((e) => e.type === 'run_end').at(-1) as Extract<AgentEvent, { type: 'run_end' }>

describe('agent loop', () => {
  it('runs a tool call, feeds the result back, and persists history', async () => {
    writeFileSync(join(projectDir, 'hello.txt'), 'hi there\n')
    const streamer = new ScriptedStreamer([
      () =>
        message(
          [
            { type: 'thinking', thinking: 'look at file', signature: 'sig1' },
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'hello.txt' } }
          ],
          'tool_use'
        ),
      (params) => {
        const last = params.messages.at(-1)!
        expect(last.role).toBe('user')
        const block = (last.content as { type: string; content: string; tool_use_id: string }[])[0]!
        expect(block.type).toBe('tool_result')
        expect(block.tool_use_id).toBe('toolu_1')
        expect(block.content).toContain('hi there')
        return message([{ type: 'text', text: 'The file says hi.' }], 'end_turn')
      }
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await agent.send(s.id, 'What does hello.txt say?')
    expect(lastEnd().status).toBe('completed')

    // Request shape: adaptive thinking with summaries, effort, caching, eager tools, fallback.
    const p = streamer.requests[0]!
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(p.output_config).toEqual({ effort: 'high' })
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
    expect(p.tools?.every((t) => (t as { eager_input_streaming?: boolean }).eager_input_streaming)).toBe(true)
    expect(p.fallbacks).toBe('default')
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.max_tokens).toBe(64000)

    // Thinking block (with signature) replayed unchanged on the second request.
    const replay = streamer.requests[1]!.messages[1]!
    expect((replay.content as { type: string; signature?: string }[])[0]).toMatchObject({ type: 'thinking', signature: 'sig1' })

    // Reload from disk: full history and usage survive.
    const reloaded = await new SessionStore(dataDir).get(s.id)
    expect(reloaded!.messages).toHaveLength(4)
    expect(reloaded!.title).toBe('What does hello.txt say?')
    expect(reloaded!.usage).toHaveLength(2)
    expect(reloaded!.usage[0]!.cost).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6)
    expect(reloaded!.toolMeta['toolu_1']!.status).toBe('ok')
    expect(ledger.summary().allTime.requests).toBe(2)
  })

  it('asks for approval and respects a denial', async () => {
    const streamer = new ScriptedStreamer([
      () => message([{ type: 'tool_use', id: 'toolu_w', name: 'write_file', input: { path: 'a.txt', content: 'x' } }], 'tool_use'),
      (params) => {
        const res = (params.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!
        expect(res.is_error).toBe(true)
        expect(res.content).toMatch(/denied/)
        return message([{ type: 'text', text: 'ok, not writing' }], 'end_turn')
      }
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    const run = agent.send(s.id, 'write a file')
    await waitFor(() => events.some((e) => e.type === 'approval'))
    const req = (events.find((e) => e.type === 'approval') as Extract<AgentEvent, { type: 'approval' }>).request
    expect(req.diff).toContain('+x')
    agent.respondApproval(req.requestId, 'deny')
    await run
    expect(lastEnd().status).toBe('completed')
  })

  it('"always" approval skips later prompts for that tool in the session', async () => {
    const streamer = new ScriptedStreamer([
      () => message([{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.txt', content: '1' } }], 'tool_use'),
      () => message([{ type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'b.txt', content: '2' } }], 'tool_use'),
      () => message([{ type: 'text', text: 'done' }], 'end_turn')
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    const run = agent.send(s.id, 'write two files')
    await waitFor(() => events.some((e) => e.type === 'approval'))
    const req = (events.find((e) => e.type === 'approval') as Extract<AgentEvent, { type: 'approval' }>).request
    agent.respondApproval(req.requestId, 'always')
    await run
    expect(events.filter((e) => e.type === 'approval')).toHaveLength(1)
    expect(readFileSync(join(projectDir, 'b.txt'), 'utf8')).toBe('2')
  })

  it('stop during a pending approval records interrupted tool results and keeps history valid', async () => {
    const streamer = new ScriptedStreamer([
      () =>
        message(
          [
            { type: 'tool_use', id: 'a', name: 'run_command', input: { command: 'echo 1' } },
            { type: 'tool_use', id: 'b', name: 'run_command', input: { command: 'echo 2' } }
          ],
          'tool_use'
        )
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    const run = agent.send(s.id, 'run things')
    await waitFor(() => events.some((e) => e.type === 'approval'))
    agent.stop(s.id)
    await run
    expect(lastEnd().status).toBe('stopped')
    const saved = (await sessions.get(s.id))!
    const last = saved.messages.at(-1)!
    expect(last.role).toBe('user')
    const ids = (last.content as unknown as { tool_use_id: string }[]).map((b) => b.tool_use_id)
    expect(ids).toEqual(['a', 'b'])

    // Continue re-runs the request without adding a new user turn.
    const streamer2 = new ScriptedStreamer([() => message([{ type: 'text', text: 'resumed' }], 'end_turn')])
    const agent2 = makeAgent(streamer2)
    await agent2.continueRun(s.id)
    expect(streamer2.requests[0]!.messages).toHaveLength(3)
    expect(lastEnd().status).toBe('completed')
  })

  it('aborting mid-stream ends the run as stopped', async () => {
    const streamer = new ScriptedStreamer([
      (_p, signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    const run = agent.send(s.id, 'long task')
    await waitFor(() => streamer.requests.length === 1)
    agent.stop(s.id)
    await run
    expect(lastEnd().status).toBe('stopped')
  })

  it('max_tokens on text ends with max_tokens and Continue appends a user turn', async () => {
    const streamer = new ScriptedStreamer([
      () => message([{ type: 'text', text: 'partial…' }], 'max_tokens'),
      (params) => {
        expect(params.messages.at(-1)).toMatchObject({ role: 'user' })
        return message([{ type: 'text', text: 'rest' }], 'end_turn')
      }
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await agent.send(s.id, 'write a lot')
    expect(lastEnd().status).toBe('max_tokens')
    await agent.continueRun(s.id)
    expect(lastEnd().status).toBe('completed')
  })

  it('never runs a tool whose input was truncated by max_tokens', async () => {
    const streamer = new ScriptedStreamer([
      () => message([{ type: 'tool_use', id: 'tw', name: 'write_file', input: { path: 'big.txt', content: 'trunc' } }], 'max_tokens'),
      (params) => {
        const r = (params.messages.at(-1)!.content as { is_error: boolean; content: string }[])[0]!
        expect(r.is_error).toBe(true)
        expect(r.content).toMatch(/cut off/)
        return message([{ type: 'text', text: 'will retry smaller' }], 'end_turn')
      }
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await settings.update({ approvalMode: 'auto' })
    await agent.send(s.id, 'write a big file')
    expect(() => readFileSync(join(projectDir, 'big.txt'))).toThrow()
  })

  it('does not keep refused content in history', async () => {
    const streamer = new ScriptedStreamer([() => message([{ type: 'text', text: 'I' }], 'refusal')])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await agent.send(s.id, 'something')
    expect(lastEnd().status).toBe('refusal')
    expect((await sessions.get(s.id))!.messages).toHaveLength(1)
  })

  it('enforces spending limits before requests', async () => {
    await settings.update({ limitDaily: 0.01 })
    const streamer = new ScriptedStreamer([
      () => message([{ type: 'tool_use', id: 'r', name: 'list_dir', input: {} }], 'tool_use'),
      () => message([{ type: 'text', text: 'should not happen' }], 'end_turn')
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await agent.send(s.id, 'go')
    // first request costs $0.014 > $0.01, so the second is blocked
    expect(streamer.requests).toHaveLength(1)
    expect(lastEnd().status).toBe('limit')
    expect(lastEnd().error).toMatch(/Daily spending limit/)
  })

  it('runs a read-only subagent through the task tool', async () => {
    writeFileSync(join(projectDir, 'x.md'), '# secret plan\n')
    const streamer = new ScriptedStreamer([
      () => message([{ type: 'tool_use', id: 'task1', name: 'task', input: { description: 'find plan', prompt: 'Find the plan' } }], 'tool_use'),
      (params) => {
        expect(params.model).toBe('claude-sonnet-5-5')
        expect(params.tools!.map((t) => (t as { name: string }).name)).not.toContain('write_file')
        return message([{ type: 'tool_use', id: 'sub1', name: 'grep', input: { pattern: 'plan' } }], 'tool_use', { model: 'claude-sonnet-5-5' })
      },
      () => message([{ type: 'text', text: 'Plan is in x.md:1' }], 'end_turn', { model: 'claude-sonnet-5-5' }),
      (params) => {
        const r = (params.messages.at(-1)!.content as { content: string }[])[0]!
        expect(r.content).toBe('Plan is in x.md:1')
        return message([{ type: 'text', text: 'Found it.' }], 'end_turn')
      }
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await agent.send(s.id, 'where is the plan?')
    expect(lastEnd().status).toBe('completed')
    const saved = (await sessions.get(s.id))!
    expect(saved.toolMeta['task1']!.subagent!.steps).toBe(2)
    // subagent requests are counted in the ledger too
    expect(ledger.summary().allTime.requests).toBe(4)
  })

  it('without a project, sends no tools', async () => {
    const streamer = new ScriptedStreamer([() => message([{ type: 'text', text: 'hello' }], 'end_turn')])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir: null, model: 'claude-haiku-5-5', effort: 'low' })
    await agent.send(s.id, 'hi')
    expect(streamer.requests[0]!.tools).toBeUndefined()
    expect(streamer.requests[0]!.fallbacks).toBeUndefined()
  })
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('beta fallback guard', () => {
  it('drops `fallbacks` and retries once if the API rejects it', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const streamer = new ScriptedStreamer([
      () => {
        throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not supported' } }, 'fallbacks: not supported', new Headers())
      },
      (params) => {
        expect(params.fallbacks).toBeUndefined()
        expect(params.betas).toBeUndefined()
        return message([{ type: 'text', text: 'ok' }], 'end_turn')
      }
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await agent.send(s.id, 'hi')
    expect(lastEnd().status).toBe('completed')
    expect(events.some((e) => e.type === 'notice' && /refusal-fallback/.test(e.message))).toBe(true)
  })

  it('reports other 400s as clear errors without retrying', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const streamer = new ScriptedStreamer([
      () => {
        throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'Your credit balance is too low to access the Anthropic API.', new Headers())
      }
    ])
    const agent = makeAgent(streamer)
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    await agent.send(s.id, 'hi')
    expect(lastEnd().status).toBe('error')
    expect(lastEnd().error).toMatch(/credit balance is too low.*Billing/s)
    expect(streamer.requests).toHaveLength(1)
  })
})

describe('stop keeps partial text', () => {
  it('appends the streamed text as an interrupted assistant message', async () => {
    const streamer: import('../src/main/agent/agent').MessageStreamer & { requests: unknown[] } = {
      requests: [],
      stream(_params, signal, onEvent) {
        onEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } } as never)
        onEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is the first half' } } as never)
        return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
      }
    }
    const agent = new Agent({ settings, sessions, ledger, streamer: () => streamer, emit: (_id, ev) => events.push(ev), platform: 'linux' })
    const s = await sessions.create({ projectDir, model: 'claude-opus-5-5', effort: 'high' })
    const run = agent.send(s.id, 'go')
    await new Promise((r) => setTimeout(r, 30))
    agent.stop(s.id)
    await run
    expect(lastEnd().status).toBe('stopped')
    const last = (await sessions.get(s.id))!.messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(JSON.stringify(last.content)).toContain('Here is the first half')
    expect(JSON.stringify(last.content)).toContain('stopped by user')
  })
})
