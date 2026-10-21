// Launches the packaged app (dist/win-unpacked/Forge.exe on Windows, dist/linux-unpacked/forge on Linux)
// and checks the UI boots.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'
const exe = process.argv[2] ?? (isWin ? join(here, '..', 'dist', 'win-unpacked', 'Forge.exe') : join(here, '..', 'dist', 'linux-unpacked', 'forge'))
const shots = join(here, 'screenshots')
mkdirSync(shots, { recursive: true })
// Linux CI runners have no SUID sandbox helper or keyring.
const args = isWin ? [] : ['--no-sandbox', '--password-store=basic']
const app = await electron.launch({ executablePath: exe, args, env: { ...process.env, FORGE_USER_DATA: mkdtempSync(join(tmpdir(), 'forge-pkg-')) } })
const win = await app.firstWindow()
win.on('pageerror', (e) => {
  console.error('pageerror', e)
  process.exitCode = 1
})
await win.waitForSelector('.modal', { timeout: 30000 })
await win.waitForSelector('text=Anthropic API key')
const encryption = await win.evaluate(() => window.forge.getSettings().then((s) => s.encryptionAvailable))
if (!encryption && isWin) throw new Error('safeStorage encryption is not available in the packaged app')
await win.keyboard.press('Escape')
await win.waitForSelector('.welcome')
await win.screenshot({ path: join(shots, `packaged-${process.platform}.png`) })
await app.close()
console.log('PACKAGED APP SMOKE TEST PASSED (encryption available:', encryption, ')')
