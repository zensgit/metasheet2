import { expect, test, type Locator, type Page } from '@playwright/test'

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

async function expectTouchTargetsAtLeast(locator: Locator, size: number): Promise<void> {
  expect(await locator.count()).toBeGreaterThan(0)
  for (const target of await locator.all()) {
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(size - 0.001)
    expect(box!.height).toBeGreaterThanOrEqual(size - 0.001)
  }
}

async function contrastRatio(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((element) => {
    type Rgba = [number, number, number, number]
    const parseColor = (value: string): Rgba => {
      if (value === 'transparent') return [0, 0, 0, 0]
      const channels = value.match(/[\d.]+/g)?.map(Number)
      if (!channels || channels.length < 3) throw new Error(`unsupported color ${value}`)
      return [channels[0], channels[1], channels[2], channels[3] ?? 1]
    }
    const composite = (front: Rgba, back: Rgba): Rgba => {
      const alpha = front[3] + back[3] * (1 - front[3])
      if (alpha === 0) return [0, 0, 0, 0]
      return [
        (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
        (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
        (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
        alpha,
      ]
    }
    const luminance = (color: Rgba) => {
      const channels = color.slice(0, 3).map((channel) => {
        const normalized = channel / 255
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }

    const styles = window.getComputedStyle(element)
    let background = parseColor(styles.backgroundColor)
    let ancestor = element.parentElement
    while (background[3] < 1 && ancestor) {
      background = composite(background, parseColor(window.getComputedStyle(ancestor).backgroundColor))
      ancestor = ancestor.parentElement
    }
    if (background[3] < 1) background = composite(background, [255, 255, 255, 1])
    const foreground = luminance(composite(parseColor(styles.color), background))
    const backgroundLuminance = luminance(background)
    return (Math.max(foreground, backgroundLuminance) + 0.05)
      / (Math.min(foreground, backgroundLuminance) + 0.05)
  })
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

async function mockVersionWorkspaceApi(
  page: Page,
  formFields: Array<Record<string, unknown>> = [
    { id: 'secret_amount_id', type: 'number', label: '报销金额', required: true },
  ],
) {
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
    formSchema: { fields: formFields },
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

  await expect(page.getByTestId('approval-field-visibility-depends')).toContainText('无（始终显示）')
  const paletteLabelsFit = await page.locator('.approval-form-palette__item span').evaluateAll((elements) =>
    elements.every((element) => element.scrollWidth <= element.clientWidth),
  )
  expect(paletteLabelsFit).toBe(true)

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

  await page.mouse.move(0, 0)
  await expect(page.locator('.el-popper[role="tooltip"]:visible')).toHaveCount(0)
  const headerSeparation = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.template-authoring__header')
    const hint = document.querySelector<HTMLElement>('.approval-form-builder__header small')
    if (!header || !hint) throw new Error('missing sticky header or form-builder hint')
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      hintTop: hint.getBoundingClientRect().top,
    }
  })
  expect(headerSeparation.hintTop).toBeGreaterThanOrEqual(headerSeparation.headerBottom)

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

test('approval route preview runs through the production wrapper and highlights the saved canvas path', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockVersionWorkspaceApi(page)
  let previewRequest: unknown = null
  await page.route('**/api/approval-templates/tpl-browser/route-preview', async (route) => {
    previewRequest = route.request().postDataJSON()
    await route.fulfill({
      json: {
        route: [
          { nodeKey: 'secret_approval_one', nodeLabel: 'secret_approval_one', assignees: [{ id: 'secret_user_id', name: '张三', assignmentType: 'user' }] },
          { nodeKey: 'secret_approval_two', nodeLabel: 'secret_approval_two', assignees: [{ id: 'secret_missing_user', name: 'secret_missing_user', assignmentType: 'user' }] },
          { nodeKey: 'secret_approval_three', nodeLabel: 'secret_approval_three', assignees: [], resolveError: 'EMPTY_ASSIGNEES' },
        ],
        truncated: false,
      },
    })
  })

  await page.goto(`${HARNESS}?mode=route-preview`)
  const previewToggle = page.getByTestId('approval-template-route-preview-toggle')
  await previewToggle.focus()
  await previewToggle.press('Enter')
  await expect(page.getByTestId('approval-canvas-route-preview-panel')).toBeVisible()
  await expect(page.getByTestId('approval-canvas-route-preview-heading')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('approval-canvas-route-preview-panel')).toHaveCount(0)
  await expect(previewToggle).toBeFocused()

  await previewToggle.click()
  await page.getByTestId('approval-canvas-route-preview-panel').getByRole('spinbutton').fill('1200')
  await page.getByTestId('approval-template-tryrun-button').click()

  await expect.poll(() => previewRequest).toEqual({
    sampleFormData: { secret_amount_id: 1200 },
    expectedLatestVersionId: 'ver-current',
  })
  await expect(page.locator('[data-route-preview="matched"][data-canvas-node]')).toHaveCount(6)
  await expect(page.locator('[data-route-preview="matched"][data-testid="approval-canvas-edge"]')).toHaveCount(5)
  await expect(page.getByTestId('approval-canvas-route-preview-tag')).toHaveCount(6)
  await expect(page.getByTestId('approval-template-tryrun-result')).toContainText('张三')
  await expect(page.getByTestId('approval-template-tryrun-result')).toContainText('成员信息待确认')
  await expect(page.getByTestId('approval-template-tryrun-result')).toContainText('审批人待定')
  const visibleText = await page.getByTestId('approval-canvas-route-preview-panel').textContent()
  expect(visibleText).not.toContain('secret_')

  await page.screenshot({
    path: 'verification-output/approval-route-preview-canvas.png',
    fullPage: true,
  })

  await page.getByTestId('approval-canvas-route-preview-close').click()
  await expect(page.getByTestId('approval-canvas-route-preview-panel')).toHaveCount(0)
  await expect(page.locator('[data-route-preview="matched"]')).toHaveCount(0)
})

test('approval route preview remains operable without horizontal overflow at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockVersionWorkspaceApi(page, [
    { id: 'secret_amount_id', type: 'number', label: '报销金额', required: true },
    { id: 'secret_reason_id', type: 'textarea', label: '报销说明' },
    {
      id: 'secret_kind_id',
      type: 'select',
      label: '报销类型',
      options: [{ label: '普通', value: 'normal' }],
    },
    {
      id: 'secret_hidden_id',
      type: 'text',
      label: '条件备注',
      visibilityRule: { fieldId: 'secret_kind_id', operator: 'eq', value: 'show' },
    },
  ])
  await page.route('**/api/approval-templates/tpl-browser/route-preview', async (route) => {
    await route.fulfill({
      json: {
        route: [
          { nodeKey: 'secret_approval_one', nodeLabel: 'secret_approval_one', assignees: [{ id: 'user-1', name: '张三', assignmentType: 'user' }] },
          { nodeKey: 'secret_approval_two', nodeLabel: 'secret_approval_two', assignees: [{ id: 'user-2', name: '李四', assignmentType: 'user' }] },
          { nodeKey: 'secret_approval_three', nodeLabel: 'secret_approval_three', assignees: [{ id: 'user-3', name: '王五', assignmentType: 'user' }] },
        ],
        truncated: false,
      },
    })
  })

  await page.goto(`${HARNESS}?mode=route-preview`)
  const headerActionIds = [
    'approval-template-undo',
    'approval-template-redo',
    'approval-template-route-preview-toggle',
    'approval-template-version-workspace-button',
    'approval-template-save-button',
    'approval-template-publish-button',
  ]
  for (const testId of headerActionIds) {
    const box = await page.getByTestId(testId).boundingBox()
    expect(box, `${testId} must render`).not.toBeNull()
    expect(box!.x, `${testId} left edge`).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width, `${testId} right edge`).toBeLessThanOrEqual(390)
  }
  const toggle = page.getByTestId('approval-template-route-preview-toggle')
  await toggle.click()
  const canvasToolbar = page.getByRole('toolbar', { name: '画布视图' })
  await expect(canvasToolbar).toBeVisible()
  for (const button of await canvasToolbar.getByRole('button').all()) {
    const box = await button.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
  const nodeActionButtons = page.locator('.template-authoring__canvas-node-actions .el-button')
  expect(await nodeActionButtons.count()).toBeGreaterThan(0)
  for (const button of await nodeActionButtons.all()) {
    const box = await button.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(40)
    expect(box?.height).toBeGreaterThanOrEqual(40)
  }
  const canvasNodeBoxes = await page.getByTestId('approval-canvas-node').evaluateAll((nodes) => nodes
    .map((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    })
    .sort((left, right) => left.top - right.top))
  for (let index = 1; index < canvasNodeBoxes.length; index += 1) {
    expect(canvasNodeBoxes[index].top).toBeGreaterThanOrEqual(canvasNodeBoxes[index - 1].bottom)
  }
  const panel = page.getByTestId('approval-canvas-route-preview-panel')
  await expect(panel).toBeVisible()
  await expectTouchTargetsAtLeast(page.locator('[data-testid="approval-canvas-route-preview-close"]:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-button:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-input__wrapper:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-select__wrapper:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-input-number:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-input-number__decrease:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-input-number__increase:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-textarea__inner:visible'), 44)
  await expectTouchTargetsAtLeast(panel.locator('.el-collapse-item__header:visible'), 44)
  await panel.getByRole('spinbutton').fill('1200')
  await page.getByTestId('approval-template-tryrun-button').click()
  await expect(page.getByTestId('approval-template-tryrun-result')).toContainText('张三')

  const layout = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="approval-canvas-route-preview-panel"]')
    const canvas = document.querySelector<HTMLElement>('[data-testid="approval-canvas-viewport"]')
    if (!panel || !canvas) throw new Error('missing route-preview mobile surface')
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      panel: panel.getBoundingClientRect().toJSON(),
      canvas: canvas.getBoundingClientRect().toJSON(),
    }
  })
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.panel.right).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.panel.top).toBeGreaterThanOrEqual(layout.canvas.bottom)

  await panel.scrollIntoViewIfNeeded()
  const navigationOverlap = await page.evaluate(() => {
    const steps = document.querySelector<HTMLElement>('.template-authoring__steps')
    const canvas = document.querySelector<HTMLElement>('[data-testid="approval-canvas-viewport"]')
    if (!steps || !canvas) throw new Error('missing authoring navigation or canvas')
    const a = steps.getBoundingClientRect()
    const b = canvas.getBoundingClientRect()
    const intersects = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    return { position: getComputedStyle(steps).position, intersects }
  })
  expect(navigationOverlap.position).toBe('static')
  expect(navigationOverlap.intersects).toBe(false)

  await page.screenshot({
    path: 'verification-output/approval-route-preview-mobile.png',
    fullPage: true,
  })

  await page.getByTestId('approval-canvas-route-preview-close').click()
  await expect(panel).toHaveCount(0)
  await expect(toggle).toBeFocused()
})

