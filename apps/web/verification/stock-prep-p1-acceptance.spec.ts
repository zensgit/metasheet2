import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import {
  SYN_PROJECT_A,
  openStockPrepHarness,
  type StockPrepRouteLog,
} from './stock-prep-fixtures'

// ---------------------------------------------------------------------------
// 备料工作台 —— 设计稿 §6.2 的 P1 七条验收,加上两条 jsdom 天生看不见的回归。
//
// 这条 lane 存在的理由,一句话:jsdom 不跑层叠。它读得到 `hidden` 属性,却不知道那条属性有没有被
// 组件自己的 `display: flex` 盖掉;它读得到 class 名,却不知道 `--ms-color-primary` 解析成了什么。
// 下面凡是用 `getComputedStyle` 的断言,都是只有真浏览器能回答的那一类;其余几条是把「不切 tab」
// 「三行免责常驻」这种流程事实钉在真实网络时序上。
//
// 落地三态 + 深链一态在文件末尾单列 —— D2 的裁决是这条 lane 里最容易被一次改动悄悄推翻的东西。
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

const LEGACY_TAB_KEYS = [
  'dashboard',
  'project-workspace',
  'bom-snapshot-diff',
  'material-mapping',
  'unit-conversion',
  'prep-line',
  'exception-queue',
] as const

function expectNoUnmockedRoutes(log: StockPrepRouteLog): void {
  expect(log.unmocked, `夹具没有覆盖到的路由:\n${log.unmocked.join('\n')}`).toEqual([])
}

/** The token sheet's resolved value for one `--ms-*` colour, read from the live document. */
async function tokenRgb(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, token)
}

// ---------------------------------------------------------------------------

