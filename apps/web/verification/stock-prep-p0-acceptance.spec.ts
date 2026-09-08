import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import {
  SYN_PROJECT_A,
  SYN_PROJECT_B,
  openStockPrepHarness,
  type StockPrepRouteLog,
} from './stock-prep-fixtures'

// ---------------------------------------------------------------------------
// 备料工作台 —— 设计稿 §6.1 的 P0 十一条验收,逐条,在真浏览器里。
//
// 每个 test 的名字就是验收条目的编号,一一对应,不合并也不改写。能在浏览器里证明的全在这里跑;
// 只能由 vitest / 源码断言覆盖的两条(P0-10 / P0-11)在文件末尾以源码读取的方式钉住,并在名字里
// 写明它是哪一种 —— 「浏览器证明不了」和「没人证明」必须能分开。
//
// 反空转:每条用例结束时 `log.unmocked` 必须为空。任何组件新长出来的读都会撞上夹具的 404
// `VERIFY_UNMOCKED_ROUTE`,变成这里的一条失败,而不是悄悄打到 Vite 的 /api 代理上。
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(HERE, '..')

/** `--ms-color-primary` as the token sheet resolves it — read from the page, never retyped here. */
async function primaryFillRgb(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = 'var(--ms-color-primary)'
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  })
}

/**
 * Every rendered `<button>` inside `root` whose RESOLVED background is the primary fill.
 *
 * `stopBeforeSelector` narrows the count to the DOM段 BEFORE that element. Document order, not
 * coordinates: a viewport-relative "above the fold" test would move with the browser window, while
 * 「工作区顶部」 is a structural place on this page (everything above 从 PLM 拉取).
 */
async function primaryFilledButtonCount(
  page: Page,
  rootSelector: string,
  stopBeforeSelector?: string,
): Promise<number> {
  const primary = await primaryFillRgb(page)
  return page.evaluate(({ rootSelector: root, stopBeforeSelector: stop, primary: fill }) => {
    const container = document.querySelector(root)
    if (!container) return -1
    const boundary = stop ? container.querySelector(stop) : null
    let count = 0
    for (const button of Array.from(container.querySelectorAll('button'))) {
      if (boundary) {
        const precedesBoundary = Boolean(
          boundary.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING,
        )
        if (!precedesBoundary) continue
      }
      const style = getComputedStyle(button)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      if (style.backgroundColor === fill) count += 1
    }
    return count
  }, { rootSelector, stopBeforeSelector, primary })
}

function expectNoUnmockedRoutes(log: StockPrepRouteLog): void {
  expect(log.unmocked, `夹具没有覆盖到的路由(说明组件长出了新的读):\n${log.unmocked.join('\n')}`).toEqual([])
}

// ---------------------------------------------------------------------------

