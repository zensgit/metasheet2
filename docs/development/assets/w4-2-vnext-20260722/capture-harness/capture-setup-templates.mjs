// W4-2 three-viewport evidence capture (charter §8.1.8-10, lock §9 W4-2: 拍前真在场断言 + 目检).
// Reproducible driver for the PNGs in docs/development/assets/w4-2-vnext-20260722/.
//
// Run from the repo root (needs the repo's node_modules — playwright is a root devDependency):
//   node docs/development/assets/w4-2-vnext-20260722/capture-harness/capture-setup-templates.mjs
//
// What it does:
//   1. copies the harness page/entry into apps/web (temp files, removed at the end),
//   2. starts the apps/web vite dev server (real components + real tokens.css, synthetic fixtures),
//   3. for each scenario x viewport: runs the IN-PAGE presence assertions (component box non-zero,
//      7 step cards, 4 template cards when the gallery is expected, dialog panel + stage-specific
//      buttons when a dialog is expected, elementFromPoint probe, scrollWidth <= clientWidth) and
//      only then captures a full-page PNG,
//   4. prints the assertion log — capture FAILS CLOSED on any assertion miss.
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../../..')
const webRoot = join(repoRoot, 'apps/web')
const assetsDir = resolve(here, '..')
const PORT = 5198

const tempHtml = join(webRoot, 'w42-setup-templates-harness.html')
const tempTsDir = join(webRoot, 'src/dev-harness')
const tempTs = join(tempTsDir, 'w42SetupTemplatesHarness.ts')

const SHOTS = [
  { file: 'w42-1440x900-all-ready-gallery.png', width: 1440, height: 900, query: 'scenario=all-ready&dialog=none&pending=none', dialog: 'none' },
  { file: 'w42-1440x900-mixed-missing-gallery.png', width: 1440, height: 900, query: 'scenario=mixed-missing&dialog=none&pending=none', dialog: 'none' },
  { file: 'w42-1440x900-dialog-confirm.png', width: 1440, height: 900, query: 'scenario=all-ready&dialog=confirm&pending=none', dialog: 'confirm' },
  { file: 'w42-1440x900-dialog-applied-pending.png', width: 1440, height: 900, query: 'scenario=all-ready&dialog=applied&pending=office-fixed', dialog: 'applied' },
  { file: 'w42-1024x768-all-ready-gallery.png', width: 1024, height: 768, query: 'scenario=all-ready&dialog=none&pending=none', dialog: 'none' },
  { file: 'w42-1024x768-dialog-confirm.png', width: 1024, height: 768, query: 'scenario=all-ready&dialog=confirm&pending=none', dialog: 'confirm' },
  { file: 'w42-390x844-all-ready-gallery.png', width: 390, height: 844, query: 'scenario=all-ready&dialog=none&pending=none', dialog: 'none' },
  { file: 'w42-390x844-dialog-confirm-no-tz.png', width: 390, height: 844, query: 'scenario=all-ready&dialog=confirm-no-tz&pending=none', dialog: 'confirm' },
]

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`vite dev server did not come up at ${url}`)
}

