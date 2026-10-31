import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h as vueH, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'

// 项目接入 — the PANEL. The DOM half of the entry the owner asked for:
//   「PLM系统接通后,在页面哪里可点击项目号,然后该项目号里的bom就自动导入到我们的多维表中」
//
// What this suite pins that the service suite cannot:
//
//   P-01 R-11 / the operator tier: the sync control is ABSENT for anyone below platform admin, and
//        the reason is rendered in words. This is the browser agreeing with the server refusal —
//        a stock-prep operator holds no `integration:*` code, so the very first call (dry-run,
//        requireAccess(req,'read')) 403s for them.
//   P-02 the plain-language register: a HELD plan renders as 待办 with a route to the queue, and the
//        word 失败/Failed appears nowhere on the panel.
//   P-03 a failed batch archive renders its own FAIL line while the panel's headline still says the
//        import succeeded.
//   P-04 the counts are a SENTENCE, and zero clauses are dropped.
//   P-05 values-free: nothing from a response reaches the DOM except counts and closed tokens; the
//        project number the OPERATOR TYPED is the one business string, and it is theirs.
//   SYNC-STRADDLE (#6591 review, follow-up O2) a 同步 run's outcome belongs to the project, scope and
//        session it was started for: after the board opens another project, the scope moves or the
//        session changes, the run's writes still complete but nothing of it renders and no `synced`.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['integration:admin'] as string[],
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    // `roles` / `permissions` are the shape `workbenchAccess.ts` decides on (it takes the SNAPSHOT,
    // never the expanding probe), so this double has to carry them or every stock-prep predicate
    // reads an empty principal.
    getAccessSnapshot: () => ({ isAdmin: false, email: '', roles: [], permissions: h.permissions }),
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import {
  BATCH_ARCHIVE_DISABLED_CODE,
  StockPreparationProjectSyncCallError,
  type StockPreparationDryRunOptions,
  type StockPreparationProjectSyncApi,
} from '../src/services/integration/stockPreparation/projectSync'
import type { StockPreparationLargeBomJobApi } from '../src/services/integration/stockPreparation/largeBomPull'
import type { StockPreparationProjectTargetApi } from '../src/services/integration/stockPreparation/projectTarget'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const PROJECT_NO = 'P2026-001'
const PLANTED_DRAWING = 'DWG-88472-A'
const PLANTED_NAME = '涡轮增压器总成'
const PLANTED_SECRET = 'pwd=secret-42007'

function api(overrides: Partial<StockPreparationProjectSyncApi> = {}): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn().mockResolvedValue({
      status: 'ready',
      canApply: true,
      dryRunToken: 'tok_abc',
      counts: { add: 3, update: 2, skip: 7, inactive: 0, manual_confirm: 0 },
      evidence: { note: PLANTED_DRAWING, secret: PLANTED_SECRET },
      projectName: PLANTED_NAME,
    }),
    reconcile: vi.fn().mockResolvedValue({ counts: { created: 2, existing: 0, pending: 2 } }),
    apply: vi.fn().mockResolvedValue({
      status: 'succeeded',
      apply: { counts: { created: 3, updated: 2, inactive: 0, skipped: 7, held: 0, failed: 0 } },
    }),
    archive: vi.fn().mockResolvedValue({ status: 'created', persisted: true, created: { batch: 1, lines: 9, run: 1 } }),
    ...overrides,
  } as StockPreparationProjectSyncApi
}

