import { expect, test, type Page } from '@playwright/test'

const HARNESS = '/verification/approval-designer-harness.html'
const browserErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { plugins: [] } }))
  await page.route('**/api/approvals/directory/users?*', (route) => route.fulfill({ json: { users: [] } }))
  await page.route('**/api/approval-templates/directory/roles', (route) => route.fulfill({ json: { roles: [] } }))
  await page.route('**/api/approval-templates/directory/formula-roles', (route) => route.fulfill({ json: { roles: [] } }))
})

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([])
})

async function openFormDesigner(page: Page) {
  await page.goto(HARNESS)
  await page.getByTestId('approval-template-section-fields').click()
  await expect(page.getByTestId('approval-form-palette')).toBeVisible()
}

const versionGraph = {
  nodes: [
    { key: 'secret_start_key', type: 'start', name: '发起', config: {} },
    { key: 'secret_approval_one', type: 'approval', name: '直属主管审批', config: { assigneeType: 'role', assigneeIds: ['manager'], approvalMode: 'single' } },
    { key: 'secret_approval_two', type: 'approval', name: '财务复核', config: { assigneeType: 'role', assigneeIds: ['finance'], approvalMode: 'single' } },
    { key: 'secret_approval_three', type: 'approval', name: '负责人确认', config: { assigneeType: 'role', assigneeIds: ['owner'], approvalMode: 'single' } },
    { key: 'secret_cc_key', type: 'cc', name: '抄送财务', config: { targetType: 'role', targetIds: ['finance'] } },
    { key: 'secret_end_key', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'secret_edge_1', source: 'secret_start_key', target: 'secret_approval_one' },
    { key: 'secret_edge_2', source: 'secret_approval_one', target: 'secret_approval_two' },
    { key: 'secret_edge_3', source: 'secret_approval_two', target: 'secret_approval_three' },
    { key: 'secret_edge_4', source: 'secret_approval_three', target: 'secret_cc_key' },
    { key: 'secret_edge_5', source: 'secret_cc_key', target: 'secret_end_key' },
  ],
}

async function mockVersionWorkspaceApi(page: Page) {
  const currentGraph = {
    ...versionGraph,
    nodes: versionGraph.nodes.map((node) => node.key === 'secret_approval_two'
      ? { ...node, name: '资金负责人复核' }
      : node),
  }
  const template = {
    id: 'tpl-browser',
    key: 'expense',
    name: '费用审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: 'ver-active',
    latestVersionId: 'ver-current',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    formSchema: { fields: [{ id: 'secret_amount_id', type: 'number', label: '报销金额', required: true }] },
    approvalGraph: currentGraph,
  }
  const summary = {
    id: 'ver-old',
    templateId: 'tpl-browser',
    version: 3,
    status: 'published',
    publishNote: '增加财务复核',
    publishedDefinitionId: 'definition-old',
    restoredFromVersionId: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  }
  const detail = {
    ...summary,
    formSchema: { fields: [{ id: 'secret_amount_id', type: 'number', label: '金额', required: true }] },
    approvalGraph: versionGraph,
    runtimeGraph: null,
  }
  let latestVersionId = template.latestVersionId
  await page.route('**/api/approval-templates/tpl-browser/form-authoring-context', (route) => route.fulfill({
    json: {
      templateId: 'tpl-browser',
      identityHistory: { complete: true, persistentIds: ['secret_amount_id'] },
      referenceInventory: { complete: true, references: [] },
    },
  }))
  await page.route('**/api/approval-templates/tpl-browser/versions/ver-old', (route) => route.fulfill({ json: detail }))
  await page.route('**/api/approval-templates/tpl-browser/versions', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { versions: [summary] } })
    else await route.fallback()
  })
  await page.route('**/api/approval-templates/tpl-browser', (route) => route.fulfill({
    json: { ...template, latestVersionId },
  }))
  return {
    template,
    summary,
    detail,
    setLatestVersionId(value: string) {
      latestVersionId = value
    },
  }
}

