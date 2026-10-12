// P7-B0 Canvas sole-surface acceptance. This drives the REAL TemplateAuthoringView through the
// existing mounted-production harness (real Vue Router + Element Plus) and intercepts only the
// template read. It proves the ordinary authoring path is Canvas-first in Chromium while the
// explicit flag-off rollback still exposes the structured list.
// W1-1a (Lock-4 F4-B / F4-C) adds one real-Element-Plus authoring pass through the inspector: the
// 'designated' empty-assignee option + its typed role picker, and the four-value same-person select.
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

// W1-1a gate r2 P2-1 (C7): one approval node with a static_user source the directory page lists, and
// a 'designated' fallback user the page does NOT list (synthetic id). The fallback must render as the
// 未知用户 placeholder, never as its raw id.
const C7_FALLBACK_RAW_ID = 'u_fallback_unlisted'
const C7_LISTED_USER = { id: 'u_listed', name: '目录用户甲', email: '' }
const C7_FALLBACK_TEMPLATE = {
  ...LINEAR_TEMPLATE,
  key: 'canvas_c7_fallback_acceptance',
  name: 'Canvas 验收转交指定人员模板',
  description: '转交指定人员标签浏览器验收',
  latestVersionId: 'ver_canvas_c7_1',
  approvalGraph: {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: '指定用户审批',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: [C7_LISTED_USER.id] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'designated',
          emptyAssigneeFallback: { userIds: [C7_FALLBACK_RAW_ID] },
        },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
  },
} as unknown as typeof LINEAR_TEMPLATE

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
    // W1-1a: directory roles served to the typed pickers (default: none, as before).
    directoryRoles?: Array<{ id: string; name: string }>
    // W1-1a gate r2 P2-1: the user search page served to every user picker (default: none, as before).
    directoryUsers?: Array<{ id: string; name: string; email: string }>
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
    body: JSON.stringify({ users: options.directoryUsers ?? [], roles: options.directoryRoles ?? [], groups: [] }),
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

// W1-1a (Lock-4 F4-B, OD-L4-3(a) / F4-C): real Element Plus selects in the real inspector. Picks the
// 'designated' empty-assignee option, a role through the typed role picker (D0 §10.2 — no raw-id
// input), and 转交直属上级 in the four-value same-person select, then asserts the exact PATCH shape:
// the role target rides the ONE fallback key, and the same-person pick writes ONLY samePersonPolicy
// (implementer default (a): any non-auto_skip pick deletes mergeWithRequester).
test('W1-1a: the inspector authors 转交指定人员 targets and the four-value same-person policy into the saved graph', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: true,
    width: 1440,
    height: 900,
    template: LINEAR_TEMPLATE,
    directoryRoles: [{ id: 'role_approval_admin', name: '审批管理员' }],
  })

  await canvasNodeSelector(page, 'approval_1').click()
  await expect(page.locator('[data-testid="approval-node-empty-fallback-role-picker"]')).toHaveCount(0)
  await page.locator('[data-testid="approval-node-empty-policy"]').click()
  await page.getByRole('option', { name: '转交指定人员', exact: true }).click()
  const rolePicker = page.locator('[data-testid="approval-node-empty-fallback-role-picker"]')
  await expect(rolePicker).toBeVisible()
  await expect(page.locator('[data-testid="approval-node-empty-fallback-hint"]')).toBeVisible()
  // Layout regression pin: outside an <el-form> a label auto-sizes, and the first cut of these rows
  // (half-width grid cells, inline labels) left the same-person select 0px wide in this inspector.
  for (const testId of ['approval-node-empty-fallback-role-picker', 'approval-node-same-person-policy']) {
    const box = await page.locator(`[data-testid="${testId}"]`).boundingBox()
    expect(box?.width ?? 0, `${testId} must not be squeezed by its label`).toBeGreaterThan(200)
  }
  await rolePicker.click()
  await page.getByRole('option', { name: '审批管理员', exact: true }).click()
  // A `multiple` el-select keeps its dropdown open after a pick, overlaying the controls below it;
  // Escape closes it (the inspector itself only binds Escape inside its rename input).
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option', { name: '审批管理员', exact: true })).toBeHidden()
  // The chip shows the role's business name (typed picker; never the raw id).
  await expect(rolePicker).toContainText('审批管理员')
  await expect(rolePicker).not.toContainText('role_approval_admin')

  const samePerson = page.locator('[data-testid="approval-node-same-person-policy"]')
  await samePerson.click()
  await page.getByRole('option', { name: '转交发起人的直属上级审批', exact: true }).click()
  await expect(page.locator('[data-testid="approval-node-same-person-transfer-hint"]')).toBeVisible()
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('有未保存更改')

  const updateRequest = page.waitForRequest((request) => (
    request.method() === 'PATCH'
      && /\/api\/approval-templates\/afb_harness_1(?:\?.*)?$/.test(request.url())
  ))
  await page.click('[data-testid="approval-template-save-button"]')
  const payload = (await updateRequest).postDataJSON() as {
    approvalGraph?: { nodes?: Array<{ key?: string; config?: Record<string, unknown> }> }
  }
  const config = payload.approvalGraph?.nodes?.find((node) => node.key === 'approval_1')?.config ?? {}
  expect(config.emptyAssigneePolicy).toBe('designated')
  expect(config.emptyAssigneeFallback).toEqual({ roleIds: ['role_approval_admin'] })
  expect(config.autoApprovalPolicy).toEqual({ samePersonPolicy: 'transfer_direct_manager' })
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('已保存')
})

