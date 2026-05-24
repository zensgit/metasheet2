/**
 * Multitable D2 Large-Table Perf Baseline — Frontend Half (black-box only)
 *
 * Implements the frontend portion of the D2 perf gate harness per
 * docs/development/multitable-perf-gate-d2-design-20260524.md §3.3
 * (v1 black-box only — no apps/web/src/** touch).
 *
 * Measurement stack (all black-box, injected via addInitScript or
 * driven from test runner):
 *   - browserContext.tracing.start({...}) — full timeline
 *   - context.newCDPSession(page) + Memory.getDOMCounters / Performance.getMetrics
 *   - PerformanceObserver(longtask|paint|event) — injected
 *   - MutationObserver(grid root) — injected
 *   - rAF-based FPS sampler — injected
 *
 * Per advisor structural correction: this spec is the frontend half;
 * backend metrics come from scripts/ops/multitable-perf-baseline.mjs
 * and are merged in the verification MD's analysis step.
 *
 * Scope of v1 (first PR):
 *   - mount metric profile (TTI, DOM/heap @ mount) — FULL
 *   - scroll metric profile (FPS, longtask, DOM/heap @ bottom) — FULL
 *   - edit/sort/filter/group metric profiles — SCAFFOLDED with TODOs;
 *     interaction-level measurement deferred to follow-up impl PR
 *     (UI selector stability + reset-between-interactions design)
 *
 * Targets come from STATE_FILE written by perf-baseline.mjs, OR from
 * TARGET_SHEET_ID + TARGET_VIEW_ID env vars (manual override).
 */
import { test, type APIRequestContext, type CDPSession } from '@playwright/test'
import * as fs from 'fs/promises'
import * as path from 'path'
import {
  resolveE2EAuthToken,
  injectTokenAndGo,
  FE_BASE_URL,
  API_BASE_URL,
} from './multitable-helpers'

const ROWS = Math.max(1, Number(process.env.ROWS || 10_000))
const METRIC_PROFILE = String(process.env.METRIC_PROFILE || 'mount')
const SCENARIO = String(process.env.SCENARIO || 'primary')
const PERF_PROFILE = String(process.env.PERF_PROFILE || 'multitable-d2-baseline')
const BASELINE_ID = String(process.env.BASELINE_ID || `${Date.now()}-spec`)
const CI_RUNNER_TAG = String(process.env.CI_RUNNER_TAG || 'local-dev')
const OUTPUT_DIR = String(process.env.OUTPUT_DIR || 'output/multitable-perf')
const STATE_FILE = String(process.env.STATE_FILE || path.join(OUTPUT_DIR, `state-${BASELINE_ID}.json`))
const VIEWPORT_WIDTH = Math.max(800, Number(process.env.VIEWPORT_WIDTH || 1440))
const VIEWPORT_HEIGHT = Math.max(600, Number(process.env.VIEWPORT_HEIGHT || 900))
const DEVICE_SCALE_FACTOR = Math.max(1, Number(process.env.DEVICE_SCALE_FACTOR || 1))
const SCROLL_TARGET = String(process.env.SCROLL_TARGET || 'bottom')
const TARGET_SHEET_ID_ENV = String(process.env.TARGET_SHEET_ID || '')
const TARGET_VIEW_ID_ENV = String(process.env.TARGET_VIEW_ID || '')

// addInitScript content — black-box measurement primitives injected into page.
// Provides window.__d2Perf with longtask/paint observers, rAF FPS sampler,
// and MutationObserver-based stability detection. Runs in browser context;
// no apps/web/src/** instrumentation.
const INIT_SCRIPT = `
(() => {
  if (window.__d2Perf) return
  const state = {
    longTasks: [],
    paintEvents: [],
    fpsSamples: [],
    samplingFps: false,
  }
  window.__d2Perf = state

  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'longtask') {
          state.longTasks.push({ start: entry.startTime, duration: entry.duration })
        } else if (entry.entryType === 'paint') {
          state.paintEvents.push({ name: entry.name, startTime: entry.startTime })
        }
      }
    })
    po.observe({ entryTypes: ['longtask', 'paint'] })
  } catch (err) {
    console.warn('[d2-perf] PerformanceObserver setup failed:', err && err.message)
  }

  state.startFpsSampling = () => {
    state.samplingFps = true
    state.fpsSamples = []
    let last = performance.now()
    const loop = () => {
      const now = performance.now()
      const delta = now - last
      if (delta > 0) state.fpsSamples.push(1000 / delta)
      last = now
      if (state.samplingFps) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }
  state.stopFpsSampling = () => { state.samplingFps = false }

  state.observeStability = (selector, timeoutMs) => new Promise((resolve) => {
    const root = document.querySelector(selector)
    if (!root) { resolve({ stable: false, ts: performance.now(), reason: 'selector_not_found' }); return }
    let lastChange = performance.now()
    const obs = new MutationObserver(() => { lastChange = performance.now() })
    obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
    const tick = () => {
      const now = performance.now()
      if (now - lastChange >= timeoutMs) {
        obs.disconnect()
        resolve({ stable: true, ts: lastChange })
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })

  state.snapshot = () => ({
    longTasks: state.longTasks.slice(),
    fpsSamples: state.fpsSamples.slice(),
    paintEvents: state.paintEvents.slice(),
  })
  state.reset = () => {
    state.longTasks = []
    state.fpsSamples = []
    state.paintEvents = []
  }
})()
`

