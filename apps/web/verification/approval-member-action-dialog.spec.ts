import { expect, test, type Locator, type Page } from '@playwright/test'

const HARNESS = '/verification/approval-member-action-dialog-harness.html'

async function openHarness(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.route('**/api/plugins', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plugins: [] }),
  }))
  await page.route('**/api/approvals/directory/resolve?**', (route) => {
    const ids = new URL(route.request().url()).searchParams.get('userIds')?.split(',') ?? []
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ users: ids.map((id) => ({ id, name: `姓名-${id}` })) }),
    })
  })
  await page.route('**/api/approvals/directory/users?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      users: [{ id: 'user_target', name: '目标审批人', email: 'target@example.test' }],
    }),
  }))
  await page.goto(HARNESS)
  await page.waitForFunction(() => window.__P5C_MEMBER_DIALOG_READY__ === true)
  await expect(page.getByTestId('approval-comment-button')).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function expectDialogPaintedWithinViewport(page: Page, testId: string): Promise<void> {
  await expect.poll(async () => {
    const viewport = page.viewportSize()
    const dialog = page.getByTestId(testId)
    const box = await dialog.boundingBox()
    if (!viewport || !box) return false

    const painted = await dialog.evaluate((node) => {
      let opacity = 1
      let element: Element | null = node
      while (element) {
        const style = window.getComputedStyle(element)
        if (style.display === 'none' || style.visibility !== 'visible') return false
        opacity *= Number(style.opacity || '1')
        element = element.parentElement
      }
      return opacity >= 0.99
    })

    return painted
      && box.x >= 0
      && box.y >= 0
      && box.x + box.width <= viewport.width
      && box.y + box.height <= viewport.height
  }).toBe(true)
}

async function selectFirstEnabledOption(page: Page, dialog: Locator, accessibleName: string): Promise<void> {
  const combobox = dialog.getByRole('combobox', { name: accessibleName })
  await combobox.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")]').click()
  const option = page.locator('.el-select-dropdown:visible [role="option"]:not(.is-disabled)').first()
  await expect(option).toBeVisible()
  await option.click()
  await expect(page.locator('.el-select-dropdown:visible')).toHaveCount(0)
}

async function expectFocusWrapsWithinDialog(page: Page, dialog: Locator): Promise<void> {
  const focusables = dialog.locator([
    'button:visible:not([disabled])',
    'input:visible:not([disabled])',
    'textarea:visible:not([disabled])',
    '[tabindex]:visible:not([tabindex="-1"])',
  ].join(', '))
  await expect.poll(() => focusables.count()).toBeGreaterThan(1)

  await focusables.last().focus()
  await page.keyboard.press('Tab')
  await expect.poll(() => dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true)

  await focusables.first().focus()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true)
}

async function completeRequiredDialogInput(page: Page, dialog: Locator, trigger: string): Promise<void> {
  switch (trigger) {
    case 'approval-reject-button':
      await dialog.getByRole('textbox', { name: '驳回原因（必填）' }).fill('需补充资料')
      return
    case 'approval-transfer-button':
      await selectFirstEnabledOption(page, dialog, '转交给')
      return
    case 'approval-add-sign-button':
      await selectFirstEnabledOption(page, dialog, '搜索并添加加签人')
      return
    case 'approval-reduce-sign-button':
      await selectFirstEnabledOption(page, dialog, '选择要移除的加签人')
      return
    case 'approval-return-button':
      await selectFirstEnabledOption(page, dialog, '选择退回目标节点')
      return
    case 'approval-comment-button':
      await dialog.getByRole('textbox', { name: '评论内容' }).fill('补充说明')
  }
}

const DESKTOP_DIALOGS = [
  {
    trigger: 'approval-approve-button',
    dialog: 'approval-action-dialog',
    name: '审批通过',
    confirm: 'approval-action-dialog-confirm',
    disabled: false,
  },
  {
    trigger: 'approval-reject-button',
    dialog: 'approval-action-dialog',
    name: '审批驳回',
    confirm: 'approval-action-dialog-confirm',
    disabled: true,
  },
  {
    trigger: 'approval-transfer-button',
    dialog: 'approval-transfer-dialog',
    name: '转交审批',
    confirm: 'approval-transfer-submit',
    disabled: true,
  },
  {
    trigger: 'approval-add-sign-button',
    dialog: 'approval-add-sign-dialog',
    name: '加签',
    confirm: 'approval-add-sign-submit',
    disabled: true,
  },
  {
    trigger: 'approval-reduce-sign-button',
    dialog: 'approval-reduce-sign-dialog',
    name: '减签',
    confirm: 'approval-reduce-sign-submit',
    disabled: true,
  },
  {
    trigger: 'approval-return-button',
    dialog: 'approval-return-dialog',
    name: '退回审批',
    confirm: 'approval-return-submit',
    disabled: true,
  },
  {
    trigger: 'approval-comment-button',
    dialog: 'approval-comment-dialog',
    name: '添加评论',
    confirm: 'approval-comment-submit',
    disabled: true,
  },
] as const