// W1-1a gate r2 P2-1 (C7) — the real-Element-Plus half of the switch-back pin. Switching 空审批人策略
// away unmounts the fallback picker while the draft keeps its target; a user search in between
// replaces the shared option list with a page that omits the target; on the switch back a FRESH
// el-select mounts with no cached option, and Element Plus labels an option-less value with the raw
// value (`useSelect.getOption`). The policy-change re-sync puts the placeholder option back first, so
// the chip reads 未知用户. Run once per editor: the Canvas inspector and the flag-off linear step editor.
async function switchEmptyPolicyAwaySearchAndBack(
  page: Page,
  testIds: { emptyPolicy: string; fallbackUserPicker: string; sourceUserPicker: string },
): Promise<void> {
  const fallbackPicker = page.locator(`[data-testid="${testIds.fallbackUserPicker}"]`)
  // Control: after hydrate the target already reads 未知用户.
  await expect(fallbackPicker).toContainText('未知用户')
  await expect(fallbackPicker).not.toContainText(C7_FALLBACK_RAW_ID)

  await page.locator(`[data-testid="${testIds.emptyPolicy}"]`).click()
  await page.getByRole('option', { name: '报错', exact: true }).click()
  await expect(fallbackPicker).toHaveCount(0)

  // Open the step's own source user picker: Element Plus emits visible-change(true), the view runs a
  // user search, and the page (one listed user) omits the fallback target.
  const search = page.waitForResponse((response) => response.url().includes('/api/approval-templates/directory/users'))
  await page.locator(`[data-testid="${testIds.sourceUserPicker}"]`).click()
  await search
  // Positive control: the search page landed (the listed user's option shows its business name).
  await expect(page.getByRole('option', { name: C7_LISTED_USER.name, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option', { name: C7_LISTED_USER.name, exact: true })).toBeHidden()

  await page.locator(`[data-testid="${testIds.emptyPolicy}"]`).click()
  await page.getByRole('option', { name: '转交指定人员', exact: true }).click()
  await expect(fallbackPicker).toBeVisible()
  await expect(fallbackPicker).toContainText('未知用户')
  await expect(fallbackPicker).not.toContainText(C7_FALLBACK_RAW_ID)
}

test('W1-1a (gate r2 P2-1): the Canvas fallback chip reads 未知用户 after switching 空审批人策略 away, searching, and back — never the raw id', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: true,
    width: 1440,
    height: 900,
    template: C7_FALLBACK_TEMPLATE,
    directoryUsers: [C7_LISTED_USER],
  })
  await canvasNodeSelector(page, 'approval_1').click()
  await switchEmptyPolicyAwaySearchAndBack(page, {
    emptyPolicy: 'approval-node-empty-policy',
    fallbackUserPicker: 'approval-node-empty-fallback-user-picker',
    sourceUserPicker: 'approval-node-source-user-picker',
  })
})

