import { app, BrowserWindow, dialog, ipcMain, safeStorage, session as electronSession, shell } from 'electron'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { EFFORTS } from '@shared/models'
import type { AgentEvent, ApiKeyTestResult, ApprovalDecision, Session, Settings } from '@shared/types'
import { SettingsStore, type SecretCipher } from './store/settings'
import { SessionStore } from './store/sessions'
import { Ledger } from './store/ledger'
import { Agent, describeApiError, sdkStreamer } from './agent/agent'
import { gitDiff, gitLog, gitStatus } from './agent/git'
import { DeviceStore } from './remote/devices'
import { RemoteController } from './remote/controller'
import { remoteMethods, type Handlers } from './remote/methods'

// Smoke-test hooks (used by CI/e2e only): isolated data dir.
if (process.env.FORGE_USER_DATA) app.setPath('userData', process.env.FORGE_USER_DATA)

const dataDir = (): string => app.getPath('userData')

const osCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data)
}

// Headless Linux CI has no keyring. Only unpackaged dev/test builds may opt into this
// obfuscating (NOT secure) store; the packaged app always uses the OS (DPAPI on Windows, the keyring on Linux).
const testCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(`forge-test:${Buffer.from(plain).toString('base64')}`),
  decrypt: (data) => Buffer.from(data.toString().replace(/^forge-test:/, ''), 'base64').toString()
}

const cipher = (): SecretCipher => (!app.isPackaged && process.env.FORGE_E2E_TEST_KEYSTORE === '1' ? testCipher : osCipher)

let settings: SettingsStore
let sessions: SessionStore
let ledger: Ledger
let agent: Agent
let devices: DeviceStore
let remote: RemoteController
let mainWindow: BrowserWindow | null = null

function makeClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    // Never pick up ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL from the environment:
    // requests always go to the first-party API with the user's own key.
    authToken: null,
    baseURL: process.env.FORGE_API_BASE_URL || 'https://api.anthropic.com',
    maxRetries: 3,
    timeout: 15 * 60 * 1000
  })
}

function emit(sessionId: string, ev: AgentEvent): void {
  mainWindow?.webContents.send('agent:event', sessionId, ev)
  remote?.broadcast({ type: 'agent', sessionId, ev })
}

/** Tell every client (this window and paired phones) to reload the session list. */
function sessionsChanged(): void {
  mainWindow?.webContents.send('sessions:changed')
  remote?.broadcast({ type: 'sessions' })
}

async function knownProjects(): Promise<string[]> {
  const dirs = new Set<string>()
  const last = settings.get().lastProjectDir
  if (last) dirs.add(last)
  for (const s of await sessions.list()) if (s.projectDir) dirs.add(s.projectDir)
  return [...dirs]
}

// Automated UI tests only: serve "remote access" on loopback instead of the Tailscale interface.
const remoteLoopbackForTests = !app.isPackaged && process.env.FORGE_E2E_REMOTE_LOOPBACK === '1'

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#07080d',
    title: 'Forge',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32' ? { color: '#07080d', symbolColor: '#c9d1e8', height: 40 } : false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // No navigation away from the app and no new windows; external links go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow?.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

async function newSession(projectDir?: string | null): Promise<Session> {
  const s = settings.get()
  const dir = projectDir === undefined ? s.lastProjectDir : projectDir
  return sessions.create({ projectDir: dir ?? null, model: s.defaultModel, effort: s.defaultEffort })
}

