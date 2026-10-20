import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { DeviceStore } from '../src/main/remote/devices'
import { RemoteController } from '../src/main/remote/controller'
import { remoteMethods, type Handlers } from '../src/main/remote/methods'
import { findTailscaleAddress, isTailnetAddress } from '../src/main/remote/tailscale'
import { tempDir } from './helpers'

const loopback = (a: string | undefined): boolean => a === '127.0.0.1' || a === '::ffff:127.0.0.1'

let controller: RemoteController | null = null
afterEach(async () => {
  await controller?.dispose()
  controller = null
})

async function setup(opts: { allowPeer?: (a: string | undefined) => boolean } = {}) {
  const dir = tempDir()
  const devices = new DeviceStore(dir)
  await devices.load()
  const calls: unknown[][] = []
  const handlers: Handlers = {
    'settings:get': () => ({ hasApiKey: true, keyHint: 'sk-ant-api…1234' }),
    'sessions:list': () => [{ id: 's1' }],
    'sessions:create': (o: unknown) => (calls.push(['create', o]), { id: 'new' }),
    'git:status': (d: string) => (calls.push(['git', d]), { isRepo: true }),
    'apikey:set': () => 'should never run'
  }
  const c: RemoteController = new RemoteController({
    devices,
    methods: remoteMethods(handlers, async () => ['/known/project'], (id): Promise<void> => c.revoke(id)),
    settings: () => ({ enabled: true, port: 0 }),
    onChange: () => {},
    findAddress: () => '127.0.0.1',
    dnsName: async () => 'my-pc.tail-1234.ts.net',
    allowPeer: opts.allowPeer ?? loopback
  })
  controller = c
  await c.refresh()
  const base = `http://127.0.0.1:${c.status().port}`
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }
  }
  const pair = async (): Promise<string> => {
    const offer = await c.startPairing()
    const code = new URL(offer.link.replace('forge://', 'http://x/')).searchParams.get('c')!
    const r = await post('/pair', { code, deviceName: 'Pixel' })
    expect(r.status).toBe(200)
    return String(r.json!.token)
  }
  return { c, dir, base, post, pair, calls, devices }
}

function openSocket(base: string): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<number> }> {
  const ws = new WebSocket(base.replace('http', 'ws') + '/events')
  const messages: unknown[] = []
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())))
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages, closed }))
    ws.once('error', reject)
  })
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20))
}

describe('tailscale detection', () => {
  it('recognises tailnet addresses only', () => {
    expect(isTailnetAddress('100.101.102.103')).toBe(true)
    expect(isTailnetAddress('::ffff:100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.127.255.255')).toBe(true)
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailnetAddress('100.128.0.1')).toBe(false)
    expect(isTailnetAddress('100.63.0.1')).toBe(false)
    expect(isTailnetAddress('192.168.1.10')).toBe(false)
    expect(isTailnetAddress('127.0.0.1')).toBe(false)
    expect(isTailnetAddress(undefined)).toBe(false)
  })
  it('picks the Tailscale interface address', () => {
    const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never
    expect(findTailscaleAddress({ lo: [iface('127.0.0.1', 'IPv4', true)], eth0: [iface('192.168.1.5', 'IPv4')] })).toBeNull()
    expect(findTailscaleAddress({ eth0: [iface('192.168.1.5', 'IPv4')], Tailscale: [iface('fd7a:115c:a1e0::5', 'IPv6'), iface('100.88.1.2', 'IPv4')] })).toBe('100.88.1.2')
    expect(findTailscaleAddress({ tailscale0: [iface('fd7a:115c:a1e0::5', 'IPv6')] })).toBe('fd7a:115c:a1e0::5')
  })
})

