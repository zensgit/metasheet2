// P7-B0 Canvas sole-surface acceptance. This drives the REAL TemplateAuthoringView through the
// existing mounted-production harness (real Vue Router + Element Plus) and intercepts only the
// template read. It proves the ordinary authoring path is Canvas-first in Chromium while the
// explicit flag-off rollback still exposes the structured list.
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'

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
  await page.setViewportSize({ width: options.width, height: options.height })
  await page.route(/\/api\/approval-templates\/afb_harness_1(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(template),
  }))
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
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('新模板')

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
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('已保存')
})