function pct(arr: number[], q: number): number | null {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

function summarizeFps(samples: number[]): { p50: number | null; p95: number | null; min: number | null } {
  if (samples.length === 0) return { p50: null, p95: null, min: null }
  // FPS is "higher is better"; for verdict comparison we want the 95th-percentile
  // of FPS *quality*, which equals the 5th-percentile of the sorted FPS samples
  // (worst frames). DO NOT "fix" pct(samples, 0.05) to 0.95 — that would invert
  // the metric semantic. See verification MD §6 advisor note.
  return {
    p50: Math.round(pct(samples, 0.5) ?? 0),
    p95: Math.round(pct(samples, 0.05) ?? 0),
    min: Math.round(Math.min(...samples)),
  }
}

// Perf workflow MUST hard-fail if servers unreachable. The shared
// ensureServersReachable() in multitable-helpers calls test.skip() which would
// read as PASS in CI, silently shipping "green" baselines that measured nothing.
async function requireServersReachable(request: APIRequestContext): Promise<void> {
  try {
    const apiHealth = await request.get(`${API_BASE_URL}/health`, { timeout: 3000 })
    if (!apiHealth.ok()) {
      const apiHealth2 = await request.get(`${API_BASE_URL}/api/health`, { timeout: 3000 })
      if (!apiHealth2.ok()) {
        throw new Error(`API health probe failed: ${API_BASE_URL}/health → ${apiHealth.status()}, /api/health → ${apiHealth2.status()}`)
      }
    }
  } catch (err) {
    throw new Error(`Perf gate requires reachable API. ${API_BASE_URL} probe failed: ${(err as Error).message}`)
  }
  try {
    const feHealth = await request.get(FE_BASE_URL, { timeout: 3000 })
    if (!feHealth.ok()) {
      throw new Error(`FE probe at ${FE_BASE_URL} returned ${feHealth.status()}`)
    }
  } catch (err) {
    throw new Error(`Perf gate requires reachable FE. ${FE_BASE_URL} probe failed: ${(err as Error).message}`)
  }
}

async function getDomNodeCount(cdp: CDPSession): Promise<number | null> {
  try {
    const counters = (await cdp.send('Memory.getDOMCounters')) as { nodes?: number }
    return counters.nodes ?? null
  } catch (err) {
    console.warn('[d2-perf-spec] CDP getDOMCounters failed:', (err as Error).message)
    return null
  }
}

async function getJsHeapMb(cdp: CDPSession): Promise<number | null> {
  try {
    const m = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> }
    const heap = m.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0
    return Math.round(heap / 1024 / 1024)
  } catch (err) {
    console.warn('[d2-perf-spec] CDP getMetrics failed:', (err as Error).message)
    return null
  }
}

async function resolveTarget(): Promise<{ sheetId: string; viewId: string }> {
  if (TARGET_SHEET_ID_ENV && TARGET_VIEW_ID_ENV) {
    return { sheetId: TARGET_SHEET_ID_ENV, viewId: TARGET_VIEW_ID_ENV }
  }
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    const state = JSON.parse(raw)
    if (!state.sheetId || !state.viewId) {
      throw new Error(`state file missing sheetId/viewId: ${STATE_FILE}`)
    }
    return { sheetId: state.sheetId, viewId: state.viewId }
  } catch (err) {
    throw new Error(
      `Cannot resolve target: provide TARGET_SHEET_ID + TARGET_VIEW_ID env, or ensure STATE_FILE exists at ${STATE_FILE} (${(err as Error).message})`,
    )
  }
}

type OutputJson = ReturnType<typeof buildOutputSkeleton>

