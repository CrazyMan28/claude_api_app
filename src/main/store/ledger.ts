import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { ZERO_USAGE, addUsage, type TokenUsage } from '@shared/models'
import type { UsageSummary } from '@shared/types'

export interface LedgerEntry {
  ts: number
  sessionId: string
  model: string
  usage: TokenUsage
  cost: number | null
  subagent?: boolean
}

/**
 * Append-only spend ledger (JSONL). Every API response the app receives is
 * recorded here with the token counts the API reported, so limits survive
 * deleting sessions. Costs are estimates; nothing here is a credit balance.
 */
export class Ledger {
  private readonly path: string
  private entries: LedgerEntry[] = []

  constructor(dataDir: string) {
    this.path = join(dataDir, 'usage.jsonl')
  }

  async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.path, 'utf8')
      this.entries = text
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LedgerEntry]
          } catch {
            return []
          }
        })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async record(e: LedgerEntry): Promise<void> {
    this.entries.push(e)
    await fs.mkdir(join(this.path, '..'), { recursive: true })
    await fs.appendFile(this.path, JSON.stringify(e) + '\n')
  }

  private sum(filter: (e: LedgerEntry) => boolean): { cost: number; usage: TokenUsage; requests: number } {
    let cost = 0
    let usage = ZERO_USAGE
    let requests = 0
    for (const e of this.entries) {
      if (!filter(e)) continue
      cost += e.cost ?? 0
      usage = addUsage(usage, e.usage)
      requests++
    }
    return { cost, usage, requests }
  }

  spentToday(now = new Date()): number {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    return this.sum((e) => e.ts >= start).cost
  }

  spentThisMonth(now = new Date()): number {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    return this.sum((e) => e.ts >= start).cost
  }

  spentInSession(sessionId: string): number {
    return this.sum((e) => e.sessionId === sessionId).cost
  }

  summary(now = new Date()): UsageSummary {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const byModel = new Map<string, { model: string; cost: number; requests: number; usage: TokenUsage }>()
    let unpriced = 0
    for (const e of this.entries) {
      const row = byModel.get(e.model) ?? { model: e.model, cost: 0, requests: 0, usage: ZERO_USAGE }
      row.cost += e.cost ?? 0
      row.requests++
      row.usage = addUsage(row.usage, e.usage)
      byModel.set(e.model, row)
      if (e.cost === null) unpriced++
    }
    return {
      today: this.sum((e) => e.ts >= dayStart),
      month: this.sum((e) => e.ts >= monthStart),
      allTime: this.sum(() => true),
      byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
      unpricedRequests: unpriced
    }
  }
}
