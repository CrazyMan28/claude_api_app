// Renders build/icon.svg to build/icon.png (512x512) with headless Chromium.
// electron-builder converts the PNG to a multi-size .ico for Windows.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const svg = readFileSync(join(here, 'icon.svg'), 'utf8')
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
await page.locator('svg').screenshot({ path: join(here, 'icon.png'), omitBackground: true })
await browser.close()
console.log('wrote build/icon.png')