describe('remote server', () => {
  it('pairs with a single-use code and stores only a token hash', async () => {
    const { c, dir, post, pair } = await setup()
    const offer = await c.startPairing()
    expect(offer.link).toMatch(/^forge:\/\/pair\?h=127\.0\.0\.1&p=\d+&c=[\w-]{32}&n=my-pc/)
    expect(offer.qr).toMatch(/^data:image\/svg\+xml;base64,/)
    const code = new URL(offer.link.replace('forge://', 'http://x/')).searchParams.get('c')!
    const ok = await post('/pair', { code, deviceName: 'Pixel 9' })
    expect(ok.status).toBe(200)
    const token = String(ok.json!.token)
    expect(token.length).toBeGreaterThan(30)
    expect((await post('/pair', { code, deviceName: 'Attacker' })).status).toBe(403)
    const stored = readFileSync(join(dir, 'remote-devices.json'), 'utf8')
    expect(stored).not.toContain(token)
    expect(stored).toContain('Pixel 9')
    expect(c.status().devices.map((d) => d.name)).toEqual(['Pixel 9'])
    expect(await pair()).not.toBe(token)
  })

  it('rejects wrong codes and rate-limits guessing', async () => {
    const { c, post } = await setup()
    await c.startPairing()
    for (let i = 0; i < 8; i++) expect((await post('/pair', { code: 'x'.repeat(32) })).status).toBe(403)
    expect((await post('/pair', { code: 'x'.repeat(32) })).status).toBe(429)
  })

  it('requires a valid token for RPC and only exposes allowlisted methods', async () => {
    const { post, pair, calls } = await setup()
    expect((await post('/rpc', { method: 'sessions:list' })).status).toBe(401)
    expect((await post('/rpc', { method: 'sessions:list' }, 'not-a-real-token-but-long-enough')).status).toBe(401)
    const token = await pair()
    const list = await post('/rpc', { method: 'sessions:list', args: [] }, token)
    expect(list.json).toEqual({ ok: true, result: [{ id: 's1' }] })
    expect((await post('/rpc', { method: 'apikey:set', args: ['sk-ant-x'] }, token)).status).toBe(403)
    expect((await post('/rpc', { method: 'settings:update', args: [{}] }, token)).status).toBe(403)
    expect((await post('/rpc', { method: 'toString', args: [] }, token)).status).toBe(403)
    expect((await post('/rpc', { method: 'sessions:get', args: [42] }, token)).status).toBe(400)
    const s = await post('/rpc', { method: 'settings:get', args: [] }, token)
    expect((s.json!.result as { keyHint: unknown }).keyHint).toBeNull()
    // only folders already used on the PC
    const bad = await post('/rpc', { method: 'git:status', args: ['C:\\Users\\me\\.ssh'] }, token)
    expect(bad.json!.ok).toBe(false)
    const badCreate = await post('/rpc', { method: 'sessions:create', args: [{ projectDir: '/etc' }] }, token)
    expect(badCreate.json!.ok).toBe(false)
    expect((await post('/rpc', { method: 'git:status', args: ['/known/project'] }, token)).json!.ok).toBe(true)
    expect(calls).toEqual([['git', '/known/project']])
  })

  it('streams events to authenticated sockets and drops revoked devices', async () => {
    const { c, base, post, pair } = await setup()
    const token = await pair()
    const sock = await openSocket(base)
    sock.ws.send(JSON.stringify({ token }))
    await until(() => sock.messages.length > 0)
    expect(sock.messages[0]).toEqual({ type: 'ready' })
    expect(c.status().devices[0]!.online).toBe(true)
    c.broadcast({ type: 'agent', sessionId: 's1', ev: { type: 'run_start' } })
    await until(() => sock.messages.length > 1)
    expect(sock.messages[1]).toEqual({ type: 'agent', sessionId: 's1', ev: { type: 'run_start' } })

    const unauth = await openSocket(base)
    unauth.ws.send(JSON.stringify({ token: 'wrong-token-wrong-token-wrong' }))
    expect(await unauth.closed).toBe(4401)

    await c.revoke(c.status().devices[0]!.id)
    expect(await sock.closed).toBe(4403)
    expect((await post('/rpc', { method: 'sessions:list' }, token)).status).toBe(401)
  })

  it('lets a phone unpair itself', async () => {
    const { c, post, pair } = await setup()
    const token = await pair()
    expect((await post('/rpc', { method: 'device:unpair', args: [] }, token)).json!.ok).toBe(true)
    expect(c.status().devices).toEqual([])
    expect((await post('/rpc', { method: 'sessions:list' }, token)).status).toBe(401)
  })

  it('refuses peers outside the tailnet', async () => {
    const { base } = await setup({ allowPeer: isTailnetAddress })
    await expect(fetch(base + '/ping')).rejects.toThrow()
  })

  it('does not listen when disabled or when Tailscale is missing', async () => {
    const devices = new DeviceStore(tempDir())
    await devices.load()
    let enabled = false
    let addr: string | null = null
    const c = new RemoteController({ devices, methods: {}, settings: () => ({ enabled, port: 0 }), onChange: () => {}, findAddress: () => addr, dnsName: async () => null })
    controller = c
    await c.refresh()
    expect(c.status().listening).toBe(false)
    enabled = true
    await c.refresh()
    expect(c.status()).toMatchObject({ listening: false, error: expect.stringMatching(/Tailscale is not running/) })
    await expect(c.startPairing()).rejects.toThrow(/Tailscale/)
    addr = '127.0.0.1'
    await c.refresh()
    expect(c.status().listening).toBe(true)
  })
})
