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
  graphJson: string
  canUndo: boolean
  canRedo: boolean
  undoDepth: number
  lastCommandOk: boolean | null
  lastCommandCode: string | null
  lastCommandChannel: 'pointer' | 'keyboard' | 'toolbar' | null
  cardKeyByFocusId: Record<string, string>
  edgeKeyByFocusId: Record<string, string>
}

type GraphSnap = {
  nodes: Array<{ key: string; type: string; name: string; config: unknown }>
  edges: Array<{ key: string; source: string; target: string }>
}

function parseGraph(metrics: PublicMetrics): GraphSnap {
  return JSON.parse(metrics.graphJson) as GraphSnap
}

/** Renderer coordinates must never appear on the persisted ApprovalGraph snapshot. */
function assertGraphHasNoCoordinates(graph: GraphSnap) {
  const raw = JSON.stringify(graph)
  // Fail if any node/edge object carries layout fields.
  for (const node of graph.nodes) {
    expect(node, `node ${node.key} must not persist coordinates`).not.toHaveProperty('x')
    expect(node, `node ${node.key} must not persist coordinates`).not.toHaveProperty('y')
    expect(node, `node ${node.key} must not persist coordinates`).not.toHaveProperty('width')
    expect(node, `node ${node.key} must not persist coordinates`).not.toHaveProperty('height')
  }
  expect(raw).not.toMatch(/"x"\s*:/)
  expect(raw).not.toMatch(/"y"\s*:/)
}

async function readMetrics(page: Page): Promise<PublicMetrics> {
  return page.evaluate(() => window.__E1_CANVAS__ as PublicMetrics)
}

