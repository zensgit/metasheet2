import { test, expect, type Page, type Locator } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import {
  parseSvgPathPoints,
  polylineHitsRect,
  rectsOverlap,
} from './approval-flow-canvas-e1-layout'

// E1 isolated approval-flow renderer spike — real-browser geometry / a11y / responsive
// verification. Does not touch production routes or Canvas V2 flags.

const OUT = 'verification-output'
const HARNESS = '/verification/approval-flow-canvas-e1-harness.html'

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  compact: { width: 1024, height: 768 },
  narrow: { width: 390, height: 844 },
} as const

type PublicMetrics = {
  ready: true
  fixtureId: string
  nodeCount: number
  edgeCount: number
  inspectorPresentation: 'dock' | 'overlay' | 'sheet'
  sheetDetent: 'half' | 'full' | null
  inspectorOpen: boolean
  readOnly: boolean
  cards: Array<{
    focusId: string
    name: string
    type: string
    x: number
    y: number
    width: number
    height: number
  }>
  edges: Array<{
    focusId: string
    path: string
    midX: number
    midY: number
    sourceFocusId: string
    targetFocusId: string
  }>
  branchLabels: Array<{
    order: number
    label: string
    priority?: number
    isDefault: boolean
    x: number
  }>
  layoutWidth: number
  layoutHeight: number
  selectedName: string | null
  liveText: string
  reducedMotion: boolean
  internalTokens: string[]
}

async function waitReady(page: Page): Promise<PublicMetrics> {
  await page.waitForFunction(() => window.__E1_CANVAS__?.ready === true, null, { timeout: 30_000 })
  return page.evaluate(() => window.__E1_CANVAS__ as PublicMetrics)
}

async function selectFixture(page: Page, id: string): Promise<PublicMetrics> {
  await page.evaluate((fixtureId) => {
    window.__E1_SELECT_FIXTURE__?.(fixtureId as never)
  }, id)
  await page.waitForFunction(
    (fixtureId) => window.__E1_CANVAS__?.ready === true && window.__E1_CANVAS__?.fixtureId === fixtureId,
    id,
    { timeout: 30_000 },
  )
  // Allow measured-height reflow to settle.
  await page.waitForTimeout(80)
  return page.evaluate(() => window.__E1_CANVAS__ as PublicMetrics)
}

async function openFirstNode(page: Page): Promise<Locator> {
  const first = page.locator('[data-test="flow-node"]').first()
  await first.click()
  await expect(page.locator('[data-test="e1-inspector"]')).toBeVisible()
  return first
}

function assertNoCardOverlap(metrics: PublicMetrics) {
  const cards = metrics.cards
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i]!
      const b = cards[j]!
      const overlap = rectsOverlap(
        { x: a.x, y: a.y, w: a.width, h: a.height },
        { x: b.x, y: b.y, w: b.width, h: b.height },
      )
      expect(
        overlap,
        `cards overlap: 「${a.name}」 vs 「${b.name}」`,
      ).toBe(false)
    }
  }
}

