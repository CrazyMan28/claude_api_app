// Model catalog and published per-token prices (USD per 1M tokens).
// Prices are Anthropic first-party API list prices; the app only ever shows
// *estimates* computed from the token counts the API reports. Actual billing
// (and your remaining credit balance) lives in the Claude Console.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ModelInfo {
  id: string
  label: string
  tier: string
  /** USD per 1M uncached input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cache-read tokens */
  cacheRead: number
  /** Server-side refusal fallback (`fallbacks: "default"`) is accepted on the Claude API. */
  supportsDefaultFallback: boolean
  /** Default effort the API uses when none is sent. */
  apiDefaultEffort: Effort
}

export const MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'Opus', input: 4, output: 20, cacheRead: 0.2, supportsDefaultFallback: true, apiDefaultEffort: 'medium' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'Fable', input: 10, output: 50, cacheRead: 0.25, supportsDefaultFallback: true, apiDefaultEffort: 'high' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'Sonnet', input: 2, output: 10, cacheRead: 0.2, supportsDefaultFallback: true, apiDefaultEffort: 'high' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'Haiku', input: 0.1, output: 0.5, cacheRead: 0.01, supportsDefaultFallback: false, apiDefaultEffort: 'medium' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'Opus', input: 5, output: 25, cacheRead: 0.5, supportsDefaultFallback: true, apiDefaultEffort: 'high' },
  { id: 'claude-fable-5', label: 'Claude Fable 5', tier: 'Fable', input: 10, output: 50, cacheRead: 1, supportsDefaultFallback: false, apiDefaultEffort: 'high' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'Sonnet', input: 2, output: 10, cacheRead: 0.2, supportsDefaultFallback: false, apiDefaultEffort: 'high' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'Opus', input: 5, output: 25, cacheRead: 0.5, supportsDefaultFallback: false, apiDefaultEffort: 'high' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'Opus', input: 5, output: 25, cacheRead: 0.5, supportsDefaultFallback: false, apiDefaultEffort: 'high' }
]

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const DEFAULT_EFFORT: Effort = 'high'

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id)
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h
  }
}

/**
 * Estimated USD cost for one response. Returns null when the model has no
 * known price (the UI then shows "unknown" instead of inventing a number).
 * Cache writes: 1.25x input for the 5-minute TTL, 2x for the 1-hour TTL.
 * Claude Haiku 5.5 doubles every rate above 100K prompt tokens.
 */
export function estimateCost(modelId: string, u: TokenUsage): number | null {
  const m = findModel(modelId)
  if (!m) return null
  const promptTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  const mult = m.id === 'claude-haiku-5-5' && promptTokens > 100_000 ? 5 : 1
  const perTok = (usd: number): number => (usd * mult) / 1_000_000
  return (
    u.input * perTok(m.input) +
    u.output * perTok(m.output) +
    u.cacheRead * perTok(m.cacheRead) +
    u.cacheWrite5m * perTok(m.input * 1.25) +
    u.cacheWrite1h * perTok(m.input * 2)
  )
}