test('approval form palette supports real drag, keyboard reorder, inspector edit, and shared undo/redo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openFormDesigner(page)

  await page.getByTestId('approval-form-palette-textarea').dragTo(
    page.getByTestId('approval-form-drop-slot-1'),
  )
  await expect(page.getByTestId('approval-template-field-row')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '选择多行文本，多行文本' })).toBeVisible()

  await page.getByRole('textbox', { name: '字段名称' }).fill('报销说明')
  await expect(page.getByRole('button', { name: '选择报销说明，多行文本' })).toBeVisible()

  const handles = page.getByTestId('approval-form-field-drag-handle')
  await handles.nth(1).press('Alt+ArrowUp')
  await expect(page.getByTestId('approval-form-field-select')).toHaveText([
    /报销说明多行文本/,
    /字段 1单行文本/,
  ])

  await page.getByTestId('approval-template-undo').click()
  await expect(page.getByTestId('approval-form-field-select')).toHaveText([
    /字段 1单行文本/,
    /报销说明多行文本/,
  ])
  await page.getByTestId('approval-template-redo').click()
  await expect(page.getByTestId('approval-form-field-select')).toHaveText([
    /报销说明多行文本/,
    /字段 1单行文本/,
  ])

  await page.screenshot({
    path: 'verification-output/approval-designer-desktop.png',
    fullPage: true,
  })
})

test('approval canvas exposes edge insertion and branch reordering in the real browser', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openFormDesigner(page)
  await page.getByRole('button', { name: '流程设计' }).click()

  await page.getByRole('button', { name: '在「审批人 1」之后插入节点' }).click()
  await page.getByRole('menuitem', { name: '条件分支' }).click()
  await expect(page.getByTestId('approval-canvas-node')).toHaveCount(6)
  await expect(page.getByTestId('approval-canvas-inspector')).toBeVisible()

  await page.getByTestId(/approval-canvas-add-condition-/).click()
  const handles = page.getByTestId(/approval-canvas-branch-handle-/)
  await expect(handles).toHaveCount(2)
  const before = await handles.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')))
  await handles.nth(0).dragTo(handles.nth(1))
  const after = await handles.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')))
  expect(after).toEqual([...before].reverse())
})

test('approval form designer stacks without horizontal overflow at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFormDesigner(page)

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) throw new Error(`missing ${selector}`)
      const value = element.getBoundingClientRect()
      return { top: value.top, bottom: value.bottom, left: value.left, right: value.right }
    }
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      palette: rect('[data-testid="approval-form-palette"]'),
      canvas: rect('[data-testid="approval-form-field-list"]'),
      inspector: rect('[data-testid="approval-form-field-inspector"]'),
      actions: rect('.template-authoring__section-actions'),
    }
  })

  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.palette.right).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.canvas.top).toBeGreaterThanOrEqual(layout.palette.bottom)
  expect(layout.inspector.top).toBeGreaterThanOrEqual(layout.canvas.bottom)
  expect(layout.actions.top).toBeGreaterThanOrEqual(layout.inspector.bottom)

  await page.screenshot({
    path: 'verification-output/approval-designer-mobile.png',
    fullPage: true,
  })
})

test('approval version workspace compares, synchronizes, and restores through the production UI', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { detail } = await mockVersionWorkspaceApi(page)
  let restoreRequest: unknown = null
  await page.route('**/api/approval-templates/tpl-browser/versions/ver-old/restore', async (route) => {
    restoreRequest = route.request().postDataJSON()
    await route.fulfill({
      json: {
        ...detail,
        id: 'ver-restored',
        version: 4,
        status: 'draft',
        restoredFromVersionId: 'ver-old',
      },
    })
  })

  await page.goto(`${HARNESS}?mode=version`)
  await page.getByTestId('approval-template-version-workspace-button').click()
  await expect(page.getByTestId('approval-version-workspace')).toBeVisible()
  await expect(page.getByText('v3 与当前草稿')).toBeVisible()
  await expect(page.getByText('直属主管审批').first()).toBeVisible()
  await expect(page.getByText('资金负责人复核').first()).toBeVisible()
  await expect(page.getByText('报销金额').first()).toBeVisible()
  await expect(page.getByTestId('approval-version-workspace')).not.toContainText('secret_')
  const workspaceHtml = await page.getByTestId('approval-version-workspace').evaluate((element) => element.outerHTML)
  expect(workspaceHtml).not.toContain('secret_')

  await page.getByRole('button', { name: '同时放大两个版本画布' }).click()
  await expect(page.locator('.approval-version-graph__header').getByText('110%')).toHaveCount(2)
  const viewports = page.locator('.approval-version-graph__viewport')
  await viewports.nth(0).evaluate((element) => {
    element.scrollTop = 120
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => viewports.nth(1).evaluate((element) => element.scrollTop)).toBe(120)
  await viewports.nth(0).evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => viewports.nth(1).evaluate((element) => element.scrollTop)).toBe(0)
  await viewports.nth(1).evaluate((element) => {
    element.scrollTop = 80
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => viewports.nth(0).evaluate((element) => element.scrollTop)).toBe(80)
  await viewports.nth(1).evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => viewports.nth(0).evaluate((element) => element.scrollTop)).toBe(0)

  await page.locator('.approval-version-workspace-dialog').screenshot({
    path: 'verification-output/approval-version-workspace.png',
  })

  await page.getByTestId('approval-version-open-restore-preview').click()
  await expect(page.getByTestId('approval-version-restore-preview')).toBeVisible()
  await expect(page.getByTestId('approval-version-restore-confirm')).toBeDisabled()
  await page.getByTestId('approval-version-restore-acknowledge').click()
  await page.getByTestId('approval-version-restore-confirm').click()
  await expect.poll(() => restoreRequest).toEqual({ expectedLatestVersionId: 'ver-current' })
})

