import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Effort } from '@shared/models'
import type { Session, SessionSummary } from '@shared/types'
import { readJson, writeFileAtomic } from './fsutil'

const ID_RE = /^[0-9a-f-]{36}$/

/** One JSON file per session under <dataDir>/sessions. */
export class SessionStore {
  private readonly dir: string
  private cache = new Map<string, Session>()
  // Serialize writes per session so overlapping saves can't reorder.
  private writeChains = new Map<string, Promise<void>>()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'sessions')
  }

  private path(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid session id: ${id}`)
    return join(this.dir, `${id}.json`)
  }

  async create(opts: { projectDir: string | null; model: string; effort: Effort }): Promise<Session> {
    const now = Date.now()
    const s: Session = {
      id: randomUUID(),
      title: 'New session',
      createdAt: now,
      updatedAt: now,
      projectDir: opts.projectDir,
      model: opts.model,
      effort: opts.effort,
      messages: [],
      toolMeta: {},
      usage: []
    }
    this.cache.set(s.id, s)
    await this.save(s)
    return s
  }

  async get(id: string): Promise<Session | null> {
    const cached = this.cache.get(id)
    if (cached) return cached
    const s = await readJson<Session>(this.path(id))
    if (s) {
      s.toolMeta ??= {}
      s.usage ??= []
      this.cache.set(id, s)
    }
    return s
  }

  async save(s: Session): Promise<void> {
    s.updatedAt = Date.now()
    this.cache.set(s.id, s)
    const data = JSON.stringify(s)
    const prev = this.writeChains.get(s.id) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(() => writeFileAtomic(this.path(s.id), data))
    this.writeChains.set(s.id, next)
    await next
  }

  async rename(id: string, title: string): Promise<void> {
    const s = await this.get(id)
    if (!s) throw new Error('session not found')
    s.title = title.trim().slice(0, 120) || 'Untitled'
    await this.save(s)
  }

  async delete(id: string): Promise<void> {
    await this.writeChains.get(id)?.catch(() => undefined)
    this.cache.delete(id)
    this.writeChains.delete(id)
    await fs.rm(this.path(id), { force: true })
  }

  async list(): Promise<SessionSummary[]> {
    let names: string[] = []
    try {
      names = await fs.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: SessionSummary[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!ID_RE.test(id)) continue
      try {
        const s = await this.get(id)
        if (!s) continue
        out.push({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          projectDir: s.projectDir,
          model: s.model,
          messageCount: s.messages.length,
          cost: s.usage.reduce((sum, u) => sum + (u.cost ?? 0), 0)
        })
      } catch {
        // skip unreadable/corrupt files instead of breaking the whole list
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}
