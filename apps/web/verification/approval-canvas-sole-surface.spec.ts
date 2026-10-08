// P7-B0 Canvas sole-surface acceptance. This drives the REAL TemplateAuthoringView through the
// existing mounted-production harness (real Vue Router + Element Plus) and intercepts only the
// template read. It proves the ordinary authoring path is Canvas-first in Chromium while the
// explicit flag-off rollback still exposes the structured list.
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page, type Request, type Response } from '@playwright/test'

const OUT = 'verification-output'

const COMPLEX_TEMPLATE = {
  id: 'afb_harness_1',
  key: 'canvas_acceptance',
  name: 'Canvas 验收复杂模板',
  description: '条件与并行流程浏览器验收',
  category: '验证',
  visibilityScope: { type: 'all', ids: [] },
  slaHours: null,
  status: 'draft',
  activeVersionId: null,
  latestVersionId: 'ver_canvas_1',
  createdAt: '2026-08-26T00:00:00Z',
  updatedAt: '2026-08-26T00:00:00Z',
  formSchema: {
    fields: [
      { id: 'amount', type: 'number', label: '金额', required: true },
      { id: 'budget_owner', type: 'user', label: '预算负责人', required: true },
      {
        id: 'purchase_items',
        type: 'detail',
        label: '采购明细',
        columns: [{ id: 'amount', type: 'number', label: '金额', required: true }],
      },
    ],
  },
  approvalGraph: {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'budget_owner_approval',
        type: 'approval',
        name: '预算负责人审批',
        config: {
          assigneeSources: [{ kind: 'form_field_user', fieldId: 'budget_owner' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'amount_gate',
        type: 'condition',
        name: '金额分级判断',
        config: {
          branches: [{
            edgeKey: 'edge-gate-fork',
            rules: [{ fieldId: 'amount', operator: 'gte', value: 20000 }],
          }],
          defaultEdgeKey: 'edge-gate-manager',
        },
      },
      {
        key: 'manager_approval',
        type: 'approval',
        name: '直属上级审批',
        config: {
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'parallel_fork',
        type: 'parallel',
        name: '高额并行审批',
        config: {
          branches: ['edge-fork-finance', 'edge-fork-legal'],
          joinMode: 'all',
          joinNodeKey: 'end',
        },
      },
      {
        key: 'finance_approval',
        type: 'approval',
        name: '财务审批',
        config: {
          assigneeSources: [{ kind: 'static_role', roleIds: ['finance'] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'legal_approval',
        type: 'approval',
        name: '法务审批',
        config: {
          assigneeSources: [{ kind: 'static_role', roleIds: ['legal'] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-budget', source: 'start', target: 'budget_owner_approval' },
      { key: 'edge-budget-gate', source: 'budget_owner_approval', target: 'amount_gate' },
      { key: 'edge-gate-fork', source: 'amount_gate', target: 'parallel_fork' },
      { key: 'edge-gate-manager', source: 'amount_gate', target: 'manager_approval' },
      { key: 'edge-fork-finance', source: 'parallel_fork', target: 'finance_approval' },
      { key: 'edge-fork-legal', source: 'parallel_fork', target: 'legal_approval' },
      { key: 'edge-finance-end', source: 'finance_approval', target: 'end' },
      { key: 'edge-legal-end', source: 'legal_approval', target: 'end' },
      { key: 'edge-manager-end', source: 'manager_approval', target: 'end' },
    ],
  },
}

const LINEAR_TEMPLATE = {
  ...COMPLEX_TEMPLATE,
  key: 'canvas_linear_acceptance',
  name: 'Canvas 验收线性模板',
  description: '普通线性流程升级浏览器验收',
  latestVersionId: 'ver_canvas_linear_1',
  approvalGraph: {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: '直属上级审批',
        config: {
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
  },
}

// T5c (test report 2026-10-08): a flow long enough that the page — not one screen — holds the
// canvas (8 approvals ⇒ 10 layers ⇒ ~1.7k px stage), the shape the tester reported.
const LONG_FLOW_STEPS = 8
const LONG_TEMPLATE = {
  ...LINEAR_TEMPLATE,
  key: 'canvas_long_flow_acceptance',
  name: 'Canvas 验收长流程模板',
  description: '长流程检查器可见性浏览器验收',
  latestVersionId: 'ver_canvas_long_1',
  approvalGraph: {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      ...Array.from({ length: LONG_FLOW_STEPS }, (_, index) => ({
        key: `approval_${index + 1}`,
        type: 'approval',
        name: `第 ${index + 1} 级审批`,
        config: {
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      })),
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: ['start', ...Array.from({ length: LONG_FLOW_STEPS }, (_, index) => `approval_${index + 1}`), 'end']
      .slice(0, -1)
      .map((source, index, sources) => ({
        key: `edge-long-${index}`,
        source,
        target: sources[index + 1] ?? 'end',
      })),
  },
} as typeof LINEAR_TEMPLATE

async function mountFlow(
  page: Page,
  options: {
    canvasV2: boolean
    width: number
    height: number
    template?: typeof COMPLEX_TEMPLATE | typeof LINEAR_TEMPLATE
    route?: 'edit' | 'new'
    enterFlow?: boolean
  },
): Promise<void> {
  const template = options.template ?? COMPLEX_TEMPLATE
  const route = options.route ?? 'edit'
  const failedApiRequests: string[] = []
  const nonOkApiResponses: string[] = []
  const recordFailedApiRequest = (request: Request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/api/')) failedApiRequests.push(pathname)
  }
  const recordNonOkApiResponse = (response: Response) => {
    const pathname = new URL(response.url()).pathname
    if (pathname.startsWith('/api/') && !response.ok()) {
      nonOkApiResponses.push(`${pathname}:${response.status()}`)
    }
  }
  page.on('requestfailed', recordFailedApiRequest)
  page.on('response', recordNonOkApiResponse)
  await page.setViewportSize({ width: options.width, height: options.height })
  await page.route(/\/api\/approval-templates\/afb_harness_1(?:\?.*)?$/, (route) => {
    const request = route.request()
    const responseTemplate = request.method() === 'PATCH'
      ? {
          ...template,
          approvalGraph: (request.postDataJSON() as { approvalGraph?: typeof template.approvalGraph })
            .approvalGraph ?? template.approvalGraph,
        }
      : template
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseTemplate),
    })
  })
  await page.route('**/api/approval-templates/directory/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ users: [], roles: [], groups: [] }),
  }))
  await page.route('**/api/approvals/directory/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ users: [], roles: [], groups: [] }),
  }))
  await page.route('**/api/plugins', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plugins: [] }),
  }))
  await page.goto(
    `/verification/approval-form-builder-mounted-harness.html?canvasV2=${options.canvasV2 ? 'on' : 'off'}&route=${route}&networkTemplate=on`,
  )
  await page.waitForFunction(() => (
    window as unknown as { __AFB_MOUNT_READY__?: boolean }
  ).__AFB_MOUNT_READY__ === true)
  await page.waitForLoadState('networkidle')
  page.off('requestfailed', recordFailedApiRequest)
  page.off('response', recordNonOkApiResponse)
  expect(failedApiRequests, 'mounted Canvas must not tolerate failed API dependencies').toEqual([])
  expect(nonOkApiResponses, 'mounted Canvas must not tolerate non-2xx API dependencies').toEqual([])
  await expect(page.locator('[data-testid="approval-template-name"]')).toHaveValue(
    route === 'edit' ? template.name : '',
  )
  if (options.enterFlow ?? true) {
    await page.click('[data-testid="approval-template-section-flow"]')
  }
}

