import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { z } from 'zod'
import { isTailnetAddress } from './tailscale'
import type { DeviceStore } from './devices'

/**
 * Remote access for the Forge Android app.
 *
 * Security model (layered):
 *  1. The server only ever binds to this PC's Tailscale address, so it is not reachable from
 *     the LAN or the internet; Tailscale (WireGuard) encrypts and authenticates the transport.
 *  2. Every connection whose peer address is outside the tailnet ranges is dropped.
 *  3. A phone must pair first with a single-use, short-lived random code shown only in the QR
 *     code on this PC. Pairing returns a per-device bearer token; only its hash is stored.
 *  4. Only an allowlist of methods is exposed (never the API key or settings), each with
 *     validated arguments. Revoking a device closes its sockets immediately.
 */

export interface RemoteContext {
  deviceId: string
}

export interface RemoteMethod {
  args: z.ZodType<unknown[]>
  run(args: unknown[], ctx: RemoteContext): unknown
}

export interface RemoteServerOptions {
  devices: DeviceStore
  methods: Record<string, RemoteMethod>
  /** peer filter; defaults to the Tailscale ranges. Tests pass a loopback filter. */
  allowPeer?: (addr: string | undefined) => boolean
  /** called after a device is paired or revoked */
  onDevicesChanged?(): void
}

export type RemoteMessage = { type: 'agent'; sessionId: string; ev: unknown } | { type: 'sessions' }

const PAIR_TTL_MS = 5 * 60 * 1000
const MAX_BODY = 1024 * 1024
const MAX_PAIR_FAILURES = 8
const AUTH_TIMEOUT_MS = 5000

interface Client {
  ws: WebSocket
  deviceId: string
  alive: boolean
}