test('approval designer remains contained at tablet and compact desktop viewports', async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport)
    await openFormDesigner(page)
    const paletteGeometry = await page.locator('.approval-form-palette__item').evaluateAll((items) => items.map((item) => {
      const label = item.querySelector('span')
      return {
        itemWidth: item.getBoundingClientRect().width,
        labelFits: Boolean(label && label.scrollWidth <= label.clientWidth),
      }
    }))
    expect(paletteGeometry.every(({ itemWidth, labelFits }) => itemWidth >= 80 && labelFits)).toBe(true)
    await page.getByRole('button', { name: '流程设计' }).click()
    await expect(page.getByTestId('approval-authoring-mode-flow')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => contrastRatio(page, '[data-testid="approval-authoring-mode-flow"]')).toBeGreaterThanOrEqual(4.5)

    const geometry = await page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>('[data-testid="approval-template-workspace-content"]')
      const canvas = document.querySelector<HTMLElement>('[data-testid="approval-canvas-workspace"]')
      const toolbar = document.querySelector<HTMLElement>('[data-testid="approval-canvas-toolbar"]')
      const actions = document.querySelector<HTMLElement>('.template-authoring__section-actions')
      if (!workspace || !canvas || !toolbar || !actions) throw new Error('missing designer surface')
      return {
        bodyWidth: document.body.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        workspaceRight: workspace.getBoundingClientRect().right,
        canvasRight: canvas.getBoundingClientRect().right,
        canvasBottom: canvas.getBoundingClientRect().bottom,
        toolbarRight: toolbar.getBoundingClientRect().right,
        actionsTop: actions.getBoundingClientRect().top,
      }
    })
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.workspaceRight).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.canvasRight).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.toolbarRight).toBeLessThanOrEqual(geometry.viewportWidth)
    if (viewport.width === 1024) expect(geometry.actionsTop).toBeGreaterThanOrEqual(geometry.canvasBottom)
  }

  await page.screenshot({
    path: 'verification-output/approval-designer-tablet.png',
    fullPage: true,
  })
})

