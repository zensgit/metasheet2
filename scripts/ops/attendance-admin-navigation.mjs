export async function selectAttendanceAdminWorkspaceSection(page, sectionId, waitMs) {
  const workspace = page.locator('[data-admin-section-workspace="true"]').first()
  if (!(await workspace.isVisible())) {
    const taskAction = page.locator('button[data-admin-task-action]:visible').first()
    await taskAction.waitFor({ state: 'visible', timeout: waitMs })
    await taskAction.click()
    await workspace.waitFor({ state: 'visible', timeout: waitMs })
  }

  const quickJump = page.locator('[data-admin-quick-jump="true"]:visible').first()
  await quickJump.waitFor({ state: 'visible', timeout: waitMs })
  await quickJump.selectOption(sectionId)
}
