// End-to-end UI test: launches the built Electron app against the mock API,
// drives it like a user and saves screenshots to e2e/screenshots.
// Run: npm run build && xvfb-run -a node e2e/ui.e2e.mjs
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import electronPath from 'electron'
import { startMockApi } from './mock-api.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const shots = join(here, 'screenshots')
mkdirSync(shots, { recursive: true })

const userData = mkdtempSync(join(tmpdir(), 'forge-e2e-data-'))
const project = mkdtempSync(join(tmpdir(), 'forge-e2e-proj-'))
const mock = await startMockApi()

async function launch() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js'), '--password-store=basic', '--no-sandbox'],
    env: {
      ...process.env,
      FORGE_USER_DATA: userData,
      FORGE_API_BASE_URL: `http://127.0.0.1:${mock.port}`,
      FORGE_E2E_PROJECT_DIR: project,
      // Linux CI has no keyring; on Windows the real DPAPI-backed safeStorage is exercised.
      ...(process.platform === 'win32' ? {} : { FORGE_E2E_TEST_KEYSTORE: '1' })
    }
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1480, height: 920 })
  win.on('console', (m) => m.type() === 'error' && console.log('[renderer error]', m.text()))
  win.on('pageerror', (e) => console.log('[pageerror]', e.message))
  return { app, win }
}

const step = (s) => console.log(`✓ ${s}`)

let { app, win } = await launch()
await win.waitForSelector('.modal', { timeout: 15000 })
step('settings opens automatically when no API key is saved')
await win.screenshot({ path: join(shots, '01-settings-first-run.png') })

await win.fill('input[placeholder="sk-ant-api03-…"]', 'sk-ant-api03-e2e-test-key-0000000000')
await win.click('button:has-text("Save & test")')
await win.waitForSelector('.test-result.ok', { timeout: 15000 })
assert.match(await win.textContent('.test-result.ok'), /Key works/)
step('API key saved (encrypted) and tested')
await win.screenshot({ path: join(shots, '02-key-saved.png') })
assert.ok(!readFileSync(join(userData, 'api-key.bin')).toString('utf8').includes('sk-ant'), 'key must not be stored in plaintext')
await win.keyboard.press('Escape')

await win.waitForSelector('.welcome')
await win.screenshot({ path: join(shots, '03-welcome.png') })
await win.click('.chip:has-text("Choose project folder")')
await win.waitForSelector(`.chip:has-text("${basename(project)}")`)
step('project folder selected')

await win.fill('.composer textarea', 'Create a hello world Python script')
await win.keyboard.press('Enter')
await win.waitForSelector('.approval', { timeout: 15000 })
step('approval requested for write_file with a diff preview')
assert.match(await win.textContent('.approval'), /Hello from Forge/)
await win.screenshot({ path: join(shots, '04-approval.png') })
await win.click('.approval button:has-text("Approve")')

await win.waitForSelector('text=Run it with', { timeout: 15000 })
await win.waitForSelector('.send-btn:not(.stop)')
step('agent loop completed: tool results fed back, final answer streamed')
assert.equal(readFileSync(join(project, 'hello.py'), 'utf8'), 'print("Hello from Forge")\n')
step('file actually written to the project')
await win.waitForSelector('.usage-line:has-text("3 requests")')
assert.equal(await win.textContent('.session-title'), 'Create a hello world Python script')
step('per-turn usage line and session title shown')
await win.waitForTimeout(600)
await win.screenshot({ path: join(shots, '05-conversation.png') })

// The real request shape the SDK sent
const first = mock.requests.find((r) => r.params.stream)
assert.equal(first.params.model, 'claude-opus-5-5')
assert.deepEqual(first.params.thinking, { type: 'adaptive', display: 'summarized' })
assert.deepEqual(first.params.output_config, { effort: 'high' })
assert.equal(first.params.fallbacks, 'default')
assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/)
assert.ok(first.params.tools.every((t) => t.eager_input_streaming === true))
const third = mock.requests.filter((r) => r.params.stream)[1]
assert.equal(third.params.messages[1].content[0].type, 'thinking', 'thinking block replayed')
assert.equal(third.params.messages[1].content[0].signature, 'mock-signature', 'signature preserved')
step('request shape verified (adaptive thinking, effort, fallbacks, eager tool streaming, thinking replay)')

// Stop mid-stream, then Continue (which then runs a command after approval)
await win.fill('.composer textarea', 'Explain something slowly')
await win.keyboard.press('Enter')
await win.waitForSelector('.md.cursor', { timeout: 15000 })
await win.waitForTimeout(500)
await win.click('.send-btn.stop')
await win.waitForSelector('.notice:has-text("Stopped")', { timeout: 15000 })
await win.waitForSelector('button:has-text("Continue")')
await win.waitForSelector('text=stopped by user')
step('stop interrupts a streaming response, keeps the partial text and offers Continue')
await win.screenshot({ path: join(shots, '05b-stopped.png') })
await win.click('button:has-text("Continue")')
await win.waitForSelector('.approval:has-text("run a command")', { timeout: 15000 })
await win.screenshot({ path: join(shots, '05c-command-approval.png') })
await win.keyboard.press('y')
await win.waitForSelector('text=Command finished; all good.', { timeout: 15000 })
await win.click('.tool:has-text("echo forge-command-output") .tool-head')
await win.waitForSelector('.tool-body:has-text("[exit code: 0]")')
step('continue resumed; run_command approved with the keyboard and its output shown')
await win.screenshot({ path: join(shots, '05d-command-output.png') })

await win.click('.tab:has-text("Usage")')
await win.waitForSelector('.stat-card')
await win.screenshot({ path: join(shots, '06-usage.png') })
await win.click('.tab:has-text("Changes")')
await win.waitForSelector('.file-row:has-text("hello.py")')
await win.screenshot({ path: join(shots, '07-changes.png') })
step('usage and changes panels render')

// rename via double-click
await win.dblclick('.session-item.active')
await win.fill('.session-item.active input', 'Hello script')
await win.keyboard.press('Enter')
await win.waitForSelector('.session-item.active:has-text("Hello script")')
step('session renamed')

await app.close()
;({ app, win } = await launch())
await win.waitForSelector('.session-item:has-text("Hello script")', { timeout: 15000 })
await win.waitForSelector('text=Run it with')
step('session and history restored after restart')
await win.screenshot({ path: join(shots, '08-after-restart.png') })

// new session + delete it
await win.click('.btn-new')
await win.waitForSelector('.welcome')
const count = await win.locator('.session-item').count()
assert.equal(count, 2)
win.once('dialog', (d) => d.accept())
await win.hover('.session-item.active')
await win.click('.session-item.active button[title="Delete"]')
await win.waitForFunction(() => document.querySelectorAll('.session-item').length === 1)
step('session created and deleted')

await app.close()
mock.server.close()
assert.ok(existsSync(join(shots, '05-conversation.png')))
console.log('\nE2E PASSED')