export class RemoteServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private offer: { code: string; expiresAt: number } | null = null
  private failures = new Map<string, { count: number; resetAt: number }>()
  private heartbeat: NodeJS.Timeout | null = null
  private bound: { host: string; port: number } | null = null
  private requested: { host: string; port: number } | null = null
  private readonly allowPeer: (addr: string | undefined) => boolean

  constructor(private readonly opts: RemoteServerOptions) {
    this.allowPeer = opts.allowPeer ?? isTailnetAddress
  }

  get address(): { host: string; port: number } | null {
    return this.bound
  }

  onlineDeviceIds(): Set<string> {
    return new Set([...this.clients].map((c) => c.deviceId))
  }

  async start(host: string, port: number): Promise<void> {
    if (this.bound && this.requested?.host === host && this.requested.port === port) return
    await this.stop()
    const server = createServer((req, res) => void this.handle(req, res))
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0]
      if (path !== '/events' || !this.allowPeer(req.socket.remoteAddress)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    })
    server.headersTimeout = 15_000
    server.requestTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // never 0.0.0.0: only the given (Tailscale) address
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.wss = wss
    this.requested = { host, port }
    this.bound = { host, port: (server.address() as { port: number }).port }
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate()
          continue
        }
        c.alive = false
        c.ws.ping()
      }
    }, 25_000)
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const c of this.clients) c.ws.terminate()
    this.clients.clear()
    this.wss?.close()
    this.wss = null
    const server = this.server
    this.server = null
    this.bound = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /** Start a pairing window. Any earlier unused code stops working. */
  startPairing(): { code: string; expiresAt: number } {
    this.offer = { code: randomBytes(24).toString('base64url'), expiresAt: Date.now() + PAIR_TTL_MS }
    return { ...this.offer }
  }

  cancelPairing(): void {
    this.offer = null
  }

  broadcast(msg: RemoteMessage): void {
    if (!this.clients.size) return
    const data = JSON.stringify(msg)
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data)
  }

  /** Close every socket of a revoked device. */
  disconnectDevice(deviceId: string): void {
    for (const c of this.clients) {
      if (c.deviceId === deviceId) {
        c.ws.close(4403, 'revoked')
        this.clients.delete(c)
      }
    }
  }

  private accept(ws: WebSocket): void {
    let client: Client | null = null
    const timer = setTimeout(() => ws.close(4401, 'unauthorized'), AUTH_TIMEOUT_MS)
    ws.on('message', (raw) => {
      if (client) return // clients only listen after auth
      clearTimeout(timer)
      let token: unknown
      try {
        token = (JSON.parse(raw.toString()) as { token?: unknown }).token
      } catch {
        /* fallthrough */
      }
      const deviceId = this.opts.devices.verify(token)
      if (!deviceId) return ws.close(4401, 'unauthorized')
      client = { ws, deviceId, alive: true }
      this.clients.add(client)
      this.opts.devices.touch(deviceId)
      ws.send(JSON.stringify({ type: 'ready' }))
      this.opts.onDevicesChanged?.()
    })
    ws.on('pong', () => {
      if (client) client.alive = true
    })
    ws.on('close', () => {
      clearTimeout(timer)
      if (client && this.clients.delete(client)) this.opts.onDevicesChanged?.()
    })
    ws.on('error', () => ws.terminate())
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowPeer(req.socket.remoteAddress)) {
      req.socket.destroy()
      return
    }
    // The phone app's WebView runs on its own origin; auth is a bearer token (no cookies),
    // so a permissive CORS policy does not expose anything.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const path = (req.url ?? '').split('?')[0]
    try {
      if (req.method === 'OPTIONS') return this.reply(res, 204)
      if (req.method === 'GET' && path === '/ping') return this.reply(res, 200, { forge: true })
      if (req.method === 'POST' && path === '/pair') return await this.pair(req, res)
      if (req.method === 'POST' && path === '/rpc') return await this.rpc(req, res)
      this.reply(res, 404, { error: 'Not found' })
    } catch (err) {
      if (err instanceof HttpError) this.reply(res, err.status, { error: err.message })
      else this.reply(res, 500, { error: 'Internal error' })
    }
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? '?'
    const now = Date.now()
    const f = this.failures.get(ip)
    if (f && f.resetAt < now) this.failures.delete(ip)
    if ((this.failures.get(ip)?.count ?? 0) >= MAX_PAIR_FAILURES) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.')
    const body = (await readJson(req)) as { code?: unknown; deviceName?: unknown }
    const offer = this.offer
    const code = typeof body?.code === 'string' ? body.code : ''
    const ok = !!offer && offer.expiresAt > now && safeEqual(code, offer.code)
    if (!ok) {
      const cur = this.failures.get(ip) ?? { count: 0, resetAt: now + 10 * 60 * 1000 }
      cur.count++
      this.failures.set(ip, cur)
      throw new HttpError(403, offer && offer.expiresAt > now ? 'Invalid pairing code.' : 'This QR code has expired. Show a new one in Forge Settings on your PC.')
    }
    this.offer = null // single use
    const { id, token } = await this.opts.devices.add(typeof body.deviceName === 'string' ? body.deviceName : 'Phone')
    this.opts.onDevicesChanged?.()
    this.reply(res, 200, { token, deviceId: id })
  }

  private async rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? ''
    const deviceId = this.opts.devices.verify(auth.startsWith('Bearer ') ? auth.slice(7) : null)
    if (!deviceId) throw new HttpError(401, 'This phone is not paired (or was removed). Pair it again from Forge Settings on your PC.')
    this.opts.devices.touch(deviceId)
    const body = (await readJson(req)) as { method?: unknown; args?: unknown }
    const method = typeof body?.method === 'string' && Object.hasOwn(this.opts.methods, body.method) ? this.opts.methods[body.method] : undefined
    if (!method) throw new HttpError(403, 'Not available from the phone.')
    const parsed = method.args.safeParse(body.args ?? [])
    if (!parsed.success) throw new HttpError(400, 'Invalid arguments.')
    try {
      const result = await method.run(parsed.data, { deviceId })
      this.reply(res, 200, { ok: true, result: result ?? null })
    } catch (err) {
      this.reply(res, 200, { ok: false, error: (err as Error)?.message ?? String(err) })
    }
  }

  private reply(res: ServerResponse, status: number, body?: unknown): void {
    if (res.headersSent) return
    res.statusCode = status
    if (body === undefined) return void res.end()
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large.')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'Invalid JSON.')
  }
}
