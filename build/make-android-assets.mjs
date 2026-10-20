// Renders the Android launcher icons and splash screens from build/icon.svg with headless Chromium.
// Run: node build/make-android-assets.mjs (output is committed under mobile/android/app/src/main/res)
import { chromium } from 'playwright-core'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const res = join(here, '../mobile/android/app/src/main/res')
const svg = readFileSync(join(here, 'icon.svg'), 'utf8')
// the "F" mark and spark without the rounded tile, for the adaptive-icon foreground
const mark = svg.replace(/<rect[^>]*\/>/g, '')
const BG = '#0b0a1d'

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await browser.newPage()

async function render(path, w, h, html) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden">${html}</body></html>`)
  await page.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } })
}
const fit = (s, size) => s.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [d, k] of Object.entries(densities)) {
  const dir = join(res, `mipmap-${d}`)
  const legacy = Math.round(48 * k)
  // the tile in icon.svg has a 16px margin of 512; scale it to fill the legacy icon
  await render(join(dir, 'ic_launcher.png'), legacy, legacy, `<div style="margin:-${legacy * 0.03}px">${fit(svg, legacy * 1.06)}</div>`)
  await render(join(dir, 'ic_launcher_round.png'), legacy, legacy, `<div style="width:${legacy}px;height:${legacy}px;border-radius:50%;overflow:hidden;background:${BG}"><div style="margin:-${legacy * 0.1}px">${fit(svg, legacy * 1.2)}</div></div>`)
  const fg = Math.round(108 * k)
  // keep the mark inside the 66dp safe zone of the 108dp adaptive canvas
  const m = Math.round(fg * 0.62)
  await render(join(dir, 'ic_launcher_foreground.png'), fg, fg, `<div style="display:grid;place-items:center;width:${fg}px;height:${fg}px">${fit(mark, m)}</div>`)
}

for (const dir of readdirSync(res).filter((d) => d.startsWith('drawable'))) {
  const file = join(res, dir, 'splash.png')
  if (!existsSync(file)) continue
  const b = readFileSync(file)
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  const s = Math.round(Math.min(w, h) * 0.32)
  await render(
    file,
    w,
    h,
    `<div style="width:${w}px;height:${h}px;display:grid;place-items:center;background:radial-gradient(60% 45% at 50% 40%, rgba(139,123,255,.22), transparent 70%), #06070c">${fit(svg, s)}</div>`
  )
}
await browser.close()
console.log('wrote Android icons and splash screens')