function buildOutputSkeleton(opts: {
  sheetId: string
  viewId: string
  playwrightChromium: string
}) {
  return {
    baselineId: BASELINE_ID,
    perfProfile: PERF_PROFILE,
    metricProfile: METRIC_PROFILE,
    rows: ROWS,
    scenario: SCENARIO,
    hardware: {
      runner: CI_RUNNER_TAG,
      cpuCount: null as number | null,
      memMb: null as number | null,
      kernel: null as string | null,
      playwrightChromium: opts.playwrightChromium || null,
    },
    viewport: {
      widthPx: VIEWPORT_WIDTH,
      heightPx: VIEWPORT_HEIGHT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    },
    metrics: {
      ttiMs: null as number | null,
      scrollFps: { p50: null as number | null, p95: null as number | null, min: null as number | null },
      longTask: { count: null as number | null, totalMs: null as number | null },
      domNodes: {
        afterMount: null as number | null,
        afterScrollBottom: null as number | null,
        delta: null as number | null,
        per10kSlope: null as number | null,
      },
      jsHeapMb: {
        afterMount: null as number | null,
        afterScrollBottom: null as number | null,
        delta: null as number | null,
        per10kSlope: null as number | null,
      },
      editCellRoundtripMs: { p50: null as number | null, p95: null as number | null },
      sortApplyMs: null as number | null,
      filterApplyMs: null as number | null,
      groupApplyMs: null as number | null,
      backendInsertMs: null,
      backendQueryMs: null,
      backendSeedAggregateMs: null,
      backendSeedChunks: null,
    },
    thresholds: null,
    verdict: 'TBD',
    notes: [
      `targetSheetId=${opts.sheetId}`,
      `targetViewId=${opts.viewId}`,
      'frontend metrics from black-box Playwright tracing + CDP + injected PerformanceObserver/MutationObserver/raf',
      'no apps/web/src/** touch (v1 black-box only)',
      `metricProfile=${METRIC_PROFILE} scenario=${SCENARIO}`,
    ] as string[],
  }
}

async function writeOutput(output: OutputJson): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true })
  const out = path.join(
    OUTPUT_DIR,
    `baseline-${ROWS}-${METRIC_PROFILE}-${SCENARIO}-${BASELINE_ID}.json`,
  )
  await fs.writeFile(out, JSON.stringify(output, null, 2))
  console.log(`[d2-perf-spec] wrote ${out}`)
}

test.describe.configure({ mode: 'serial' })

test.describe('multitable D2 perf baseline (frontend half)', () => {
  let target: { sheetId: string; viewId: string }
  let chromiumVersion = ''

  test.beforeAll(async ({ request, browser }) => {
    await requireServersReachable(request)
    target = await resolveTarget()
    chromiumVersion = browser.version()
    console.log(`[d2-perf-spec] target=${JSON.stringify(target)} chromium=${chromiumVersion}`)
  })

  test(`metricProfile=${METRIC_PROFILE} scenario=${SCENARIO} rows=${ROWS}`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(15 * 60 * 1000) // 15 min max per profile run
    const output = buildOutputSkeleton({
      sheetId: target.sheetId,
      viewId: target.viewId,
      playwrightChromium: chromiumVersion,
    })

    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    })
    await context.addInitScript({ content: INIT_SCRIPT })

    const tracePath = path.join(
      OUTPUT_DIR,
      `trace-${METRIC_PROFILE}-${SCENARIO}-${BASELINE_ID}.zip`,
    )
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false })

    const token = await resolveE2EAuthToken(request)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    try {
      await cdp.send('Performance.enable')
    } catch (err) {
      console.warn('[d2-perf-spec] Performance.enable failed:', (err as Error).message)
    }

    // ---------------- mount ----------------
    const mountStart = Date.now()
    await injectTokenAndGo(page, token, `/multitable/${target.sheetId}/${target.viewId}`)
    await page.waitForSelector('.meta-grid__table', { timeout: 60_000 })
    // Wait for grid to stop mutating for 1.5s — proxy for "interactive"
    const stable = (await page.evaluate(async () => {
      // @ts-expect-error window.__d2Perf is injected by addInitScript
      return await window.__d2Perf.observeStability('.meta-grid__table tbody', 1500)
    })) as { stable: boolean; ts: number; reason?: string }
    const mountEnd = Date.now()
    output.metrics.ttiMs = mountEnd - mountStart
    output.notes.push(`mountStable=${JSON.stringify(stable)}`)

    output.metrics.domNodes.afterMount = await getDomNodeCount(cdp)
    output.metrics.jsHeapMb.afterMount = await getJsHeapMb(cdp)

    // ---------------- scenario tweaks ----------------
    if (SCENARIO === 'expanded') {
      // TODO(d2-followup): trigger expand for a subset of rows (EXPANDED_ROW_RATIO).
      // v1 baseline keeps scenario=expanded as a structural placeholder so the JSON
      // schema records scenario tag even when expansion impl is deferred.
      output.notes.push('scenario=expanded recorded but expansion UI trigger TODO in v1')
    }

    // ---------------- metric profile dispatch ----------------
    if (METRIC_PROFILE === 'mount') {
      // Mount metrics already captured above.
    } else if (METRIC_PROFILE === 'scroll') {
      await measureScroll(page, output)
    } else if (METRIC_PROFILE === 'edit') {
      await measureEdit(page, output)
    } else if (METRIC_PROFILE === 'sort') {
      await measureSort(page, output)
    } else if (METRIC_PROFILE === 'filter') {
      await measureFilter(page, output)
    } else if (METRIC_PROFILE === 'group') {
      await measureGroup(page, output)
    } else {
      throw new Error(`Unknown METRIC_PROFILE=${METRIC_PROFILE} (mount|scroll|edit|sort|filter|group)`)
    }

    // ---------------- final DOM/heap snapshot ----------------
    output.metrics.domNodes.afterScrollBottom = await getDomNodeCount(cdp)
    output.metrics.jsHeapMb.afterScrollBottom = await getJsHeapMb(cdp)
    if (output.metrics.domNodes.afterMount !== null && output.metrics.domNodes.afterScrollBottom !== null) {
      output.metrics.domNodes.delta =
        output.metrics.domNodes.afterScrollBottom - output.metrics.domNodes.afterMount
    }
    if (output.metrics.jsHeapMb.afterMount !== null && output.metrics.jsHeapMb.afterScrollBottom !== null) {
      output.metrics.jsHeapMb.delta =
        output.metrics.jsHeapMb.afterScrollBottom - output.metrics.jsHeapMb.afterMount
    }

    // ---------------- longtask snapshot ----------------
    const perfSnapshot = (await page.evaluate(() => {
      // @ts-expect-error injected
      return window.__d2Perf.snapshot()
    })) as { longTasks: Array<{ start: number; duration: number }>; fpsSamples: number[]; paintEvents: unknown[] }
    output.metrics.longTask.count = perfSnapshot.longTasks.length
    output.metrics.longTask.totalMs = Math.round(
      perfSnapshot.longTasks.reduce((acc, t) => acc + t.duration, 0),
    )

    await context.tracing.stop({ path: tracePath })
    console.log(`[d2-perf-spec] trace -> ${tracePath}`)
    await context.close()
    await writeOutput(output)
  })
})