test('W1-1a (gate r2 P2-1): the flag-off linear fallback chip reads 未知用户 after switching 空审批人策略 away, searching, and back — never the raw id', async ({ page }) => {
  await mountFlow(page, {
    canvasV2: false,
    width: 1440,
    height: 900,
    template: C7_FALLBACK_TEMPLATE,
    directoryUsers: [C7_LISTED_USER],
  })
  await expect(page.locator('[data-testid="approval-canvas-workspace"]')).toHaveCount(0)
  await switchEmptyPolicyAwaySearchAndBack(page, {
    emptyPolicy: 'approval-step-empty-policy',
    fallbackUserPicker: 'approval-step-empty-fallback-user-picker',
    sourceUserPicker: 'approval-step-user-picker',
  })
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
  // W1-1a: the linear editor's four-value same-person select renders usable (full-width row) with 默认.
  const linearSamePerson = page.locator('[data-testid="approval-step-same-person-policy"]').first()
  await expect(linearSamePerson).toBeVisible()
  await expect(linearSamePerson).toContainText('默认（跟随模板设置）')
  expect((await linearSamePerson.boundingBox())?.width ?? 0).toBeGreaterThan(200)
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

// ── R-43 (B) gate r3 (F3-1 / F3-2 / NIT-c / P3-f): typed condition values in the REAL editors (real
// Element Plus, real TemplateAuthoringView). Element Plus's `el-input` emits nothing when the typed
// text equals the text it already shows, so a marked saved value must be shown EMPTY (with the saved
// value as a read-only note) — then re-entering it exactly as it was saved is a real edit that stores
// the working shape. Covers: flag OFF (legacy designer + structured list, a referenced number field
// retyped to text), flag ON (Designer 2.0 inspector + Canvas inspector, API-seeded values), and the
// pre-R-43 scalar `in` shape in both branch-editor hosts. Loading never rewrites a rule.
type R43Json = Record<string, any>

function r43Template(fields: R43Json[], rules: R43Json[]): R43Json {
  return {
    ...COMPLEX_TEMPLATE,
    key: 'canvas_r43_condition_values',
    name: 'Canvas 验收条件值类型模板',
    description: '条件值按字段类型填写浏览器验收',
    latestVersionId: 'ver_canvas_r43_1',
    formSchema: { fields },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'cond_1', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e-a', rules }], defaultEdgeKey: 'e-b' } },
        {
          key: 'app_a',
          type: 'approval',
          name: 'A',
          config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
        },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-start-c', source: 'start', target: 'cond_1' },
        { key: 'e-a', source: 'cond_1', target: 'app_a' },
        { key: 'e-b', source: 'cond_1', target: 'end' },
        { key: 'e-a-end', source: 'app_a', target: 'end' },
      ],
    },
  }
}

const R43_TEMPLATE_URL = /\/api\/approval-templates\/afb_harness_1(?:\?.*)?$/

/** Mounts with a stateful PATCH echo (form schema AND graph), so a save never reverts a retype. */
async function r43Mount(page: Page, initial: R43Json, canvasV2: boolean): Promise<void> {
  let current = initial
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route(R43_TEMPLATE_URL, (route) => {
    const request = route.request()
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as R43Json
      current = {
        ...current,
        ...(body.formSchema ? { formSchema: body.formSchema } : {}),
        ...(body.approvalGraph ? { approvalGraph: body.approvalGraph } : {}),
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
  })
  for (const pattern of ['**/api/approval-templates/directory/**', '**/api/approvals/directory/**']) {
    await page.route(pattern, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ users: [], roles: [], groups: [] }),
    }))
  }
  await page.route('**/api/plugins', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plugins: [] }),
  }))
  await page.goto(
    `/verification/approval-form-builder-mounted-harness.html?canvasV2=${canvasV2 ? 'on' : 'off'}&route=edit&networkTemplate=on`,
  )
  await page.waitForFunction(() => (
    window as unknown as { __AFB_MOUNT_READY__?: boolean }
  ).__AFB_MOUNT_READY__ === true)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('[data-testid="approval-template-name"]')).toHaveValue(initial.name)
}

async function r43Save(page: Page): Promise<R43Json> {
  const pending = page.waitForRequest((request) => request.method() === 'PATCH' && R43_TEMPLATE_URL.test(request.url()))
  await page.click('[data-testid="approval-template-save-button"]')
  const payload = (await pending).postDataJSON() as R43Json
  await expect(page.locator('[data-testid="approval-template-save-state"]')).toHaveText('已保存')
  return payload
}