function buildHandlers(): Handlers {
  const h: Handlers = {}
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void => {
    h[channel] = fn as Handlers[string]
  }
  handle('settings:get', () => settings.publicView())
  handle('apikey:set', (key: string) => settings.setApiKey(String(key)))
  handle('apikey:clear', () => settings.clearApiKey())
  handle('apikey:test', async (): Promise<ApiKeyTestResult> => {
    const key = settings.getApiKey()
    if (!key) return { ok: false, message: 'No API key saved yet.' }
    const client = makeClient(key)
    try {
      const ids: string[] = []
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id)
      // A 1-token request on the cheapest model confirms the key can actually bill
      // (listing models works even when the organization has no usable credits).
      await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 32, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with OK.' }] })
      return { ok: true, message: `Key works. ${ids.length} models available to your organization.`, models: ids }
    } catch (err) {
      return { ok: false, message: describeApiError(err) }
    }
  })
  handle('sessions:list', () => sessions.list())
  handle('sessions:get', (id: string) => sessions.get(id))
  handle('sessions:create', (opts?: { projectDir?: string | null }) => newSession(opts?.projectDir))
  handle('sessions:rename', (id: string, title: string) => sessions.rename(id, title))
  handle('sessions:delete', async (id: string) => {
    agent.stop(id)
    await sessions.delete(id)
  })
  handle('sessions:update', async (id: string, patch: Partial<Pick<Session, 'model' | 'effort' | 'projectDir'>>) => {
    const s = await sessions.get(id)
    if (!s) return null
    if (agent.isRunning(id)) throw new Error('Stop the agent before changing session settings.')
    if (typeof patch.model === 'string' && patch.model.trim()) s.model = patch.model.trim()
    if (patch.effort && EFFORTS.includes(patch.effort)) s.effort = patch.effort
    if (patch.projectDir === null || typeof patch.projectDir === 'string') {
      s.projectDir = patch.projectDir
      await settings.update({ lastProjectDir: patch.projectDir })
    }
    await sessions.save(s)
    return s
  })
  handle('agent:send', (id: string, text: string) => {
    void agent.send(id, String(text)).catch((err) => emit(id, { type: 'run_end', status: 'error', error: (err as Error).message }))
  })
  handle('agent:continue', (id: string) => {
    void agent.continueRun(id).catch((err) => emit(id, { type: 'run_end', status: 'error', error: (err as Error).message }))
  })
  handle('agent:stop', (id: string) => agent.stop(id))
  handle('agent:running', (id: string) => agent.isRunning(id))
  handle('agent:approval', (requestId: string, decision: ApprovalDecision) => agent.respondApproval(requestId, decision))
  handle('agent:runningSessions', () => agent.runningSessionIds())
  handle('agent:pendingApprovals', () => agent.pendingApprovals())
  handle('projects:list', () => knownProjects())
  handle('dialog:pickDirectory', async () => {
    if (process.env.FORGE_E2E_PROJECT_DIR) return process.env.FORGE_E2E_PROJECT_DIR // automated UI tests only
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose project folder' })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  handle('git:status', (dir: string) => gitStatus(dir))
  handle('git:diff', (dir: string, file?: string, staged?: boolean) => gitDiff(dir, file, staged))
  handle('git:log', (dir: string) => gitLog(dir))
  handle('usage:summary', () => ledger.summary())
  handle('shell:openExternal', async (url: string) => {
    const allowed = ['https://platform.claude.com', 'https://console.anthropic.com', 'https://docs.claude.com', 'https://support.claude.com']
    if (allowed.some((a) => url === a || url.startsWith(a + '/'))) await shell.openExternal(url)
  })
  handle('settings:update', async (patch: Partial<Settings>) => {
    const view = await settings.update(patch)
    if (patch.remote) await remote.refresh()
    return view
  })
  handle('remote:status', async () => {
    await remote.refresh()
    return remote.status()
  })
  handle('remote:startPairing', () => remote.startPairing())
  handle('remote:revoke', async (id: string) => {
    await remote.revoke(String(id))
    return remote.status()
  })
  // Session list changes are pushed to every client, wherever they came from.
  for (const ch of ['sessions:create', 'sessions:rename', 'sessions:delete', 'sessions:update']) {
    const fn = h[ch]!
    h[ch] = async (...args: unknown[]) => {
      const r = await fn(...args)
      sessionsChanged()
      return r
    }
  }
  return h
}

function registerIpc(h: Handlers): void {
  for (const [channel, fn] of Object.entries(h)) ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

app.whenReady().then(async () => {
  settings = new SettingsStore(dataDir(), cipher())
  sessions = new SessionStore(dataDir())
  ledger = new Ledger(dataDir())
  devices = new DeviceStore(dataDir())
  await Promise.all([settings.load(), ledger.load(), devices.load()])
  agent = new Agent({
    settings,
    sessions,
    ledger,
    emit,
    streamer: () => {
      const key = settings.getApiKey()
      return key ? sdkStreamer(makeClient(key)) : null
    }
  })
  // Strict CSP for the renderer (no remote code, no inline scripts).
  electronSession.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:*"
        ]
      }
    })
  })
  const handlers = buildHandlers()
  remote = new RemoteController({
    devices,
    methods: remoteMethods(handlers, knownProjects, (id) => remote.revoke(id)),
    settings: () => settings.get().remote,
    onChange: () => {},
    ...(remoteLoopbackForTests ? { findAddress: () => '127.0.0.1', dnsName: async () => null, allowPeer: (a) => a === '127.0.0.1' || a === '::ffff:127.0.0.1' } : {})
  })
  remote.watch()
  registerIpc(handlers)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => void remote?.dispose())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