test.describe('设计稿 §6.1 —— P0 验收', () => {
  test('P0-01 一线打开 /stock-prep,0 点击就看到「今天要处理」;目录为空时是 no_projects 的专门文案,不是「暂无数据」', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'operator', scenario: 'ready' })

    // 零点击:落地页就是 home,而且真的是任务首页的组件,不是别的 tab。
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'home')
    await expect(page.locator('[data-testid="stock-prep-operator-home"]')).toBeVisible()
    await expect(page.locator('[data-testid="stock-prep-operator-home-guidance"]')).toBeVisible()
    await expect(page.locator('[data-testid="stock-prep-operator-home-cards"]')).toBeVisible()
    expectNoUnmockedRoutes(log)

    // 目录为空 —— 同一个账号、同一条路径,只是这台部署里还没有他的项目。
    const emptyLog = await openStockPrepHarness(page, { actor: 'operator', scenario: 'noProjects' })
    const empty = page.locator('[data-testid="stock-prep-operator-home-empty"]')
    await expect(empty).toBeVisible()
    await expect(empty).toHaveAttribute('data-empty-state', 'no_projects')
    await expect(empty).toContainText('这里还没有您的项目')
    // 反向断言:通用兜底文案一个字都不许出现在这一屏上。
    await expect(page.locator('[data-testid="stock-prep-panel"]')).not.toContainText('暂无数据')
    expectNoUnmockedRoutes(emptyLog)
  })

  test('P0-02 从工作区进确认队列,输入框自动带上项目号;换一个项目号,队列跟着变', async ({ page }) => {
    const log = await openStockPrepHarness(page, {
      actor: 'operator',
      scenario: 'ready',
      projectNo: SYN_PROJECT_A,
    })

    // `?projectNo=` 深链落在工作区(而不是首页)—— 这是 §2.3 的状态位。
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'project-board')
    await expect(page.locator('[data-testid="stock-prep-project-board-status"]')).toBeVisible()

    await page.locator('[data-testid="stock-prep-project-board-goto-queue"]').click()
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'confirmation-queue')
    await expect(page.locator('[data-testid="stock-prep-confirmation-project-input"]')).toHaveValue(SYN_PROJECT_A)

    // 换一个号:回首页(清掉状态位)→ 用兜底输入框打开另一个项目 → 再进队列。
    await page.locator('[data-testid="stock-prep-tab-home"]').click()
    await expect(page.locator('[data-testid="stock-prep-operator-home"]')).toBeVisible()
    await page.locator('[data-testid="stock-prep-project-board-input"]').fill(SYN_PROJECT_B)
    await page.locator('[data-testid="stock-prep-project-board-open"]').click()
    await expect(page.locator('[data-testid="stock-prep-project-board-title"]')).toContainText(SYN_PROJECT_B)

    await page.locator('[data-testid="stock-prep-tab-confirmation-queue"]').click()
    await expect(page.locator('[data-testid="stock-prep-confirmation-project-input"]')).toHaveValue(SYN_PROJECT_B)
    expectNoUnmockedRoutes(log)
  })

  test('P0-03 工作区顶部 `--ms-color-primary` 填充的按钮 ≤ 1(按真实层叠数,不按类名数)', async ({ page }) => {
    const log = await openStockPrepHarness(page, {
      actor: 'operator',
      scenario: 'ready',
      projectNo: SYN_PROJECT_A,
    })
    await expect(page.locator('[data-testid="stock-prep-project-board-status"]')).toBeVisible()

    // 「顶部」有一个精确的 DOM 边界:从 PLM 拉取那一段(`…-board-pull`)以上。它以下是各自成段的面板,
    // 每段自己的主操作位由 G1 在那一段里各管各的 —— 这条断言说的是操作员一进来看到的那一屏。
    const top = await primaryFilledButtonCount(
      page,
      '[data-testid="stock-prep-project-board"]',
      '[data-testid="stock-prep-project-board-pull"]',
    )
    expect(top, '工作区顶部的主操作位数量').toBeLessThanOrEqual(1)
    expect(top, '顶部至少要有那一个「下一步」主按钮,否则这条断言是空的').toBe(1)
    expectNoUnmockedRoutes(log)
  })

  test('P0-04 队列的 ledger_missing 空态上有 [去装:开始使用],一击进向导', async ({ page }) => {
    // 平台管理员 + 未装完的部署。P1-1 的 D2 把这个账号的落地页移到了 开始使用,所以这里显式走到
    // 队列 —— 验收条说的是「落在空队列上的人有没有出路」,而出路就是这颗按钮。
    const log = await openStockPrepHarness(page, {
      actor: 'platform',
      scenario: 'fresh',
      tab: 'confirmation-queue',
    })
    await expect(page.locator('[data-testid="stock-prep-confirmation-queue"]')).toBeVisible()

    // 队列列表要按一次才读(这个视图的既有契约:onMounted 只读目录,不读队列)。
    await page.locator('[data-testid="stock-prep-confirmation-queue-refresh"]').click()
    const empty = page.locator('[data-testid="stock-prep-confirmation-empty"]')
    await expect(empty).toBeVisible()
    await expect(empty).toHaveAttribute('data-empty-state', 'ledger_missing')

    await page.locator('[data-testid="stock-prep-confirmation-empty-go-install"]').click()
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'getting-started')
    await expect(page.locator('[data-testid="stock-prep-getting-started"]')).toBeVisible()
    expectNoUnmockedRoutes(log)
  })

  test('P0-05 向导在没点任何按钮之前,就已经渲染出六步地图与九步计划的 held 解释', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'fresh' })

    // D2:未装完 → 落地页就是 开始使用。零点击。
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'getting-started')
    const map = page.locator('[data-testid="stock-prep-getting-started-map"]')
    await expect(map).toBeVisible()
    await expect(map.locator('[data-testid="stock-prep-getting-started-step"]')).toHaveCount(6)
    await expect(page.locator('[data-testid="stock-prep-getting-started-progress"]')).toContainText('/6')

    const plan = page.locator('[data-testid="stock-prep-getting-started-plan"]')
    await expect(plan).toContainText('九步')
    const held = page.locator('[data-testid="stock-prep-getting-started-plan-held-step"]')
    const heldCount = await held.count()
    expect(heldCount, '九步计划里「要人来做」的那几步').toBeGreaterThan(0)

    // 摘要说的 driven + held 必须真的是九,而且 held 的行数必须就是摘要里那个数 —— 否则这张卡是在
    // 用一句话描述另一份计划。
    const summary = await page.locator('[data-testid="stock-prep-getting-started-plan-summary"]').innerText()
    const driven = Number(/其中 (\d+) 步/.exec(summary)?.[1])
    const heldStated = Number(/剩下 (\d+) 步/.exec(summary)?.[1])
    expect(driven + heldStated, '摘要里的 driven + held').toBe(9)
    expect(heldCount, 'held 行数与摘要自洽').toBe(heldStated)

    for (let index = 0; index < heldCount; index += 1) {
      const explanation = held.nth(index).locator('[data-testid="stock-prep-getting-started-plan-held"]')
      await expect(explanation).not.toHaveText(/^\s*$/)
    }

    // 「没点任何按钮」不是形容词:这一屏没有发出过任何写请求。
    const writes = log.calls.filter((call) => call.method !== 'GET')
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([])
    expectNoUnmockedRoutes(log)
  })

  test('P0-06 env 类 blocker 没有「立即修复」只有复制;http 类旁边有「重复点是安全的」', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'fresh' })
    // 部署预检是手动读(D6 的同款纪律:不随页面自动跑),所以先按「只检查,先不装」。
    await page.locator('[data-testid="stock-prep-getting-started-check-preflight"]').click()

    const blockers = page.locator('[data-testid="stock-prep-getting-started-blocker"]')
    await expect(blockers).toHaveCount(2)

    const httpBlocker = page.locator('[data-testid="stock-prep-getting-started-blocker"][data-fix-kind="http"]')
    const envBlocker = page.locator('[data-testid="stock-prep-getting-started-blocker"][data-fix-kind="env"]')
    await expect(httpBlocker).toHaveCount(1)
    await expect(envBlocker).toHaveCount(1)

    // http:一句「重复点是安全的」,而且没有自己的修复按钮(那颗主操作位在卡片底部,只有一个)。
    await expect(httpBlocker.locator('[data-testid="stock-prep-getting-started-blocker-safe-note"]'))
      .toContainText('重复点是安全的')
    await expect(httpBlocker.locator('button')).toHaveCount(0)

    // env:一颗、且只有一颗按钮 —— 复制给运维。本页没有、也不应该有输入框。
    const envButtons = envBlocker.locator('button')
    await expect(envButtons).toHaveCount(1)
    await expect(envButtons).toHaveAttribute('data-testid', 'stock-prep-getting-started-blocker-copy')
    await expect(envBlocker).not.toContainText('立即修复')
    await expect(envBlocker.locator('input')).toHaveCount(0)
    expectNoUnmockedRoutes(log)
  })

  test('P0-07 地图不是闸机:no-go 状态下第⑥步仍可点,ledger-not-ready 状态下第④步仍可点', async ({ page }) => {
    const log = await openStockPrepHarness(page, {
      actor: 'platform',
      scenario: 'fresh',
      routes: { sourceVerdict: 'no-go' },
    })

    // ④ —— 预检回来带着 ledger-not-ready(http 类)这条 blocker,「开始安装」不因它而锁。
    await page.locator('[data-testid="stock-prep-getting-started-check-preflight"]').click()
    await expect(page.locator('[data-testid="stock-prep-getting-started-blocker"][data-fix-kind="http"]'))
      .toContainText('STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY')
    const runInstall = page.locator('[data-testid="stock-prep-getting-started-run-install"]')
    await expect(runInstall).toBeVisible()
    await expect(runInstall).toBeEnabled()

    // ⑥ —— 源预检判定 no-go,第⑥步照样可点。no-go 是一份诊断,不是一道闸门。
    await page.locator('[data-testid="stock-prep-getting-started-run-source-preflight"]').click()
    await expect(page.locator('[data-testid="stock-prep-getting-started-step"][data-step="source-verify"]'))
      .toHaveAttribute('data-badge', 'blocked')
    const goBoard = page.locator('[data-testid="stock-prep-getting-started-go-project-board"]')
    await expect(goBoard).toBeVisible()
    await expect(goBoard).toBeEnabled()
    expectNoUnmockedRoutes(log)
  })

  test('P0-08 错误渲染成两行 + 「复制这条报错」,而且复制出来的内容 values-free', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'defaults500' })

    const error = page.locator('[data-testid="stock-prep-install-error"]')
    await expect(error).toBeVisible()
    // 第一行:发生了什么 + HTTP 码。第二行:该做什么。
    await expect(error).toContainText('HTTP 500')
    await expect(page.locator('[data-testid="stock-prep-install-error-next"]')).toBeVisible()
    await expect(page.locator('[data-testid="stock-prep-install-error-next"]')).not.toHaveText(/^\s*$/)

    await page.locator('[data-testid="stock-prep-install-error-copy"]').click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain('HTTP_500')
    // values-free:合成夹具里每一个业务形状的串都不许出现在剪贴板里,连带主机/邮箱/IP 的形状。
    for (const forbidden of [SYN_PROJECT_A, SYN_PROJECT_B, '示例项目', 'SYN-PART', 'syn-source', 'syn-tenant']) {
      expect(copied, `复制内容里不得出现 ${forbidden}`).not.toContain(forbidden)
    }
    expect(copied).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    expect(copied).not.toMatch(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    expectNoUnmockedRoutes(log)
  })

  test('P0-09 对账成功后队列自动刷新,页面上没有「再手动点一次刷新」这句话', async ({ page }) => {
    const log = await openStockPrepHarness(page, {
      actor: 'platform',
      scenario: 'ready',
      tab: 'confirmation-queue',
    })
    await page.locator('[data-testid="stock-prep-confirmation-project-input"]').fill(SYN_PROJECT_A)
    await page.locator('[data-testid="stock-prep-confirmation-queue-refresh"]').click()
    await expect(page.locator('[data-testid="stock-prep-confirmation-counts"]')).toBeVisible()

    const before = log.count('GET', '/confirmation-decisions')
    expect(before, '第一次队列读').toBeGreaterThan(0)

    await page.locator('[data-testid="stock-prep-confirmation-reconcile"]').click()
    await expect(page.locator('[data-testid="stock-prep-admin-action-notice"]')).toBeVisible()

    // 动作 → 结果 → 自动重读。第二次 GET 是壳替操作员发的,不是人再点一次刷新。
    await expect
      .poll(() => log.count('GET', '/confirmation-decisions'), { message: '对账之后队列必须被自动重读一次' })
      .toBeGreaterThan(before)
    expect(log.count('POST', '/confirmation-decisions/reconcile')).toBe(1)

    await expect(page.locator('[data-testid="stock-prep-panel"]')).not.toContainText('再手动点一次刷新')
    expectNoUnmockedRoutes(log)
  })

  test('P0-10 [源码断言 · 浏览器证明不了] StockPreparationWorkspace.spec.ts 的 tab 计数四处与落地五处仍在,本 lane 一个字没动它', async () => {
    // 这条验收说的是「既有 jsdom 套件零改动且全绿」。跑那套是 vitest 的事(CI 的 web 单测 job),
    // 浏览器只能证明「它还在、而且它钉的还是那九处」—— 所以这里做的是源码断言,并且在用例名里
    // 写明了这一点,免得被读成「浏览器已经验过了」。
    const source = readFileSync(join(WEB_ROOT, 'tests', 'StockPreparationWorkspace.spec.ts'), 'utf8')
    const tabCountAssertions = source.match(
      /querySelectorAll\('\[data-testid\^="stock-prep-tab-"\]'\)\.length\)\.toBe\(\d+\)/g,
    ) ?? []
    expect(tabCountAssertions.length, 'tab 计数断言(F6 的四处)').toBeGreaterThanOrEqual(4)
    const landingAssertions = source.match(/data-active/g) ?? []
    expect(landingAssertions.length, '落地 data-active 断言(F6 的五处)').toBeGreaterThanOrEqual(5)
  })

  test('P0-11 [源码断言 · 浏览器证明不了] 备料域的 .vue 里没有未显式 import 的 el-*,且没有 steps/drawer/alert/tabs', async () => {
    const { readdirSync } = await import('node:fs')
    const dir = join(WEB_ROOT, 'src', 'components', 'integration', 'stockPreparation')
    const files = readdirSync(dir).filter((name) => name.endsWith('.vue'))
    expect(files.length, '备料组件数').toBeGreaterThan(10)

    const offenders: string[] = []
    for (const name of files) {
      const source = readFileSync(join(dir, name), 'utf8')
      const template = source.slice(0, source.indexOf('<script') >= 0 ? source.indexOf('<script') : source.length)
      for (const match of template.matchAll(/<(el-[a-z-]+)/g)) {
        const tag = match[1]
        // 只有显式 import 过的共享件才算数(G6);steps/drawer/alert/tabs 一律不通过。
        const pascal = `El${tag.slice(3).replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase())}`
        const banned = ['el-steps', 'el-step', 'el-drawer', 'el-alert', 'el-tabs', 'el-tab-pane']
        if (banned.includes(tag) || !new RegExp(`\\b${pascal}\\b`).test(source)) {
          offenders.push(`${name}: ${tag}`)
        }
      }
    }
    expect(offenders, `未显式 import 或明令禁止的 el-* 标签:\n${offenders.join('\n')}`).toEqual([])
  })
})
