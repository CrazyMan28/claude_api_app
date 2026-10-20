// End-to-end test of Forge for Android: the built phone web app (mobile/www) runs in Chromium at
// a phone viewport and pairs with the real desktop app, whose remote server listens on loopback
// (test-only stand-in for the Tailscale interface). Saves screenshots to e2e/screenshots.
// Run: npm run build && npm run build:mobile && xvfb-run -a node e2e/mobile.e2e.mjs
import { _electron as electron, chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import electronPath from 'electron'
import { startMockApi } from './mock-api.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const www = join(root, 'mobile/www')
const shots = join(here, 'screenshots')
mkdirSync(shots, { recursive: true })
assert.ok(existsSync(join(www, 'index.html')), 'run npm run build:mobile first')

const userData = mkdtempSync(join(tmpdir(), 'forge-e2e-data-'))
const project = mkdtempSync(join(tmpdir(), 'forge-e2e-proj-'))
const mock = await startMockApi()
const step = (s) => console.log(`✓ ${s}`)

// static server for the phone's web layer (what Capacitor serves inside the APK)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const web = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const file = join(www, path === '/' ? 'index.html' : path)
  if (!file.startsWith(www) || !existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const webUrl = `http://127.0.0.1:${web.address().port}/`

const app = await electron.launch({
  executablePath: electronPath,
  args: [join(root, 'out/main/index.js'), '--password-store=basic', '--no-sandbox'],
  env: {
    ...process.env,
    FORGE_USER_DATA: userData,
    FORGE_API_BASE_URL: `http://127.0.0.1:${mock.port}`,
    FORGE_E2E_PROJECT_DIR: project,
    FORGE_E2E_REMOTE_LOOPBACK: '1',
    ...(process.platform === 'win32' ? {} : { FORGE_E2E_TEST_KEYSTORE: '1' })
  }
})
const pc = await app.firstWindow()
await pc.setViewportSize({ width: 1480, height: 920 })
pc.on('pageerror', (e) => console.log('[pc pageerror]', e.message))

function findChromium() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (base && existsSync(base)) {
    for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x))) {
      for (const p of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe']) if (existsSync(join(base, d, p))) return { executablePath: join(base, d, p) }
    }
  }
  return { channel: 'chrome' } // preinstalled on GitHub runners
}
const browser = await chromium.launch(findChromium())
const phoneCtx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const phone = await phoneCtx.newPage()
phone.on('pageerror', (e) => console.log('[phone pageerror]', e.message))
phone.on('dialog', (d) => d.accept())
pc.on('dialog', (d) => d.accept())

const openDrawer = async () => {
  if (!(await phone.locator('.app.mobile.drawer-open').count())) await phone.click('[aria-label="Sessions"]')
  await phone.waitForSelector('.app.mobile.drawer-open')
  await phone.waitForTimeout(350) // slide-in transition
}