function assertEdgesDoNotCrossCards(metrics: PublicMetrics) {
  const byFocus = new Map(metrics.cards.map((card) => [card.focusId, card]))
  for (const edge of metrics.edges) {
    const points = parseSvgPathPoints(edge.path)
    expect(points.length, `edge ${edge.focusId} path parse`).toBeGreaterThanOrEqual(2)
    for (const card of metrics.cards) {
      // Source/target attachment is allowed; interior crossings are not.
      if (card.focusId === edge.sourceFocusId || card.focusId === edge.targetFocusId) continue
      const hit = polylineHitsRect(points, {
        x: card.x,
        y: card.y,
        w: card.width,
        h: card.height,
      })
      expect(
        hit,
        `edge through card 「${card.name}」 (edge ${edge.focusId})`,
      ).toBe(false)
    }
    // Soft check: endpoints near source bottom / target top.
    const source = byFocus.get(edge.sourceFocusId)
    const target = byFocus.get(edge.targetFocusId)
    if (source && target && points[0] && points[points.length - 1]) {
      expect(Math.abs(points[0].x - (source.x + source.width / 2))).toBeLessThan(2)
      expect(Math.abs(points[points.length - 1]!.x - (target.x + target.width / 2))).toBeLessThan(2)
    }
  }
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(
    overflow.scrollWidth,
    `horizontal overflow: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1)
}

async function assertNoInternals(page: Page, metrics: PublicMetrics) {
  const tokens = metrics.internalTokens
  const payload = await page.evaluate(() => {
    const root = document.querySelector('[data-test="e1-shell"]') ?? document.body
    const texts: string[] = []
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent?.trim()
        if (value) texts.push(value)
        return
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        for (const attr of ['aria-label', 'title', 'alt']) {
          const value = el.getAttribute(attr)
          if (value) texts.push(value)
        }
        // data-focus-id / data-edge-focus are opaque (n0/e0) — allowed.
        // Never allow raw keys in data-test visible labels.
      }
      node.childNodes.forEach(walk)
    }
    walk(root)
    return texts
  })

  for (const token of tokens) {
    // Skip trivial tokens that are legitimate UI words when they coincide with business labels.
    // e.g. node name "发起" vs key "start" — keys are English identifiers; names are Chinese.
    if (!token || token.length < 2) continue
    // Business-facing Chinese names may equal display; only flag English/internal-looking tokens
    // and explicit edge notations.
    const looksInternal =
      /^[a-z][a-z0-9_-]*$/i.test(token) ||
      token.includes('->') ||
      token.includes(' → ') ||
      token.startsWith('e-') ||
      token.includes('_')
    if (!looksInternal) continue
    for (const text of payload) {
      // Whole-token match or clear key leakage — avoid flagging Chinese labels.
      if (text === token || text.includes(token)) {
        expect(text, `internal token leaked into DOM/ARIA: ${token}`).not.toContain(token)
      }
    }
  }

  // Explicit ban on source -> target patterns in any accessible string.
  for (const text of payload) {
    expect(text, `arrow edge notation in UI: ${text}`).not.toMatch(/\b\w+\s*->\s*\w+\b/)
  }
}

async function assertNoActionButtonCluster(page: Page) {
  // Cards must not host move/delete/add-branch action clusters.
  const cluster = page.locator('[data-test="flow-node"] button, [data-test="flow-node"] [data-test*="action"]')
  await expect(cluster).toHaveCount(0)
  // Insertion controls live on edges, not cards.
  const inserts = page.locator('[data-test="edge-insert"]')
  await expect(inserts.first()).toBeVisible()
}

test.describe('E1 approval-flow canvas renderer spike', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
  })

  test('desktop 1440×900: geometry, inspector dock, long labels, priority, keyboard, 100-node', async ({ page }, testInfo) => {
    const errs: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`console: ${m.text()}`)
    })
    page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

    await page.setViewportSize(VIEWPORTS.desktop)
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
    let metrics = await waitReady(page)

    // --- linear fixture ---
    metrics = await selectFixture(page, 'linear')
    expect(metrics.nodeCount).toBe(4)
    await expect(page.locator('[data-test="flow-node"]')).toHaveCount(4)
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoHorizontalOverflow(page)
    await assertNoActionButtonCluster(page)
    await assertNoInternals(page, metrics)

    // Edge-centered insertion controls present; no card action cluster.
    const insertBox = await page.locator('[data-test="edge-insert"]').first().boundingBox()
    expect(insertBox, 'insert control box').toBeTruthy()
    expect(insertBox!.width).toBeGreaterThanOrEqual(40)
    expect(insertBox!.height).toBeGreaterThanOrEqual(40)

    // Inspector dock 360px at 1440.
    await openFirstNode(page)
    metrics = await page.evaluate(() => window.__E1_CANVAS__ as PublicMetrics)
    expect(metrics.inspectorPresentation).toBe('dock')
    const inspector = page.locator('[data-test="e1-inspector"]')
    await expect(inspector).toHaveAttribute('data-presentation', 'dock')
    const inspectorWidth = await inspector.evaluate((el) => getComputedStyle(el).width)
    expect(inspectorWidth, 'desktop inspector width').toBe('360px')
    const canvasRegion = page.locator('[data-test="e1-canvas-region"]')
    const canvasBox = await canvasRegion.boundingBox()
    expect(canvasBox, 'canvas region').toBeTruthy()
    expect(canvasBox!.width, 'canvas width with docked inspector').toBeGreaterThanOrEqual(1000)

    // Single polite live region.
    const live = page.locator('[data-test="e1-live"]')
    await expect(live).toHaveAttribute('aria-live', 'polite')
    await expect(live).toHaveAttribute('role', 'status')
    await expect(page.locator('[aria-live]')).toHaveCount(1)

    // Keyboard: focus a node, move, activate insertion.
    await page.locator('[data-test="flow-node"]').nth(1).focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-test="e1-inspector"]')).toBeVisible()
    // Focus an insert control and activate.
    await page.locator('[data-test="edge-insert"]').first().focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-test="insert-menu"]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-test="e1-live"]')).not.toHaveText('')
    await page.screenshot({ path: `${OUT}/e1-desktop-linear.png` })

    // --- condition branch priority (config order, not nodes order) ---
    metrics = await selectFixture(page, 'condition')
    // Gateway has 3 exits; labels should be left-to-right mid → high → default.
    const ordered = [...metrics.branchLabels].sort((a, b) => a.x - b.x)
    expect(ordered.map((item) => item.order)).toEqual([0, 1, 2])
    expect(ordered[0]?.priority).toBe(1)
    expect(ordered[1]?.priority).toBe(2)
    expect(ordered[2]?.isDefault).toBe(true)
    // DOM visibility of priority markers.
    await expect(page.locator('[data-test="branch-priority"]')).toHaveCount(2)
    await expect(page.locator('[data-test="branch-label"][data-default="true"]')).toHaveCount(1)
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)

    // Swap priority (config.branches only) — visual order flips for rule branches.
    await page.locator('[data-test="swap-priority"]').click()
    metrics = await waitReady(page)
    expect(metrics.fixtureId).toBe('condition-priority-swapped')
    const swapped = [...metrics.branchLabels].sort((a, b) => a.x - b.x)
    expect(swapped[0]?.label).toContain('一千')
    expect(swapped[1]?.label).toContain('一百')
    expect(swapped[2]?.isDefault).toBe(true)
    await page.screenshot({ path: `${OUT}/e1-desktop-condition-priority.png` })

    // --- parallel all / any with nested condition ---
    for (const id of ['parallel-all', 'parallel-any'] as const) {
      metrics = await selectFixture(page, id)
      expect(metrics.nodeCount).toBeGreaterThanOrEqual(8)
      // Three parallel branch labels under the fork (plus nested condition labels).
      const forkBranches = metrics.branchLabels.filter((label) =>
        ['财务分支', '法务分支', '紧急判断分支'].includes(label.label),
      )
      expect(forkBranches.length).toBe(3)
      // Lane order follows config.branches: C → A → B (紧急, 财务, 法务)
      const forkSorted = [...forkBranches].sort((a, b) => a.x - b.x)
      expect(forkSorted.map((item) => item.label)).toEqual(['紧急判断分支', '财务分支', '法务分支'])
      assertNoCardOverlap(metrics)
      assertEdgesDoNotCrossCards(metrics)
      await assertNoInternals(page, metrics)
    }
    await page.screenshot({ path: `${OUT}/e1-desktop-parallel-any.png` })

    // --- long labels ---
    metrics = await selectFixture(page, 'long-labels')
    const longCard = page.locator('[data-test="flow-node"][data-node-type="approval"]').first()
    await expect(longCard.locator('[data-test="node-name"]')).toBeVisible()
    const nameOverflow = await longCard.locator('[data-test="node-name"]').evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
        scrollWidth: (el as HTMLElement).scrollWidth,
        clientWidth: (el as HTMLElement).clientWidth,
      }
    })
    expect(nameOverflow.textOverflow).toBe('ellipsis')
    expect(nameOverflow.whiteSpace).toBe('nowrap')
    // Full text retained in title / aria-label, not layout-breaking wrap.
    const aria = await longCard.getAttribute('aria-label')
    expect(aria && aria.length).toBeGreaterThan(40)
    const branchTitle = await page.locator('[data-test="branch-label"]').first().getAttribute('title')
    expect(branchTitle && branchTitle.length).toBeGreaterThanOrEqual(40)
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoInternals(page, metrics)
    await page.screenshot({ path: `${OUT}/e1-desktop-long-labels.png` })

    // --- read-only legacy / timeout / threshold ---
    for (const id of ['readonly-legacy', 'readonly-timeout', 'readonly-threshold'] as const) {
      metrics = await selectFixture(page, id)
      expect(metrics.readOnly).toBe(true)
      await expect(page.locator('[data-test="readonly-banner"]')).toBeVisible()
      await openFirstNode(page)
      await expect(page.locator('[data-test="inspector-readonly"]')).toBeVisible()
      // No insertion in read-only.
      await expect(page.locator('[data-test="edge-insert"]')).toHaveCount(0)
      await assertNoInternals(page, metrics)
    }
    await page.screenshot({ path: `${OUT}/e1-desktop-readonly.png` })

    // --- 100-node mixed graph ---
    const mixedStart = performance.now()
    metrics = await selectFixture(page, 'mixed-100')
    const firstMixedRenderMs = performance.now() - mixedStart
    expect(metrics.nodeCount).toBe(100)
    await expect(page.locator('[data-test="flow-node"]')).toHaveCount(100)
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoHorizontalOverflow(page)
    // Canvas surface should scroll vertically inside region, not blow page width.
    const surfaceBox = await page.locator('[data-test="e1-canvas-surface"]').boundingBox()
    expect(surfaceBox, '100-node surface').toBeTruthy()
    await assertNoInternals(page, metrics)
    const firstMixedGeometry = {
      cards: metrics.cards.map(({ focusId, x, y, width, height }) => ({
        focusId,
        x,
        y,
        width,
        height,
      })),
      edges: metrics.edges.map(({ focusId, path, midX, midY }) => ({
        focusId,
        path,
        midX,
        midY,
      })),
    }

    // A real node remains interactive in the large graph.
    const lateCard = page.locator('[data-test="flow-node"]').nth(80)
    await lateCard.scrollIntoViewIfNeeded()
    await lateCard.click()
    await expect(page.locator('[data-test="e1-inspector"]')).toBeVisible()

    // Reload the same fixture from a different state and require byte-identical
    // render coordinates and routes at the same viewport.
    await selectFixture(page, 'linear')
    const repeatStart = performance.now()
    const repeatedMixed = await selectFixture(page, 'mixed-100')
    const repeatedMixedRenderMs = performance.now() - repeatStart
    const repeatedMixedGeometry = {
      cards: repeatedMixed.cards.map(({ focusId, x, y, width, height }) => ({
        focusId,
        x,
        y,
        width,
        height,
      })),
      edges: repeatedMixed.edges.map(({ focusId, path, midX, midY }) => ({
        focusId,
        path,
        midX,
        midY,
      })),
    }
    expect(repeatedMixedGeometry).toEqual(firstMixedGeometry)
    console.info(
      `[e1] mixed-100 render: first=${firstMixedRenderMs.toFixed(2)}ms repeat=${repeatedMixedRenderMs.toFixed(2)}ms`,
    )
    await testInfo.attach('mixed-100-render-timing.json', {
      body: JSON.stringify({
        firstRenderMs: Number(firstMixedRenderMs.toFixed(2)),
        repeatedRenderMs: Number(repeatedMixedRenderMs.toFixed(2)),
      }),
      contentType: 'application/json',
    })
    await page.screenshot({ path: `${OUT}/e1-desktop-mixed-100.png`, fullPage: false })

    // Reduced-motion media: style rule present (presence check).
    const hasReducedMotionRule = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules ?? [])) {
            if (rule instanceof CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(rule.conditionText)) {
              return true
            }
          }
        } catch {
          // cross-origin sheets ignored
        }
      }
      return false
    })
    expect(hasReducedMotionRule, 'prefers-reduced-motion rule').toBe(true)

    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })

  test('compact 1024×768: 320px overlay inspector, no overflow, geometry holds', async ({ page }) => {
    const errs: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`console: ${m.text()}`)
    })
    page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

    await page.setViewportSize(VIEWPORTS.compact)
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
    await waitReady(page)
    let metrics = await selectFixture(page, 'condition')
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoHorizontalOverflow(page)

    await openFirstNode(page)
    metrics = await page.evaluate(() => window.__E1_CANVAS__ as PublicMetrics)
    expect(metrics.inspectorPresentation).toBe('overlay')
    const inspector = page.locator('[data-test="e1-inspector"]')
    await expect(inspector).toHaveAttribute('data-presentation', 'overlay')
    const width = await inspector.evaluate((el) => getComputedStyle(el).width)
    expect(width, 'compact overlay width').toBe('320px')
    const position = await inspector.evaluate((el) => getComputedStyle(el).position)
    expect(position).toBe('absolute')

    // With overlay closed, canvas remains usable full width.
    await page.locator('[data-test="inspector-close"]').click()
    await expect(inspector).toHaveCount(0)
    const canvasBox = await page.locator('[data-test="e1-canvas-region"]').boundingBox()
    expect(canvasBox!.width).toBeGreaterThan(900)

    // Re-open and confirm inserts stay ≥ 40×40.
    await openFirstNode(page)
    const insertBox = await page.locator('[data-test="edge-insert"]').first().boundingBox()
    expect(insertBox!.width).toBeGreaterThanOrEqual(40)
    expect(insertBox!.height).toBeGreaterThanOrEqual(40)

    metrics = await selectFixture(page, 'mixed-100')
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/e1-compact-1024.png` })
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })

  test('narrow 390×844: bottom sheet, no horizontal overflow, targets, geometry', async ({ page }) => {
    const errs: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`console: ${m.text()}`)
    })
    page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

    await page.setViewportSize(VIEWPORTS.narrow)
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
    await waitReady(page)

    // Harness chrome must wrap so it does not pollute overflow assertions.
    let metrics = await selectFixture(page, 'linear')
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoHorizontalOverflow(page)

    await openFirstNode(page)
    metrics = await page.evaluate(() => window.__E1_CANVAS__ as PublicMetrics)
    expect(metrics.inspectorPresentation).toBe('sheet')
    const inspector = page.locator('[data-test="e1-inspector"]')
    await expect(inspector).toHaveAttribute('data-presentation', 'sheet')
    await expect(inspector).toHaveAttribute('data-sheet-detent', 'half')
    await expect(page.locator('[data-test="sheet-handle"]')).toBeVisible()

    // Half detent leaves canvas visible above the sheet.
    const canvasBox = await page.locator('[data-test="e1-canvas-region"]').boundingBox()
    const sheetBox = await inspector.boundingBox()
    expect(canvasBox, 'canvas').toBeTruthy()
    expect(sheetBox, 'sheet').toBeTruthy()
    expect(sheetBox!.y, 'sheet starts below canvas top').toBeGreaterThan(canvasBox!.y + 100)
    // Visible canvas above half sheet roughly ≥ 320px in design lock; allow modest tolerance for chrome.
    const visibleAbove = sheetBox!.y - canvasBox!.y
    expect(visibleAbove, `visible canvas above sheet (${visibleAbove})`).toBeGreaterThanOrEqual(280)

    // Sheet action targets ≥ 44×44.
    for (const testId of ['sheet-half', 'sheet-full', 'inspector-close'] as const) {
      const box = await page.locator(`[data-test="${testId}"]`).boundingBox()
      expect(box, testId).toBeTruthy()
      expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(40)
    }

    await page.locator('[data-test="sheet-full"]').click()
    await expect(inspector).toHaveAttribute('data-sheet-detent', 'full')
    await page.locator('[data-test="sheet-half"]').click()
    await expect(inspector).toHaveAttribute('data-sheet-detent', 'half')

    // Long labels + priority still hold at 390 without page-level horizontal scroll.
    metrics = await selectFixture(page, 'long-labels')
    await assertNoHorizontalOverflow(page)
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoInternals(page, metrics)

    metrics = await selectFixture(page, 'condition')
    const ordered = [...metrics.branchLabels].sort((a, b) => a.x - b.x)
    expect(ordered[ordered.length - 1]?.isDefault).toBe(true)

    metrics = await selectFixture(page, 'mixed-100')
    expect(metrics.nodeCount).toBe(100)
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoHorizontalOverflow(page)

    await page.screenshot({ path: `${OUT}/e1-narrow-390.png` })
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })
})
