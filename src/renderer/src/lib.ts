import type { ApiBlock, ApiMessage } from '@shared/types'
import type { TokenUsage } from '@shared/models'

export function fmtCost(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined) return 'unknown'
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(digits)}`
  return `$${n.toFixed(2)}`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function totalIn(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
}

export function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`
  return new Date(ts).toLocaleDateString()
}

export function dayGroup(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= startToday) return 'Today'
  if (ts >= startToday - 86400_000) return 'Yesterday'
  if (ts >= startToday - 7 * 86400_000) return 'This week'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function blocks(m: ApiMessage): ApiBlock[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n')
  return ''
}

export function basename(p: string | null | undefined): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function diffStats(diff: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return { add, del }
}
