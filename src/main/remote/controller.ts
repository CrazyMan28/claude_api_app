import QRCode from 'qrcode'
import type { PairingOffer, RemoteSettings, RemoteStatus } from '@shared/types'
import { RemoteServer, type RemoteMessage, type RemoteMethod } from './server'
import { findTailscaleAddress, tailscaleDnsName } from './tailscale'
import type { DeviceStore } from './devices'

export interface RemoteControllerOptions {
  devices: DeviceStore
  methods: Record<string, RemoteMethod>
  settings(): RemoteSettings
  /** remote status changed (devices paired/online, listening state) */
  onChange(): void
  /** overridable for tests; defaults to detecting the Tailscale interface */
  findAddress?: () => string | null
  dnsName?: () => Promise<string | null>
  allowPeer?: (addr: string | undefined) => boolean
}

/** Starts/stops the remote server to match the settings and the Tailscale interface. */
export class RemoteController {
  readonly server: RemoteServer
  private error: string | null = null
  private dns: string | null = null
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null

  constructor(private readonly o: RemoteControllerOptions) {
    this.server = new RemoteServer({ devices: o.devices, methods: o.methods, allowPeer: o.allowPeer, onDevicesChanged: () => o.onChange() })
  }

  /** Begin watching; Tailscale can come up (or change address) after Forge starts. */
  watch(intervalMs = 30_000): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), intervalMs)
    this.timer.unref?.()
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.server.stop()
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null))
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    const { enabled, port } = this.o.settings()
    const before = JSON.stringify([this.server.address, this.error])
    if (!enabled) {
      this.error = null
      await this.server.stop()
    } else {
      const addr = (this.o.findAddress ?? findTailscaleAddress)()
      if (!addr) {
        this.error = 'Tailscale is not running on this PC. Install Tailscale, sign in, then come back.'
        await this.server.stop()
      } else {
        try {
          await this.server.start(addr, port)
          this.error = null
          this.dns = await (this.o.dnsName ?? tailscaleDnsName)()
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          this.error = code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port.` : `Could not start: ${(err as Error).message}`
          await this.server.stop()
        }
      }
    }
    if (JSON.stringify([this.server.address, this.error]) !== before) this.o.onChange()
  }

  status(): RemoteStatus {
    const { enabled, port } = this.o.settings()
    const online = this.server.onlineDeviceIds()
    const addr = this.server.address
    return {
      enabled,
      listening: !!addr,
      address: addr?.host ?? (enabled ? null : (this.o.findAddress ?? findTailscaleAddress)()),
      dnsName: addr ? this.dns : null,
      port: addr?.port ?? port,
      error: this.error,
      devices: this.o.devices
        .list()
        .map((d) => ({ ...d, online: online.has(d.id) }))
        .sort((a, b) => b.createdAt - a.createdAt)
    }
  }

  async startPairing(): Promise<PairingOffer> {
    await this.refresh()
    const addr = this.server.address
    if (!addr) throw new Error(this.error ?? 'Turn on phone access first.')
    const { code, expiresAt } = this.server.startPairing()
    const params = new URLSearchParams({ h: addr.host, p: String(addr.port), c: code })
    if (this.dns) params.set('n', this.dns)
    const link = `forge://pair?${params.toString()}`
    const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0d16', light: '#ffffff' } })
    return { link, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, expiresAt }
  }

  async revoke(deviceId: string): Promise<void> {
    await this.o.devices.revoke(deviceId)
    this.server.disconnectDevice(deviceId)
    this.o.onChange()
  }

  broadcast(msg: RemoteMessage): void {
    this.server.broadcast(msg)
  }
}
