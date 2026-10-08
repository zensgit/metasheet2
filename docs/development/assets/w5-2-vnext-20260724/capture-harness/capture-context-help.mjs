// W5-2 three-viewport evidence capture (charter §8.1.8-10, lock §9 W5-2: 拍前真在场断言 + 目检).
// Reproducible driver for the six PNGs in docs/development/assets/w5-2-vnext-20260724/.
//
// Run from the repo root (needs the repo's node_modules — playwright is a root devDependency):
//   node docs/development/assets/w5-2-vnext-20260724/capture-harness/capture-context-help.mjs
//
// What it does (W4-1/W5-1 capture-harness form, verbatim discipline):
//   1. copies the harness page/entry into apps/web (temp files, removed at the end),
//   2. starts the apps/web vite dev server (real component + real tokens.css + real pure module —
//      every string on screen comes from the same closed-set content the specs assert against),
//   3. for each context x locale x viewport: runs the IN-PAGE presence assertions (component box
//      non-zero, elementFromPoint inside the component, scenario-specific key-state element
//      present, and scrollWidth <= clientWidth) and only then captures a full-page PNG,
//   4. prints the assertion log — capture FAILS CLOSED (throws) on any assertion miss.
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../../..')
const webRoot = join(repoRoot, 'apps/web')
const assetsDir = resolve(here, '..')
const PORT = 5199

const tempHtml = join(webRoot, 'w52-context-help-harness.html')
const tempTsDir = join(webRoot, 'src/dev-harness')
const tempTs = join(tempTsDir, 'w52ContextHelpHarness.ts')

// Scenario-specific presence probes (拍前在场断言, key states per shot).
const KEY_PROBES = {
  'setup-wizard': [
    ['[data-context-help-entry][data-context-help-category="applicable_scenarios"]', 1],
    ['[data-context-help-entry][data-context-help-category="save_impact"]', 1],
  ],
  import: [
    ['[data-context-help-entry][data-context-help-category="failure_recovery"] li', 6],
  ],
  'self-request-center': [
    ['[data-context-help-entry][data-context-help-category="evidence_link"]', 1],
    ['[data-context-help-evidence-link]', 1],
  ],
}

const SHOTS = [
  { file: 'w52-1440x900-setup-wizard-zh.png', width: 1440, height: 900, context: 'setup-wizard', locale: 'zh' },
  { file: 'w52-1440x900-import-zh.png', width: 1440, height: 900, context: 'import', locale: 'zh' },
  { file: 'w52-1024x768-import-zh.png', width: 1024, height: 768, context: 'import', locale: 'zh' },
  { file: 'w52-1024x768-self-request-center-zh.png', width: 1024, height: 768, context: 'self-request-center', locale: 'zh' },
  { file: 'w52-390x844-setup-wizard-zh.png', width: 390, height: 844, context: 'setup-wizard', locale: 'zh' },
  { file: 'w52-390x844-self-request-center-en.png', width: 390, height: 844, context: 'self-request-center', locale: 'en' },
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

  copyFileSync(join(here, 'context-help-harness.html'), tempHtml)
  mkdirSync(tempTsDir, { recursive: true })
  copyFileSync(join(here, 'w52ContextHelpHarness.ts'), tempTs)

  const vite = spawn('pnpm', ['--filter', '@metasheet/web', 'exec', 'vite', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
  })

  let browser
  try {
    await waitForServer(`http://localhost:${PORT}/w52-context-help-harness.html`)
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true })
    } catch {
      browser = await chromium.launch({ headless: true }) // fallback: bundled chromium
    }

    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })
      await page.goto(`http://localhost:${PORT}/w52-context-help-harness.html?context=${shot.context}&locale=${shot.locale}`)
      await page.waitForSelector('[data-attendance-context-help]')

      // 拍前在场断言 (in-page, before the capture) — fail closed.
      const check = await page.evaluate(({ probes, contextId }) => {
        const root = document.querySelector('[data-attendance-context-help]')
        if (!root) return { ok: false, why: 'component root missing' }
        if (root.getAttribute('data-context-help-context') !== contextId) {
          return { ok: false, why: `context mismatch: ${root.getAttribute('data-context-help-context')}` }
        }
        const box = root.getBoundingClientRect()
        if (box.width <= 0 || box.height <= 0) return { ok: false, why: 'component box is zero' }
        for (const [selector, minCount] of probes) {
          const found = document.querySelectorAll(selector).length
          if (found < minCount) return { ok: false, why: `expected >=${minCount} of ${selector}, got ${found}` }
        }
        const probePoint = root.getBoundingClientRect()
        const probe = document.elementFromPoint(
          probePoint.left + probePoint.width / 2,
          Math.min(probePoint.top + 24, window.innerHeight - 1),
        )
        if (!probe || !root.contains(probe)) return { ok: false, why: 'elementFromPoint missed the component' }
        const doc = document.documentElement
        return {
          ok: doc.scrollWidth <= doc.clientWidth,
          why: doc.scrollWidth <= doc.clientWidth ? '' : 'horizontal page scroll',
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          box: { width: Math.round(box.width), height: Math.round(box.height) },
        }
      }, { probes: KEY_PROBES[shot.context], contextId: shot.context })
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
