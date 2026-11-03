export async function selectAttendanceAdminWorkspaceSection(page, sectionId, waitMs) {
  const workspace = page.locator('[data-admin-section-workspace="true"]').first()
  if (!(await workspace.isVisible())) {
    const taskAction = page.locator('button[data-admin-task-action]:visible').first()
    await taskAction.waitFor({ state: 'visible', timeout: waitMs })
    await taskAction.click()
    await workspace.waitFor({ state: 'visible', timeout: waitMs })
  }

  const quickJump = page.locator('[data-admin-quick-jump="true"]:visible').first()
  if (await quickJump.isVisible()) {
    await quickJump.waitFor({ state: 'visible', timeout: waitMs })
    await quickJump.selectOption(sectionId)
    return
  }

  const compactToggle = page.locator('.attendance__admin-nav-toggle[aria-expanded="false"]').first()
  if (await compactToggle.isVisible()) await compactToggle.click()
  await page.locator('.attendance__admin-nav').first().waitFor({ state: 'visible', timeout: waitMs })

  const anchor = page.locator(`button[data-admin-anchor="${sectionId}"]`).first()
  if (!(await anchor.isVisible())) {
    const groups = await page.locator('.attendance__admin-nav-group-header').all()
    for (const group of groups) {
      if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    }
  }
  await anchor.waitFor({ state: 'visible', timeout: waitMs })
  await anchor.click()
}
