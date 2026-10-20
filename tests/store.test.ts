import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsStore } from '../src/main/store/settings'
import { SessionStore } from '../src/main/store/sessions'
import { Ledger } from '../src/main/store/ledger'
import { estimateCost } from '../src/shared/models'
import { fakeCipher, tempDir } from './helpers'

describe('settings', () => {
  it('stores the API key encrypted and never in settings.json', async () => {
    const dir = tempDir()
    const s = new SettingsStore(dir, fakeCipher)
    await s.load()
    await expect(s.setApiKey('not-a-key')).rejects.toThrow(/sk-ant-/)
    const view = await s.setApiKey('  sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234  ')
    expect(view.hasApiKey).toBe(true)
    expect(view.keyHint).toBe('sk-ant-api…1234')
    expect(JSON.stringify(view)).not.toContain('abcdefghijklmnop')
    await s.update({ approvalMode: 'auto-edits', limitDaily: 5 })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('sk-ant')
    expect(readFileSync(join(dir, 'api-key.bin'), 'utf8')).not.toContain('sk-ant')
    const again = new SettingsStore(dir, fakeCipher)
    await again.load()
    expect(again.getApiKey()).toBe('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234')
    expect(again.get().approvalMode).toBe('auto-edits')
    await again.clearApiKey()
    expect(again.publicView().hasApiKey).toBe(false)
  })
  it('refuses to store a key without OS encryption', async () => {
    const s = new SettingsStore(tempDir(), { ...fakeCipher, isAvailable: () => false })
    await s.load()
    await expect(s.setApiKey('sk-ant-api03-abcdefghijklmnop')).rejects.toThrow(/Secure storage/)
  })
  it('sanitizes bad values', async () => {
    const s = new SettingsStore(tempDir(), fakeCipher)
    await s.load()
    await s.update({ approvalMode: 'yolo' as never, maxStepsPerRun: -5, limitDaily: Number.NaN })
    expect(s.get().approvalMode).toBe('ask')
    expect(s.get().maxStepsPerRun).toBe(1)
    expect(s.get().limitDaily).toBe(0)
  })
})

describe('sessions', () => {
  it('creates, lists, renames, deletes', async () => {
    const dir = tempDir()
    const store = new SessionStore(dir)
    const a = await store.create({ projectDir: null, model: 'claude-opus-5-5', effort: 'high' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.create({ projectDir: '/p', model: 'claude-sonnet-5-5', effort: 'low' })
    // the rename must land in a later millisecond than b's creation, or the two tie on updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await store.rename(a.id, '  Fix the build  ')
    const fresh = new SessionStore(dir)
    const list = await fresh.list()
    expect(list.map((s) => s.id)).toEqual([a.id, b.id])
    expect(list[0]!.title).toBe('Fix the build')
    await fresh.delete(b.id)
    expect((await new SessionStore(dir).list()).map((s) => s.id)).toEqual([a.id])
    await expect(fresh.get('../../etc/passwd')).rejects.toThrow(/invalid session id/)
  })
})

describe('costs and ledger', () => {
  it('estimates cost from usage', () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 0 }
    expect(estimateCost('claude-opus-5-5', u)).toBeCloseTo(4 + 20 + 0.2 + 5)
    expect(estimateCost('claude-unknown', u)).toBeNull()
    // Haiku 5.5 long-context tier (>100K prompt tokens) is 5x
    expect(estimateCost('claude-haiku-5-5', { input: 200_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeCloseTo(0.1)
  })
  it('sums spend by day, month and session and persists', async () => {
    const dir = tempDir()
    const l = new Ledger(dir)
    await l.load()
    const now = new Date()
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    await l.record({ ts: now.getTime(), sessionId: 's1', model: 'claude-opus-5-5', usage, cost: 1.5 })
    await l.record({ ts: now.getTime() - 40 * 86400_000, sessionId: 's2', model: 'claude-opus-5-5', usage, cost: 2 })
    await l.record({ ts: now.getTime(), sessionId: 's1', model: 'mystery', usage, cost: null })
    const l2 = new Ledger(dir)
    await l2.load()
    expect(l2.spentToday()).toBeCloseTo(1.5)
    expect(l2.spentInSession('s1')).toBeCloseTo(1.5)
    const sum = l2.summary()
    expect(sum.allTime.cost).toBeCloseTo(3.5)
    expect(sum.unpricedRequests).toBe(1)
  })
})