const r43Rules = (payload: R43Json) =>
  payload.approvalGraph.nodes.find((node: R43Json) => node.key === 'cond_1').config.branches[0].rules
const r43Field = (payload: R43Json, id: string) =>
  payload.formSchema.fields.find((field: R43Json) => field.id === id)

function r43Rule(scope: Locator, index: number) {
  const row = scope.locator('[data-testid="approval-condition-rule"]').nth(index)
  return {
    issue: row.locator('[data-testid="approval-condition-rule-issue"]'),
    text: row.locator('input[data-testid="approval-condition-rule-value"]'),
    list: row.locator('textarea[data-testid="approval-condition-rule-values"]'),
    stored: row.locator('[data-testid="approval-condition-rule-stored-value-text"]'),
  }
}

const R43_NOT_TEXT = '比较值的类型与字段类型不一致'
const R43_IN_NOT_LIST = '「包含于」需要一组值'
const R43_LIST_NOT_SCALAR = '这个条件类型只能比较单个值'

test('R-43 gate r3 (flag OFF): retyping a referenced number field to text marks its values; re-entering them as saved corrects them', async ({ page }) => {
  const fields = [
    { id: 'amount', type: 'number', label: '金额', required: true },
    { id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'amount', operator: 'eq', value: 5 } },
    { id: 'note2', type: 'text', label: '备注二', visibilityRule: { fieldId: 'amount', operator: 'in', values: [1, 2] } },
    { id: 'approvers', type: 'user', label: '会签人', props: { selection: 'multi', maxSelections: 5 } },
  ]
  const rules = [
    { fieldId: 'amount', operator: 'eq', value: 5 },
    { fieldId: 'amount', operator: 'in', value: [1, 2] },
    { fieldId: 'amount', operator: 'gt', value: 3 },
    { fieldId: 'approvers', operator: 'in', value: 'u1' },
  ]
  await r43Mount(page, r43Template(fields, rules), false)
  await page.click('[data-testid="approval-template-section-fields"]')
  const fieldRows = page.locator('[data-testid="approval-template-field-row"]')
  await expect(fieldRows).toHaveCount(4)
  const noteRow = fieldRows.nth(1)
  const note2Row = fieldRows.nth(2)
  const previews = page.locator('.template-authoring__form-preview-row')

  await fieldRows.nth(0).locator('[data-testid="approval-field-type"]').click()
  await page.getByRole('option', { name: '文本', exact: true }).click()

  // Visibility (legacy designer): marked, box EMPTY, saved value shown read-only, no 「留空=等于空值」.
  await previews.nth(1).click()
  await expect(noteRow.locator('[data-testid="approval-field-visibility-issue"]')).toContainText(R43_NOT_TEXT)
  await expect(noteRow.locator('input[data-testid="approval-field-visibility-value"]')).toHaveValue('')
  await expect(noteRow.locator('[data-testid="approval-field-visibility-stored-value-text"]')).toHaveText('5')
  await expect(noteRow).not.toContainText('比较值留空表示')
  await previews.nth(2).click()
  await expect(note2Row.locator('[data-testid="approval-field-visibility-issue"]')).toContainText(R43_NOT_TEXT)
  await expect(note2Row.locator('textarea[data-testid="approval-field-visibility-values"]')).toHaveValue('')
  await expect(note2Row.locator('[data-testid="approval-field-visibility-stored-value-text"]')).toHaveText('[1,2]')

  // Branch (structured list): the same, aligned; gt still in effect; scalar `in` on a multi-person field
  // is in effect too (its form value is a list the executor `includes` into).
  await page.click('[data-testid="approval-template-section-flow"]')
  const body = page.locator('body')
  await expect(body.locator('[data-testid="approval-condition-rule"]')).toHaveCount(4)
  await expect(r43Rule(body, 0).issue).toContainText(R43_NOT_TEXT)
  await expect(r43Rule(body, 0).text).toHaveValue('')
  await expect(r43Rule(body, 0).stored).toHaveText('5')
  await expect(r43Rule(body, 1).issue).toContainText(R43_NOT_TEXT)
  await expect(r43Rule(body, 1).list).toHaveValue('')
  await expect(r43Rule(body, 1).stored).toHaveText('[1,2]')
  await expect(r43Rule(body, 2).issue).toHaveCount(0)
  await expect(r43Rule(body, 2).text).toHaveValue('3')
  await expect(r43Rule(body, 2).stored).toHaveCount(0)
  await expect(r43Rule(body, 3).issue).toHaveCount(0)
  await expect(r43Rule(body, 3).list).toHaveValue('u1')
  await expectNoDocumentOverflow(page)
  await page.screenshot({ path: `${OUT}/p7-canvas-r43-marked-values-flag-off.png`, fullPage: true })

  // First save: no rewrite on load, no blocker — every value byte-identical.
  const first = await r43Save(page)
  expect(r43Field(first, 'amount').type).toBe('text')
  expect(r43Field(first, 'note').visibilityRule).toEqual({ fieldId: 'amount', operator: 'eq', value: 5 })
  expect(r43Field(first, 'note2').visibilityRule).toEqual({ fieldId: 'amount', operator: 'in', values: [1, 2] })
  expect(r43Rules(first)).toEqual(rules)

  // Re-enter every marked value exactly as it was saved (`fill` = select-all + type).
  await page.click('[data-testid="approval-template-section-fields"]')
  await previews.nth(1).click()
  await noteRow.locator('input[data-testid="approval-field-visibility-value"]').fill('5')
  await previews.nth(2).click()
  await note2Row.locator('textarea[data-testid="approval-field-visibility-values"]').fill('1\n2')
  await expect(noteRow.locator('[data-testid="approval-field-visibility-issue"]')).toHaveCount(0)
  await expect(note2Row.locator('[data-testid="approval-field-visibility-issue"]')).toHaveCount(0)
  await expect(noteRow.locator('[data-testid="approval-field-visibility-stored-value"]')).toHaveCount(0)
  await page.click('[data-testid="approval-template-section-flow"]')
  await r43Rule(body, 0).text.fill('5')
  await r43Rule(body, 1).list.fill('1\n2')
  await expect(body.locator('[data-testid="approval-condition-rule-issue"]')).toHaveCount(0)
  await expect(body.locator('[data-testid="approval-condition-rule-stored-value"]')).toHaveCount(0)

  const second = await r43Save(page)
  expect(r43Field(second, 'note').visibilityRule).toEqual({ fieldId: 'amount', operator: 'eq', value: '5' })
  expect(r43Field(second, 'note2').visibilityRule).toEqual({ fieldId: 'amount', operator: 'in', values: ['1', '2'] })
  expect(r43Rules(second)).toEqual([
    { fieldId: 'amount', operator: 'eq', value: '5' },
    { fieldId: 'amount', operator: 'in', value: ['1', '2'] },
    { fieldId: 'amount', operator: 'gt', value: 3 },
    { fieldId: 'approvers', operator: 'in', value: 'u1' },
  ])
})

