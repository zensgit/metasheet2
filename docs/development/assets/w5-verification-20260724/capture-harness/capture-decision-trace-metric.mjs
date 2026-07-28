// Wave 5 收官验证 — §9/§10 12-cell explainability metric matrix, three-viewport evidence capture
// (charter §8.1.8-10, lock §10: 拍前真在场断言 + 目检 + 合成数据 + trace response body 禁入证据).
// SAME MECHANISM as the W5-1 capture harness (docs/development/assets/w5-1-vnext-20260723/
// capture-harness/capture-decision-trace.mjs) — copy/mount/probe/screenshot/cleanup, extended to
// the 12 metric-matrix scenarios instead of the 6 W5-1 display scenarios (those six PNGs and their
// harness stay frozen as-is — they are already-merged #4564 evidence, not touched here).
//
// Run from the repo root (needs the repo's node_modules — playwright is a root devDependency):
//   node docs/development/assets/w5-verification-20260724/capture-harness/capture-decision-trace-metric.mjs
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../../..')
const webRoot = join(repoRoot, 'apps/web')
const assetsDir = resolve(here, '..')
const PORT = 5199

const tempHtml = join(webRoot, 'w5-metric-decision-trace-harness.html')
const tempTsDir = join(webRoot, 'src/dev-harness')
const tempTs = join(tempTsDir, 'w5MetricDecisionTraceHarness.ts')

// Scenario-specific presence probes (拍前在场断言, key states per shot) — mirrors the DOM
// assertions in apps/web/tests/attendance-decision-trace-metric.spec.ts one-for-one so the
// screenshot and the guard-collected spec assertion prove the SAME thing.
const KEY_PROBES = {
  'today-a': [
    ['[data-trace-reason]', 1],
    ['[data-trace-basis-env][data-trace-posture="current_live_no_history"]', 1],
    ['[data-trace-may-differ]', 1],
  ],
  'today-b': [
    ['[data-trace-fail-closed]', 1],
    ['[data-trace-basis-env][data-trace-posture="undeterminable"]', 1],
  ],
  'late-a': [
    ['[data-trace-basis-ref="attendance_records.meta.tier"][data-trace-posture="snapshot_frozen"]', 1],
  ],
  'late-b': [
    ['[data-trace-basis-ref="attendance_records.meta.tier"][data-trace-posture="undeterminable"]', 1],
    ['[data-trace-fail-closed]', 1],
  ],
  'missing-a': [
    ['[data-trace-conclusion-row="missingSide"]', 1],
  ],
  'missing-b': [
    ['[data-trace-basis-ref="auto_absence_generation"][data-trace-posture="undeterminable"]', 1],
    ['[data-trace-fail-closed]', 1],
  ],
  'overtime-a': [
    ['[data-trace-segment]', 1],
    ['[data-trace-basis-ref="attendance_overtime_rules"][data-trace-posture="current_live_no_history"]', 1],
  ],
  'overtime-b': [
    ['[data-trace-coverage-note]', 1],
    ['[data-trace-basis-env][data-trace-posture="not_in_effect"]', 1],
    ['[data-trace-fail-closed]', 1],
  ],
  'comptime-a': [
    ['[data-trace-lot][data-trace-lot-resolved="mapped"]', 1],
    ['[data-trace-lot][data-trace-lot-resolved="unknown_source"]', 1],
    ['[data-trace-retention-disclosure]', 1],
  ],
  'comptime-b': [
    ['[data-trace-basis-ref="attendance_leave_balances"][data-trace-posture="undeterminable"]', 1],
    ['[data-trace-fail-closed]', 1],
  ],
  'approver-a': [
    ['[data-trace-step]', 2],
    ['[data-trace-timeline-source][data-trace-timeline-source-ref="approval_records"]', 1],
  ],
  'approver-b': [
    ['[data-trace-fail-closed]', 1],
    ['[data-trace-basis-ref="approval_assignments"][data-trace-posture="undeterminable"]', 1],
  ],
}

const SHOTS = [
  { file: 'w5m-1440x900-self-today-a.png', width: 1440, height: 900, scenario: 'today-a', audience: 'self' },
  { file: 'w5m-1440x900-admin-late-a.png', width: 1440, height: 900, scenario: 'late-a', audience: 'admin' },
  { file: 'w5m-1440x900-self-missing-a.png', width: 1440, height: 900, scenario: 'missing-a', audience: 'self' },
  { file: 'w5m-1440x900-admin-overtime-a.png', width: 1440, height: 900, scenario: 'overtime-a', audience: 'admin' },
  { file: 'w5m-1024x768-self-comptime-a.png', width: 1024, height: 768, scenario: 'comptime-a', audience: 'self' },
  { file: 'w5m-1024x768-admin-approver-a.png', width: 1024, height: 768, scenario: 'approver-a', audience: 'admin' },
  { file: 'w5m-1024x768-self-today-b.png', width: 1024, height: 768, scenario: 'today-b', audience: 'self' },
  { file: 'w5m-1024x768-admin-late-b.png', width: 1024, height: 768, scenario: 'late-b', audience: 'admin' },
  { file: 'w5m-390x844-self-missing-b.png', width: 390, height: 844, scenario: 'missing-b', audience: 'self' },
  { file: 'w5m-390x844-admin-overtime-b.png', width: 390, height: 844, scenario: 'overtime-b', audience: 'admin' },
  { file: 'w5m-390x844-self-comptime-b.png', width: 390, height: 844, scenario: 'comptime-b', audience: 'self' },
  { file: 'w5m-390x844-admin-approver-b.png', width: 390, height: 844, scenario: 'approver-b', audience: 'admin' },
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

  copyFileSync(join(here, 'decision-trace-metric-harness.html'), tempHtml)
  mkdirSync(tempTsDir, { recursive: true })
  copyFileSync(join(here, 'w5MetricDecisionTraceHarness.ts'), tempTs)

  const vite = spawn('pnpm', ['--filter', '@metasheet/web', 'exec', 'vite', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
  })

  let browser
  try {
    await waitForServer(`http://localhost:${PORT}/w5-metric-decision-trace-harness.html`)
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true })
    } catch {
      browser = await chromium.launch({ headless: true }) // fallback: bundled chromium
    }

    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })
      await page.goto(`http://localhost:${PORT}/w5-metric-decision-trace-harness.html?scenario=${shot.scenario}&audience=${shot.audience}`)
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
