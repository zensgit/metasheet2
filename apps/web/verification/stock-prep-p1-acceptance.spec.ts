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
// D2 的落地裁决在文件末尾单列 —— 它是这条 lane 里最容易被一次改动悄悄推翻的东西。
// `STOCK_PREP_LANDING_KEYS` 是四个键,所以那里是四态各一条(getting-started / ops / home /
// confirmation-queue)+ 深链一态 + 两条 rail 组成(工作台管理员、只读观察者)。曾经只写了三态,
// 而没写的那一个正好是 fixture 里造好却没人进去的世界(`readerOnly` / `reader`);
// scripts/ops/stock-prep-browser-ci-wiring.test.mjs 现在有一条机械断言钉住「每个夹具世界、每个
// 夹具身份都至少被一条用例打开过」,免得再长出这种死码。
//
// 本 lane 明确不覆盖的半条(声明在这里,不藏在 PR 正文里):
//   * §6.2 验收 3 的后半「确认队列 tab 独立打开时逐像素一致」—— 没有基线截图,config 里
//     `screenshot: 'off'`。要做就得先立基线并接受它的维护成本;今天不做,所以不声称。
//   * P1-04 只跑了 ok / forbidden 两态。真实世界里还有 500 与超时,那两条与「? 看不到」同一分支。
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
    // `click()` 的 ack 与 route 拦截事件走同一条 CDP 连接、先后无序,所以这里必须轮询而不是即时读
    // 计数 —— 同文件 P0-09 对同类事实用的就是 `expect.poll`。一条 required lane 上的间歇红会卡住
    // 所有备料 PR 的合并。
    await expect
      .poll(() => log.count('POST', '/confirmation-decisions/confirm'), { message: '就地确认必须发出且只发出一次写' })
      .toBe(1)

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

    // 「常驻」的另一半:不可关闭。既不是 <details>(那样默认可收),也没有自己的关闭按钮,而且它
    // 不是被塞在某个可折叠祖先里的。只断言「在」的话,把三行包进一个 <details> 也照样绿。
    const caveatList = page.locator('[data-testid="stock-prep-ops-audit-caveats"]')
    await expect(caveatList).toHaveCount(1)
    await expect(caveatList.locator('button')).toHaveCount(0)
    const dismissible = await caveatList.evaluate((el) => Boolean(el.closest('details')) || el.tagName === 'DETAILS')
    expect(dismissible, '三行免责不许可折叠 / 可关闭').toBe(false)

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

  test('P1-07 [源码断言 · 浏览器证明不了] 安装页与源预检的既有 jsdom 套件仍在,并且各自还钉着自己那件事', async () => {
    // 「这一期只改一次」是一句关于 PR 数量的话,浏览器测不了。能测的是设计稿 §6.2 第 7 条点名的
    // 那两套还在、而且还在钉各自的锚点 —— 套件被悄悄删掉的话,这条会红。
    //
    // 这里以前只查了安装页那一套:用例名与注释都写「两套」,函数体里源预检一个字节没碰。删掉整个
    // 源预检套件,当时这条照样绿。
    const installSpec = join(REPO_ROOT, 'apps', 'web', 'tests', 'StockPreparationInstallView.spec.ts')
    expect(existsSync(installSpec), 'StockPreparationInstallView.spec.ts').toBe(true)
    // P1-7 引进来的折叠分节。
    expect(readFileSync(installSpec, 'utf8')).toContain('stock-prep-install-fold')

    const sourcePreflightSpec = join(REPO_ROOT, 'apps', 'web', 'tests', 'StockPreparationSourcePreflight.spec.ts')
    expect(existsSync(sourcePreflightSpec), 'StockPreparationSourcePreflight.spec.ts').toBe(true)
    const sourcePreflightSource = readFileSync(sourcePreflightSpec, 'utf8')
    // 源预检自己那件事:逐项 check 行、blocker 行、以及 go / no-go 的判定 —— P0-07「no-go 不是闸门」
    // 在浏览器侧只证明按钮还能点,判定本身的形状由这一套钉。
    for (const anchor of [
      'stock-prep-source-preflight-check',
      'stock-prep-source-preflight-blocker',
      'stock-prep-source-preflight-verdict',
    ]) {
      expect(sourcePreflightSource, `源预检套件缺锚点 ${anchor}`).toContain(anchor)
    }
  })
})

// ---------------------------------------------------------------------------
// 两条回归,分属两类 —— 类别写在标题里,不含糊
// ---------------------------------------------------------------------------

