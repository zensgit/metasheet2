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
