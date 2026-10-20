import { join } from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readJson, writeFileAtomic } from '../store/fsutil'

interface StoredDevice {
  id: string
  name: string
  /** sha256 of the device token; the token itself is only ever held by the phone */
  tokenHash: string
  createdAt: number
  lastSeen: number | null
}

const hash = (token: string): Buffer => createHash('sha256').update(token).digest()

/** Paired phones. Persisted to <userData>/remote-devices.json. */
export class DeviceStore {
  private devices: StoredDevice[] = []
  private readonly path: string
  private lastSaved = 0

  constructor(dataDir: string) {
    this.path = join(dataDir, 'remote-devices.json')
  }

  async load(): Promise<void> {
    const saved = await readJson<StoredDevice[]>(this.path)
    this.devices = Array.isArray(saved) ? saved.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string') : []
  }

  private async save(): Promise<void> {
    this.lastSaved = Date.now()
    await writeFileAtomic(this.path, JSON.stringify(this.devices, null, 2))
  }

  list(): Omit<StoredDevice, 'tokenHash'>[] {
    return this.devices.map(({ tokenHash: _, ...d }) => d)
  }

  /** Register a new device and return its bearer token (shown to the phone once, never stored). */
  async add(name: string): Promise<{ id: string; token: string }> {
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    const clean = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Phone'
    this.devices.push({ id, name: clean, tokenHash: hash(token).toString('hex'), createdAt: Date.now(), lastSeen: Date.now() })
    await this.save()
    return { id, token }
  }

  /** Returns the device id for a valid token, or null. Constant-time per stored hash. */
  verify(token: unknown): string | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
    const h = hash(token)
    let found: string | null = null
    for (const d of this.devices) {
      const stored = Buffer.from(d.tokenHash, 'hex')
      if (stored.length === h.length && timingSafeEqual(stored, h)) found = d.id
    }
    return found
  }

  /** Record activity; written to disk at most once a minute. */
  touch(id: string): void {
    const d = this.devices.find((x) => x.id === id)
    if (!d) return
    d.lastSeen = Date.now()
    if (Date.now() - this.lastSaved > 60_000) void this.save().catch(() => {})
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.id !== id)
    if (this.devices.length === before) return false
    await this.save()
    return true
  }
}