try {
  // --- PC: API key, a project, then turn on phone access and show a pairing code
  await pc.waitForSelector('.modal', { timeout: 15000 })
  await pc.fill('input[placeholder="sk-ant-api03-…"]', 'sk-ant-api03-e2e-test-key-0000000000')
  await pc.click('button:has-text("Save & test")')
  await pc.waitForSelector('.test-result.ok', { timeout: 15000 })
  await pc.keyboard.press('Escape')
  await pc.click('.chip:has-text("Choose project folder")')
  await pc.waitForSelector(`.chip:has-text("${basename(project)}")`)
  await pc.click('button[title="Settings (Ctrl+,)"]')
  await pc.click('[aria-label="toggle phone access"]')
  await pc.waitForSelector('.remote-status.ok', { timeout: 15000 })
  await pc.click('button:has-text("Pair a phone")')
  await pc.waitForSelector('.qr img')
  await pc.locator('.remote-section').scrollIntoViewIfNeeded()
  await pc.waitForTimeout(400)
  await pc.screenshot({ path: join(shots, 'm01-pc-pairing-qr.png') })
  const link = (await pc.textContent('[data-testid="pair-link"]')).trim()
  assert.match(link, /^forge:\/\/pair\?h=127\.0\.0\.1&p=\d+&c=/)
  step('PC: phone access on, single-use pairing QR shown')

  // --- phone: pair
  await phone.goto(webUrl)
  await phone.waitForSelector('.pair-screen')
  await phone.waitForTimeout(500)
  await phone.screenshot({ path: join(shots, 'm02-phone-pair.png') })
  await phone.fill('.pair-manual input', link)
  await phone.click('.pair-manual button')
  await phone.waitForSelector('.app.mobile', { timeout: 15000 })
  await pc.waitForSelector('.device-row:has-text("connected")', { timeout: 15000 })
  step('phone paired; PC lists it as connected')
  await pc.keyboard.press('Escape')

  // a used code cannot pair a second phone
  const port = new URL(link.replace('forge://', 'http://x/')).searchParams.get('p')
  const replay = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', body: JSON.stringify({ code: new URL(link.replace('forge://', 'http://x/')).searchParams.get('c') }) })
  assert.equal(replay.status, 403)
  step('pairing code is single-use')

  // --- phone: chat in the PC's session, approve the edit from the phone
  await phone.waitForSelector(`.chip:has-text("${basename(project)}")`, { timeout: 15000 })
  await phone.fill('.composer textarea', 'Create a hello world Python script')
  await phone.click('.send-btn')
  await phone.waitForSelector('.approval', { timeout: 15000 })
  await pc.waitForSelector('.approval', { timeout: 15000 })
  step('approval request reaches both the phone and the PC')
  await phone.waitForTimeout(400)
  await phone.screenshot({ path: join(shots, 'm03-phone-approval.png') })
  await phone.click('.approval button:has-text("Approve")')
  await phone.waitForSelector('text=Run it with', { timeout: 15000 })
  await pc.waitForSelector('text=Run it with', { timeout: 15000 })
  assert.equal(readFileSync(join(project, 'hello.py'), 'utf8'), 'print("Hello from Forge")\n')
  await phone.waitForTimeout(500)
  await phone.screenshot({ path: join(shots, 'm04-phone-chat.png') })
  step('phone sent the message, streamed the reply and approved the file write')

  // --- phone: changes panel as a bottom sheet
  await phone.click('button[title="Toggle side panel (Ctrl+B)"]')
  await phone.waitForSelector('.mobile-sheet .file-row:has-text("hello.py")', { timeout: 15000 })
  await phone.waitForTimeout(500)
  await phone.screenshot({ path: join(shots, 'm05-phone-changes.png') })
  await phone.click('.mobile-sheet .tab:has-text("Git")')
  await phone.waitForTimeout(300)
  await phone.click('.mobile-sheet .tab:has-text("Usage")')
  await phone.waitForSelector('.mobile-sheet .stat-card', { timeout: 15000 })
  await phone.click('.mobile-sheet [aria-label="Close panel"]')
  step('changes, git and usage panels work on the phone')

  // --- phone: start a session in a known project, then delete it
  await openDrawer()
  await phone.screenshot({ path: join(shots, 'm06-phone-sessions.png') })
  await phone.click('.btn-new')
  await pc.waitForFunction(() => document.querySelectorAll('.session-item').length === 2, null, { timeout: 15000 })
  step('session started from the phone shows up on the PC')
  await phone.click('.chip >> nth=0')
  await phone.waitForSelector('.project-row')
  await phone.screenshot({ path: join(shots, 'm07-phone-project-picker.png') })
  await phone.click('.project-row')
  await phone.waitForSelector(`.chip:has-text("${basename(project)}")`)
  await openDrawer()
  await phone.click('.session-item.active button[title="Delete"]')
  await pc.waitForFunction(() => document.querySelectorAll('.session-item').length === 1, null, { timeout: 15000 })
  step('session deleted from the phone disappears on the PC')

  // --- phone settings, then revoke from the PC
  await openDrawer()
  await phone.click('button[title="Settings (Ctrl+,)"]')
  await phone.waitForSelector('.modal:has-text("Connected PC")')
  await phone.waitForTimeout(400)
  await phone.screenshot({ path: join(shots, 'm08-phone-settings.png') })
  await phone.keyboard.press('Escape')

  await pc.click('button[title="Settings (Ctrl+,)"]')
  await pc.click('.device-row button[title="Remove this phone"]')
  await phone.waitForSelector('.pair-screen:has-text("removed")', { timeout: 15000 })
  step('removing the phone on the PC disconnects it immediately')
} finally {
  await browser.close()
  await app.close()
  web.close()
  mock.server.close()
}
console.log('\nMOBILE E2E PASSED')