test.describe('设计稿 §6.2 —— P1 验收', () => {
  test('P1-01 rail 仍是一个 tablist、条目 testid 原名、三组齐全,深度工具默认收起(display:none 且不在 Tab 序)', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'ready' })

    const rail = page.locator('[data-testid="stock-prep-tabs"]')
    await expect(rail).toHaveAttribute('role', 'tablist')
    await expect(rail).toHaveAttribute('aria-orientation', 'vertical')

    // 三组,一个不少。组标题不是 tab —— 它没有 role="tab",也没有 stock-prep-tab-* 名字。
    for (const group of ['work', 'deploy', 'help']) {
      await expect(page.locator(`[data-testid="stock-prep-rail-group-${group}"]`)).toHaveCount(1)
      await expect(page.locator(`[data-testid="stock-prep-rail-group-title-${group}"]`)).toBeVisible()
      await expect(page.locator(`[data-testid="stock-prep-rail-group-title-${group}"]`))
        .not.toHaveAttribute('role', 'tab')
    }

    // 条目 testid 原名 + role="tab"。平台管理员看得到全部 14 项(7 常驻 + 7 折叠)。
    await expect(rail.locator('[data-testid^="stock-prep-tab-"]')).toHaveCount(14)
    for (const key of ['home', 'project-board', 'confirmation-queue', 'getting-started', 'install', 'ops', 'help']) {
      await expect(rail.locator(`[data-testid="stock-prep-tab-${key}"]`)).toHaveAttribute('role', 'tab')
    }

    // ---- 这条只有真浏览器能答:`hidden` 的全部效力来自 UA 的 `[hidden]{display:none}`,而面板自己
    //      的 `.sp-rail__advanced-panel{display:flex}` 是作者来源、还带 scope 属性,两项都赢它。仓库里
    //      也没有任何全局 `[hidden]` 兜底。所以「默认收起」成不成立,只能问层叠。
    const panel = page.locator('[data-testid="stock-prep-rail-advanced-panel"]')
    await expect(panel).toHaveAttribute('hidden', '')
    const collapsedDisplay = await panel.evaluate((el) => getComputedStyle(el).display)
    expect(collapsedDisplay, '深度工具面板收起时的 computed display').toBe('none')

    // ...而且折叠里的 tab 真的退出了 Tab 序:display:none 的元素 focus() 是空操作。
    const focusable = await page.evaluate((keys) => keys.map((key) => {
      const el = document.querySelector(`[data-testid="stock-prep-tab-${key}"]`) as HTMLElement | null
      if (!el) return 'missing'
      el.focus()
      return document.activeElement === el ? 'focusable' : 'not-focusable'
    }), [...LEGACY_TAB_KEYS])
    expect(focusable, '折叠里的七个 legacy tab 都不在 Tab 序里').toEqual(
      LEGACY_TAB_KEYS.map(() => 'not-focusable'),
    )

    // 正向对照(防止上面那条因为「元素根本不存在」而空转):展开之后它们立刻可聚焦、可见。
    await page.locator('[data-testid="stock-prep-rail-advanced-toggle"]').click()
    await expect(panel).not.toHaveAttribute('hidden', '')
    expect(await panel.evaluate((el) => getComputedStyle(el).display)).toBe('flex')
    const focusableAfter = await page.evaluate((keys) => keys.map((key) => {
      const el = document.querySelector(`[data-testid="stock-prep-tab-${key}"]`) as HTMLElement | null
      if (!el) return 'missing'
      el.focus()
      return document.activeElement === el ? 'focusable' : 'not-focusable'
    }), [...LEGACY_TAB_KEYS])
    expect(focusableAfter).toEqual(LEGACY_TAB_KEYS.map(() => 'focusable'))
    expectNoUnmockedRoutes(log)
  })

  test('P1-02 [源码断言 · 浏览器证明不了] workbenchAccess.ts 与插件侧镜像文件同时在位,rail 清单两边同名', async () => {
    // 这条验收说的是「两边同改、权限矩阵套件全绿」,判定它的是 stockPrepPermissionMatrix.spec.ts
    // (vitest,F-01 逐字段钉死)。浏览器能做的只有一件事:确认那个镜像还在、还是同一份清单,
    // 免得镜像被删掉之后矩阵套件变成一个自己跟自己比的空转。
    const web = join(REPO_ROOT, 'apps', 'web', 'src', 'services', 'integration', 'stockPreparation', 'workbenchAccess.ts')
    const plugin = join(REPO_ROOT, 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-workbench-access.cjs')
    expect(existsSync(web), 'workbenchAccess.ts').toBe(true)
    expect(existsSync(plugin), '插件侧镜像 stock-preparation-workbench-access.cjs').toBe(true)

    const webSource = readFileSync(web, 'utf8')
    const pluginSource = readFileSync(plugin, 'utf8')
    for (const key of ['home', 'project-board', 'confirmation-queue', 'getting-started', 'install', 'ops', 'help']) {
      expect(webSource, `web 侧 rail 清单缺 ${key}`).toContain(`'${key}'`)
      expect(pluginSource, `插件侧 rail 清单缺 ${key}`).toContain(`'${key}'`)
    }
    expect(pluginSource).toContain('STOCK_PREP_RAIL_GROUPS')
  })

  test('P1-03 就地确认之后,不切 tab 就能看到「回到上面再同步一次」', async ({ page }) => {
    const log = await openStockPrepHarness(page, {
      actor: 'operator',
      scenario: 'ready',
      projectNo: SYN_PROJECT_A,
    })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'project-board')

    // 面板 2 默认收起(线框 C 的原话),展开之后才在这一页上就地处理。
    const panel = page.locator('[data-testid="stock-prep-project-board-confirm-panel"]')
    await expect(panel).toBeVisible()
    await panel.locator('[data-testid="stock-prep-project-board-confirm-toggle"]').click()

    const embeddedQueue = panel.locator('[data-testid="stock-prep-confirmation-queue"]')
    await expect(embeddedQueue).toBeVisible()
    // embedded 模式下没有第二个项目号输入框 —— 号是宿主给的。
    await expect(embeddedQueue.locator('[data-testid="stock-prep-confirmation-project-input"]')).toHaveCount(0)

    await embeddedQueue.locator('[data-testid="stock-prep-confirmation-queue-refresh"]').click()
    await expect(embeddedQueue.locator('[data-testid="stock-prep-confirmation-row"]')).toHaveCount(1)

    await embeddedQueue.locator('[data-testid="stock-prep-confirmation-select"]').click()
    await embeddedQueue.locator('[data-testid="stock-prep-confirmation-confirm"]').click()
    expect(log.count('POST', '/confirmation-decisions/confirm')).toBe(1)

    // 确认完队列真的清空了,于是空态换成 nothing_pending —— 闭环按钮就挂在这个空态上。
    const empty = embeddedQueue.locator('[data-testid="stock-prep-confirmation-empty"]')
    await expect(empty).toBeVisible()
    await expect(empty).toHaveAttribute('data-empty-state', 'nothing_pending')
    const resync = embeddedQueue.locator('[data-testid="stock-prep-confirmation-empty-resync"]')
    await expect(resync).toBeVisible()
    // 线框 D ④ 的原话,而且是 embedded 专用那一版 —— 它真的会回到本页上面那块同步面板。
    await expect(resync).toContainText('回到上面再同步一次')

    // 「不切 tab」不是形容词:整个过程结束时,壳渲染的还是同一个面板。
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'project-board')
    expectNoUnmockedRoutes(log)
  })

  test('P1-04 第⑤步:能读角色目录的账号看到 ✔/⚠ 与角色名+人数,读不到的账号看到「? 看不到」—— 两者都不是「没完成」', async ({ page }) => {
    // 平台管理员:/api/admin/roles 答得上。
    const okLog = await openStockPrepHarness(page, {
      actor: 'platform',
      scenario: 'ready',
      tab: 'getting-started',
      routes: { roleCatalog: 'ok' },
    })
    const okState = page.locator('[data-testid="stock-prep-getting-started-access-state"]')
    await expect(okState).toHaveAttribute('data-state', 'ready')
    await expect(page.locator('[data-testid="stock-prep-getting-started-access-headline"]')).toBeVisible()
    const roles = page.locator('[data-testid="stock-prep-getting-started-access-role"]')
    await expect(roles).toHaveCount(1)
    await expect(roles.first()).toContainText('合成一线角色')
    await expect(roles.first()).toContainText('6 人')
    // 反向断言(线框 B2 的硬规则):只出角色名与人数,零用户身份。
    const rolesText = await roles.allTextContents()
    for (const text of rolesText) {
      expect(text).not.toContain('syn-user')
      expect(text).not.toContain('@')
    }
    await expect(okState).not.toContainText('还没开始')
    expectNoUnmockedRoutes(okLog)

    // stock-prep:admin —— 能开向导,但 /admin/roles 是 requiresAdmin(F10),读不到。
    const deniedLog = await openStockPrepHarness(page, {
      actor: 'stockadmin',
      scenario: 'ready',
      tab: 'getting-started',
      routes: { roleCatalog: 'forbidden' },
    })
    const deniedState = page.locator('[data-testid="stock-prep-getting-started-access-state"]')
    await expect(deniedState).toHaveAttribute('data-state', 'unknown')
    await expect(deniedState).toContainText('看不到')
    await expect(deniedState).not.toContainText('还没开始')
    // 第三态不许借用绿/红:'unknown' 的字色既不是 success 也不是 danger。
    const glyphColor = await deniedState.locator('.stock-prep-gs__glyph').first()
      .evaluate((el) => getComputedStyle(el).color)
    expect(glyphColor).not.toBe(await tokenRgb(page, '--ms-color-success'))
    expect(glyphColor).not.toBe(await tokenRgb(page, '--ms-color-danger'))
    // 而地图上的第⑤步也读 unknown,不是「没完成」。
    await expect(page.locator('[data-testid="stock-prep-getting-started-step"][data-step="grant-access"]'))
      .toHaveAttribute('data-badge', 'unknown')
    expectNoUnmockedRoutes(deniedLog)
  })

  test('P1-05 审计面三行免责常驻;主行只出「您 / 其他同事」,零人名', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'ready', tab: 'ops' })

    // 三行免责在查之前就在,而且不是折叠的。
    const caveats = page.locator('[data-testid="stock-prep-ops-audit-caveat"]')
    await expect(caveats).toHaveCount(3)
    for (let index = 0; index < 3; index += 1) await expect(caveats.nth(index)).toBeVisible()
    await expect(caveats.nth(0)).toContainText('不等于')

    await page.locator('[data-testid="stock-prep-ops-audit-project-input"]').fill(SYN_PROJECT_A)
    await page.locator('[data-testid="stock-prep-ops-audit-search"]').click()
    await expect(page.locator('[data-testid="stock-prep-ops-audit-list"]')).toBeVisible()

    // 查完之后三行还在(它是每个分支的兄弟节点,不是某一支里面的)。
    await expect(caveats).toHaveCount(3)

    const rows = page.locator('[data-testid="stock-prep-ops-audit-row"]')
    await expect(rows).toHaveCount(3)
    const who = await page.locator('[data-testid="stock-prep-ops-audit-row-who"]').allTextContents()
    expect(who.length).toBe(3)
    for (const label of who) expect(['您', '其他同事']).toContain(label.trim())
    // 主行的三格里不得出现内部操作者标识 —— 它只允许待在技术详情里。
    for (const testid of ['stock-prep-ops-audit-row-time', 'stock-prep-ops-audit-row-action', 'stock-prep-ops-audit-row-who']) {
      for (const text of await page.locator(`[data-testid="${testid}"]`).allTextContents()) {
        expect(text, `${testid} 不得渲染 actor 原值`).not.toContain('syn-user')
      }
    }
    expectNoUnmockedRoutes(log)
  })

  test('P1-06 健康面:「未检查」既不是绿也不是红;计划任务写「未接入监控」', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'ready', tab: 'ops' })
    await expect(page.locator('[data-testid="stock-prep-ops-health"]')).toBeVisible()

    // 部署自检是手动探(D6 同款),所以进来就是「未检查」。
    const preflightCell = page.locator('[data-testid="stock-prep-ops-cell-preflight"]')
    await expect(preflightCell).toHaveAttribute('data-cell-status', 'idle')
    await expect(preflightCell).toContainText('未检查')

    const success = await tokenRgb(page, '--ms-color-success')
    const danger = await tokenRgb(page, '--ms-color-danger')
    const badge = preflightCell.locator('.sp-ops__cell-badge')
    const badgeColor = await badge.evaluate((el) => getComputedStyle(el).color)
    expect(badgeColor, '「未检查」不得借用 success 色').not.toBe(success)
    expect(badgeColor, '「未检查」不得借用 danger 色').not.toBe(danger)
    // 而且这条断言不是空的:同一张面板上确实存在一个 success 色的徽标可以对照。
    const successBadges = await page.locator('.sp-ops__cell-badge').evaluateAll(
      (nodes, ok) => nodes.filter((node) => getComputedStyle(node).color === ok).length,
      success,
    )
    expect(successBadges, '对照组:面板上至少有一个真绿徽标').toBeGreaterThan(0)

    const scheduled = page.locator('[data-testid="stock-prep-ops-cell-scheduled-task"]')
    await expect(scheduled).toHaveAttribute('data-cell-status', 'not_monitored')
    await expect(scheduled).toContainText('未接入监控')
    const scheduledColor = await scheduled.locator('.sp-ops__cell-badge').evaluate((el) => getComputedStyle(el).color)
    expect(scheduledColor, '「未接入监控」不得是绿的').not.toBe(success)
    expectNoUnmockedRoutes(log)
  })

  test('P1-07 [源码断言 · 浏览器证明不了] 安装页与源预检的既有 jsdom 套件仍在,并且仍钉着折叠分节', async () => {
    // 「这一期只改一次」是一句关于 PR 数量的话,浏览器测不了。能测的是那两套还在、而且还在钉
    // P1-7 引进来的折叠分节 —— 套件被悄悄删掉的话,这条会红。
    const installSpec = join(REPO_ROOT, 'apps', 'web', 'tests', 'StockPreparationInstallView.spec.ts')
    expect(existsSync(installSpec), 'StockPreparationInstallView.spec.ts').toBe(true)
    expect(readFileSync(installSpec, 'utf8')).toContain('stock-prep-install-fold')
  })
})