for (const viewport of [
  { label: 'desktop', width: 1440, height: 960 },
  { label: 'tablet', width: 1024, height: 768 },
] as const) {
  test(`P5-C member-action dialogs use the real accessible grammar at ${viewport.label}`, async ({ page }) => {
    await openHarness(page, viewport.width, viewport.height)

    for (const entry of DESKTOP_DIALOGS) {
      const trigger = page.getByTestId(entry.trigger)
      await expect(trigger).toBeVisible()
      await trigger.click()

      const dialog = page.getByTestId(entry.dialog)
      await expect(dialog).toBeVisible()
      const accessibleDialog = page.getByRole('dialog', { name: entry.name })
      await expect(accessibleDialog).toBeVisible()
      await expect(accessibleDialog).toHaveAttribute('aria-modal', 'true')
      await expectDialogPaintedWithinViewport(page, entry.dialog)
      const confirm = page.getByTestId(entry.confirm)
      if (entry.disabled) {
        await expect(confirm).toBeDisabled()
        await completeRequiredDialogInput(page, dialog, entry.trigger)
        await expect(confirm).toBeEnabled()
      } else {
        await expect(confirm).toBeEnabled()
      }

      await expectFocusWrapsWithinDialog(page, dialog)
      await confirm.focus()

      const focusInsideDialog = await page.evaluate((testId) => {
        const root = document.querySelector(`[data-testid="${testId}"]`)
        return !!root && root.contains(document.activeElement)
      }, entry.dialog)
      expect(focusInsideDialog).toBe(true)

      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
    }

    await expectNoHorizontalOverflow(page)
    const screenshotTrigger = page.getByTestId('approval-comment-button')
    await screenshotTrigger.click()
    await expect(page.getByRole('dialog', { name: '添加评论' })).toBeVisible()
    await expectDialogPaintedWithinViewport(page, 'approval-comment-dialog')
    await page.screenshot({
      path: `verification-output/p5c-member-dialog-${viewport.width}.png`,
      fullPage: false,
    })
    await page.keyboard.press('Escape')
    await expect(screenshotTrigger).toBeFocused()
  })
}

test('P5-C mobile keeps only supported actions and the action dialog stays inside the viewport', async ({ page }) => {
  await openHarness(page, 390, 844)

  for (const hiddenAction of [
    'approval-transfer-button',
    'approval-add-sign-button',
    'approval-reduce-sign-button',
    'approval-return-button',
  ]) {
    await expect(page.getByTestId(hiddenAction)).toBeHidden()
  }

  await expect(page.getByTestId('approval-approve-button')).toBeVisible()
  await expect(page.getByTestId('approval-reject-button')).toBeVisible()

  const approveTrigger = page.getByTestId('approval-approve-button')
  await approveTrigger.click()
  const approveDialog = page.getByRole('dialog', { name: '审批通过' })
  await expect(approveDialog).toBeVisible()
  await expectDialogPaintedWithinViewport(page, 'approval-action-dialog')
  const approveConfirm = page.getByTestId('approval-action-dialog-confirm')
  await expect(approveConfirm).toBeEnabled()
  await approveConfirm.focus()
  await page.keyboard.press('Escape')
  await expect(approveDialog).toBeHidden()
  await expect(approveTrigger).toBeFocused()

  await expectNoHorizontalOverflow(page)
})

test('P5-C mobile reject requires a reason and keeps modal focus inside the viewport', async ({ page }) => {
  await openHarness(page, 390, 844)

  const trigger = page.getByTestId('approval-reject-button')
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = page.getByTestId('approval-action-dialog')
  const accessibleDialog = page.getByRole('dialog', { name: '审批驳回' })
  await expect(accessibleDialog).toBeVisible()
  await expect(accessibleDialog).toHaveAttribute('aria-modal', 'true')
  await expectDialogPaintedWithinViewport(page, 'approval-action-dialog')

  const reason = dialog.getByRole('textbox', { name: '驳回原因（必填）' })
  const confirm = page.getByTestId('approval-action-dialog-confirm')
  await expect(reason).toBeFocused()
  await expect(confirm).toBeDisabled()
  await reason.fill('   ')
  await expect(confirm).toBeDisabled()
  await reason.fill('请补充移动端凭证')
  await expect(confirm).toBeEnabled()

  await expectFocusWrapsWithinDialog(page, dialog)
  await expectNoHorizontalOverflow(page)

  await page.keyboard.press('Escape')
  await expect(accessibleDialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('P5-C mobile comment dialog traps focus and restores its trigger', async ({ page }) => {
  await openHarness(page, 390, 844)

  const trigger = page.getByTestId('approval-comment-button')
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = page.getByRole('dialog', { name: '添加评论' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expectDialogPaintedWithinViewport(page, 'approval-comment-dialog')
  const textarea = dialog.getByRole('textbox', { name: '评论内容' })
  const confirm = page.getByTestId('approval-comment-submit')
  await expect(textarea).toBeVisible()
  await expect(confirm).toBeDisabled()
  await textarea.fill('   ')
  await expect(confirm).toBeDisabled()
  await textarea.fill('移动端评论')
  await expect(confirm).toBeEnabled()

  await expectFocusWrapsWithinDialog(page, dialog)

  await expectNoHorizontalOverflow(page)
  await page.screenshot({
    path: 'verification-output/p5c-member-dialog-390.png',
    fullPage: false,
  })

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})
