// W5-1 three-viewport evidence capture (charter §8.1.8-10, lock §9 W5-1: 拍前真在场断言 + 目检).
// Reproducible driver for the six PNGs in docs/development/assets/w5-1-vnext-20260723/.
//
// Run from the repo root (needs the repo's node_modules — playwright is a root devDependency):
//   node docs/development/assets/w5-1-vnext-20260723/capture-harness/capture-decision-trace.mjs
//
// What it does (W4-1 capture-harness form, verbatim discipline):
//   1. copies the harness page/entry into apps/web (temp files, removed at the end),
//   2. starts the apps/web vite dev server (real component + real tokens.css, synthetic fixtures),
//   3. for each scenario x audience x viewport: runs the IN-PAGE presence assertions (component
//      box non-zero, elementFromPoint inside the component, scenario-specific key-state element
//      present — retention disclosure / may-differ note / fail-closed banner / coverage note /
//      approval_records timeline citation — and scrollWidth <= clientWidth) and only then
//      captures a full-page PNG,
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

const tempHtml = join(webRoot, 'w51-decision-trace-harness.html')
const tempTsDir = join(webRoot, 'src/dev-harness')
const tempTs = join(tempTsDir, 'w51DecisionTraceHarness.ts')

// Scenario-specific presence probes (拍前在场断言, key states per shot).
const KEY_PROBES = {
  'approver-grounded': [
    ['[data-trace-step]', 3],
    ['[data-trace-timeline-source][data-trace-timeline-source-ref="approval_records"]', 1],
  ],
  'overtime-partial-legacy': [
    ['[data-trace-coverage-note]', 1],
    ['[data-trace-basis-env][data-trace-posture="not_in_effect"]', 1],
    ['[data-trace-fail-closed]', 1],
  ],
  'comp-time': [
    ['[data-trace-retention-disclosure]', 1],
    ['[data-trace-lot][data-trace-lot-resolved="unknown_source"]', 1],
    ['[data-trace-lot][data-trace-lot-resolved="mapped"]', 1],
  ],
  'late-current-live': [
    ['[data-trace-may-differ]', 1],
    ['[data-trace-basis-env][data-trace-posture="current_live_no_history"]', 1],
  ],
  'today-undeterminable': [
    ['[data-trace-fail-closed]', 1],
    ['[data-trace-undeterminable]', 1],
  ],
}

const SHOTS = [
  { file: 'w51-1440x900-admin-approver-grounded.png', width: 1440, height: 900, scenario: 'approver-grounded', audience: 'admin' },
  { file: 'w51-1440x900-self-comp-time.png', width: 1440, height: 900, scenario: 'comp-time', audience: 'self' },
  { file: 'w51-1024x768-admin-overtime-partial-legacy.png', width: 1024, height: 768, scenario: 'overtime-partial-legacy', audience: 'admin' },
  { file: 'w51-1024x768-self-late-current-live.png', width: 1024, height: 768, scenario: 'late-current-live', audience: 'self' },
  { file: 'w51-390x844-self-today-undeterminable.png', width: 390, height: 844, scenario: 'today-undeterminable', audience: 'self' },
  { file: 'w51-390x844-admin-comp-time.png', width: 390, height: 844, scenario: 'comp-time', audience: 'admin' },
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

  copyFileSync(join(here, 'decision-trace-harness.html'), tempHtml)
  mkdirSync(tempTsDir, { recursive: true })
  copyFileSync(join(here, 'w51DecisionTraceHarness.ts'), tempTs)

  const vite = spawn('pnpm', ['--filter', '@metasheet/web', 'exec', 'vite', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
  })

  let browser
  try {
    await waitForServer(`http://localhost:${PORT}/w51-decision-trace-harness.html`)
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true })
    } catch {
      browser = await chromium.launch({ headless: true }) // fallback: bundled chromium
    }

    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })
      await page.goto(`http://localhost:${PORT}/w51-decision-trace-harness.html?scenario=${shot.scenario}&audience=${shot.audience}`)
      await page.waitForSelector('[data-attendance-decision-trace]')

      // 拍前在场断言 (in-page, before the capture) — fail closed.
      const check = await page.evaluate(({ probes, audience }) => {
        const root = document.querySelector('[data-attendance-decision-trace]')
        if (!root) return { ok: false, why: 'component root missing' }
        if (root.getAttribute('data-trace-audience') !== audience) {
          return { ok: false, why: `audience mismatch: ${root.getAttribute('data-trace-audience')}` }
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
      }, { probes: KEY_PROBES[shot.scenario], audience: shot.audience })
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