test('approval version restore refreshes a typed stale fence through the real request wrapper', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { detail, setLatestVersionId } = await mockVersionWorkspaceApi(page)
  const restoreRequests: unknown[] = []
  await page.route('**/api/approval-templates/tpl-browser/versions/ver-old/restore', async (route) => {
    restoreRequests.push(route.request().postDataJSON())
    if (restoreRequests.length === 1) {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'APPROVAL_TEMPLATE_VERSION_STALE',
            message: 'postgres://admin:secret@db.internal:5432',
          },
        },
      })
      return
    }
    await route.fulfill({
      json: {
        ...detail,
        id: 'ver-restored-after-conflict',
        version: 5,
        status: 'draft',
        restoredFromVersionId: 'ver-old',
      },
    })
  })

  await page.goto(`${HARNESS}?mode=version`)
  await page.getByTestId('approval-template-version-workspace-button').click()
  await page.getByTestId('approval-version-open-restore-preview').click()
  setLatestVersionId('ver-current-after-conflict')
  await page.getByTestId('approval-version-restore-acknowledge').click()
  await page.getByTestId('approval-version-restore-confirm').click()

  await expect(
    page.getByTestId('approval-version-restore-preview')
      .getByText('版本已由其他人更新，列表已刷新。请重新核对后再次确认。'),
  ).toBeVisible()
  await expect(page.getByTestId('approval-version-workspace')).not.toContainText('db.internal')
  await expect(page.getByText('资金负责人复核').first()).toBeVisible()
  await expect(page.getByTestId('approval-version-restore-confirm')).toBeDisabled()
  expect(restoreRequests).toEqual([{ expectedLatestVersionId: 'ver-current' }])
  const errors = browserErrors.get(page) ?? []
  expect(errors.filter((message) => message.includes('status of 409 (Conflict)'))).toHaveLength(1)
  browserErrors.set(page, errors.filter((message) => !message.includes('status of 409 (Conflict)')))

  await page.getByTestId('approval-version-restore-acknowledge').click()
  await page.getByTestId('approval-version-restore-confirm').click()
  await expect.poll(() => restoreRequests).toEqual([
    { expectedLatestVersionId: 'ver-current' },
    { expectedLatestVersionId: 'ver-current-after-conflict' },
  ])
})

test('approval version workspace stacks without horizontal overflow at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockVersionWorkspaceApi(page)
  await page.goto(`${HARNESS}?mode=version`)
  await page.getByTestId('approval-template-version-workspace-button').click()
  await expect(page.getByTestId('approval-version-workspace')).toBeVisible()

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) throw new Error(`missing ${selector}`)
      const value = element.getBoundingClientRect()
      return { top: value.top, bottom: value.bottom, left: value.left, right: value.right }
    }
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      timeline: rect('.approval-version-workspace__timeline'),
      firstGraph: rect('.approval-version-graph'),
      secondGraph: rect('.approval-version-graph:nth-child(2)'),
      details: rect('.approval-version-workspace__details'),
    }
  })
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.timeline.right).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.secondGraph.top).toBeGreaterThanOrEqual(layout.firstGraph.bottom)
  expect(layout.details.top).toBeGreaterThanOrEqual(layout.secondGraph.bottom)
  await page.locator('.approval-version-workspace-dialog').screenshot({
    path: 'verification-output/approval-version-workspace-mobile.png',
  })
})