test('authoring navigation never scrolls content beneath a dynamic header', async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1024, height: 800 },
    { width: 900, height: 800 },
    { width: 800, height: 800 },
    { width: 761, height: 800 },
  ]) {
    await page.setViewportSize(viewport)
    await openFormDesigner(page)
    await expect.poll(() => page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.template-authoring__header')
      const hint = document.querySelector<HTMLElement>('.approval-form-builder__header small')
      if (!header || !hint) throw new Error('missing header or form-builder hint')
      return hint.getBoundingClientRect().top >= header.getBoundingClientRect().bottom
    })).toBe(true)
    if (viewport.width <= 1024) {
      const navigation = await page.evaluate(() => {
        const steps = document.querySelector<HTMLElement>('.template-authoring__steps')
        const modeSwitch = document.querySelector<HTMLElement>('.template-authoring__mode-switch')
        if (!steps || !modeSwitch) throw new Error('missing steps or authoring mode switch')
        const a = steps.getBoundingClientRect()
        const b = modeSwitch.getBoundingClientRect()
        return {
          position: getComputedStyle(steps).position,
          intersects: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
        }
      })
      expect(navigation.position).toBe('static')
      expect(navigation.intersects).toBe(false)
    }
  }
})

test('mobile canvas move and branch inspector controls meet the touch contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFormDesigner(page)
  await page.getByRole('button', { name: '流程设计' }).click()

  await page.getByRole('button', { name: '在「审批人 1」之后插入节点' }).click()
  await page.getByRole('menuitem', { name: '审批' }).click()
  const moveButton = page.locator(
    '[data-testid^="approval-canvas-move-"]:not([data-testid^="approval-canvas-move-up-"]):not([data-testid^="approval-canvas-move-down-"])',
  ).first()
  await moveButton.click()
  const moveTargets = page.locator('[data-testid^="approval-canvas-move-target-"]')
  expect(await moveTargets.count()).toBeGreaterThan(0)
  for (const target of await moveTargets.all()) {
    const box = await target.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(40)
    expect(box?.height).toBeGreaterThanOrEqual(40)
  }
  await moveButton.click()

  await page.getByRole('button', { name: '在「审批人 1」之后插入节点' }).click()
  await page.getByRole('menuitem', { name: '条件分支' }).click()
  await page.getByTestId(/approval-canvas-add-condition-/).click()
  await expect(page.getByTestId('approval-canvas-branch-reorder')).toBeVisible()

  const bottomSheetControls = page.locator(
    '.template-authoring__canvas-branch-handle, .template-authoring__canvas-branch-actions .el-button, .template-authoring__canvas-inspector-body .el-button',
  )
  await expectTouchTargetsAtLeast(bottomSheetControls, 44)
  const inspector = page.getByTestId('approval-canvas-inspector')
  await expectTouchTargetsAtLeast(inspector.locator('.el-input__wrapper:visible'), 44)
  await expectTouchTargetsAtLeast(inspector.locator('.el-select__wrapper:visible'), 44)

  await page.getByTestId('approval-condition-predicate-mode').first().click()
  await page.getByRole('option', { name: '公式', exact: true }).click()
  await expectTouchTargetsAtLeast(inspector.locator('.el-textarea__inner:visible'), 44)

  await page.getByTestId('approval-canvas-node').filter({ hasText: '审批人 1' }).first().click()
  await expect(page.getByTestId('approval-node-editor')).toBeVisible()
  await page.getByTestId('approval-node-source-kind').click()
  await page.getByRole('option', { name: '指定层级上级', exact: true }).click()
  await expectTouchTargetsAtLeast(inspector.locator('.el-checkbox:visible'), 44)
  await expectTouchTargetsAtLeast(inspector.locator('.el-input-number:visible'), 44)
  await expectTouchTargetsAtLeast(inspector.locator('.el-input-number__decrease:visible'), 44)
  await expectTouchTargetsAtLeast(inspector.locator('.el-input-number__increase:visible'), 44)
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
  const closeButton = page.locator('.approval-version-workspace-dialog .el-dialog__headerbtn')
  const closeBox = await closeButton.boundingBox()
  // Chromium can report a CSS 44px target as 43.999999px after device-scale conversion.
  expect(closeBox?.width).toBeGreaterThanOrEqual(44 - 0.001)
  expect(closeBox?.height).toBeGreaterThanOrEqual(44 - 0.001)
  const versionDate = page.getByTestId('approval-version-timeline-date')
  await expect(versionDate).toBeVisible()
  expect(await versionDate.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const timelineCardsFit = await page.locator(
    '[data-testid="approval-version-current-draft"], [data-testid^="approval-version-timeline-"]',
  ).evaluateAll((elements) => elements.every((element) => {
    const rect = element.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= document.documentElement.clientWidth
  }))
  expect(timelineCardsFit).toBe(true)

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
