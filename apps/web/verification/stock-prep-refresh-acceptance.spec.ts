import { expect, test } from '@playwright/test'
import {
  SYN_PROJECT_A,
  openStockPrepHarness,
  type StockPrepRouteLog,
} from './stock-prep-fixtures'

// ---------------------------------------------------------------------------
// 备料分批拉取第一期 step 4 PR-7 —— 「拉取待确认」与项目备料页的分批拉取横幅,在真浏览器里走一遍。
//
// jsdom 的 StockPreparationRefreshQueue.spec.ts 已经钉住了每个分支;这条 lane 证明的是真实组件 +
// 真实 apiFetch + 真实路由在一起时:拉取人员从 rail 进到「拉取待确认」,确认按钮要等两页对照都读过、
// 勾选历史不可查证、输入项目号之后才可用,确认之后页面说「必须重新试算」并把人送回项目备料页;
// 一线(没有 pull)看得到横幅却没有入口;不受分批拉取管辖的项目(`ready` 世界)页面与以前一样,没有横幅。
//
// 夹具世界全是合成的(SYN-PROJ-* / SYN-PART-*),每条用例都断言没有漏网的路由。
// ---------------------------------------------------------------------------

function expectNoUnmockedRoutes(log: StockPrepRouteLog): void {
  expect(log.unmocked, `夹具没有覆盖到的路由:\n${log.unmocked.join('\n')}`).toEqual([])
}