// ---------------------------------------------------------------------------
// jsdom 盲区回归 —— 两条只有真浏览器能答的
// ---------------------------------------------------------------------------

test.describe('jsdom 盲区回归', () => {
  test('R-01 wizard 形态下,defaults 读 500 时报错条与「复制这条报错」都看得见', async ({ page }) => {
    // 这条曾经真的错过:报错条本来包在 `mode !== 'wizard'` 里,于是 D2 把新部署的管理员送到的
    // 那一个形态,恰好是唯一不说「为什么读不到」的形态。jsdom 看得到 DOM,但看不到「这一屏上到底
    // 有没有」—— 因为在 wizard 形态里那个节点压根不渲染,而单测挂载的是默认 full 形态。
    const log = await openStockPrepHarness(page, {
      actor: 'platform',
      scenario: 'defaults500',
      tab: 'getting-started',
    })
    await expect(page.locator('[data-testid="stock-prep-install"]')).toHaveAttribute('data-mode', 'wizard')
    // 形态确实是 wizard:安装页自己的那些卡片一个都没有渲染。
    await expect(page.locator('[data-testid="stock-prep-install-intro"]')).toHaveCount(0)

    const error = page.locator('[data-testid="stock-prep-install-error"]')
    await expect(error).toBeVisible()
    await expect(error).toContainText('HTTP 500')
    const copy = page.locator('[data-testid="stock-prep-install-error-copy"]')
    await expect(copy).toBeVisible()
    await expect(copy).toBeEnabled()
    // 「看得见」按屏幕算,不按 DOM 算。
    const box = await error.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(0)
    expect(box?.height ?? 0).toBeGreaterThan(0)
    expectNoUnmockedRoutes(log)
  })

  test('R-02 安装页的折叠分节样式真的生效(不是 UA 默认的 <details>)', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'ready', tab: 'install' })
    const fold = page.locator('[data-testid="stock-prep-install-fold"]').first()
    await expect(fold).toBeVisible()

    const computed = await fold.evaluate((el) => {
      const summary = el.querySelector('summary') as HTMLElement
      const heading = summary.querySelector('h4') as HTMLElement
      return {
        // UA 默认给 <summary> 的是 `display: list-item` + `list-style-type: disclosure-closed`。
        // 组件的 `list-style: none` 生效了,这两个才会变。
        listStyleType: getComputedStyle(summary).listStyleType,
        // UA 默认 <h4> 是 block;组件把它放回 summary 的那一行上。
        headingDisplay: getComputedStyle(heading).display,
        // 自己画的折叠箭头 —— 只有真层叠会产出这个伪元素。
        marker: getComputedStyle(summary, '::before').content,
        userSelect: getComputedStyle(summary).userSelect,
      }
    })
    expect(computed.listStyleType, '<summary> 的 list-style 被组件覆盖成 none').toBe('none')
    expect(computed.headingDisplay, 'summary 里的 h4 被拉回同一行').toBe('inline')
    expect(computed.marker, '组件自己的折叠箭头').toContain('▸')
    expect(computed.userSelect).toBe('none')
    expectNoUnmockedRoutes(log)
  })
})

