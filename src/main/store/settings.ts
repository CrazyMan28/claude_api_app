import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS } from '@shared/models'
import type { ApprovalMode, PublicSettings, Settings } from '@shared/types'
import { readJson, writeFileAtomic } from './fsutil'

/** Encrypts the API key at rest. In the app this is Electron safeStorage (DPAPI on Windows). */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: DEFAULT_MODEL,
  defaultEffort: DEFAULT_EFFORT,
  approvalMode: 'ask',
  refusalFallback: true,
  subagentModel: 'claude-sonnet-5-5',
  subagentEffort: 'medium',
  maxStepsPerRun: 80,
  limitPerSession: 0,
  limitDaily: 0,
  limitMonthly: 0,
  lastProjectDir: null
}

const APPROVAL_MODES: ApprovalMode[] = ['ask', 'auto-edits', 'auto', 'read-only']

function sanitize(patch: Partial<Settings>, base: Settings): Settings {
  const out: Settings = { ...base }
  if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) out.defaultModel = patch.defaultModel.trim()
  if (patch.defaultEffort && EFFORTS.includes(patch.defaultEffort)) out.defaultEffort = patch.defaultEffort
  if (patch.approvalMode && APPROVAL_MODES.includes(patch.approvalMode)) out.approvalMode = patch.approvalMode
  if (typeof patch.refusalFallback === 'boolean') out.refusalFallback = patch.refusalFallback
  if (typeof patch.subagentModel === 'string' && patch.subagentModel.trim()) out.subagentModel = patch.subagentModel.trim()
  if (patch.subagentEffort && EFFORTS.includes(patch.subagentEffort)) out.subagentEffort = patch.subagentEffort
  const num = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined
  out.maxStepsPerRun = num(patch.maxStepsPerRun, 1, 1000) ?? out.maxStepsPerRun
  out.limitPerSession = num(patch.limitPerSession, 0, 1e6) ?? out.limitPerSession
  out.limitDaily = num(patch.limitDaily, 0, 1e6) ?? out.limitDaily
  out.limitMonthly = num(patch.limitMonthly, 0, 1e6) ?? out.limitMonthly
  if (patch.lastProjectDir === null || typeof patch.lastProjectDir === 'string') out.lastProjectDir = patch.lastProjectDir
  return out
}

export class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS }
  private apiKey: string | null = null
  private readonly settingsPath: string
  private readonly keyPath: string

  constructor(
    dataDir: string,
    private readonly cipher: SecretCipher
  ) {
    this.settingsPath = join(dataDir, 'settings.json')
    this.keyPath = join(dataDir, 'api-key.bin')
  }

  async load(): Promise<void> {
    const saved = await readJson<Partial<Settings>>(this.settingsPath)
    this.settings = sanitize(saved ?? {}, DEFAULT_SETTINGS)
    try {
      const raw = await fs.readFile(this.keyPath)
      this.apiKey = this.cipher.decrypt(raw)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Undecryptable (e.g. copied from another Windows user): treat as unset.
        this.apiKey = null
      }
    }
  }

  get(): Settings {
    return { ...this.settings }
  }

  getApiKey(): string | null {
    return this.apiKey
  }

  publicView(): PublicSettings {
    const k = this.apiKey
    return {
      ...this.settings,
      hasApiKey: !!k,
      keyHint: k ? `${k.slice(0, 10)}…${k.slice(-4)}` : null,
      encryptionAvailable: this.cipher.isAvailable()
    }
  }

  async update(patch: Partial<Settings>): Promise<PublicSettings> {
    this.settings = sanitize(patch, this.settings)
    await writeFileAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
    return this.publicView()
  }

  async setApiKey(key: string): Promise<PublicSettings> {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('API key is empty')
    if (!/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(trimmed)) {
      throw new Error('That does not look like an Anthropic API key (expected it to start with "sk-ant-").')
    }
    if (!this.cipher.isAvailable()) {
      throw new Error('Secure storage is not available on this system, so the key cannot be stored safely.')
    }
    await writeFileAtomic(this.keyPath, this.cipher.encrypt(trimmed))
    this.apiKey = trimmed
    return this.publicView()
  }

  async clearApiKey(): Promise<PublicSettings> {
    await fs.rm(this.keyPath, { force: true })
    this.apiKey = null
    return this.publicView()
  }
}