test.describe('备料分批拉取 step 4 PR-7 —— 拉取待确认', () => {
  test('RA-01 拉取人员:读完两页对照 + 勾选 + 输入项目号才可确认;确认后要求重新试算并回到项目备料', async ({ page }) => {
    const log = await openStockPrepHarness(page, {
      actor: 'puller',
      scenario: 'governed',
      tab: 'refresh-queue',
      projectNo: SYN_PROJECT_A,
    })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'refresh-queue')
    const queue = page.locator('[data-testid="stock-prep-refresh-queue"]')
    await expect(queue).toHaveAttribute('data-refresh-rendering', 'holds')
    await expect(page.locator('[data-testid="stock-prep-refresh-hold"]')).toHaveCount(2)
    // The rail count is the open project's holds, for a puller.
    await expect(page.locator('[data-testid="stock-prep-rail-count-refresh-queue"]')).toHaveText('2')

    const candidate = page.locator('[data-testid="stock-prep-refresh-hold"][data-hold-kind="continuation_candidate"]')
    await expect(candidate.locator('[data-testid="stock-prep-refresh-pages"]')).toContainText('已看 1 / 2 页')
    await candidate.locator('[data-testid="stock-prep-refresh-history-ack"] input').check()
    await candidate.locator('[data-testid="stock-prep-refresh-typed-project-no"]').fill(SYN_PROJECT_A)
    await expect(candidate.locator('[data-testid="stock-prep-refresh-confirm"]')).toBeDisabled()

    await candidate.locator('[data-testid="stock-prep-refresh-next-pair-page"]').click()
    await expect(candidate.locator('[data-testid="stock-prep-refresh-pages"]')).toContainText('已看 2 / 2 页')
    // The second read carried the receipt id the first one issued.
    expect(log.urls('/refresh/holds').some((url) => url.includes('receipt=') && url.includes('pairCursor=1'))).toBe(true)
    await expect(candidate.locator('[data-testid="stock-prep-refresh-confirm"]')).toBeEnabled()

    await candidate.locator('[data-testid="stock-prep-refresh-confirm"]').click()
    await expect(page.locator('[data-testid="stock-prep-refresh-preview-again"]')).toContainText('必须重新试算')
    expect(log.count('POST', '/refresh/continuations/confirm')).toBe(1)
    // No request of this page carries the workspace id (the routes' closed allow-lists would 400 it).
    for (const call of log.calls.filter((entry) => entry.path.includes('/refresh/'))) {
      expect(call.search, call.url).not.toContain('workspaceId')
    }

    await page.locator('[data-testid="stock-prep-refresh-go-preview"]').click()
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'project-board')
    expectNoUnmockedRoutes(log)
  })

  test('RA-02 项目备料页:拉取人员看见横幅和入口;一线只看见横幅', async ({ page }) => {
    let log = await openStockPrepHarness(page, { actor: 'puller', scenario: 'governed', projectNo: SYN_PROJECT_A })
    const banner = page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')
    await expect(banner).toContainText('本项目有 2 项待拉取人员确认')
    await expect(banner).toHaveAttribute('data-refresh-status', 'pending_confirmation')
    await page.locator('[data-testid="stock-prep-project-board-refresh-open-queue"]').click()
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'refresh-queue')
    expectNoUnmockedRoutes(log)

    log = await openStockPrepHarness(page, { actor: 'operator', scenario: 'governed', projectNo: SYN_PROJECT_A })
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')).toContainText('待拉取人员确认')
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-open-queue"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-tab-refresh-queue"]')).toHaveCount(0)
    expectNoUnmockedRoutes(log)
  })

  // 备料分批拉取第一期 step 5 PR-9 (R-77) —— 「变更计划」/「变更复核」 in the real browser.
  test('RA-04 拉取人员:内容变化指向「变更计划」;勾选 + 输入项目号才可确认;确认后要求重新试算并写入', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'puller', scenario: 'governedChangePlan', tab: 'refresh-queue', projectNo: SYN_PROJECT_A })
    const card = page.locator('[data-testid="stock-prep-refresh-hold"][data-hold-kind="content_change"]')
    await expect(card.locator('[data-testid="stock-prep-refresh-content-plan-pointer"]')).toContainText('变更计划')
    await expect(card.locator('[data-testid="stock-prep-refresh-go-change-plan"]')).toBeVisible()
    const plan = page.locator('[data-testid="stock-prep-refresh-change-plan-proposal"]')
    await expect(plan).toContainText('这次有 1 项内容变化')
    await expect(plan).toContainText('总用量')
    const confirm = plan.locator('[data-testid="stock-prep-refresh-change-plan-confirm"]')
    await expect(confirm).toBeDisabled()
    await plan.locator('[data-testid="stock-prep-refresh-change-plan-ack"] input').check()
    await expect(confirm).toBeDisabled()
    await plan.locator('[data-testid="stock-prep-refresh-change-plan-typed-project-no"]').fill(SYN_PROJECT_A)
    await expect(confirm).toBeEnabled()
    await confirm.click()
    const next = page.locator('[data-testid="stock-prep-refresh-preview-again"]')
    await expect(next).toContainText('变更计划')
    await expect(next).toContainText('必须重新试算')
    expect(log.count('POST', '/refresh/change-plans/confirm')).toBe(1)
    for (const call of log.calls.filter((entry) => entry.path.includes('/refresh/'))) {
      expect(call.search, call.url).not.toContain('workspaceId')
    }
    expectNoUnmockedRoutes(log)
  })

  test('RA-05 拉取人员:变更待复核 —— rail 计数 1、横幅入口;读完两页 + 结论 + 项目号才可复核;复核后回到项目备料要核对', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'puller', scenario: 'governedReview', projectNo: SYN_PROJECT_A })
    const banner = page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')
    await expect(banner).toHaveAttribute('data-refresh-status', 'change_pending_review')
    await expect(page.locator('[data-testid="stock-prep-rail-count-refresh-queue"]')).toHaveText('1')
    await page.locator('[data-testid="stock-prep-project-board-refresh-open-queue"]').click()
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'refresh-queue')
    await expect(page.locator('[data-testid="stock-prep-refresh-queue"]')).toHaveAttribute('data-refresh-rendering', 'review_pending')
    const review = page.locator('[data-testid="stock-prep-refresh-change-review"]')
    await expect(review).toContainText('这份变更计划是您确认的')
    const complete = review.locator('[data-testid="stock-prep-refresh-change-review-complete"]')
    await review.locator('[data-testid="stock-prep-refresh-change-review-conclusion-handled"] input').check()
    await review.locator('[data-testid="stock-prep-refresh-change-review-typed-project-no"]').fill(SYN_PROJECT_A)
    await expect(complete, 'page 2 of 2 not read yet').toBeDisabled()
    await review.locator('[data-testid="stock-prep-refresh-change-review-next"]').click()
    await expect(review.locator('[data-testid="stock-prep-refresh-change-review-pages"]')).toContainText('已看 2 / 2 页')
    await expect(complete).toBeEnabled()
    await complete.click()
    await expect(page.locator('[data-testid="stock-prep-refresh-preview-again"]')).toContainText('核对')
    expect(log.count('POST', '/refresh/change-reviews/complete')).toBe(1)
    await page.locator('[data-testid="stock-prep-refresh-go-preview"]').click()
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'project-board')
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')).toContainText('待核对')
    await expect(page.locator('[data-testid="stock-prep-project-sync-check"]')).toBeVisible()
    expectNoUnmockedRoutes(log)
  })

  test('RA-06 一线:变更待复核只有横幅,没有入口、没有 rail 计数、没有「拉取待确认」', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'operator', scenario: 'governedReview', projectNo: SYN_PROJECT_A })
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')).toContainText('变更待复核')
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-open-queue"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-rail-count-refresh-queue"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-tab-refresh-queue"]')).toHaveCount(0)
    expect(log.calls.some((call) => call.path.includes('/change-plans/') || call.path.includes('/change-reviews/'))).toBe(false)
    expectNoUnmockedRoutes(log)
  })

  // 备料分批拉取第一期 step 6a-3 (S6-3, R-91) —— 「拉取待确认」's recovery card in the real browser.
  test('RA-07 拉取人员:失败待恢复 —— 输入项目号才可核对;核对后才可结束;结束要求重新试算(批次开关关着:没有批次行)', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'puller', scenario: 'governedRecovery', tab: 'refresh-queue', projectNo: SYN_PROJECT_A })
    const queue = page.locator('[data-testid="stock-prep-refresh-queue"]')
    await expect(queue).toHaveAttribute('data-refresh-rendering', 'recovery_pending')
    const card = page.locator('[data-testid="stock-prep-refresh-recovery"]')
    await expect(card).toContainText('上次写入未完成')
    const execution = card.locator('[data-testid="stock-prep-refresh-recovery-execution"]')
    await expect(execution).toHaveCount(1)
    await expect(execution.locator('[data-testid="stock-prep-refresh-recover"]')).toBeDisabled()
    await expect(execution.locator('[data-testid="stock-prep-refresh-recovery-close"]')).toBeDisabled()
    // A puller never sees the admin's runbook close.
    await expect(card.locator('[data-testid="stock-prep-refresh-close-unverified"]')).toHaveCount(0)
    await execution.locator('[data-testid="stock-prep-refresh-recovery-typed-project-no"]').fill(SYN_PROJECT_A)
    await execution.locator('[data-testid="stock-prep-refresh-recover"]').click()
    await expect(execution.locator('[data-testid="stock-prep-refresh-recovery-report"]')).toHaveAttribute('data-result', 'mixed')
    await expect(execution.locator('[data-testid="stock-prep-refresh-recovery-counts"]')).toContainText('计划写 3 行')
    await expect(execution.locator('[data-testid="stock-prep-refresh-recovery-pending-entry"]')).toHaveCount(2)
    // N-SWITCH: the switch is off in this world — no batch line anywhere.
    await expect(card.locator('[data-testid="stock-prep-refresh-recovery-execution-batch"]')).toHaveCount(0)
    await expect(card.locator('[data-testid="stock-prep-refresh-recovery-report-batch"]')).toHaveCount(0)
    await expect(execution.locator('[data-testid="stock-prep-refresh-recovery-close"]')).toBeEnabled()
    await execution.locator('[data-testid="stock-prep-refresh-recovery-close"]').click()
    await expect(page.locator('[data-testid="stock-prep-refresh-preview-again"]')).toHaveAttribute('data-preview-again', 'recovered')
    await expect(page.locator('[data-testid="stock-prep-refresh-preview-again"]')).toContainText('请重新试算')
    await expect(card).toHaveCount(0)
    expect(log.count('POST', '/recover')).toBe(2)
    for (const call of log.calls.filter((entry) => entry.path.includes('/refresh/'))) {
      expect(call.search, call.url).not.toContain('workspaceId')
      expect(call.search, call.url).not.toContain('limit=')
    }
    expectNoUnmockedRoutes(log)
  })

  test('RA-08 失败待恢复:拉取人员的横幅带入口;一线只看见「等待拉取人员核对」,不读执行记录', async ({ page }) => {
    let log = await openStockPrepHarness(page, { actor: 'puller', scenario: 'governedRecovery', projectNo: SYN_PROJECT_A })
    const banner = page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')
    await expect(banner).toHaveAttribute('data-refresh-status', 'failed_pending_recovery')
    await expect(banner).toContainText('等待拉取人员核对')
    await page.locator('[data-testid="stock-prep-project-board-refresh-open-queue"]').click()
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'refresh-queue')
    await expect(page.locator('[data-testid="stock-prep-refresh-recovery"]')).toBeVisible()
    expectNoUnmockedRoutes(log)

    log = await openStockPrepHarness(page, { actor: 'operator', scenario: 'governedRecovery', projectNo: SYN_PROJECT_A })
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')).toContainText('等待拉取人员核对')
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-open-queue"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-tab-refresh-queue"]')).toHaveCount(0)
    expect(log.calls.some((call) => call.path.includes('/refresh/executions'))).toBe(false)
    expectNoUnmockedRoutes(log)
  })

  test('RA-03 不受分批拉取管辖的项目:没有横幅、没有核对,rail 上也没有计数(休眠)', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'puller', scenario: 'ready', projectNo: SYN_PROJECT_A })
    await expect(page.locator('[data-testid="stock-prep-project-board-title"]')).toBeVisible()
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-project-sync-check"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-rail-count-refresh-queue"]')).toHaveCount(0)
    // The tab is there for a puller — and says 未启用 for this project.
    await page.locator('[data-testid="stock-prep-tab-refresh-queue"]').click()
    await expect(page.locator('[data-testid="stock-prep-refresh-queue"]')).toHaveAttribute('data-refresh-rendering', 'not_governed')
    // PR-9 dormancy tripwire: a not-governed project never reads the change plan.
    expect(log.calls.some((call) => call.path.includes('/change-plans/') || call.path.includes('/change-reviews/'))).toBe(false)
    // S6-3 dormancy tripwire: a not-governed project never reads the (audited) executions list.
    expect(log.calls.some((call) => call.path.includes('/refresh/executions'))).toBe(false)
    expectNoUnmockedRoutes(log)
  })
})