// ---------------------------------------------------------------------------
// D2 落地裁决 —— 四态,各一条
// ---------------------------------------------------------------------------

test.describe('D2 落地裁决(§2.2 / workbenchAccess.stockPrepLandingKey)', () => {
  test('落地 · 平台管理员 + 未装完 → 开始使用', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'fresh' })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'getting-started')
    await expect(page.locator('[data-testid="stock-prep-getting-started"]')).toBeVisible()
    expectNoUnmockedRoutes(log)
  })

  test('落地 · 平台管理员 + 已装完 → 记录与排查', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'platform', scenario: 'ready' })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'ops')
    await expect(page.locator('[data-testid="stock-prep-ops-panel"]')).toBeVisible()
    expectNoUnmockedRoutes(log)
  })

  test('落地 · 一线(operate ∧ read)→ 今天要处理', async ({ page }) => {
    const log = await openStockPrepHarness(page, { actor: 'operator', scenario: 'ready' })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'home')
    await expect(page.locator('[data-testid="stock-prep-operator-home"]')).toBeVisible()
    expectNoUnmockedRoutes(log)
  })

  test('落地 · `?projectNo=` 深链压过一切落地规则 → 项目备料', async ({ page }) => {
    // 平台管理员 + 已装完本来落在 记录与排查;URL 里带着项目号时,链接要的那个页面赢。
    const log = await openStockPrepHarness(page, {
      actor: 'platform',
      scenario: 'ready',
      projectNo: SYN_PROJECT_A,
    })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'project-board')
    await expect(page.locator('[data-testid="stock-prep-project-board-title"]')).toContainText(SYN_PROJECT_A)
    expectNoUnmockedRoutes(log)
  })
})