test('R-43 gate r3 (flag ON): Designer 2.0 + Canvas inspector show API-seeded marked values empty; re-entering them as saved corrects them', async ({ page }) => {
  const fields = [
    { id: 'reason', type: 'text', label: '事由' },
    { id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'reason', operator: 'eq', value: 5 } },
    { id: 'note2', type: 'text', label: '备注二', visibilityRule: { fieldId: 'reason', operator: 'in', values: [1, 2] } },
  ]
  const rules = [
    { fieldId: 'reason', operator: 'eq', value: 5 },
    { fieldId: 'reason', operator: 'in', value: [1, 2] },
  ]
  await r43Mount(page, r43Template(fields, rules), true)
  await page.click('[data-testid="approval-template-section-fields"]')
  const cards = page.locator('[data-testid="approval-form-builder-card"]')
  await expect(cards).toHaveCount(3)
  const issue = page.locator('[data-testid="approval-form-field-inspector-visibility-issue"]')
  const stored = page.locator('[data-testid="approval-form-field-inspector-visibility-stored-value-text"]')

  await cards.nth(1).click()
  const valueBox = page.locator('[data-testid="approval-form-field-inspector-visibility-value"]')
  await expect(valueBox).toHaveValue('')
  await expect(issue).toContainText(R43_NOT_TEXT)
  await expect(stored).toHaveText('5')
  await valueBox.fill('5')
  await valueBox.press('Tab')
  await expect(issue).toHaveCount(0)
  await expect(stored).toHaveCount(0)

  await cards.nth(2).click()
  const listBox = page.locator('[data-testid="approval-form-field-inspector-visibility-values"]')
  await expect(listBox).toHaveValue('')
  await expect(stored).toHaveText('[1,2]')
  await listBox.fill('1\n2')
  await listBox.press('Tab')
  await expect(issue).toHaveCount(0)

  await page.click('[data-testid="approval-template-section-flow"]')
  await canvasNodeSelector(page, 'cond_1').click()
  const inspector = page.locator('[data-testid="approval-canvas-inspector"]')
  await expect(inspector).toBeVisible()
  await expect(r43Rule(inspector, 0).issue).toContainText(R43_NOT_TEXT)
  await expect(r43Rule(inspector, 0).text).toHaveValue('')
  await expect(r43Rule(inspector, 0).stored).toHaveText('5')
  await expect(r43Rule(inspector, 1).list).toHaveValue('')
  await expect(r43Rule(inspector, 1).stored).toHaveText('[1,2]')
  await page.screenshot({ path: `${OUT}/p7-canvas-r43-marked-values-flag-on.png`, fullPage: true })
  await r43Rule(inspector, 0).text.fill('5')
  await r43Rule(inspector, 1).list.fill('1\n2')
  await expect(inspector.locator('[data-testid="approval-condition-rule-issue"]')).toHaveCount(0)
  await expect(inspector.locator('[data-testid="approval-condition-rule-stored-value"]')).toHaveCount(0)

  const payload = await r43Save(page)
  expect(r43Field(payload, 'note').visibilityRule).toEqual({ fieldId: 'reason', operator: 'eq', value: '5' })
  expect(r43Field(payload, 'note2').visibilityRule).toEqual({ fieldId: 'reason', operator: 'in', values: ['1', '2'] })
  expect(r43Rules(payload)).toEqual([
    { fieldId: 'reason', operator: 'eq', value: '5' },
    { fieldId: 'reason', operator: 'in', value: ['1', '2'] },
  ])
})