// ---------------- per-metric-profile helpers ----------------

async function measureScroll(page: import('@playwright/test').Page, output: OutputJson): Promise<void> {
  // Methodology: start FPS sampling, dispatch ONE scroll-to-bottom jump, then
  // wait 1500ms for paint/layout settling while raf samples accumulate. This
  // measures FPS during the post-scroll settle window, NOT during a sustained
  // user scroll gesture. Good enough for verdict B detection (DOM-memory-bound
  // failure manifests in the settle window via long paint tasks); for richer
  // sustained-scroll signal, follow-up impl can drive a multi-frame scroll loop.
  await page.evaluate(() => {
    // @ts-expect-error injected
    window.__d2Perf.startFpsSampling()
  })
  await page.evaluate((target: string) => {
    const el = document.querySelector('.meta-grid__table-wrap') as HTMLElement | null
    if (!el) return
    if (target === 'bottom') el.scrollTop = el.scrollHeight
    else if (target === 'mid') el.scrollTop = el.scrollHeight / 2
    else if (target === 'random') el.scrollTop = Math.random() * el.scrollHeight
    else el.scrollTop = el.scrollHeight
  }, SCROLL_TARGET)
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    // @ts-expect-error injected
    window.__d2Perf.stopFpsSampling()
  })
  const samples = (await page.evaluate(() => {
    // @ts-expect-error injected
    return window.__d2Perf.fpsSamples.slice()
  })) as number[]
  output.metrics.scrollFps = summarizeFps(samples)
}

async function measureEdit(page: import('@playwright/test').Page, output: OutputJson): Promise<void> {
  // TODO(d2-followup): UI-stable cell-edit roundtrip measurement.
  // v1 records a placeholder; impl deferred to follow-up PR after UI selector
  // contract is locked (currently dblclick + MetaCellEditor focus is the trigger
  // but timing markers for "commit done" need either MutationObserver on the
  // specific cell or backend POST /records request observer.
  output.notes.push('measureEdit: v1 scaffold; per-cell edit roundtrip impl deferred')
}

async function measureSort(page: import('@playwright/test').Page, output: OutputJson): Promise<void> {
  // TODO(d2-followup): trigger sort via header click + MutationObserver for row order change.
  output.notes.push('measureSort: v1 scaffold; sort apply latency impl deferred')
}

async function measureFilter(page: import('@playwright/test').Page, output: OutputJson): Promise<void> {
  // TODO(d2-followup): apply filter via toolbar + MutationObserver for row count change.
  output.notes.push('measureFilter: v1 scaffold; filter apply latency impl deferred')
}

async function measureGroup(page: import('@playwright/test').Page, output: OutputJson): Promise<void> {
  // TODO(d2-followup): apply group via toolbar + MutationObserver for group header emergence.
  output.notes.push('measureGroup: v1 scaffold; group apply latency impl deferred')
}