function canvasNode(page: Page, key: string) {
  return page.locator(`[data-testid="approval-canvas-node"][data-canvas-node="${key}"]`)
}

function canvasNodeSelector(page: Page, key: string) {
  return canvasNode(page, key).locator('[data-testid="approval-canvas-node-select"]')
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))
  expect(overflow).toBeLessThanOrEqual(1)
}

async function expectNoOverlap(first: Locator, second: Locator, label: string): Promise<void> {
  const firstBox = await first.boundingBox()
  const secondBox = await second.boundingBox()
  expect(firstBox, `${label}: first element must be laid out`).not.toBeNull()
  expect(secondBox, `${label}: second element must be laid out`).not.toBeNull()
  if (!firstBox || !secondBox) return
  const overlapWidth = Math.max(
    0,
    Math.min(firstBox.x + firstBox.width, secondBox.x + secondBox.width) - Math.max(firstBox.x, secondBox.x),
  )
  const overlapHeight = Math.max(
    0,
    Math.min(firstBox.y + firstBox.height, secondBox.y + secondBox.height) - Math.max(firstBox.y, secondBox.y),
  )
  expect(overlapWidth * overlapHeight, label).toBe(0)
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Unexpected page error: ${error.message}`)
  })
})

for (const viewport of [
  { label: '1440', width: 1440, height: 900 },
  { label: '1024', width: 1024, height: 768 },
  { label: '390', width: 390, height: 844 },
] as const) {
  test(`Canvas is the sole authoring surface and opens the real inspector at ${viewport.label}px`, async ({ page }) => {
    await mountFlow(page, { canvasV2: true, width: viewport.width, height: viewport.height })

    await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toBeVisible()
    await expect(page.locator('[data-testid="approval-graph-canvas"]')).toBeVisible()
    await expect(page.locator('[data-testid="approval-graph-readonly-list"]')).toHaveCount(0)
    await expect(page.locator('.template-authoring__view-toggle')).toHaveCount(0)
    await expect(canvasNode(page, 'amount_gate')).toHaveAttribute('data-node-type', 'condition')
    await expect(canvasNode(page, 'parallel_fork')).toHaveAttribute('data-node-type', 'parallel')

    // Pointer selection opens the real condition inspector with the selected node identity.
    await canvasNodeSelector(page, 'amount_gate').click()
    const conditionInspector = page.locator('[data-testid="approval-canvas-inspector"]')
    await expect(conditionInspector).toBeVisible()
    await expect(conditionInspector).toHaveAttribute('data-inspector-node', 'amount_gate')
    await expect(conditionInspector).toHaveAttribute('data-inspector-type', 'condition')
    await expect(conditionInspector).toContainText('金额分级判断')
    await page.click('[data-testid="approval-canvas-inspector-close"]')
    await expect(conditionInspector).toHaveCount(0)

    // Keyboard selection uses the production Enter handler and opens the approval-node tab strip.
    const approvalSelector = canvasNodeSelector(page, 'budget_owner_approval')
    await expect(approvalSelector).toHaveAttribute('role', 'button')
    await expect(approvalSelector).toHaveAttribute('aria-label', '编辑审批节点「预算负责人审批」')
    await approvalSelector.focus()
    await page.keyboard.press('Enter')
    const approvalInspector = page.locator('[data-testid="approval-canvas-inspector"]')
    await expect(approvalInspector).toHaveAttribute('data-inspector-node', 'budget_owner_approval')
    await expect(approvalInspector).toHaveAttribute('data-inspector-type', 'approval')
    await expect(approvalInspector).toContainText('预算负责人审批')
    await expect(page.locator('[data-testid="approval-canvas-inspector-tablist"]')).toHaveAttribute('role', 'tablist')
    await expect(page.locator('[data-testid="approval-canvas-inspector-tab-assignee"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-testid="approval-canvas-inspector-tab-fieldPermissions"]')).toHaveAttribute('aria-selected', 'false')

    if (viewport.width === 390) {
      await expectNoOverlap(
        page.locator('.template-authoring__steps'),
        approvalSelector,
        'mobile step navigation must not cover the focused Canvas node',
      )
      await expectNoOverlap(
        page.locator('.template-authoring__section-actions'),
        approvalInspector,
        'mobile section actions must not cover the Canvas inspector',
      )
    }
    await expectNoDocumentOverflow(page)
    await page.screenshot({ path: `${OUT}/p7-canvas-sole-surface-${viewport.label}.png`, fullPage: true })
  })
}

test('ordinary linear editable templates promote into Canvas without exposing the legacy step editor', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: true,
    width: 1440,
    height: 900,
    template: LINEAR_TEMPLATE,
  })
  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toBeVisible()
  await expect(canvasNode(page, 'approval_1')).toHaveAttribute('data-node-type', 'approval')
  await expect(page.locator('[data-testid="approval-graph-readonly-list"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-template-add-step"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-template-step-spine"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-template-step-row"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('已保存')

  await canvasNodeSelector(page, 'approval_1').click()
  await page.click('[data-testid="approval-canvas-inspector-rename"]')
  await page.fill('[data-testid="approval-canvas-inspector-rename-input"]', '财务复核')
  await page.press('[data-testid="approval-canvas-inspector-rename-input"]', 'Enter')
  await expect(canvasNodeSelector(page, 'approval_1')).toHaveAttribute('aria-label', '编辑审批节点「财务复核」')
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('有未保存更改')
})

test('linear Canvas exposes sequential approval and persists the selected mode', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: true,
    width: 1440,
    height: 900,
    template: LINEAR_TEMPLATE,
  })

  await canvasNodeSelector(page, 'approval_1').click()
  const mode = page.locator('[data-testid="approval-node-mode"]')
  await mode.click()
  await page.getByRole('option', { name: '依次审批', exact: true }).click()
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('有未保存更改')

  const updateRequest = page.waitForRequest((request) => (
    request.method() === 'PATCH'
      && /\/api\/approval-templates\/afb_harness_1(?:\?.*)?$/.test(request.url())
  ))
  await page.click('[data-testid="approval-template-save-button"]')
  const payload = (await updateRequest).postDataJSON() as {
    approvalGraph?: { nodes?: Array<{ key?: string; config?: { approvalMode?: string } }> }
  }
  expect(payload.approvalGraph?.nodes?.find((node) => node.key === 'approval_1')?.config?.approvalMode)
    .toBe('sequential')
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('已保存')
})

test('entering Canvas preserves pre-flow edits and keeps the saved linear draft dirty', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: true,
    width: 1440,
    height: 900,
    template: LINEAR_TEMPLATE,
    enterFlow: false,
  })

  const editedName = 'Canvas 验收线性模板（已编辑）'
  const nameInput = page.locator('[data-testid="approval-template-name"]')
  const saveState = page.locator('[data-testid="approval-template-save-state"]')
  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toHaveCount(0)
  await expect(saveState).toHaveText('已保存')

  await nameInput.fill(editedName)
  await expect(nameInput).toHaveValue(editedName)
  await expect(saveState).toHaveText('有未保存更改')

  await page.click('[data-testid="approval-template-section-flow"]')
  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toBeVisible()
  await expect(nameInput).toHaveValue(editedName)
  await expect(saveState).toHaveText('有未保存更改')
})

test('/new promotes its starter flow into Canvas without manufacturing a dirty draft', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: true,
    width: 1440,
    height: 900,
    route: 'new',
  })

  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toBeVisible()
  await expect(canvasNode(page, 'approval_1')).toHaveAttribute('data-node-type', 'approval')
  // Re-pinned (approval-form-ux-slice1 remedy, 20260916 gate condition 1): draftStateLabel's
  // !isEditMode && !isDraftDirty branch now renders '新表单' (TemplateAuthoringView.vue:1857),
  // not '新模板' — this is the B3 rename, not a regression.
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('新表单')

  await canvasNodeSelector(page, 'approval_1').click()
  await page.click('[data-testid="approval-canvas-inspector-rename"]')
  await page.fill('[data-testid="approval-canvas-inspector-rename-input"]', '新建画布审批')
  await page.press('[data-testid="approval-canvas-inspector-rename-input"]', 'Enter')
  await expect(canvasNodeSelector(page, 'approval_1')).toHaveAttribute('aria-label', '编辑审批节点「新建画布审批」')
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('有未保存更改')
})

test('flag OFF keeps the explicit structured-list rollback and does not mount Canvas', async ({ page }) => {
  await mountFlow(page, { canvasV2: false, width: 1440, height: 900 })
  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-graph-canvas"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-graph-readonly-list"]')).toBeVisible()
  await expect(page.locator('[data-testid="approval-graph-node-row"]')).toHaveCount(
    COMPLEX_TEMPLATE.approvalGraph.nodes.length,
  )
})

test('flag OFF keeps the linear legacy editor editable and saves its real graph', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: false,
    width: 1440,
    height: 900,
    template: LINEAR_TEMPLATE,
  })

  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="approval-template-step-spine"]')).toBeVisible()
  const stepRow = page.locator('[data-testid="approval-template-step-row"]').first()
  await expect(stepRow).toBeVisible()
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('已保存')

  await stepRow.locator('input').first().fill('财务复核')
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('有未保存更改')

  const updateRequest = page.waitForRequest((request) => (
    request.method() === 'PATCH'
      && /\/api\/approval-templates\/afb_harness_1(?:\?.*)?$/.test(request.url())
  ))
  await page.click('[data-testid="approval-template-save-button"]')
  const payload = (await updateRequest).postDataJSON() as {
    approvalGraph?: { nodes?: Array<{ key?: string; name?: string }> }
  }
  expect(payload.approvalGraph?.nodes?.find((node) => node.key === 'approval_1')?.name).toBe('财务复核')
  await expect(stepRow.locator('input').first()).toHaveValue('财务复核')
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('已保存')
})

// ── T5c (test report 2026-10-08): the node inspector stays in view for a node far down a long flow.
// The harness mounts the view without the App shell, so the DOCUMENT is the scroll container here
// (in the app it is `.app-main`); every assertion is relative to the viewport and the sticky bars,
// never to hard-coded shell offsets. `toBeVisible()` is NOT enough — it passes for an element that
// has scrolled out of the viewport; `toBeInViewport` + overlap checks are the real gate.
for (const viewport of [
  { label: '1440', width: 1440, height: 900 },
  { label: '1024', width: 1024, height: 768 },
] as const) {
  test(`T5c: selecting a node far down a long flow keeps the inspector in view at ${viewport.label}px`, async ({ page }) => {
    await mountFlow(page, { canvasV2: true, width: viewport.width, height: viewport.height, template: LONG_TEMPLATE })
    await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toBeVisible()
    const lastKey = `approval_${LONG_FLOW_STEPS}`
    // The flow really is taller than the viewport (otherwise this proves nothing).
    const scrollRange = await page.evaluate(() => (
      document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight
    ))
    expect(scrollRange).toBeGreaterThan(300)

    await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight))
    const lastSelector = canvasNodeSelector(page, lastKey)
    await expect(lastSelector).toBeInViewport()
    await lastSelector.click()

    const inspector = page.locator('[data-testid="approval-canvas-inspector"]')
    await expect(inspector).toHaveAttribute('data-inspector-node', lastKey)
    const heading = inspector.locator('.template-authoring__canvas-inspector-header')
    await expect(heading).toBeInViewport({ ratio: 1 })
    await expectNoOverlap(page.locator('.template-authoring__steps'), heading, 'the step bar must not cover the inspector heading')
    await expectNoOverlap(page.locator('.template-authoring__header'), heading, 'the page header must not cover the inspector heading')
    // The node's own settings are reachable without scrolling back up.
    await expect(inspector.locator('[data-testid="approval-canvas-inspector-topology"]')).toBeInViewport()
    const footer = page.locator('[data-testid="approval-canvas-inspector-footer"]')
    await expect(footer).toBeInViewport({ ratio: 1 })
    await expectNoOverlap(page.locator('.template-authoring__section-actions'), footer, 'the sticky 下一步 bar must not cover the inspector footer')
    // Selecting did not drag the page away from the node the author just clicked.
    await expect(lastSelector).toBeInViewport()
    await expectNoDocumentOverflow(page)
    await page.screenshot({ path: `${OUT}/t5c-long-flow-inspector-${viewport.label}.png` })
  })
}

test('T5c: opening and closing a tall inspector does not ratchet the page taller (stage min-height feedback)', async ({ page }) => {
  await mountFlow(page, { canvasV2: true, width: 1440, height: 900, template: LINEAR_TEMPLATE })
  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toBeVisible()
  const pageHeight = () => page.evaluate(() => document.scrollingElement!.scrollHeight)
  const before = await pageHeight()

  await canvasNodeSelector(page, 'approval_1').click()
  const inspector = page.locator('[data-testid="approval-canvas-inspector"]')
  await expect(inspector).toHaveAttribute('data-inspector-node', 'approval_1')
  // Make the inspector content as tall as an author realistically gets it (several source cards).
  for (let i = 0; i < 3; i += 1) await page.click('[data-testid="approval-node-source-add"]')
  // Any viewport sync while the inspector is open (zoom here) used to copy the stretched height
  // into the stage's inline min-height, which then outlived the inspector.
  await page.click('[data-testid="approval-canvas-zoom-in"]')
  await page.click('[data-testid="approval-canvas-zoom-out"]')
  await page.click('[data-testid="approval-canvas-inspector-close"]')
  await expect(inspector).toHaveCount(0)
  expect(await pageHeight()).toBeLessThanOrEqual(before + 2)
  // D0 §5: closing returns focus to the node that was being edited.
  await expect(canvasNodeSelector(page, 'approval_1')).toBeFocused()
})