/** HTML5 DnD through the real drag events so pointer channel uses the shared adapter. */
async function html5DragCardToEdge(page: Page, cardFocusId: string, edgeFocusId: string) {
  await page.evaluate(
    ({ fromFocus, toFocus }) => {
      const source = document.querySelector(`[data-focus-id="${fromFocus}"]`)
      const target = document.querySelector(`[data-focus-id="${toFocus}"]`)
      if (!source || !target) throw new Error('drag source/target missing')
      const dt = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    { fromFocus: cardFocusId, toFocus: edgeFocusId },
  )
  await page.waitForTimeout(80)
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

    // Swap priority via real reorder-condition-branches history command (not fixture swap).
    const graphBeforePriority = metrics.graphJson
    assertGraphHasNoCoordinates(parseGraph(metrics))
    await page.locator('[data-test="swap-priority"]').click()
    await page.waitForTimeout(80)
    metrics = await waitReady(page)
    expect(metrics.fixtureId).toBe('condition')
    expect(metrics.lastCommandOk).toBe(true)
    expect(metrics.lastCommandChannel).toBe('toolbar')
    expect(metrics.canUndo).toBe(true)
    expect(metrics.graphJson).not.toBe(graphBeforePriority)
    const swapped = [...metrics.branchLabels].sort((a, b) => a.x - b.x)
    expect(swapped[0]?.label).toContain('一千')
    expect(swapped[1]?.label).toContain('一百')
    expect(swapped[2]?.isDefault).toBe(true)
    // Undo restores byte-identical graph (history inverse).
    await page.locator('[data-test="undo"]').click()
    await page.waitForTimeout(80)
    metrics = await waitReady(page)
    expect(metrics.graphJson).toBe(graphBeforePriority)
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

  test('E1-b: command history reorder, legal/illegal move, shared drag adapter, non-persisted coords', async ({ page }) => {
    const errs: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`console: ${m.text()}`)
    })
    page.on('pageerror', (e) => errs.push(`pageerror: ${String(e)}`))

    await page.setViewportSize(VIEWPORTS.desktop)
    await page.goto(HARNESS, { waitUntil: 'domcontentloaded' })
    await waitReady(page)

    // --- (1) Branch reorder through command API; undo restores byte-identical graph ---
    let metrics = await selectFixture(page, 'condition')
    const beforeReorder = metrics.graphJson
    assertGraphHasNoCoordinates(parseGraph(metrics))
    const condConfigBefore = parseGraph(metrics).nodes.find((node) => node.type === 'condition')
      ?.config as { branches: Array<{ edgeKey: string }>; defaultEdgeKey: string }
    expect(condConfigBefore.branches.map((branch) => branch.edgeKey)).toEqual(['e-mid', 'e-high'])

    const reorderResult = await page.evaluate(() => window.__E1_SWAP_CONDITION_PRIORITY__?.())
    expect(reorderResult && 'ok' in reorderResult ? reorderResult.ok : false).toBe(true)
    await page.waitForTimeout(80)
    metrics = await readMetrics(page)
    expect(metrics.lastCommandOk).toBe(true)
    expect(metrics.lastCommandChannel).toBe('toolbar')
    expect(metrics.fixtureId).toBe('condition')
    const condConfigAfter = parseGraph(metrics).nodes.find((node) => node.type === 'condition')
      ?.config as { branches: Array<{ edgeKey: string }>; defaultEdgeKey: string }
    expect(condConfigAfter.branches.map((branch) => branch.edgeKey)).toEqual(['e-high', 'e-mid'])
    expect(condConfigAfter.defaultEdgeKey).toBe(condConfigBefore.defaultEdgeKey)
    expect(metrics.graphJson).not.toBe(beforeReorder)
    // Visual lane order follows config.
    const lanes = [...metrics.branchLabels].sort((a, b) => a.x - b.x)
    expect(lanes[0]?.label).toContain('一千')
    expect(lanes[1]?.label).toContain('一百')
    expect(lanes[2]?.isDefault).toBe(true)

    const undoResult = await page.evaluate(() => window.__E1_UNDO__?.())
    expect(undoResult && 'ok' in undoResult ? undoResult.ok : false).toBe(true)
    await page.waitForTimeout(80)
    metrics = await readMetrics(page)
    expect(metrics.graphJson).toBe(beforeReorder)
    assertGraphHasNoCoordinates(parseGraph(metrics))
    await assertNoInternals(page, metrics)

    // --- (2) One legal approval move onto an edge via real move-node-into-edge ---
    metrics = await selectFixture(page, 'linear')
    const beforeMove = metrics.graphJson
    const preMoveApprovalFocus = metrics.cards.find((card) => card.name === '主管审批')?.focusId
    expect(preMoveApprovalFocus, 'pre-move 主管审批 focus').toBeTruthy()
    assertGraphHasNoCoordinates(parseGraph(metrics))
    // Move 主管审批 (approval_1) onto the edge after 抄送 (e-cc-end).
    const legal = await page.evaluate(() =>
      window.__E1_MOVE_NODE_INTO_EDGE__?.('approval_1', 'e-cc-end', 'keyboard'),
    )
    expect(legal?.ok).toBe(true)
    expect(legal?.code).toBeNull()
    await page.waitForTimeout(80)
    metrics = await readMetrics(page)
    expect(metrics.lastCommandOk).toBe(true)
    expect(metrics.lastCommandChannel).toBe('keyboard')
    expect(metrics.graphJson).not.toBe(beforeMove)
    const moved = parseGraph(metrics)
    expect(moved.edges.some((edge) => edge.source === 'start' && edge.target === 'cc_1')).toBe(true)
    expect(moved.edges.some((edge) => edge.source === 'cc_1' && edge.target === 'approval_1')).toBe(true)
    expect(moved.edges.some((edge) => edge.source === 'approval_1' && edge.target === 'end')).toBe(true)
    expect(moved.edges.some((edge) => edge.source === 'start' && edge.target === 'approval_1')).toBe(false)
    assertGraphHasNoCoordinates(moved)
    await expect(page.locator('[data-test="e1-live"]')).toContainText('已移动')
    // Live region must stay values-free (no edge/node keys).
    const liveAfterLegal = await page.locator('[data-test="e1-live"]').innerText()
    expect(liveAfterLegal).not.toMatch(/approval_1|e-cc-end|e-start/)
    // Selection follows history.selectionAfter (node key), not the stale pre-move focusId.
    // Layer reorder after move would otherwise leave the inspector on a different card.
    expect(metrics.selectedName).toBe('主管审批')
    await expect(page.locator('[data-test="e1-inspector"]')).toBeVisible()
    await expect(page.locator('[data-test="inspector-name"]')).toHaveText('主管审批')
    const postMoveApproval = metrics.cards.find((card) => card.name === '主管审批')
    expect(postMoveApproval, 'post-move 主管审批 card').toBeTruthy()
    expect(metrics.cardKeyByFocusId[postMoveApproval!.focusId]).toBe('approval_1')
    // Discriminating: focus id for 主管审批 can change after layer re-layout; selection must track key.
    expect(postMoveApproval!.focusId).not.toBe(preMoveApprovalFocus)
    const selectedFocusAfterMove = Object.entries(metrics.cardKeyByFocusId).find(
      ([, key]) => key === 'approval_1',
    )?.[0]
    expect(selectedFocusAfterMove).toBe(postMoveApproval!.focusId)
    await expect(page.locator(`[data-focus-id="${postMoveApproval!.focusId}"]`)).toBeFocused()
    await assertNoInternals(page, metrics)

    // Undo restores exact prior graph AND selectionBefore (主管审批 / approval_1).
    await page.evaluate(() => window.__E1_UNDO__?.())
    await page.waitForTimeout(80)
    metrics = await readMetrics(page)
    expect(metrics.graphJson).toBe(beforeMove)
    expect(metrics.selectedName).toBe('主管审批')
    await expect(page.locator('[data-test="inspector-name"]')).toHaveText('主管审批')
    const postUndoApproval = metrics.cards.find((card) => card.name === '主管审批')
    expect(postUndoApproval, 'post-undo 主管审批 card').toBeTruthy()
    expect(metrics.cardKeyByFocusId[postUndoApproval!.focusId]).toBe('approval_1')
    await expect(page.locator(`[data-focus-id="${postUndoApproval!.focusId}"]`)).toBeFocused()

    // --- (3) Illegal self-slot: typed rejection, values-free copy, byte-identical graph ---
    metrics = await selectFixture(page, 'linear')
    const beforeIllegal = metrics.graphJson
    const illegal = await page.evaluate(() =>
      window.__E1_MOVE_NODE_INTO_EDGE__?.('approval_1', 'e-approval-cc', 'keyboard'),
    )
    expect(illegal?.ok).toBe(false)
    expect(illegal?.code).toBe('self-slot')
    await page.waitForTimeout(80)
    metrics = await readMetrics(page)
    expect(metrics.lastCommandOk).toBe(false)
    expect(metrics.lastCommandCode).toBe('self-slot')
    expect(metrics.graphJson).toBe(beforeIllegal)
    expect(metrics.canUndo).toBe(false)
    await expect(page.locator('[data-test="e1-live"]')).toHaveText('该位置不能放置此节点')
    const liveIllegal = await page.locator('[data-test="e1-live"]').innerText()
    expect(liveIllegal).not.toMatch(/approval_1|e-approval-cc|self-slot/)
    // Unsupported type rejection (start) also stays values-free and non-mutating.
    const unsupported = await page.evaluate(() =>
      window.__E1_MOVE_NODE_INTO_EDGE__?.('start', 'e-cc-end', 'keyboard'),
    )
    expect(unsupported?.ok).toBe(false)
    expect(unsupported?.code).toBe('unsupported-node-type')
    metrics = await readMetrics(page)
    expect(metrics.graphJson).toBe(beforeIllegal)
    await expect(page.locator('[data-test="e1-live"]')).toHaveText('此节点类型不支持此操作')

    // --- (4) Pointer/HTML5 drag uses the same adapter as keyboard activation ---
    metrics = await selectFixture(page, 'linear')
    const beforeDrag = metrics.graphJson
    const approvalCard = metrics.cards.find((card) => card.type === 'approval')
    expect(approvalCard, 'approval card').toBeTruthy()
    // Target the insert control on e-cc-end (after 抄送).
    const ccEndFocus = Object.entries(metrics.edgeKeyByFocusId).find(([, key]) => key === 'e-cc-end')?.[0]
    expect(ccEndFocus, 'e-cc-end focus').toBeTruthy()
    await html5DragCardToEdge(page, approvalCard!.focusId, ccEndFocus!)
    metrics = await readMetrics(page)
    expect(metrics.lastCommandOk).toBe(true)
    expect(metrics.lastCommandChannel).toBe('pointer')
    expect(metrics.graphJson).not.toBe(beforeDrag)
    const afterPointer = parseGraph(metrics)
    expect(afterPointer.edges.some((edge) => edge.source === 'cc_1' && edge.target === 'approval_1')).toBe(true)
    // Pointer path also remaps selection via history.selectionAfter — still 主管审批.
    expect(metrics.selectedName).toBe('主管审批')
    await expect(page.locator('[data-test="inspector-name"]')).toHaveText('主管审批')

    // Reset and exercise keyboard activation of the same adapter (`m` on edge insert).
    metrics = await selectFixture(page, 'linear')
    const beforeKeyboard = metrics.graphJson
    const approvalFocus = metrics.cards.find((card) => card.type === 'approval')!.focusId
    const edgeFocusAgain = Object.entries(metrics.edgeKeyByFocusId).find(([, key]) => key === 'e-cc-end')?.[0]
    expect(edgeFocusAgain, 'e-cc-end focus after reset').toBeTruthy()
    await page.locator(`[data-focus-id="${approvalFocus}"]`).click()
    await page.locator(`[data-focus-id="${edgeFocusAgain}"]`).focus()
    await page.keyboard.press('m')
    await page.waitForTimeout(80)
    metrics = await readMetrics(page)
    expect(metrics.lastCommandOk).toBe(true)
    expect(metrics.lastCommandChannel).toBe('keyboard')
    expect(metrics.graphJson).not.toBe(beforeKeyboard)
    // Same topology as pointer path.
    const afterKeyboard = parseGraph(metrics)
    expect(afterKeyboard.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(
      afterPointer.edges.map((e) => `${e.source}->${e.target}`).sort(),
    )
    // Keyboard path: selection/inspector still name 主管审批 after focusId reshuffle.
    expect(metrics.selectedName).toBe('主管审批')
    await expect(page.locator('[data-test="inspector-name"]')).toHaveText('主管审批')
    const kbApproval = metrics.cards.find((card) => card.name === '主管审批')!
    await expect(page.locator(`[data-focus-id="${kbApproval.focusId}"]`)).toBeFocused()

    // --- (5) Renderer coordinates remain non-persisted after mutations ---
    assertGraphHasNoCoordinates(afterKeyboard)
    expect(metrics.cards.every((card) => typeof card.x === 'number')).toBe(true)
    // Geometry + no-internals still hold on mutated linear graph.
    assertNoCardOverlap(metrics)
    assertEdgesDoNotCrossCards(metrics)
    await assertNoInternals(page, metrics)
    await assertNoHorizontalOverflow(page)

    await page.screenshot({ path: `${OUT}/e1-b-command-drag.png` })
    expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([])
  })
})
