import type { AgentEvent, ForgeApi } from '@shared/types'

export interface Pairing {
  /** e.g. http://100.88.1.2:47821 */
  base: string
  /** what to show the user (MagicDNS name or IP) */
  label: string
  token: string
}

export interface PairLink {
  base: string
  label: string
  code: string
}

/** Parse the forge://pair?h=..&p=..&c=..&n=.. link from the QR code. */
export function parsePairLink(raw: string): PairLink | null {
  const text = raw.trim()
  if (!/^forge:\/\/pair\?/i.test(text)) return null
  const q = new URLSearchParams(text.slice(text.indexOf('?') + 1))
  const h = q.get('h')
  const p = Number(q.get('p'))
  const c = q.get('c')
  if (!h || !c || !Number.isInteger(p) || p <= 0 || p > 65535) return null
  if (!/^[0-9a-fA-F:.]+$/.test(h)) return null // an IP address, nothing else
  const host = h.includes(':') ? `[${h}]` : h
  return { base: `http://${host}:${p}`, label: q.get('n') || h, code: c }
}

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function postJson(url: string, body: unknown, token?: string, timeoutMs = 20_000): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: ctl.signal
    })
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }
  } catch {
    throw new RemoteError("Can't reach your PC. Check that Tailscale is connected on both devices and Forge is running on the PC.", 0)
  } finally {
    clearTimeout(t)
  }
}

/** Exchange the one-time QR code for this phone's device token. */
export async function pairWithPc(link: PairLink, deviceName: string): Promise<Pairing> {
  const r = await postJson(`${link.base}/pair`, { code: link.code, deviceName })
  if (r.status !== 200 || typeof r.json?.token !== 'string') throw new RemoteError(String(r.json?.error ?? `Pairing failed (${r.status}).`), r.status)
  return { base: link.base, label: link.label, token: r.json.token }
}

const notOnPhone = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is managed in Forge on your PC.`)
}

/**
 * ForgeApi over HTTP + WebSocket, so the phone runs the exact same UI as the PC.
 * Calls go to POST /rpc; agent events and session-list changes arrive over /events.
 */
export function createRemoteForge(p: Pairing, hooks: { onUnauthorized(): void; unpair(): Promise<void> }): ForgeApi & { close(): void } {
  const agentListeners = new Set<(id: string, ev: AgentEvent) => void>()
  const sessionListeners = new Set<() => void>()
  const connListeners = new Set<(ok: boolean) => void>()
  let online = false
  let ws: WebSocket | null = null
  let retry = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let dead = false

  const setOnline = (ok: boolean): void => {
    if (ok === online) return
    online = ok
    for (const cb of connListeners) cb(ok)
  }

  const rpc = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    // optional trailing arguments must not turn into JSON nulls
    while (args.length && args[args.length - 1] === undefined) args.pop()
    const r = await postJson(`${p.base}/rpc`, { method, args }, p.token)
    if (r.status === 401) {
      dead = true
      hooks.onUnauthorized()
    }
    if (r.status !== 200) throw new RemoteError(String(r.json?.error ?? `Request failed (${r.status}).`), r.status)
    if (!r.json?.ok) throw new RemoteError(String(r.json?.error ?? 'Request failed.'), 200)
    return r.json.result as T
  }

  const connect = (): void => {
    if (dead || (ws && ws.readyState <= WebSocket.OPEN)) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    const sock = new WebSocket(`${p.base.replace(/^http/, 'ws')}/events`)
    ws = sock
    sock.onopen = () => sock.send(JSON.stringify({ token: p.token }))
    sock.onmessage = (e) => {
      let msg: { type?: string; sessionId?: string; ev?: AgentEvent }
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (msg.type === 'ready') {
        retry = 0
        setOnline(true)
      } else if (msg.type === 'agent' && msg.sessionId && msg.ev) {
        for (const cb of agentListeners) cb(msg.sessionId, msg.ev)
      } else if (msg.type === 'sessions') {
        for (const cb of sessionListeners) cb()
      }
    }
    sock.onclose = (e) => {
      if (ws === sock) ws = null
      setOnline(false)
      if (dead) return
      if (e.code === 4401 || e.code === 4403) {
        dead = true
        hooks.onUnauthorized()
        return
      }
      const delay = Math.min(15_000, 800 * 2 ** retry++)
      retryTimer = setTimeout(connect, delay)
    }
  }
  connect()
  // Android suspends the WebView in the background: reconnect right away on return.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && !online) {
      retry = 0
      if (ws && ws.readyState !== WebSocket.OPEN) ws.close()
      connect()
    }
  }
  document.addEventListener('visibilitychange', onVisible)

  return {
    close: () => {
      dead = true
      if (retryTimer) clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', onVisible)
      ws?.close()
    },
    getSettings: () => rpc('settings:get'),
    updateSettings: notOnPhone('Settings'),
    setApiKey: notOnPhone('The API key'),
    clearApiKey: notOnPhone('The API key'),
    testApiKey: notOnPhone('The API key'),
    listSessions: () => rpc('sessions:list'),
    getSession: (id) => rpc('sessions:get', id),
    createSession: (opts) => rpc('sessions:create', opts),
    renameSession: (id, title) => rpc('sessions:rename', id, title),
    deleteSession: (id) => rpc('sessions:delete', id),
    updateSession: (id, patch) => rpc('sessions:update', id, patch),
    send: (id, text) => rpc('agent:send', id, text),
    continueRun: (id) => rpc('agent:continue', id),
    stop: (id) => rpc('agent:stop', id),
    isRunning: (id) => rpc('agent:running', id),
    respondApproval: (requestId, decision) => rpc('agent:approval', requestId, decision),
    pickDirectory: async () => null, // the app shows the project picker instead
    gitStatus: (dir) => rpc('git:status', dir),
    gitDiff: (dir, file, staged) => rpc('git:diff', dir, file, staged),
    gitLog: (dir) => rpc('git:log', dir),
    usageSummary: () => rpc('usage:summary'),
    openExternal: async (url) => {
      window.open(url, '_blank')
    },
    listProjects: () => rpc('projects:list'),
    runningSessions: () => rpc('agent:runningSessions'),
    pendingApprovals: () => rpc('agent:pendingApprovals'),
    remoteStatus: notOnPhone('Phone access'),
    remoteStartPairing: notOnPhone('Phone access'),
    remoteRevoke: notOnPhone('Phone access'),
    onAgentEvent: (cb) => {
      agentListeners.add(cb)
      return () => agentListeners.delete(cb)
    },
    onSessionsChanged: (cb) => {
      sessionListeners.add(cb)
      return () => sessionListeners.delete(cb)
    },
    platform: 'android',
    mobile: {
      host: p.label,
      unpair: async () => {
        dead = true
        await rpc('device:unpair').catch(() => {})
        ws?.close()
        await hooks.unpair()
      },
      onConnection: (cb) => {
        connListeners.add(cb)
        cb(online)
        return () => connListeners.delete(cb)
      }
    }
  }
}
