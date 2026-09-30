import { expect, test, type Locator, type Page } from '@playwright/test'

const HARNESS = '/verification/approval-member-action-dialog-harness.html'

async function openHarness(page: Page, width: number, height: number, query = ''): Promise<void> {
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
  await page.goto(`${HARNESS}${query}`)
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

test('a role-seated approver sees the process-evidence uploader in the 评论 dialog; without the server field the same viewer does not', async ({ page }) => {
  // The uploader is gated on the pipeline flag AND the server-resolved `canAttachProcessEvidence`.
  // The fixture's only seat is ROLE-typed, so the client-side mirror behind the 「等待你处理」 cue
  // is false — the cue's absence below is the proof this is not the old user-seat path.
  await page.route('**/api/approval/attachments/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ attachments: [] }),
  }))

  await openHarness(page, 1440, 960, '?scenario=role-seat-evidence')
  await expect(page.getByTestId('approval-my-turn-badge')).toHaveCount(0)

  const trigger = page.getByTestId('approval-comment-button')
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '添加评论' })
  await expect(dialog).toBeVisible()
  await expectDialogPaintedWithinViewport(page, 'approval-comment-dialog')
  await expect(page.getByTestId('approval-comment-attachment-upload')).toBeVisible()
  await expect(page.getByTestId('approval-comment-attachment-input')).toBeEnabled()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({
    path: 'verification-output/p5c-role-seat-evidence-uploader-1440.png',
    fullPage: false,
  })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Same viewer, same role seat, same flag — only the server's answer differs.
  await openHarness(page, 1440, 960, '?scenario=role-seat-evidence&evidence=denied')
  await expect(page.getByTestId('approval-my-turn-badge')).toHaveCount(0)
  await page.getByTestId('approval-comment-button').click()
  await expect(page.getByRole('dialog', { name: '添加评论' })).toBeVisible()
  await expect(page.getByTestId('approval-comment-submit')).toBeVisible()
  await expect(page.getByTestId('approval-comment-attachment-upload')).toHaveCount(0)
})

// F4-S1 (Lock-5 L5-B, OD-L5-4(b) + owner disposition (1)) — the 加签 dialog's 后加签 arm in a real
// browser: the default stays 并加签, the 后加签 arm states the same-node-new-round shape (never the
// corpus 「当前节点自动通过并流转到新增节点」), the payload carries `addSignMode:'after'`, and the
// server's round-incomplete 409 renders INLINE while the dialog stays open (not a policy denial).
// The refusal is mode-selected: switching back to 并加签 in the same dialog submits and closes it.
for (const viewport of [
  { label: 'desktop', width: 1440, height: 960 },
  { label: 'tablet', width: 1024, height: 768 },
] as const) {
  test(`F4-S1 后加签 in the add-sign dialog: honest copy, after-mode payload, inline round-incomplete refusal at ${viewport.label}`, async ({ page }) => {
    await openHarness(page, viewport.width, viewport.height, '?scenario=add-sign-after')

    const trigger = page.getByTestId('approval-add-sign-button')
    await trigger.click()
    const accessibleDialog = page.getByRole('dialog', { name: '加签' })
    await expect(accessibleDialog).toBeVisible()
    const dialog = page.getByTestId('approval-add-sign-dialog')

    const parallelArm = dialog.getByRole('radio', { name: '并加签' })
    const afterArm = dialog.getByRole('radio', { name: '后加签' })
    await expect(parallelArm).toBeChecked()
    await expect(afterArm).not.toBeChecked()
    await expect(page.getByTestId('approval-add-sign-mode-hint')).toBeVisible()
    await expect(page.getByTestId('approval-add-sign-after-hint')).toHaveCount(0)
    await expect(dialog).not.toContainText('前加签')

    // Element Plus paints the radio dot over the visually hidden native input, so a member (and
    // this test) selects an arm by clicking its visible label — the `el-radio` root carrying the
    // arm's testid — never the covered input itself.
    await dialog.getByTestId('approval-add-sign-placement-after').click()
    await expect(afterArm).toBeChecked()
    const afterHint = page.getByTestId('approval-add-sign-after-hint')
    await expect(afterHint).toBeVisible()
    await expect(afterHint).toContainText('同一节点上开始新一轮审批')
    await expect(afterHint).toContainText('不会插入新的审批节点')
    await expect(afterHint).toContainText('也不是「当前节点自动通过并流转到新增节点」')
    await expect(page.getByTestId('approval-add-sign-mode-hint')).toHaveCount(0)

    await selectFirstEnabledOption(page, dialog, '搜索并添加加签人')
    // One addee: the appended round needs no aggregation choice (OD-L5-5(a)).
    await expect(page.getByTestId('approval-add-sign-aggregation')).toHaveCount(0)
    await expectDialogPaintedWithinViewport(page, 'approval-add-sign-dialog')

    const confirm = page.getByTestId('approval-add-sign-submit')
    await expect(confirm).toBeEnabled()
    await confirm.click()

    const inlineError = dialog.getByTestId('approval-action-dialog-error')
    await expect(inlineError).toBeVisible()
    await expect(inlineError).toContainText('本节点还有其他审批人尚未表态，你的同意还不能完成本轮，暂不能后加签')
    await expect(inlineError).not.toContainText('请重试')
    await expect(accessibleDialog).toBeVisible()
    await expect(page.locator('.el-message--error')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({
      path: `verification-output/f4s1-add-sign-after-refused-${viewport.width}.png`,
      fullPage: false,
    })

    const afterRequests = await page.evaluate(() => window.__P5C_ACTION_REQUESTS__ ?? [])
    expect(afterRequests).toEqual([
      { id: 'apv_5', req: { action: 'add_sign', targetUserIds: ['user_target'], addSignMode: 'after' } },
    ])

    // Mode-selected: the same dialog, same addee, 并加签 → submitted and closed.
    await dialog.getByTestId('approval-add-sign-placement-parallel').click()
    await expect(parallelArm).toBeChecked()
    await expect(page.getByTestId('approval-add-sign-mode-hint')).toBeVisible()
    await confirm.click()
    await expect(accessibleDialog).toBeHidden()
    const allRequests = await page.evaluate(() => window.__P5C_ACTION_REQUESTS__ ?? [])
    expect(allRequests.at(-1)).toEqual(
      { id: 'apv_5', req: { action: 'add_sign', targetUserIds: ['user_target'], addSignMode: 'parallel' } },
    )
  })
}
