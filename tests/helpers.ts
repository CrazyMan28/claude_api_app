import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { MessageStreamer } from '../src/main/agent/agent'
import type { SecretCipher } from '../src/main/store/settings'

export function tempDir(prefix = 'forge-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().replace(/^enc:/, ''), 'base64').toString()
}

type Block = Record<string, unknown> & { type: string }

export function message(content: Block[], stop_reason: string, extra: Partial<Anthropic.Beta.BetaMessage> = {}): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: content as unknown as Anthropic.Beta.BetaContentBlock[],
    stop_reason: stop_reason as Anthropic.Beta.BetaMessage['stop_reason'],
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null
    } as unknown as Anthropic.Beta.BetaUsage,
    ...extra
  } as Anthropic.Beta.BetaMessage
}

/** Replays scripted responses; records every request it received. */
export class ScriptedStreamer implements MessageStreamer {
  requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = []
  constructor(private script: ((params: Anthropic.Beta.MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<Anthropic.Beta.BetaMessage> | Anthropic.Beta.BetaMessage)[]) {}

  async stream(params: Anthropic.Beta.MessageCreateParamsNonStreaming, signal: AbortSignal, onEvent: (ev: Anthropic.Beta.BetaRawMessageStreamEvent) => void): Promise<Anthropic.Beta.BetaMessage> {
    this.requests.push(structuredClone(params))
    const step = this.script.shift()
    if (!step) throw new Error('script exhausted')
    const msg = await step(params, signal)
    msg.content.forEach((b, index) => {
      onEvent({ type: 'content_block_start', index, content_block: b } as Anthropic.Beta.BetaRawMessageStreamEvent)
      if (b.type === 'text') onEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } } as Anthropic.Beta.BetaRawMessageStreamEvent)
    })
    return msg
  }
}