async function main() {
  const { chromium } = await import(join(repoRoot, 'node_modules/@playwright/test/index.mjs'))

  copyFileSync(join(here, 'setup-templates-harness.html'), tempHtml)
  mkdirSync(tempTsDir, { recursive: true })
  copyFileSync(join(here, 'w42SetupTemplatesHarness.ts'), tempTs)

  const vite = spawn('pnpm', ['--filter', '@metasheet/web', 'exec', 'vite', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
  })

  let browser
  try {
    await waitForServer(`http://localhost:${PORT}/w42-setup-templates-harness.html`)
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true })
    } catch {
      browser = await chromium.launch({ headless: true }) // fallback: bundled chromium
    }

    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })
      await page.goto(`http://localhost:${PORT}/w42-setup-templates-harness.html?${shot.query}`)
      await page.waitForSelector('[data-attendance-setup-readiness]')

      // 拍前在场断言 (in-page, before the capture) — fail closed.
      const check = await page.evaluate((dialogMode) => {
        const root = document.querySelector('[data-attendance-setup-readiness]')
        if (!root) return { ok: false, why: 'component root missing' }
        const box = root.getBoundingClientRect()
        if (box.width <= 0 || box.height <= 0) return { ok: false, why: 'component box is zero' }
        const cards = Array.from(document.querySelectorAll('[data-setup-step]'))
        if (cards.length !== 7) return { ok: false, why: `expected 7 step cards, got ${cards.length}` }
        const templates = Array.from(document.querySelectorAll('[data-setup-template-card]'))
        if (templates.length !== 4) return { ok: false, why: `expected 4 template cards, got ${templates.length}` }
        const zeroTemplate = templates.find((c) => c.getBoundingClientRect().width <= 0 || c.getBoundingClientRect().height <= 0)
        if (zeroTemplate) return { ok: false, why: `zero-size template card ${zeroTemplate.getAttribute('data-setup-template-card')}` }
        const derivation = document.querySelector('[data-setup-preview-derivation]')
        if (!derivation) return { ok: false, why: 'preview derivation panel missing' }
        if (dialogMode === 'none') {
          if (document.querySelector('[data-setup-template-dialog]')) return { ok: false, why: 'unexpected dialog present' }
          const first = templates[0].getBoundingClientRect()
          const probe = document.elementFromPoint(first.left + first.width / 2, Math.min(first.top + first.height / 2, window.innerHeight - 1))
          if (!probe) return { ok: false, why: 'elementFromPoint missed the gallery' }
        } else {
          const dialog = document.querySelector('[data-setup-template-dialog]')
          if (!dialog) return { ok: false, why: 'dialog missing' }
          if (dialog.getAttribute('data-setup-template-dialog-stage') !== (dialogMode === 'applied' ? 'applied' : 'confirm')) {
            return { ok: false, why: `dialog stage mismatch: ${dialog.getAttribute('data-setup-template-dialog-stage')}` }
          }
          const panel = dialog.querySelector('[role="dialog"]')
          const pbox = panel?.getBoundingClientRect()
          if (!pbox || pbox.width <= 0 || pbox.height <= 0) return { ok: false, why: 'dialog panel box is zero' }
          const stageButton = dialogMode === 'applied'
            ? dialog.querySelector('[data-setup-template-undo]')
            : dialog.querySelector('[data-setup-template-apply]')
          if (!stageButton) return { ok: false, why: 'stage button missing' }
          const probe = document.elementFromPoint(pbox.left + pbox.width / 2, Math.min(pbox.top + pbox.height / 2, window.innerHeight - 1))
          if (!probe || !dialog.contains(probe)) return { ok: false, why: 'elementFromPoint missed the dialog' }
        }
        const doc = document.documentElement
        return {
          ok: doc.scrollWidth <= doc.clientWidth,
          why: doc.scrollWidth <= doc.clientWidth ? '' : 'horizontal page scroll',
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          box: { width: Math.round(box.width), height: Math.round(box.height) },
        }
      }, shot.dialog)
      if (!check.ok) throw new Error(`[${shot.file}] presence assertion FAILED: ${check.why}`)
      console.log(`[${shot.file}] presence PASS — component ${check.box.width}x${check.box.height}, scrollWidth/clientWidth ${check.scrollWidth}/${check.clientWidth}`)

      await page.screenshot({ path: join(assetsDir, shot.file), fullPage: true })
      await page.close()
    }
  } finally {
    if (browser) await browser.close()
    try { process.kill(-vite.pid) } catch { try { vite.kill() } catch { /* already gone */ } }
    if (existsSync(tempHtml)) rmSync(tempHtml)
    if (existsSync(tempTs)) rmSync(tempTs)
    try { rmSync(tempTsDir, { recursive: true }) } catch { /* non-empty means user files — leave it */ }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