for (const canvasV2 of [false, true]) {
  const host = canvasV2 ? 'flag ON Canvas inspector' : 'flag OFF structured list'
  test(`R-43 gate r3 (${host}): the pre-R-43 scalar \`in\` and a one-entry list under eq are corrected by re-entering them as saved`, async ({ page }) => {
    const fields = [{ id: 'reason', type: 'text', label: '事由' }]
    const rules = [
      { fieldId: 'reason', operator: 'in', value: 'a' },
      { fieldId: 'reason', operator: 'in', value: 'b' },
      { fieldId: 'reason', operator: 'eq', value: ['c'] },
    ]
    await r43Mount(page, r43Template(fields, rules), canvasV2)
    await page.click('[data-testid="approval-template-section-flow"]')
    let scope = page.locator('body')
    if (canvasV2) {
      await canvasNodeSelector(page, 'cond_1').click()
      scope = page.locator('[data-testid="approval-canvas-inspector"]')
      await expect(scope).toBeVisible()
    }
    await expect(r43Rule(scope, 0).issue).toContainText(R43_IN_NOT_LIST)
    await expect(r43Rule(scope, 0).list).toHaveValue('')
    await expect(r43Rule(scope, 0).stored).toHaveText('a')
    await expect(r43Rule(scope, 1).stored).toHaveText('b')
    await expect(r43Rule(scope, 2).issue).toContainText(R43_LIST_NOT_SCALAR)
    await expect(r43Rule(scope, 2).text).toHaveValue('')
    await expect(r43Rule(scope, 2).stored).toHaveText('["c"]')

    // An untouched save keeps the old shapes (no rewrite on load).
    expect(r43Rules(await r43Save(page))).toEqual(rules)

    // `fill` (select-all + type) for one rule; a click + select-all + typed key for the other.
    await r43Rule(scope, 0).list.fill('a')
    await r43Rule(scope, 1).list.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('b')
    await r43Rule(scope, 2).text.fill('c')
    await expect(scope.locator('[data-testid="approval-condition-rule-issue"]')).toHaveCount(0)
    await expect(scope.locator('[data-testid="approval-condition-rule-stored-value"]')).toHaveCount(0)
    expect(r43Rules(await r43Save(page))).toEqual([
      { fieldId: 'reason', operator: 'in', value: ['a'] },
      { fieldId: 'reason', operator: 'in', value: ['b'] },
      { fieldId: 'reason', operator: 'eq', value: 'c' },
    ])
  })
}
