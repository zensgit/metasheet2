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

  test('RA-03 不受分批拉取管辖的项目:没有横幅、没有核对,rail 上也没有计数(休眠)', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'puller', scenario: 'ready', projectNo: SYN_PROJECT_A })
    await expect(page.locator('[data-testid="stock-prep-project-board-title"]')).toBeVisible()
    await expect(page.locator('[data-testid="stock-prep-project-board-refresh-banner"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-project-sync-check"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="stock-prep-rail-count-refresh-queue"]')).toHaveCount(0)
    // The tab is there for a puller — and says 未启用 for this project.
    await page.locator('[data-testid="stock-prep-tab-refresh-queue"]').click()
    await expect(page.locator('[data-testid="stock-prep-refresh-queue"]')).toHaveAttribute('data-refresh-rendering', 'not_governed')
    expectNoUnmockedRoutes(log)
  })
})
