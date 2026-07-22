// W4-1 three-viewport evidence capture (charter §8.1.8-10, lock §9 W4-1: 拍前真在场断言 + 目检).
// Reproducible driver for the five PNGs in docs/development/assets/w4-1-vnext-20260722/.
//
// Run from the repo root (needs the repo's node_modules — playwright is a root devDependency):
//   node docs/development/assets/w4-1-vnext-20260722/capture-harness/capture-setup-readiness.mjs
//
// What it does:
//   1. copies the harness page/entry into apps/web (temp files, removed at the end),
//   2. starts the apps/web vite dev server (real component + real tokens.css, synthetic fixtures),
//   3. for each scenario x viewport: runs the IN-PAGE presence assertions (component box non-zero,
//      elementFromPoint inside the component, 7 step cards non-zero, 7 preview entries present,
//      scrollWidth <= clientWidth) and only then captures a full-page PNG,
//   4. prints the assertion log (values included) — capture FAILS CLOSED on any assertion miss.
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../../..')
const webRoot = join(repoRoot, 'apps/web')
const assetsDir = resolve(here, '..')
const PORT = 5197

const tempHtml = join(webRoot, 'w41-setup-readiness-harness.html')
const tempTsDir = join(webRoot, 'src/dev-harness')
const tempTs = join(tempTsDir, 'w41SetupReadinessHarness.ts')

const SHOTS = [
  { file: 'w41-1440x900-all-ready-admin.png', width: 1440, height: 900, scenario: 'all-ready', role: 'admin' },
  { file: 'w41-1440x900-mixed-missing-admin.png', width: 1440, height: 900, scenario: 'mixed-missing', role: 'admin' },
  { file: 'w41-1440x900-mixed-missing-delegated.png', width: 1440, height: 900, scenario: 'mixed-missing', role: 'delegated' },
  { file: 'w41-1024x768-mixed-missing-admin.png', width: 1024, height: 768, scenario: 'mixed-missing', role: 'admin' },
  { file: 'w41-390x844-mixed-missing-delegated.png', width: 390, height: 844, scenario: 'mixed-missing', role: 'delegated' },
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
  // @playwright/test is the repo's root devDependency (root package.json) and re-exports the
  // playwright browser API; resolve it from the repo root so this script runs from any cwd.
  const { chromium } = await import(join(repoRoot, 'node_modules/@playwright/test/index.mjs'))

  copyFileSync(join(here, 'setup-readiness-harness.html'), tempHtml)
  mkdirSync(tempTsDir, { recursive: true })
  copyFileSync(join(here, 'w41SetupReadinessHarness.ts'), tempTs)

  const vite = spawn('pnpm', ['--filter', '@metasheet/web', 'exec', 'vite', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
  })

  let browser
  try {
    await waitForServer(`http://localhost:${PORT}/w41-setup-readiness-harness.html`)
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true })
    } catch {
      browser = await chromium.launch({ headless: true }) // fallback: bundled chromium
    }

    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })
      await page.goto(`http://localhost:${PORT}/w41-setup-readiness-harness.html?scenario=${shot.scenario}&role=${shot.role}`)
      await page.waitForSelector('[data-attendance-setup-readiness]')

      // 拍前在场断言 (in-page, before the capture) — fail closed.
      const check = await page.evaluate(() => {
        const root = document.querySelector('[data-attendance-setup-readiness]')
        if (!root) return { ok: false, why: 'component root missing' }
        const box = root.getBoundingClientRect()
        if (box.width <= 0 || box.height <= 0) return { ok: false, why: 'component box is zero' }
        const cards = Array.from(document.querySelectorAll('[data-setup-step]'))
        if (cards.length !== 7) return { ok: false, why: `expected 7 step cards, got ${cards.length}` }
        const zeroCard = cards.find((c) => c.getBoundingClientRect().width <= 0 || c.getBoundingClientRect().height <= 0)
        if (zeroCard) return { ok: false, why: `zero-size card ${zeroCard.getAttribute('data-setup-step')}` }
        const previewEntries = document.querySelectorAll('[data-setup-step-preview-entry]')
        if (previewEntries.length !== 7) return { ok: false, why: `expected 7 preview entries, got ${previewEntries.length}` }
        const first = cards[0].getBoundingClientRect()
        const probe = document.elementFromPoint(first.left + first.width / 2, Math.min(first.top + first.height / 2, window.innerHeight - 1))
        if (!probe || !root.contains(probe)) return { ok: false, why: 'elementFromPoint missed the component' }
        const doc = document.documentElement
        return {
          ok: doc.scrollWidth <= doc.clientWidth,
          why: doc.scrollWidth <= doc.clientWidth ? '' : 'horizontal page scroll',
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          box: { width: Math.round(box.width), height: Math.round(box.height) },
        }
      })
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