/** A large-BOM job api double that reaches `done` in one tick of everything. */
function largeBomJobApi(overrides: Partial<StockPreparationLargeBomJobApi> = {}): StockPreparationLargeBomJobApi {
  return {
    startExpansion: vi.fn().mockResolvedValue({ jobId: 'large-bom-expansion-panel-1', status: 'queued', authoritative: false }),
    runExpansion: vi.fn().mockResolvedValue({
      jobId: 'large-bom-expansion-panel-1',
      status: 'completed',
      authoritative: true,
      progress: { rowsExpanded: 500, readCount: 520, frontierRemaining: 0, completedChunks: 1 },
      budgets: { maxRows: 1000, maxPages: 10, maxReadCount: 1200, maxElapsedMs: 30000, maxDepth: 10, maxArtifactChunks: 1 },
    }),
    planExpansion: vi.fn().mockResolvedValue({
      jobId: 'large-bom-expansion-panel-1',
      status: 'completed',
      authoritative: true,
      evidence: { plan: { counts: { add: 40, update: 10, skip: 0, inactive: 0, manual_confirm: 0 } } },
    }),
    startApply: vi.fn().mockResolvedValue({
      jobId: 'large-bom-apply-panel-1',
      status: 'queued',
      counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 },
    }),
    runApplyChunk: vi.fn().mockResolvedValue({
      jobId: 'large-bom-apply-panel-1',
      status: 'succeeded',
      counts: { created: 40, updated: 10, inactive: 0, skipped: 0, held: 0, failed: 0 },
    }),
    ...overrides,
  } as StockPreparationLargeBomJobApi
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationProjectSyncPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['integration:admin']
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  function mountPanel(props: Record<string, unknown> = {}): HTMLDivElement {
    app = createApp(StockPreparationProjectSyncPanel as Component, props)
    app.mount(container!)
    return container!
  }

  async function runSync(root: HTMLElement, projectNo = PROJECT_NO): Promise<void> {
    const input = root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement
    input.value = projectNo
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement).click()
    await flushUi()
  }

  // ---- P-01 --------------------------------------------------------------------------------
  it('P-01: a platform admin sees the sync control', () => {
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).toBeNull()
  })

  // 拉取人员拉数据 (R-33, 2026-10-08; was 一线自己拉数据): the owner first ruled a floor operator may
  // self-serve the pull, then reversed it — pulling belongs to the 拉取人员, a holder of
  // `stock-prep:pull` on top of operate and read. The control follows the server, not the other way
  // round — the plugin suite stock-preparation-operator-pull-gate.test.cjs (P-14) is what proves the
  // server admits the puller and refuses the floor operator.
  it('P-01: the stock-prep PULL tier (read+operate+pull) gets the sync control', () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]')).toBeNull()
  })

  it('P-01: the floor operator (read+operate, no pull) no longer gets it, and is sent to the 拉取人员', () => {
    h.permissions = ['stock-prep:read', 'stock-prep:operate']
    const root = mountPanel({ api: api() })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).toBeNull()
    const denied = root.querySelector('[data-testid="stock-prep-project-sync-denied"]') as HTMLElement
    expect(denied).not.toBeNull()
    expect(denied.textContent).toContain('请联系拉取人员')
    // …and is NOT told to obtain a permission they already hold.
    expect(denied.textContent).not.toContain('备料操作权限')
  })

  it('P-01: the pull tier is a CONJUNCTION — pull WITHOUT operate, pull WITHOUT read, and operate WITHOUT read all get nothing', () => {
    for (const permissions of [['stock-prep:read', 'stock-prep:pull'], ['stock-prep:operate', 'stock-prep:pull'], ['stock-prep:pull'], ['stock-prep:operate']]) {
      h.permissions = permissions
      const root = mountPanel({ api: api() })
      expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]'), permissions.join('+')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-denied"]'), permissions.join('+')).not.toBeNull()
      app?.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  it('P-01: neither the integration:write nor the read-only tier gets it, and both are told who does', () => {
    // NOTE the probe this suite injects is an EXACT-match one, so `stock-prep:admin` does not satisfy
    // `stock-prep:pull` here the way the real `useAuth` ladder would. That is deliberate: this
    // assertion is about the codes the panel asks for, and the ladder itself is pinned by
    // stockPrepPermissionMatrix.spec.ts against the live plugin module.
    for (const permissions of [['integration:write'], ['integration:read'], ['stock-prep:read'], []]) {
      h.permissions = permissions
      const root = mountPanel({ api: api() })
      expect(root.querySelector('[data-testid="stock-prep-project-sync-run"]')).toBeNull()
      const denied = root.querySelector('[data-testid="stock-prep-project-sync-denied"]') as HTMLElement
      expect(denied).not.toBeNull()
      // The reason names BOTH tiers that can run it — the 拉取人员 first, the platform administrator
      // second — because sending someone to the wrong person is its own kind of dead end.
      expect(denied.textContent).toContain('拉取人员')
      expect(denied.textContent).toContain('平台管理员')
      app?.unmount()
      app = null
      container!.innerHTML = ''
    }
  })

  // ---- the happy path ----------------------------------------------------------------------
  it('runs the four steps from a typed project number and points at the multitable', async () => {
    const double = api()
    const onOpenMultitable = vi.fn()
    const root = mountPanel({ api: double, onOpenMultitable })
    await runSync(root)

    // R67 ④: the panel hands the dry run its progress / stop-polling options.
    expect(double.dryRun).toHaveBeenCalledWith(PROJECT_NO, expect.objectContaining({ signal: expect.anything(), onProgress: expect.any(Function) }))
    expect(double.apply).toHaveBeenCalledWith(PROJECT_NO, 'tok_abc')

    const steps = root.querySelectorAll('[data-testid="stock-prep-project-sync-step"]')
    expect(steps.length).toBe(4)
    expect((steps[2] as HTMLElement).getAttribute('data-status')).toBe('ok')

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('imported')
    expect(verdict.textContent).toContain('导入完成')

    const openMultitable = root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]') as HTMLButtonElement
    expect(openMultitable).not.toBeNull()
    openMultitable.click()
    expect(onOpenMultitable).toHaveBeenCalledTimes(1)
  })

  // ---- 打开备料多维表: THE LABEL AND THE DESTINATION AGREE -----------------------------------
  //
  // The parent owns routing, and until this pass it had nowhere to route: the panel's link always
  // said 「到多维表看数据」 and always landed on the multitable chooser. The operator directory now
  // hands the parent the same tenant-gated `{ sheetId, viewId }` 项目备料页 returns, so the button
  // says which of the two things it will actually do. It still composes NO route itself.

  it('with a fill handle the link names the 备料主表', async () => {
    const root = mountPanel({ api: api(), fillTarget: { sheetId: 'sheet_x', viewId: 'view_x' } })
    await runSync(root)
    const link = root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]') as HTMLButtonElement
    expect(link.getAttribute('data-fill-target')).toBe('bound')
    expect(link.textContent).toContain('打开备料多维表')
  })

  it('with NO handle it promises only the multitable home — the destination the parent really has', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const link = root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]') as HTMLButtonElement
    expect(link.getAttribute('data-fill-target')).toBe('none')
    // 客户反馈 2026-10-21 9a: `/multitable` is the HOME page (新建 Base + template cards), not a workbench.
    expect(link.textContent).toContain('打开多维表首页')
    expect(link.textContent).not.toContain('工作台')
    expect(link.textContent).not.toContain('打开备料多维表')
  })

  it('9a: with NO handle a sentence beside the button says where it lands and that no template is to be chosen', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const hint = root.querySelector('[data-testid="stock-prep-project-sync-no-sheet-link-hint"]') as HTMLElement
    expect(hint).not.toBeNull()
    expect(hint.textContent).toContain('多维表首页')
    expect(hint.textContent).toContain('由系统或管理员按固定模板建立')
    expect(hint.textContent).toContain('不用在首页选模板')
    expect(hint.textContent).toContain('不要在那里新建 Base')
    // Default mount = 项目工作台: it points at 项目备料, and never promises a re-pull makes a link.
    expect(hint.textContent).toContain('请在「项目备料」页打开这个项目')
    expect(hint.textContent).not.toContain('再拉取一次')
    expect(hint.textContent).not.toContain('自动建')
    // It sits in the same next-step row as the button it explains.
    const link = root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]') as HTMLElement
    expect(hint.parentElement).toBe(link.parentElement)

    h.locale = 'en'
    app?.unmount()
    app = null
    container!.innerHTML = ''
    const en = mountPanel({ api: api() })
    await runSync(en)
    const enHint = en.querySelector('[data-testid="stock-prep-project-sync-no-sheet-link-hint"]') as HTMLElement
    expect(enHint.textContent).toContain('multitable home')
    expect(enHint.textContent).toContain('do not pick a template or create a Base')
  })

  it('round 1 (F1): mounted on 项目备料 the sentence points DOWN this page, not back to the page it is on', async () => {
    const root = mountPanel({ api: api(), noLinkHintContext: 'board' })
    await runSync(root)
    const hint = root.querySelector('[data-testid="stock-prep-project-sync-no-sheet-link-hint"]') as HTMLElement
    expect(hint.textContent).toContain('见本页下方另一个「打开多维表首页」按钮旁的说明')
    expect(hint.textContent).not.toContain('「项目备料」页')
    expect(hint.textContent).not.toContain('再拉取一次')
    expect(hint.textContent).toContain('不用在首页选模板')
  })

  it('9a: WITH a handle there is no such sentence — the button lands on the sheet itself', async () => {
    const root = mountPanel({ api: api(), fillTarget: { sheetId: 'sheet_x', viewId: 'view_x' } })
    await runSync(root)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-no-sheet-link-hint"]')).toBeNull()
  })
  // ---- P-04 --------------------------------------------------------------------------------
  it('P-04: the plan counts read as a sentence, with the zero clauses dropped', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const counts = root.querySelector('[data-testid="stock-prep-project-sync-counts"]') as HTMLElement
    expect(counts.textContent).toContain('新增 3 行')
    expect(counts.textContent).toContain('更新 2 行')
    expect(counts.textContent).toContain('7 行已经是最新的')
    // inactive and manual_confirm were 0 — their clauses must not be printed at all.
    expect(counts.textContent).not.toContain('0 行')
  })

  // ---- P-02 --------------------------------------------------------------------------------
  it('P-02: a held plan renders as 待办 — no 失败 anywhere, and a route to the queue', async () => {
    const double = api({
      dryRun: vi.fn().mockResolvedValue({
        status: 'manual_confirm_required',
        canApply: true,
        dryRunToken: 'tok_held',
        counts: { add: 4, update: 0, skip: 0, inactive: 0, manual_confirm: 5 },
      }),
    })
    const onNavigateStage = vi.fn()
    const root = mountPanel({ api: double, onNavigateStage })
    await runSync(root)

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('held')
    expect(verdict.textContent).toContain('还差一步')

    // THE REGISTER: a held plan is work outstanding, so the failure word must not be on the panel.
    const text = root.textContent || ''
    expect(text).not.toContain('失败')
    expect(text).toContain('确认队列')

    // The write step is a SKIP whose reason is rendered with the same weight as an OK line.
    const write = root.querySelector('[data-step="apply"]') as HTMLElement
    expect(write.getAttribute('data-status')).toBe('skip')
    expect(write.textContent).toContain('先不写入')

    // ...and the route out of it carries the pending count.
    const queue = root.querySelector('[data-testid="stock-prep-project-sync-open-queue"]') as HTMLButtonElement
    expect(queue).not.toBeNull()
    expect(queue.textContent).toContain('2') // reconcile's pending count
    queue.click()
    expect(onNavigateStage).toHaveBeenCalledWith('confirmation-queue')

    expect(double.apply).not.toHaveBeenCalled()
  })

  // ---- P-03 --------------------------------------------------------------------------------
  it('P-03: a failed batch archive shows its own FAIL line while the headline still says imported', async () => {
    const double = api({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(500, '/mvp-persist', { code: 'PERSIST_PLAN_TOO_LARGE' })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('imported')
    expect(verdict.textContent).toContain('导入完成')

    const archive = root.querySelector('[data-step="archive"]') as HTMLElement
    expect(archive.getAttribute('data-status')).toBe('fail')
    expect(archive.textContent).toContain('存档没成功')
    // ...and it says, in the same breath, that the import itself is fine.
    expect(archive.textContent).toContain('导入本身不受影响')
    // 客户反馈 2026-10-21 9b: and it no longer promises that a re-sync fixes what it cannot name.
    expect(archive.textContent).not.toContain('通常就补上了')
  })

  it('9b: a code-less 404 on the archive names the missing PLM source, and 技术详情 carries the HTTP status', async () => {
    const double = api({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(404, '/mvp-persist', {})),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('imported')
    const archive = root.querySelector('[data-step="archive"]') as HTMLElement
    expect(archive.getAttribute('data-status')).toBe('fail')
    expect(archive.textContent).toContain('没找到这个项目的 PLM 数据源')
    expect(archive.textContent).not.toContain('通常就补上了')
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('BATCH_ARCHIVE_SOURCE_SYSTEM_NOT_FOUND')
    const details = Array.from(tech.querySelectorAll('[data-testid="stock-prep-project-sync-step-detail"]')).map((el) => el.textContent)
    expect(details).toContain('status=404')
    expect(details.some((text) => (text ?? '').startsWith('code='))).toBe(false)
  })

  it('P-03: the archive being off for this deployment renders as a setting, not a fault', async () => {
    const double = api({
      archive: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(403, '/mvp-persist', { code: BATCH_ARCHIVE_DISABLED_CODE })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const archive = root.querySelector('[data-step="archive"]') as HTMLElement
    expect(archive.getAttribute('data-status')).toBe('skip')
    expect(archive.textContent).toContain('这是设置,不是故障')
    expect((root.textContent || '')).not.toContain('失败')
  })

  // ---- P-07: 客户反馈 2026-09-24 #2 (裁定见 PR #6074;后端诊断见 #6067) —————————————————————————
  // a dry-run failure names its ACTUAL cause instead of always printing the same "try again" line.
  // The OLD, always-the-same sentence — asserted absent for the two classes it used to wrongly cover.
  const OLD_GENERIC_PLAN_READ_FAILED_ZH = '没能连上取数,试算没有跑起来'

  it('P-07: a CONNECTION_* dry-run refusal names the broken connection, not the generic retry line', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(500, '/dry-run', { code: 'CONNECTION_CANONICAL_UNAVAILABLE' }),
      ),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('连接配置失效')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
    // The code stays visible in 技术详情 for whoever quotes it to an administrator.
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('PLAN_READ_FAILED_CONNECTION')
    expect(tech.textContent).toContain('CONNECTION_CANONICAL_UNAVAILABLE')
  })

  it('P-07: a TARGET_SHEET_FOREIGN_PROJECT refusal names the other project, not the generic retry line', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(
        new StockPreparationProjectSyncCallError(409, '/dry-run', { code: 'TARGET_SHEET_FOREIGN_PROJECT' }),
      ),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('其他项目的有效数据')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('PLAN_READ_FAILED_FOREIGN_PROJECT')
    expect(tech.textContent).toContain('TARGET_SHEET_FOREIGN_PROJECT')
  })

  it('P-07: a bare 403 on the plan is named as a permission refusal', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(403, '/dry-run', {})),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('没有从 PLM 拉取')
  })

  it('P-07: a bare 401 on the plan is named as an expired session, not a permission refusal', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(401, '/dry-run', {})),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.getAttribute('data-status')).toBe('fail')
    expect(plan.textContent).toContain('登录已过期')
    expect(plan.textContent).not.toContain('没有从 PLM 拉取')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('PLAN_READ_UNAUTHENTICATED')
  })

  it('P-07: SOURCE_UNAVAILABLE keeps the original "try again shortly" sentence — this IS the transient case', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(503, '/dry-run', { code: 'SOURCE_UNAVAILABLE' })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.textContent).toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
  })

  it('P-07: an unrecognized dry-run failure asks the operator to screenshot the technical details', async () => {
    const double = api({
      dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(400, '/dry-run', { code: 'SOME_OTHER_CODE' })),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.textContent).toContain('截图')
    expect(plan.textContent).not.toContain(OLD_GENERIC_PLAN_READ_FAILED_ZH)
  })

  // ---- P-06: the partial-write headline tells the truth ------------------------------------
  it('P-06: a partial write says rows landed, counts what did not, and KEEPS the sheet link', async () => {
    const double = api({
      apply: vi.fn().mockResolvedValue({
        status: 'partial',
        apply: { counts: { created: 2, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 1 } },
      }),
    })
    const root = mountPanel({ api: double })
    await runSync(root)

    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    // THE VERDICT AND THE HEADLINE, both pinned. Asserting only the step reason is what let the false
    // headline ship: the step said WRITE_PARTIAL while the sentence above it said nothing changed.
    expect(verdict.getAttribute('data-verdict')).toBe('partial')
    expect(verdict.textContent).toContain('写入了一部分')
    expect(verdict.textContent).not.toContain('数据没有变化')
    expect(verdict.textContent).not.toContain('没有导入成功')

    // ...and HOW MANY are missing, which is what makes it actionable.
    const count = root.querySelector('[data-testid="stock-prep-project-sync-verdict-count"]') as HTMLElement
    expect(count).not.toBeNull()
    expect(count.textContent).toContain('1')

    // The rows ARE in the sheet, so the way to look at them must be on screen.
    expect(root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]')).not.toBeNull()
  })

  it('P-06: a genuinely blocked run keeps the "nothing changed" headline and hides the sheet link', async () => {
    const double = api({
      apply: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(500, '/apply')),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.getAttribute('data-verdict')).toBe('blocked')
    expect(verdict.textContent).toContain('数据没有变化')
    expect(root.querySelector('[data-testid="stock-prep-project-sync-open-multitable"]')).toBeNull()
  })

  it('P-06: an archive whose outcome the server did not state makes no claim about it', async () => {
    const double = api({ archive: vi.fn().mockResolvedValue({ status: 'created' }) })
    const root = mountPanel({ api: double })
    await runSync(root)
    const archive = root.querySelector('[data-step="archive"]') as HTMLElement
    expect(archive.getAttribute('data-status')).toBe('ok')
    // No positive claim in either direction.
    expect(archive.textContent).not.toContain('之前已经存过了')
    expect(archive.textContent).toContain('没说清')
  })

  // ---- L-BOM: the audit's second dead-end ---------------------------------------------------
  it('L-BOM: a large_bom_bounded plan mounts the background channel, which drives itself to done', async () => {
    const jobApi = largeBomJobApi()
    const double = api({
      dryRun: vi.fn().mockResolvedValue({
        status: 'large_bom_bounded',
        canApply: false,
        dryRunToken: null,
        counts: {},
      }),
    })
    const onOpenMultitable = vi.fn()
    const root = mountPanel({
      api: double,
      largeBomApi: jobApi,
      largeBomPollWait: vi.fn().mockResolvedValue(undefined),
      onOpenMultitable,
    })
    await runSync(root)

    // The SKIP still renders exactly as before — this fix adds a surface, it does not hide the SKIP.
    const planStep = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(planStep.getAttribute('data-status')).toBe('skip')
    expect(planStep.textContent).toContain('太大')
    // The small-BOM apply/archive steps never ran — the plan stopped before them.
    expect(double.apply).not.toHaveBeenCalled()

    // The background channel is now visible and already driving itself (it starts on its own mount).
    const largeBom = root.querySelector('[data-testid="stock-prep-large-bom-pull"]') as HTMLElement
    expect(largeBom).not.toBeNull()
    expect(jobApi.startExpansion).toHaveBeenCalledWith(PROJECT_NO)

    await flushUi()
    expect(largeBom.getAttribute('data-phase')).toBe('done')

    // Its deep link is wired to the SAME parent event the small-BOM path's own link uses.
    const link = root.querySelector('[data-testid="stock-prep-large-bom-open-multitable"]') as HTMLButtonElement
    expect(link).not.toBeNull()
    link.click()
    expect(onOpenMultitable).toHaveBeenCalledTimes(1)
  })

  it('round 1 (F1): the background channel inherits the panel\'s mount context for its no-link sentence', async () => {
    const double = api({
      dryRun: vi.fn().mockResolvedValue({ status: 'large_bom_bounded', canApply: false, dryRunToken: null, counts: {} }),
    })
    const root = mountPanel({
      api: double,
      largeBomApi: largeBomJobApi(),
      largeBomPollWait: vi.fn().mockResolvedValue(undefined),
      noLinkHintContext: 'board',
    })
    await runSync(root)
    await flushUi()
    const hint = root.querySelector('[data-testid="stock-prep-large-bom-no-sheet-link-hint"]') as HTMLElement
    expect(hint).not.toBeNull()
    expect(hint.textContent).toContain('见本页下方另一个「打开多维表首页」按钮旁的说明')
    expect(hint.textContent).not.toContain('「项目备料」页')
  })

  it('L-BOM: an ordinary (non-large-BOM) run never mounts the background channel', async () => {
    const root = mountPanel({ api: api(), largeBomApi: largeBomJobApi() })
    await runSync(root)
    expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]')).toBeNull()
  })

  // ---- P-05 --------------------------------------------------------------------------------
  it('P-05: no business value from a response reaches the DOM; the typed number does', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const text = root.textContent || ''
    for (const forbidden of [PLANTED_DRAWING, PLANTED_NAME, PLANTED_SECRET, 'secret', 'tok_abc']) {
      expect(text).not.toContain(forbidden)
    }
    // The operator's own input is still in their own field.
    const input = root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement
    expect(input.value).toBe(PROJECT_NO)
  })

  it('refuses to run on an empty project number', async () => {
    const double = api()
    const root = mountPanel({ api: double })
    const button = root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    button.click()
    await flushUi()
    expect(double.dryRun).not.toHaveBeenCalled()
  })

  it('renders the four steps as pending before any run', () => {
    const root = mountPanel({ api: api() })
    const steps = root.querySelectorAll('[data-testid="stock-prep-project-sync-step"]')
    expect(steps.length).toBe(4)
    for (const step of steps) expect((step as HTMLElement).getAttribute('data-status')).toBe('pending')
    expect(root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')).toBeNull()
  })

  it('arming from a row 刷新 explains why the number has to be typed and focuses the field', async () => {
    const root = mountPanel({ api: api(), armedAt: 0 })
    expect(root.querySelector('[data-testid="stock-prep-project-sync-armed"]')).toBeNull()

    app!.unmount()
    app = createApp(StockPreparationProjectSyncPanel as Component, { api: api(), armedAt: 1 })
    // Mounting with a non-zero armedAt must NOT arm — only a CHANGE does, so a re-render cannot
    // spontaneously grab focus from wherever the operator is.
    app.mount(container!)
    await flushUi()
    expect(container!.querySelector('[data-testid="stock-prep-project-sync-armed"]')).toBeNull()
  })

  it('is bilingual: the English side renders the same steps and verdict', async () => {
    h.locale = 'en'
    const root = mountPanel({ api: api() })
    await runSync(root)
    const verdict = root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement
    expect(verdict.textContent).toContain('Imported')
    expect((root.textContent || '')).toContain('rows added')
  })

  it('keeps the raw outcome code in the technical disclosure for an implementer to grep', async () => {
    const root = mountPanel({ api: api() })
    await runSync(root)
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech).not.toBeNull()
    expect(tech.textContent).toContain('IMPORTED')
    expect(tech.textContent).toContain('mvp-persist')
    // The disclosure is a real <details> that is CLOSED by default: plain language first.
    expect(tech.tagName.toLowerCase()).toBe('details')
    expect(tech.getAttribute('data-open')).toBe('false')
  })

  // ---- R67 ④ — 试算 through the background job lane -------------------------------------------
  //
  // The run's dry-run step enqueues and polls (projectSync.ts; its wire half is pinned in
  // StockPreparationProjectSync.spec.ts). What the PANEL owns: the progress line with the time taken,
  // stopping the poll when it goes away (the job keeps running server-side), and showing a trial that
  // is still running when it comes back — without ever starting one on its own.

  it('R67-P1: while the background trial runs the panel says so with the elapsed time; the result then renders as before', async () => {
    let finish: (plan: unknown) => void = () => {}
    const double = api({
      dryRun: vi.fn().mockImplementation((_projectNo: string, options?: StockPreparationDryRunOptions) => {
        options?.onProgress?.({ elapsedMs: 83_000, attached: false })
        return new Promise((resolve) => { finish = resolve })
      }),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const line = root.querySelector('[data-testid="stock-prep-project-sync-dry-run-progress"]') as HTMLElement
    expect(line).not.toBeNull()
    expect(line.getAttribute('data-dry-run-progress')).toBe('run')
    expect(line.textContent).toContain('1:23')
    expect(line.textContent).toContain('后台试算')
    finish({ status: 'ready', canApply: true, dryRunToken: 'tok_abc', counts: { add: 3, update: 2, skip: 7, inactive: 0, manual_confirm: 0 } })
    await flushUi(12)
    expect(root.querySelector('[data-testid="stock-prep-project-sync-dry-run-progress"]')).toBeNull()
    expect((root.querySelector('[data-testid="stock-prep-project-sync-verdict"]') as HTMLElement).dataset.verdict).toBe('imported')
    expect(double.apply).toHaveBeenCalledWith(PROJECT_NO, 'tok_abc')
  })

  it('R67-P1 (en): the progress line is bilingual and says leaving does not stop it', async () => {
    h.locale = 'en'
    const double = api({
      dryRun: vi.fn().mockImplementation((_projectNo: string, options?: StockPreparationDryRunOptions) => {
        options?.onProgress?.({ elapsedMs: 5_000, attached: true })
        return new Promise(() => {})
      }),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    const line = root.querySelector('[data-testid="stock-prep-project-sync-dry-run-progress"]') as HTMLElement
    expect(line.getAttribute('data-dry-run-progress')).toBe('attached')
    expect(line.textContent).toContain('0:05')
    expect(line.textContent).toContain('leaving this page does not stop it')
  })

  it('R67-P2: unmounting stops the poll (the signal handed to the dry run is aborted); the job is left running', async () => {
    let seen: AbortSignal | undefined
    const double = api({
      dryRun: vi.fn().mockImplementation((_projectNo: string, options?: StockPreparationDryRunOptions) => {
        seen = options?.signal
        return new Promise(() => {})
      }),
    })
    const root = mountPanel({ api: double })
    await runSync(root)
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(false)
    app!.unmount()
    app = null
    expect(seen!.aborted).toBe(true)
  })

  it('R67-P3: re-attach — mounted on a project whose trial is still running, it shows it, polls until it ends, and never starts a run', async () => {
    const statuses = [
      { status: 'running' as const, elapsedMs: 61_000 },
      { status: 'running' as const, elapsedMs: 63_000 },
      { status: 'succeeded' as const, elapsedMs: 64_000 },
    ]
    let release: () => void = () => {}
    const waits: number[] = []
    const dryRunPollWait = vi.fn((ms: number) => {
      waits.push(ms)
      return new Promise<void>((resolve) => { release = resolve })
    })
    const double = api({ dryRunJobStatus: vi.fn().mockImplementation(async () => statuses.shift() ?? null) })
    const root = mountPanel({ api: double, projectNo: PROJECT_NO, dryRunPollWait })
    await flushUi()
    let line = root.querySelector('[data-testid="stock-prep-project-sync-dry-run-progress"]') as HTMLElement
    expect(line).not.toBeNull()
    expect(line.getAttribute('data-dry-run-progress')).toBe('resumed')
    expect(line.textContent).toContain('1:01')
    expect(double.dryRunJobStatus).toHaveBeenCalledWith(PROJECT_NO)
    release()
    await flushUi()
    line = root.querySelector('[data-testid="stock-prep-project-sync-dry-run-progress"]') as HTMLElement
    expect(line.textContent).toContain('1:03')
    release()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-project-sync-dry-run-progress"]')).toBeNull()
    expect(waits).toEqual([2000, 2000])
    expect(double.dryRun).not.toHaveBeenCalled()
    expect(double.apply).not.toHaveBeenCalled()
  })

  it('R67-P3b: unmounting while re-attached stops polling the status', async () => {
    let release: () => void = () => {}
    const dryRunPollWait = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const double = api({ dryRunJobStatus: vi.fn().mockResolvedValue({ status: 'running', elapsedMs: 1_000 }) })
    mountPanel({ api: double, projectNo: PROJECT_NO, dryRunPollWait })
    await flushUi()
    expect(double.dryRunJobStatus).toHaveBeenCalledTimes(1)
    app!.unmount()
    app = null
    release()
    await flushUi()
    expect(double.dryRunJobStatus).toHaveBeenCalledTimes(1)
  })

  it('R67-P4: someone else\'s trial of the project is running — the step says to wait, not 「稍后再试」 for a broken source', async () => {
    const root = mountPanel({
      api: api({
        dryRun: vi.fn().mockRejectedValue(new StockPreparationProjectSyncCallError(409, '/dry-run-jobs', { code: 'STOCK_PREPARATION_DRY_RUN_JOB_IN_PROGRESS' })),
      }),
    })
    await runSync(root)
    const plan = root.querySelector('[data-step="dry-run"]') as HTMLElement
    expect(plan.textContent).toContain('另一位同事')
    expect(plan.textContent).not.toContain('没能连上取数')
    const tech = root.querySelector('[data-testid="stock-prep-project-sync-tech"]') as HTMLElement
    expect(tech.textContent).toContain('PLAN_DRY_RUN_BUSY')
  })

  // ---- SYNC-STRADDLE (#6591 review, follow-up O2) ------------------------------------------
  // The project board keeps this panel mounted across a project switch and only moves its `projectNo`
  // prop, so a run started on project A can land while project B is open. Its writes are A's and stay
  // (the double's apply/archive still run); what must not happen is A's verdict / steps rendering on
  // B's board, or `synced(report-of-A)` driving B's 「下一步」 bar. Synthetic values only.
  describe('SYNC-STRADDLE — a run renders only on the board it was started for', () => {
    const PROJECT_A = 'SYN-PROJ-A'
    const PROJECT_B = 'SYN-PROJ-B'
    const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
    const PLAN = { status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 3, update: 0, skip: 0, inactive: 0, manual_confirm: 0 } }
    const APPLIED = { status: 'succeeded', apply: { counts: { created: 3, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 } } }

    beforeEach(() => {
      localStorage.setItem('auth_token', 'synthetic-session-a')
    })
    afterEach(() => {
      localStorage.removeItem('auth_token')
    })

    function held<T>(value: T): { fn: ReturnType<typeof vi.fn>; release: () => void } {
      const releases: Array<() => void> = []
      const fn = vi.fn().mockImplementation(() => new Promise<T>((done) => { releases.push(() => done(value)) }))
      return { fn, release: () => { for (const release of releases.splice(0)) release() } }
    }

    function mountOnBoard(props: Record<string, unknown>) {
      const board = reactive({ projectNo: PROJECT_A, scope: { ...SCOPE } })
      const onSynced = vi.fn()
      const onProjectTargetChanged = vi.fn()
      const Board = defineComponent({
        setup: () => () => vueH(StockPreparationProjectSyncPanel as Component, {
          ...props,
          projectNo: board.projectNo,
          scope: board.scope,
          onSynced,
          onProjectTargetChanged,
        }),
      })
      app = createApp(Board)
      app.mount(container!)
      return { root: container!, board, onSynced, onProjectTargetChanged }
    }

    const verdictOf = (root: HTMLElement) => root.querySelector('[data-testid="stock-prep-project-sync-verdict"]')?.getAttribute('data-verdict') ?? null
    const stepStatuses = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-testid="stock-prep-project-sync-step"]')).map((step) => step.getAttribute('data-status'))
    const press = async (root: HTMLElement, id: string) => {
      const button = root.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
      expect(button, `${id} must render`).not.toBeNull()
      button!.click()
      await flushUi(12)
    }

    /** Press 同步 on A; the plan lands (its step is painted), the write is held mid-flight. */
    async function runOnAHeldAtApply() {
      const apply = held(APPLIED)
      const double = api({ dryRun: vi.fn().mockResolvedValue(PLAN), apply: apply.fn as never })
      const mounted = mountOnBoard({ api: double })
      await flushUi()
      await press(mounted.root, 'stock-prep-project-sync-run')
      expect(double.dryRun).toHaveBeenCalledTimes(1)
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PROJECT_A)
      expect(double.apply).toHaveBeenCalledTimes(1)
      expect(stepStatuses(mounted.root)[0], 'the plan step of the run on A is painted').not.toBe('pending')
      return { ...mounted, double, releaseApply: apply.release }
    }

    it('control: an undisturbed run renders its verdict and tells the board once', async () => {
      const { root, onSynced, releaseApply, double } = await runOnAHeldAtApply()
      releaseApply()
      await flushUi(12)
      expect(verdictOf(root)).toBe('imported')
      expect(onSynced).toHaveBeenCalledTimes(1)
      expect(onSynced.mock.calls[0][0]?.verdict).toBe('imported')
      expect(double.archive).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['the board opened another project', true, (board: { projectNo: string }) => { board.projectNo = PROJECT_B }],
      ['the scope moved', true, (board: { scope: { tenantId: string; workspaceId: string } }) => { board.scope = { ...SCOPE, workspaceId: 'workspace-syn-other' } }],
      ['another principal took the session', true, () => {
        localStorage.setItem('auth_token', 'synthetic-session-other')
        notifyAuthPrincipalChange()
      }],
      ['another tab replaced the session (no notification)', false, () => { localStorage.setItem('auth_token', 'synthetic-session-other-tab') }],
    ] as Array<[string, boolean, (board: any) => void]>)('a run that lands after %s writes, but renders nothing and tells the board nothing', async (_label, notified, change) => {
      const { root, board, onSynced, onProjectTargetChanged, releaseApply, double } = await runOnAHeldAtApply()
      change(board)
      await flushUi()
      if (notified) {
        expect(stepStatuses(root), 'what the panel showed of the run on A is cleared on the switch').toEqual(['pending', 'pending', 'pending', 'pending'])
      }
      releaseApply()
      await flushUi(12)
      // The run itself completed: its write and its archive went through for A.
      expect(double.apply).toHaveBeenCalledTimes(1)
      expect(double.archive).toHaveBeenCalledTimes(1)
      expect((double.archive as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PROJECT_A)
      // …and nothing of it renders on the board that is open now, or reaches that board.
      expect(verdictOf(root)).toBeNull()
      expect(stepStatuses(root)).toEqual(['pending', 'pending', 'pending', 'pending'])
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect((root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement).textContent).not.toContain('正在拉取')
    })

    it('a step of the run on A that lands while B is open is not painted there, even before the run ends', async () => {
      const apply = held(APPLIED)
      const archive = held({ status: 'created', persisted: true, created: { batch: 1, lines: 3, run: 1 } })
      const double = api({ dryRun: vi.fn().mockResolvedValue(PLAN), apply: apply.fn as never, archive: archive.fn as never })
      const { root, board, onSynced } = mountOnBoard({ api: double })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      board.projectNo = PROJECT_B
      await flushUi()
      apply.release()
      await flushUi(12)
      expect(double.archive).toHaveBeenCalledTimes(1)
      expect(stepStatuses(root), 'A\'s apply step stays off B\'s board while A\'s archive is still running').toEqual(['pending', 'pending', 'pending', 'pending'])
      archive.release()
      await flushUi(12)
      expect(stepStatuses(root)).toEqual(['pending', 'pending', 'pending', 'pending'])
      expect(verdictOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
    })

    it('back on A after a dropped run: A pulls again normally and renders its own verdict', async () => {
      const { root, board, onSynced, releaseApply, double } = await runOnAHeldAtApply()
      board.projectNo = PROJECT_B
      await flushUi()
      releaseApply()
      await flushUi(12)
      board.projectNo = PROJECT_A
      await flushUi()
      expect(verdictOf(root)).toBeNull()
      ;(double.apply as ReturnType<typeof vi.fn>).mockResolvedValue(APPLIED)
      await press(root, 'stock-prep-project-sync-run')
      expect(verdictOf(root)).toBe('imported')
      expect(onSynced).toHaveBeenCalledTimes(1)
      expect(onSynced.mock.calls[0][0]?.verdict).toBe('imported')
    })

    it('a FINISHED run on A does not leave its verdict on B\'s board', async () => {
      const { root, board, onSynced, releaseApply } = await runOnAHeldAtApply()
      releaseApply()
      await flushUi(12)
      expect(verdictOf(root)).toBe('imported')
      board.projectNo = PROJECT_B
      await flushUi()
      expect(verdictOf(root)).toBeNull()
      expect(stepStatuses(root)).toEqual(['pending', 'pending', 'pending', 'pending'])
      expect(onSynced).toHaveBeenCalledTimes(1)
    })

    // R78 known limitation a: a 「新建」 / 「重新拉取」 / 「确认写入」 question belongs to the run that asked it. A yes
    // continues that run's flow for ITS project, so after the board has moved it is answered no — open or late.
    const promptOf = (root: HTMLElement) => root.querySelector('[data-testid="stock-prep-project-sync-target-prompt"]')?.getAttribute('data-prompt') ?? null
    const runButton = (root: HTMLElement) => root.querySelector('[data-testid="stock-prep-project-sync-run"]') as HTMLButtonElement
    const noticeOf = (root: HTMLElement) => root.querySelector('[data-testid="stock-prep-project-sync-target-notice"]')

    /** Press 同步 on A against A's active sheet: the 「重新拉取」 question is open on A, nothing pulled yet. */
    async function repullQuestionOpenOnA() {
      const log: string[] = []
      const double = api({ dryRun: vi.fn().mockResolvedValue(PLAN) })
      const mounted = mountOnBoard({ api: double, targetApi: activeTarget(log) })
      await flushUi()
      await press(mounted.root, 'stock-prep-project-sync-run')
      expect(promptOf(mounted.root)).toBe('repull')
      expect(log).toEqual(['target.get'])
      return { ...mounted, double, log }
    }

    it('R78-a1: the 「重新拉取」 question open on A is answered no when the board opens B — A is not pulled, and B\'s 同步 is usable', async () => {
      const { root, board, double, log, onSynced, onProjectTargetChanged } = await repullQuestionOpenOnA()
      board.projectNo = PROJECT_B
      await flushUi(12)
      expect(promptOf(root), 'no question about A on B\'s board').toBeNull()
      expect(log).toEqual(['target.get'])
      expect(double.dryRun).not.toHaveBeenCalled()
      expect(double.apply).not.toHaveBeenCalled()
      expect(noticeOf(root), 'A\'s 「没有拉取」 notice does not land on B either').toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
      expect(runButton(root).textContent).not.toContain('正在')
    })

    it('R78-a2: the 「确认写入」 question open on A (after 「新建」 on A) is answered no when the board opens B — the sheet stands, nothing is written', async () => {
      const log: string[] = []
      const double = api({ dryRun: vi.fn().mockResolvedValue(PLAN) })
      const { root, board, onSynced, onProjectTargetChanged } = mountOnBoard({ api: double, targetApi: absentTarget(log) })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      expect(promptOf(root)).toBe('create')
      await press(root, 'stock-prep-project-target-create')
      expect(promptOf(root)).toBe('write')
      expect(log).toEqual(['target.get', 'target.create'])
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PROJECT_A)
      board.projectNo = PROJECT_B
      await flushUi(12)
      expect(promptOf(root), 'no write question about A on B\'s board').toBeNull()
      expect(double.apply).not.toHaveBeenCalled()
      expect(double.archive).not.toHaveBeenCalled()
      // The create confirmed on A's own board stands (no undo anywhere); the flow's own re-read of A's counts follows.
      expect(log).toEqual(['target.get', 'target.create', 'target.get'])
      expect(verdictOf(root)).toBeNull()
      expect(stepStatuses(root)).toEqual(['pending', 'pending', 'pending', 'pending'])
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
    })

    it('R78-a3: a 「确认写入」 question A\'s trial asks after the board opened B is answered no and never shown — nothing is written', async () => {
      const log: string[] = []
      const plan = held(PLAN)
      const double = api({ dryRun: plan.fn as never })
      const { root, board, onSynced, onProjectTargetChanged } = mountOnBoard({ api: double, targetApi: absentTarget(log) })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      await press(root, 'stock-prep-project-target-create')
      expect(log).toEqual(['target.get', 'target.create'])
      expect(double.dryRun).toHaveBeenCalledTimes(1)
      expect(promptOf(root), 'A\'s trial is still running: nothing asked yet').toBeNull()
      board.projectNo = PROJECT_B
      await flushUi()
      plan.release()
      await flushUi(12)
      expect(promptOf(root), 'A\'s write question never renders on B\'s board').toBeNull()
      expect(double.apply).not.toHaveBeenCalled()
      expect(verdictOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
    })

    it('R78-a4: a 「新建」 question A\'s sheet read asks after the board opened B is answered no and never shown — nothing is created', async () => {
      const log: string[] = []
      let releaseRead: () => void = () => {}
      const target = absentTarget(log, { gate: () => new Promise<void>((done) => { releaseRead = done }) })
      const double = api({ dryRun: vi.fn().mockResolvedValue(PLAN) })
      const { root, board, onSynced, onProjectTargetChanged } = mountOnBoard({ api: double, targetApi: target })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      expect(log).toEqual(['target.get'])
      board.projectNo = PROJECT_B
      await flushUi()
      releaseRead()
      await flushUi(12)
      expect(promptOf(root), 'no 「新建」 question about A on B\'s board').toBeNull()
      expect(target.create).not.toHaveBeenCalled()
      expect(double.dryRun).not.toHaveBeenCalled()
      expect(noticeOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
    })

    it('R78-a5: another tab replaced the session between the question and the click (no notification) — the yes does not count', async () => {
      const { root, double, onSynced, onProjectTargetChanged } = await repullQuestionOpenOnA()
      localStorage.setItem('auth_token', 'synthetic-session-other-tab')
      await press(root, 'stock-prep-project-sync-target-prompt-confirm')
      expect(double.dryRun, 'A is not pulled under another session').not.toHaveBeenCalled()
      expect(double.apply).not.toHaveBeenCalled()
      expect(promptOf(root)).toBeNull()
      expect(verdictOf(root)).toBeNull()
      expect(noticeOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
    })

    it('R78-a6 control: the 「重新拉取」 question answered yes on its own board pulls A and renders A\'s verdict', async () => {
      const { root, double, log, onSynced, onProjectTargetChanged } = await repullQuestionOpenOnA()
      await press(root, 'stock-prep-project-sync-target-prompt-confirm')
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PROJECT_A)
      expect(double.apply).toHaveBeenCalledWith(PROJECT_A, 'tok_syn')
      expect(log).toEqual(['target.get', 'target.get'])
      expect(verdictOf(root)).toBe('imported')
      expect(onSynced).toHaveBeenCalledTimes(1)
      expect(onProjectTargetChanged).toHaveBeenCalledTimes(1)
    })

    it('R78-a7: another principal takes the session while the question is open — it is answered no and goes', async () => {
      const { root, double, onSynced } = await repullQuestionOpenOnA()
      localStorage.setItem('auth_token', 'synthetic-session-other')
      notifyAuthPrincipalChange()
      await flushUi(12)
      expect(promptOf(root)).toBeNull()
      expect(double.dryRun).not.toHaveBeenCalled()
      expect(noticeOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
    })

    const promptProjectNo = (root: HTMLElement) => root.querySelector('[data-testid="stock-prep-project-sync-target-prompt-project-no"]')?.textContent ?? null

    it('R78-a8: the 「新建」 question open on A is answered no when the board opens B — nothing is created, and B\'s own 同步 asks about B by name', async () => {
      const log: string[] = []
      const double = api({ dryRun: vi.fn().mockResolvedValue(PLAN) })
      const target = absentTarget(log)
      const { root, board, onSynced, onProjectTargetChanged } = mountOnBoard({ api: double, targetApi: target })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      expect(promptOf(root)).toBe('create')
      expect(promptProjectNo(root)).toBe(PROJECT_A)
      board.projectNo = PROJECT_B
      await flushUi(12)
      expect(promptOf(root), 'no 「新建」 question about A on B\'s board').toBeNull()
      expect(target.create).not.toHaveBeenCalled()
      expect(double.dryRun).not.toHaveBeenCalled()
      expect(noticeOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
      await press(root, 'stock-prep-project-sync-run')
      expect(promptOf(root)).toBe('create')
      expect(promptProjectNo(root), 'B\'s own question names B').toBe(PROJECT_B)
      expect((target.get as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([PROJECT_A, PROJECT_B])
      expect(target.create).not.toHaveBeenCalled()
    })

    it.each([
      ['tenant', { tenantId: 'tenant-syn-other' }],
      ['workspace', { workspaceId: 'workspace-syn-other' }],
    ] as Array<[string, Partial<typeof SCOPE>]>)('R78-a9 (%s): the 「重新拉取」 question open on A is answered no when the scope moves — A is not pulled, and 同步 is usable', async (_label, other) => {
      const { root, board, double, log, onSynced, onProjectTargetChanged } = await repullQuestionOpenOnA()
      board.scope = { ...SCOPE, ...other } as typeof SCOPE
      await flushUi(12)
      expect(promptOf(root), 'no question from the scope the board left').toBeNull()
      expect(log).toEqual(['target.get'])
      expect(double.dryRun).not.toHaveBeenCalled()
      expect(double.apply).not.toHaveBeenCalled()
      expect(noticeOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
    })

    it('R78-a10: A → B → A with the 「重新拉取」 question open on A — the old question does not come back on A, and a fresh 同步 there asks again and its yes counts', async () => {
      const { root, board, double, log, onSynced } = await repullQuestionOpenOnA()
      board.projectNo = PROJECT_B
      await flushUi()
      board.projectNo = PROJECT_A
      await flushUi(12)
      expect(promptOf(root), 'the old question never comes back').toBeNull()
      expect(double.dryRun).not.toHaveBeenCalled()
      expect(noticeOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
      await press(root, 'stock-prep-project-sync-run')
      expect(promptOf(root), 'the fresh run on A asks its own question').toBe('repull')
      await press(root, 'stock-prep-project-sync-target-prompt-confirm')
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([PROJECT_A])
      expect(double.apply).toHaveBeenCalledWith(PROJECT_A, 'tok_syn')
      expect(log).toEqual(['target.get', 'target.get', 'target.get'])
      expect(verdictOf(root)).toBe('imported')
      expect(onSynced).toHaveBeenCalledTimes(1)
    })

    it('R78-a11: 「新建」 confirmed on A, and A\'s trial lands after A → B → A — its 「确认写入」 question is not shown even back on A, and nothing is written', async () => {
      const log: string[] = []
      const plan = held(PLAN)
      const double = api({ dryRun: plan.fn as never })
      const { root, board, onSynced, onProjectTargetChanged } = mountOnBoard({ api: double, targetApi: absentTarget(log) })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      await press(root, 'stock-prep-project-target-create')
      expect(log).toEqual(['target.get', 'target.create'])
      expect(promptOf(root), 'A\'s trial is still running: nothing asked yet').toBeNull()
      board.projectNo = PROJECT_B
      await flushUi()
      board.projectNo = PROJECT_A
      await flushUi()
      plan.release()
      await flushUi(12)
      expect(promptOf(root), 'a run the board has left asks nothing, even back on its own project').toBeNull()
      expect(double.apply).not.toHaveBeenCalled()
      expect(double.archive).not.toHaveBeenCalled()
      expect(verdictOf(root)).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(runButton(root).disabled).toBe(false)
    })

    // R78 known limitation b: on the board the project box is the board's project, a run in flight included.
    const projectBox = (root: HTMLElement) => root.querySelector('[data-testid="stock-prep-project-sync-project-no"]') as HTMLInputElement

    it('R78-b1: the project box follows the board to B while A\'s run is in flight, and the next 同步 there pulls B', async () => {
      const { root, board, releaseApply, double } = await runOnAHeldAtApply()
      expect(projectBox(root).value).toBe(PROJECT_A)
      board.projectNo = PROJECT_B
      await flushUi()
      expect(projectBox(root).value, 'mid-run, the box already shows the board\'s project').toBe(PROJECT_B)
      releaseApply()
      await flushUi(12)
      expect(projectBox(root).value, 'A landing does not put A back').toBe(PROJECT_B)
      ;(double.dryRun as ReturnType<typeof vi.fn>).mockClear()
      ;(double.apply as ReturnType<typeof vi.fn>).mockResolvedValue(APPLIED)
      await press(root, 'stock-prep-project-sync-run')
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PROJECT_B)
      expect(verdictOf(root)).toBe('imported')
    })

    it('R78-b2: B\'s own running trial is looked for once A\'s straddled run has ended (the re-attach probe waits, then runs)', async () => {
      const probed: string[] = []
      const apply = held(APPLIED)
      const double = api({
        dryRun: vi.fn().mockResolvedValue(PLAN),
        apply: apply.fn as never,
        dryRunJobStatus: vi.fn(async (projectNo: string) => { probed.push(projectNo); return null }),
      })
      const { root, board } = mountOnBoard({ api: double })
      await flushUi()
      expect(probed).toEqual([PROJECT_A])
      await press(root, 'stock-prep-project-sync-run')
      expect(double.apply).toHaveBeenCalledTimes(1)
      board.projectNo = PROJECT_B
      await flushUi()
      expect(probed, 'not while A\'s run is in flight').toEqual([PROJECT_A])
      apply.release()
      await flushUi(12)
      expect(probed).toEqual([PROJECT_A, PROJECT_B])
    })

    it('R78-b3: the waiting re-attach probe runs once — a later run on B that ends without a switch does not probe again', async () => {
      const probed: string[] = []
      const apply = held(APPLIED)
      const double = api({
        dryRun: vi.fn().mockResolvedValue(PLAN),
        apply: apply.fn as never,
        dryRunJobStatus: vi.fn(async (projectNo: string) => { probed.push(projectNo); return null }),
      })
      const { root, board } = mountOnBoard({ api: double })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      board.projectNo = PROJECT_B
      await flushUi()
      apply.release()
      await flushUi(12)
      expect(probed).toEqual([PROJECT_A, PROJECT_B])
      ;(double.apply as ReturnType<typeof vi.fn>).mockResolvedValue(APPLIED)
      await press(root, 'stock-prep-project-sync-run')
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(PROJECT_B)
      expect(verdictOf(root)).toBe('imported')
      await flushUi(12)
      expect(probed, 'no second probe after a run on B with no switch').toEqual([PROJECT_A, PROJECT_B])
    })

    it('R78-b4: A → B → C while A\'s run is in flight — the box shows C, the waiting probe runs once, for C, and the next 同步 pulls C', async () => {
      const PROJECT_C = 'SYN-PROJ-C'
      const probed: string[] = []
      const apply = held(APPLIED)
      const double = api({
        dryRun: vi.fn().mockResolvedValue(PLAN),
        apply: apply.fn as never,
        dryRunJobStatus: vi.fn(async (projectNo: string) => { probed.push(projectNo); return null }),
      })
      const { root, board } = mountOnBoard({ api: double })
      await flushUi()
      expect(probed).toEqual([PROJECT_A])
      await press(root, 'stock-prep-project-sync-run')
      expect(double.apply).toHaveBeenCalledTimes(1)
      board.projectNo = PROJECT_B
      await flushUi()
      board.projectNo = PROJECT_C
      await flushUi()
      expect(projectBox(root).value, 'the box follows every switch, not only the first').toBe(PROJECT_C)
      expect(probed, 'not while A\'s run is in flight').toEqual([PROJECT_A])
      apply.release()
      await flushUi(12)
      expect(probed, 'once, for the project the board is on now').toEqual([PROJECT_A, PROJECT_C])
      ;(double.dryRun as ReturnType<typeof vi.fn>).mockClear()
      ;(double.apply as ReturnType<typeof vi.fn>).mockResolvedValue(APPLIED)
      await press(root, 'stock-prep-project-sync-run')
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PROJECT_C)
      expect(verdictOf(root)).toBe('imported')
    })

    // R78 known limitation c: the trial's progress line belongs to the run (or 核对) that is current. A's poll goes on
    // after the switch — the trial completes for A — but paints nothing on the board that is open now.
    const progressLine = (root: HTMLElement) => root.querySelector('[data-testid="stock-prep-project-sync-dry-run-progress"]')
    function trialWithProgressHeld() {
      const plan = held(PLAN)
      let onProgress: StockPreparationDryRunOptions['onProgress']
      const dryRun = vi.fn((_projectNo: string, options?: StockPreparationDryRunOptions) => {
        onProgress = options?.onProgress
        onProgress?.({ elapsedMs: 83_000, attached: false })
        return plan.fn()
      })
      return { dryRun, tick: (elapsedMs: number) => onProgress?.({ elapsedMs, attached: false }), release: plan.release }
    }

    it.each([
      ['R78-c1', 'the board opened another project', (board: { projectNo: string }) => { board.projectNo = PROJECT_B }],
      ['R78-c2', 'the scope moved', (board: { scope: { tenantId: string; workspaceId: string } }) => { board.scope = { ...SCOPE, workspaceId: 'workspace-syn-other' } }],
    ] as Array<[string, string, (board: any) => void]>)('%s: A\'s trial progress line goes when %s, and the next poll of A\'s trial does not paint it back', async (_id, _label, change) => {
      const trial = trialWithProgressHeld()
      const { root, board } = mountOnBoard({ api: api({ dryRun: trial.dryRun as never }) })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      expect(progressLine(root)?.textContent).toContain('1:23')
      change(board)
      await flushUi()
      expect(progressLine(root), 'cleared on the switch').toBeNull()
      trial.tick(85_000)
      await flushUi()
      expect(progressLine(root), 'A\'s next poll paints nothing here').toBeNull()
      trial.release()
      await flushUi(12)
      expect(progressLine(root)).toBeNull()
      expect(verdictOf(root)).toBeNull()
    })

    it('R78-c3: the 核对 lane — A\'s check progress line goes when the board opens B, and the next poll does not paint it back', async () => {
      const trial = trialWithProgressHeld()
      const double = api({ dryRun: trial.dryRun as never })
      const { root, board, onSynced } = mountOnBoard({ api: double, refreshStatus: 'executed_pending_settlement' })
      await flushUi()
      await press(root, 'stock-prep-project-sync-check')
      expect((double.dryRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PROJECT_A)
      expect(progressLine(root)?.textContent).toContain('1:23')
      board.projectNo = PROJECT_B
      await flushUi()
      expect(progressLine(root), 'cleared on the switch').toBeNull()
      trial.tick(85_000)
      await flushUi()
      expect(progressLine(root), 'A\'s next check poll paints nothing here').toBeNull()
      trial.release()
      await flushUi(12)
      expect(progressLine(root)).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-check-result"]')).toBeNull()
      expect(onSynced).not.toHaveBeenCalled()
    })

    // The re-attach lane (R67 ④): the 「上次的试算还在后台…」 line a mount's probe painted goes on any invalidation, and
    // the probe that painted it lets go — its polls go to the scope it started under. Nothing is probed for the new
    // scope or session from here (a press of 同步 there still attaches to a trial that is running).
    it.each([
      ['workspace', (board: { scope: { tenantId: string; workspaceId: string } }) => { board.scope = { ...SCOPE, workspaceId: 'workspace-syn-other' } }],
      ['tenant', (board: { scope: { tenantId: string; workspaceId: string } }) => { board.scope = { ...SCOPE, tenantId: 'tenant-syn-other' } }],
      ['session', () => {
        localStorage.setItem('auth_token', 'synthetic-session-other')
        notifyAuthPrincipalChange()
      }],
    ] as Array<[string, (board: any) => void]>)('R78-c4 (%s): the re-attach line of A\'s earlier trial goes on the switch, and the probe started before it does not paint it back', async (_label, change) => {
      let releaseWait: () => void = () => {}
      const wait = vi.fn(() => new Promise<void>((done) => { releaseWait = done }))
      const probed: string[] = []
      const double = api({
        dryRunJobStatus: vi.fn(async (projectNo: string) => { probed.push(projectNo); return { status: 'running' as const, elapsedMs: 83_000 } }),
      })
      const { root, board, onSynced } = mountOnBoard({ api: double, dryRunPollWait: wait })
      await flushUi()
      expect(probed).toEqual([PROJECT_A])
      expect(progressLine(root)?.getAttribute('data-dry-run-progress')).toBe('resumed')
      change(board)
      await flushUi()
      expect(progressLine(root), 'cleared on the switch').toBeNull()
      releaseWait()
      await flushUi(12)
      expect(progressLine(root), 'not painted back from the trial the board has left').toBeNull()
      expect(probed, 'the probe started before the switch polls no more').toEqual([PROJECT_A])
      expect(double.dryRun).not.toHaveBeenCalled()
      expect(onSynced).not.toHaveBeenCalled()
    })

    // The large-BOM background channel is ticked FROM THE PAGE (largeBomPull.ts): unmounting it would cut A's
    // write short. A board switch therefore hides it and lets it finish; a session switch stops it.
    const LARGE_PLAN = { status: 'large_bom_bounded', canApply: false, dryRunToken: null, counts: {} }
    async function largeTrialOnAHeldAtChunk(chunkStatus = 'succeeded') {
      const chunk = held({ jobId: 'large-bom-apply-panel-1', status: chunkStatus, counts: { created: 40, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 } })
      const jobApi = largeBomJobApi({ runApplyChunk: chunk.fn as never })
      const double = api({ dryRun: vi.fn().mockResolvedValue(LARGE_PLAN) })
      const mounted = mountOnBoard({ api: double, largeBomApi: jobApi, largeBomPollWait: vi.fn().mockResolvedValue(undefined) })
      await flushUi()
      await press(mounted.root, 'stock-prep-project-sync-run')
      const channel = mounted.root.querySelector('[data-testid="stock-prep-large-bom-pull"]') as HTMLElement
      expect(channel, 'the trial on A mounted its background channel').not.toBeNull()
      expect(jobApi.startExpansion).toHaveBeenCalledWith(PROJECT_A)
      expect(jobApi.runApplyChunk).toHaveBeenCalledTimes(1)
      expect(channel.getAttribute('data-phase')).toBe('applying')
      expect(mounted.onSynced).toHaveBeenCalledTimes(1)
      return { ...mounted, double, jobApi, channel, releaseChunk: chunk.release }
    }

    it('large BOM: after the board opens B, A\'s background write is hidden there but runs to done', async () => {
      const { root, board, onSynced, jobApi, channel, releaseChunk } = await largeTrialOnAHeldAtChunk()
      board.projectNo = PROJECT_B
      await flushUi()
      expect(verdictOf(root)).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]'), 'still mounted: unmounting would stop A\'s write').toBe(channel)
      expect(channel.style.display, 'not shown on B\'s board').toBe('none')
      releaseChunk()
      await flushUi(12)
      expect(channel.getAttribute('data-phase')).toBe('done')
      expect(jobApi.runApplyChunk).toHaveBeenCalledTimes(1)
      // The channel's own completion is `synced(null)` — "re-read your board", never A's report.
      expect(onSynced.mock.calls.map((call) => call[0])).toEqual([expect.objectContaining({ verdict: expect.any(String) }), null])
    })

    it('large BOM: a session switch stops the page-driven write (it never continues under another principal)', async () => {
      const { root, jobApi, releaseChunk } = await largeTrialOnAHeldAtChunk()
      localStorage.setItem('auth_token', 'synthetic-session-other')
      notifyAuthPrincipalChange()
      await flushUi()
      expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]')).toBeNull()
      releaseChunk()
      await flushUi(12)
      expect(jobApi.runApplyChunk).toHaveBeenCalledTimes(1)
    })

    it('large BOM: a trial of A that lands after the board opened B starts no background write there', async () => {
      const plan = held(LARGE_PLAN)
      const jobApi = largeBomJobApi()
      const { root, board, onSynced } = mountOnBoard({ api: api({ dryRun: plan.fn as never }), largeBomApi: jobApi, largeBomPollWait: vi.fn().mockResolvedValue(undefined) })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      board.projectNo = PROJECT_B
      await flushUi()
      plan.release()
      await flushUi(12)
      expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]')).toBeNull()
      expect(jobApi.startExpansion).not.toHaveBeenCalled()
      expect(onSynced).not.toHaveBeenCalled()
    })

    // R78 known limitation d: the channel is shown iff the board is back on the context (project + scope) it started on.
    it('R78-d1: A → B → A — A\'s still-running background write is shown again on A (the same channel) and runs to done there', async () => {
      const { root, board, onSynced, jobApi, channel, releaseChunk } = await largeTrialOnAHeldAtChunk()
      board.projectNo = PROJECT_B
      await flushUi()
      expect(channel.style.display, 'hidden on B, as before').toBe('none')
      board.projectNo = PROJECT_A
      await flushUi()
      expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]'), 'the same channel, never remounted').toBe(channel)
      expect(channel.style.display, 'shown again on the board it started on').not.toBe('none')
      releaseChunk()
      await flushUi(12)
      expect(channel.getAttribute('data-phase')).toBe('done')
      expect(channel.style.display).not.toBe('none')
      expect(jobApi.runApplyChunk).toHaveBeenCalledTimes(1)
      expect(onSynced.mock.calls.map((call) => call[0])).toEqual([expect.objectContaining({ verdict: expect.any(String) }), null])
    })

    it.each([
      ['R78-d2', 'workspace', { workspaceId: 'workspace-syn-other' }],
      ['R78-d2', 'tenant', { tenantId: 'tenant-syn-other' }],
    ] as Array<[string, string, Partial<typeof SCOPE>]>)('%s: same project, %s X → Y → X — hidden while the scope differs, shown again when it is back', async (_id, _label, other) => {
      const { board, channel, releaseChunk } = await largeTrialOnAHeldAtChunk()
      board.scope = { ...SCOPE, ...other }
      await flushUi()
      expect(channel.style.display, 'hidden in the other scope').toBe('none')
      board.scope = { ...SCOPE }
      await flushUi()
      expect(channel.style.display, 'shown again in its own scope').not.toBe('none')
      releaseChunk()
      await flushUi(12)
      expect(channel.getAttribute('data-phase')).toBe('done')
    })

    it('R78-d3 (kept): A → B → A, then 同步 again — the old channel is unmounted and its write stops between chunks', async () => {
      const { root, board, double, jobApi, channel, releaseChunk } = await largeTrialOnAHeldAtChunk('running')
      board.projectNo = PROJECT_B
      await flushUi()
      board.projectNo = PROJECT_A
      await flushUi()
      ;(double.dryRun as ReturnType<typeof vi.fn>).mockResolvedValue(PLAN)
      await press(root, 'stock-prep-project-sync-run')
      expect(channel.isConnected, 'the new run unmounts the old channel').toBe(false)
      expect(root.querySelector('[data-testid="stock-prep-large-bom-pull"]')).toBeNull()
      expect(verdictOf(root)).toBe('imported')
      // The held chunk answers "still running": the unmounted loop must not tick again.
      releaseChunk()
      await flushUi(12)
      expect(jobApi.runApplyChunk).toHaveBeenCalledTimes(1)
    })

    function activeTarget(log: string[], options: { restore?: () => Promise<unknown>; archived?: boolean } = {}): StockPreparationProjectTargetApi {
      const state = (archived: boolean) => ({
        status: archived ? 'archived' : 'active',
        sheetId: 'sheet_syn_straddle',
        viewId: 'view_syn_straddle',
        todoViewId: 'view_syn_straddle_todo',
        rowCount: 3,
        activeRowCount: 3,
        rowCountBounded: false,
        lastPulledAt: null,
        lastPullOutcome: null,
        archivedAt: null,
        may: { create: false, archive: !archived, restore: archived },
      })
      let archived = options.archived === true
      return {
        get: vi.fn(async () => { log.push('target.get'); return state(archived) }),
        create: vi.fn(async () => { log.push('target.create'); return { status: 'active', created: false, sheetId: 'sheet_syn_straddle', viewId: 'view_syn_straddle', todoViewId: 'view_syn_straddle_todo' } }),
        list: vi.fn(async () => ({ count: 0, limit: 200, items: [] })),
        restore: vi.fn(async () => {
          log.push('target.restore')
          if (options.restore) await options.restore()
          archived = false
          return { status: 'active' }
        }),
      } as unknown as StockPreparationProjectTargetApi
    }

    /** No sheet yet, and this caller may create it; active once created. `gate` holds every read before the create. */
    function absentTarget(log: string[], options: { gate?: () => Promise<void> } = {}): StockPreparationProjectTargetApi {
      let created = false
      const state = () => ({
        status: created ? 'active' : 'absent',
        sheetId: created ? 'sheet_syn_straddle' : null,
        viewId: created ? 'view_syn_straddle' : null,
        todoViewId: created ? 'view_syn_straddle_todo' : null,
        rowCount: created ? 0 : null,
        activeRowCount: created ? 0 : null,
        rowCountBounded: created ? false : null,
        lastPulledAt: null,
        lastPullOutcome: null,
        archivedAt: null,
        may: { create: !created, archive: created, restore: false },
      })
      return {
        get: vi.fn(async () => {
          log.push('target.get')
          if (options.gate && !created) await options.gate()
          return state()
        }),
        create: vi.fn(async () => {
          log.push('target.create')
          created = true
          return { status: 'active', created: true, sheetId: 'sheet_syn_straddle', viewId: 'view_syn_straddle', todoViewId: 'view_syn_straddle_todo' }
        }),
        list: vi.fn(async () => ({ count: 0, limit: 200, items: [] })),
      } as unknown as StockPreparationProjectTargetApi
    }

    it('the repair path: a repair of A that lands after the board opened B renders nothing there', async () => {
      const log: string[] = []
      const secondPlan = held(PLAN)
      let dryRuns = 0
      const double = api({
        dryRun: vi.fn().mockImplementation((...args: unknown[]) => {
          dryRuns += 1
          log.push('dryRun')
          if (dryRuns === 1) return Promise.reject(new StockPreparationProjectSyncCallError(422, 'dry-run', { code: 'TARGET_SCHEMA_INCOMPLETE' }))
          return secondPlan.fn(...args)
        }),
      })
      const { root, board, onSynced, onProjectTargetChanged } = mountOnBoard({ api: double, targetApi: activeTarget(log) })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      await press(root, 'stock-prep-project-sync-target-prompt-confirm')
      expect(onSynced).toHaveBeenCalledTimes(1)
      const targetChangesBefore = onProjectTargetChanged.mock.calls.length
      await press(root, 'stock-prep-project-sync-repair-action')
      expect(log).toContain('target.create')
      expect(dryRuns).toBe(2)
      board.projectNo = PROJECT_B
      await flushUi()
      secondPlan.release()
      await flushUi(12)
      expect(double.apply).toHaveBeenCalledTimes(1)
      expect(verdictOf(root)).toBeNull()
      expect(onSynced).toHaveBeenCalledTimes(1)
      expect(onProjectTargetChanged).toHaveBeenCalledTimes(targetChangesBefore)
    })

    it('the restore path: a restore of A that lands after the board opened B starts no pull there', async () => {
      const log: string[] = []
      let releaseRestore: () => void = () => {}
      const double = api({ dryRun: vi.fn().mockImplementation(async () => { log.push('dryRun'); return PLAN }) })
      const { root, board, onSynced, onProjectTargetChanged } = mountOnBoard({
        api: double,
        targetApi: activeTarget(log, { archived: true, restore: () => new Promise<void>((done) => { releaseRestore = done }) }),
      })
      await flushUi()
      await press(root, 'stock-prep-project-sync-run')
      await press(root, 'stock-prep-project-sync-restore')
      const typed = root.querySelector('[data-testid="stock-prep-project-sync-restore-input"]') as HTMLInputElement
      typed.value = PROJECT_A
      typed.dispatchEvent(new Event('input'))
      await flushUi()
      await press(root, 'stock-prep-project-sync-restore-confirm')
      expect(log).toContain('target.restore')
      board.projectNo = PROJECT_B
      await flushUi()
      releaseRestore()
      await flushUi(12)
      // The restore stands (the server did it); the pull it would have started for A is not started on B's board.
      expect(log.filter((entry) => entry === 'dryRun')).toEqual([])
      expect(root.querySelector('[data-testid="stock-prep-project-sync-target-prompt"]'), 'no 「重新拉取」 question about A on B\'s board').toBeNull()
      expect(double.apply).not.toHaveBeenCalled()
      expect(onProjectTargetChanged).not.toHaveBeenCalled()
      expect(onSynced).not.toHaveBeenCalled()
      expect(root.querySelector('[data-testid="stock-prep-project-sync-restore-prompt"]')).toBeNull()
      expect(verdictOf(root)).toBeNull()
    })
  })
})