test.describe('形态回归(jsdom 能写,只是没人写)', () => {
  test('R-01 wizard 形态下,defaults 读 500 时报错条与「复制这条报错」都看得见', async ({ page }) => {
    // 这条曾经真的错过:报错条本来包在 `mode !== 'wizard'` 里,于是 D2 把新部署的管理员送到的
    // 那一个形态,恰好是唯一不说「为什么读不到」的形态。
    //
    // 分类要说准:这不是 jsdom 盲区。`mode` 是 StockPreparationInstallView.vue 上一个普通的
    // props('full' | 'wizard' | 'review',默认 'full'),jsdom 完全可以 `mount({ mode: 'wizard' })`
    // 然后断言 `[data-testid=stock-prep-install-error]` 存在;把报错条包回 `mode !== 'wizard'`
    // 之后的失败信息是「元素不存在」,纯 DOM 缺席,与层叠无关。真正只有浏览器能答的是 R-02 与
    // P1-01。这一条留在这条 lane 里的理由,是它 CHECKS THE COMPOSITION —— D2 把哪个账号送到哪个
    // 形态、那个形态在真实层叠下这一屏上有没有,是壳+路由+组件一起决定的;而
    // apps/web/tests/StockPreparationInstallView.spec.ts 里今天没有任何一处以 mode:'wizard'
    // 挂载,所以在 jsdom 侧补一条同类用例,才是它长期该待的地方。
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
})

test.describe('jsdom 盲区回归(只有真层叠能答)', () => {
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

  test('落地 · 只读队列观察者(只有 stock-prep:read)→ 确认队列,rail 只剩 确认队列 + 帮助', async ({ page }) => {
    // `STOCK_PREP_LANDING_KEYS` 的第四个键。这是四态里最容易被漏掉的一个:它是 `stockPrepLandingKey`
    // 的 fallback 分支 —— 既不是管理员、也不满足 operate ∧ read 的那个人。
    const log = await openStockPrepHarness(page, { actor: 'reader', scenario: 'ready' })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'confirmation-queue')
    await expect(page.locator('[data-testid="stock-prep-confirmation-queue"]')).toBeVisible()

    // R-11「可见即可用」在最窄的主体上:能看见的只有他真能开的两项。这也是反向断言 —— 只读账号
    // 若看得见 今天要处理 / 开始使用,就是「可见但一点就 403」。
    const rail = page.locator('[data-testid="stock-prep-tabs"]')
    await expect(rail.locator('[data-testid^="stock-prep-tab-"]')).toHaveCount(2)
    for (const visible of ['confirmation-queue', 'help']) {
      await expect(rail.locator(`[data-testid="stock-prep-tab-${visible}"]`)).toHaveCount(1)
    }
    for (const hidden of ['home', 'project-board', 'getting-started', 'install', 'ops']) {
      await expect(rail.locator(`[data-testid="stock-prep-tab-${hidden}"]`)).toHaveCount(0)
    }
    // 深度工具那一组整组不属于他 —— 连折叠开关都不该在。
    await expect(page.locator('[data-testid="stock-prep-rail-advanced-toggle"]')).toHaveCount(0)

    // 而且这个身份连目录都不去读:`confirmationQueue.projectDirectory` 是 OPERATE 层的能力,
    // 视图对没有这项能力的人 `return` 而不是发一个注定 403 的请求。
    expect(log.count('GET', '/operator/projects'), '只读观察者不发目录读').toBe(0)
    expectNoUnmockedRoutes(log)
  })

  test('落地 · 工作台管理员(stock-prep:admin)→ 与平台管理员同判定,但 rail 里没有深度工具', async ({ page }) => {
    // 同一条 D2 分支(`canOpenStockPrepInstallView` → deploymentReady ? ops : getting-started),
    // 不同的 rail 组成:legacy MVP 那七项是 platform-admin 门,`stock-prep:admin` 够不着。
    const log = await openStockPrepHarness(page, { actor: 'stockadmin', scenario: 'ready' })
    await expect(page.locator('[data-testid="stock-prep-panel"]')).toHaveAttribute('data-active', 'ops')

    const rail = page.locator('[data-testid="stock-prep-tabs"]')
    await expect(rail.locator('[data-testid^="stock-prep-tab-"]')).toHaveCount(7)
    for (const key of ['home', 'project-board', 'confirmation-queue', 'getting-started', 'install', 'ops', 'help']) {
      await expect(rail.locator(`[data-testid="stock-prep-tab-${key}"]`)).toHaveCount(1)
    }
    await expect(page.locator('[data-testid="stock-prep-rail-advanced-toggle"]')).toHaveCount(0)
    for (const legacy of LEGACY_TAB_KEYS) {
      await expect(rail.locator(`[data-testid="stock-prep-tab-${legacy}"]`)).toHaveCount(0)
    }
    expectNoUnmockedRoutes(log)
  })

  test('readerOnly:目录被 OPERATOR_SCOPE_TENANT_REQUIRED 拒绝时,页面说「判断不了」,而不是「都清了」,也不是报错', async ({ page }) => {
    // 服务端按设计拒绝两类主体的目录读(无自己租户的平台管理员 / 没有宿主成员关系的部署)。这两条
    // 不是故障:它们每次开页都会到,把它们渲染成红色错误条,就是每个管理员每次打开都看见一条假警报。
    // 但也不许静音 —— 静音的那一版让所有人看见「都清了」,而那是一句没人能背书的好消息。
    const log = await openStockPrepHarness(page, {
      actor: 'operator',
      scenario: 'readerOnly',
      tab: 'confirmation-queue',
    })
    await expect(page.locator('[data-testid="stock-prep-confirmation-queue"]')).toBeVisible()
    // 目录读确实发生了,而且确实被拒了 —— 否则下面那条空态断言可能只是「压根没读」。
    await expect
      .poll(() => log.count('GET', '/operator/projects'), { message: 'operate 主体必须去读目录' })
      .toBeGreaterThan(0)

    await page.locator('[data-testid="stock-prep-confirmation-project-input"]').fill(SYN_PROJECT_A)
    await page.locator('[data-testid="stock-prep-confirmation-queue-refresh"]').click()

    const empty = page.locator('[data-testid="stock-prep-confirmation-empty"]')
    await expect(empty).toBeVisible()
    await expect(empty).toHaveAttribute('data-empty-state', 'directory_unavailable')
    await expect(empty).toContainText('无法判断')
    // 反向断言两头:既不是 `nothing_pending` 那句「没有要您拿主意的事」的好消息(那是我们背书不了
    // 的一句话),也不是页面级错误条。
    await expect(empty).not.toContainText('没有要您拿主意的事')
    await expect(empty).not.toHaveAttribute('data-empty-state', 'nothing_pending')
    await expect(page.locator('[data-testid="stock-prep-confirmation-error"]')).toHaveCount(0)
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
