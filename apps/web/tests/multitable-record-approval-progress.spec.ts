/**
 * 记录抽屉 审批进度卡片 / MetaRecordApprovalPanel 「查看进度」 (Q17).
 *
 * The panel already lists a record's SUBMISSIONS (multitable route, sheet `canRead`). This slice adds a
 * collapsed, per-row read of the approval INSTANCE behind a submission — `GET /api/approvals/:id` +
 * `/:id/history`, through the approval centre's own `getApproval`/`getApprovalHistory`.
 *
 * What this file pins (and the mutation that breaks each):
 *  1. GATE. Without `approvals:read` on the FE the card renders NOTHING and no instance read is ever
 *     issued — the submissions list and its request-number link are untouched. Drop the
 *     `canReadApprovals &&` in the template (or the `if (!canReadApprovals.value) return` in
 *     `loadProgress`) ⇒ red.
 *  2. LAZY. Expanding the PANEL reads the submissions list only; the instance pair fires on first expand
 *     of THAT row's card. Fetch from the load/mount path instead ⇒ red.
 *  3. CACHE. Exactly ONE pair of reads per instance; collapse/re-expand serves the cache.
 *  4. RENDER. 第 N / M 步 (only when both are numbers), 当前待处理人 resolved through the SAME shared
 *     directory resolver the approval centre uses, and a history list — oldest first, snake_case AND
 *     camelCase rows, capped at 20 with a 「仅显示最近 20 条」 note.
 *  5. DEGRADATION. 403 → 无权查看审批进度, 404 → 你不是该审批的参与人，进度不可见, anything else →
 *     进度加载失败 + a 重试 BUTTON (403/404 get no retry — they are answers, not hiccups). The status is
 *     parsed out of `apiGet`'s generic `API error: NNN ...` throw (utils/api.ts has no typed error on
 *     that path), so map 404 onto the 403 copy ⇒ red.
 *  6. FRESHNESS. A `refreshToken` bump (the inspector's post-submit signal) drops the progress cache and
 *     collapses the card, so the next expand re-reads. Skip `invalidateProgress()` there ⇒ red.
 *  7. 完成时间 renders on TERMINAL rows only — data the list route already returns and the panel never
 *     showed. Render it for every status ⇒ red.
 *  8. A ROUTER-LESS mount adds no NEW `[Vue warn]` (the card uses no router API at all). The panel's
 *     pre-existing `useRouter()` warn is the ONLY one tolerated — see that test's own comment.
 *
 * NO REAL HTTP: `../src/approvals/api` is mocked at module level (`getApproval`/`getApprovalHistory`/
 * `resolveApprovalDirectoryUsers` only — every other export, including the real
 * `normalizeApprovalHistoryEnvelope` and the real `ApprovalDirectoryResolveError` class the resolver
 * branches on, is the genuine module).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaRecordApprovalPanel from '../src/multitable/components/MetaRecordApprovalPanel.vue'
import type { MetaRecord, MetaRecordApprovalSubmission } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { __resetResolvedDirectoryNamesForTests } from '../src/approvals/directoryResolve'
import { getApproval, getApprovalHistory, resolveApprovalDirectoryUsers } from '../src/approvals/api'

vi.mock('../src/approvals/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/api')>()
  return {
    ...actual,
    getApproval: vi.fn(),
    getApprovalHistory: vi.fn(),
    resolveApprovalDirectoryUsers: vi.fn(async () => [] as Array<{ id: string; name: string }>),
  }
})

const mockGetApproval = vi.mocked(getApproval)
const mockGetApprovalHistory = vi.mocked(getApprovalHistory)
const mockResolveUsers = vi.mocked(resolveApprovalDirectoryUsers)

async function flushUi(cycles = 6) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const RECORD = { id: 'rec_1', version: 3, data: { fld_title: 'Alpha' } } as unknown as MetaRecord

const PENDING_SUBMISSION: MetaRecordApprovalSubmission = {
  id: 'sub_1',
  templateId: 'tpl_leave',
  templateName: '请假申请',
  status: 'pending',
  approvalInstanceId: 'inst_1',
  requestNo: 'AP-2026-0001',
  submittedBy: 'u_1',
  submittedByName: '张三',
  createdAt: '2026-09-15T02:00:00.000Z',
  drift: { changed: false, changedFieldIds: [] },
}

// No approvalInstanceId — a submission whose instance was never created has nothing to read.
const CREATING_SUBMISSION: MetaRecordApprovalSubmission = {
  id: 'sub_2',
  templateId: 'tpl_purchase',
  status: 'creating',
  submittedBy: 'u_2',
  createdAt: '2026-09-15T01:00:00.000Z',
  drift: { changed: false, changedFieldIds: [] },
}

const APPROVED_SUBMISSION: MetaRecordApprovalSubmission = {
  id: 'sub_3',
  templateId: 'tpl_leave',
  status: 'approved',
  approvalInstanceId: 'inst_3',
  requestNo: 'AP-2026-0003',
  submittedBy: 'u_1',
  createdAt: '2026-09-14T02:00:00.000Z',
  completedAt: '2026-09-14T06:30:00.000Z',
  drift: { changed: false, changedFieldIds: [] },
}

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst_1',
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: null,
    businessKey: null,
    title: '请假申请',
    status: 'pending',
    requester: null,
    subject: null,
    policy: null,
    currentStep: 2,
    totalSteps: 3,
    requestNo: 'AP-2026-0001',
    currentNodeKey: 'approval_1',
    assignments: [
      { id: 'asgn_1', type: 'approval', assigneeId: 'u_manager', sourceStep: 2, nodeKey: 'approval_1', isActive: true, metadata: {} },
      // Inactive at the current node, and an ACTIVE one at a node the instance is no longer on:
      // neither is a pending approver.
      { id: 'asgn_2', type: 'approval', assigneeId: 'u_done', sourceStep: 1, nodeKey: 'approval_1', isActive: false, metadata: {} },
      { id: 'asgn_3', type: 'approval', assigneeId: 'u_later', sourceStep: 3, nodeKey: 'approval_2', isActive: true, metadata: {} },
    ],
    createdAt: '2026-09-15T02:00:00.000Z',
    updatedAt: '2026-09-15T03:00:00.000Z',
    ...overrides,
  } as never
}

const mountedApps: App[] = []

function fakeClient(rows: MetaRecordApprovalSubmission[] = [PENDING_SUBMISSION]) {
  return {
    listRecordApprovals: vi.fn().mockResolvedValue({ submissions: rows, hasMore: false }),
  }
}

interface PanelOptions {
  client?: ReturnType<typeof fakeClient>
  permissions?: string[] | null
}

function grantPermissions(permissions: string[] | null): void {
  if (permissions === null) {
    localStorage.removeItem('user_permissions')
    return
  }
  localStorage.setItem('user_permissions', JSON.stringify(permissions))
}

function mountPanel(options: PanelOptions = {}) {
  // The FE gate reads the session snapshot (useAuth().getAccessSnapshot -> localStorage
  // `user_permissions`), so the permission is granted the way a real session grants it — not by
  // stubbing the composable, which would have no discriminating power over the gate itself.
  grantPermissions(options.permissions === undefined ? ['approvals:read'] : options.permissions)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const client = options.client ?? fakeClient()
  const state = reactive({ record: RECORD as MetaRecord | null, refreshToken: 0 })
  const app = createApp({
    render() {
      return h(MetaRecordApprovalPanel, {
        record: state.record,
        sheetId: 'sheet_1',
        apiClient: client as never,
        refreshToken: state.refreshToken,
      })
    },
  })
  app.mount(container)
  mountedApps.push(app)
  return { container, app, client, state }
}

const toggle = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-test="record-approval-toggle"]')
const progressToggles = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('[data-test="record-approval-progress-toggle"]'))
const q = (root: HTMLElement, test: string) => root.querySelector<HTMLElement>(`[data-test="${test}"]`)
const qa = (root: HTMLElement, test: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(`[data-test="${test}"]`))

async function expandPanel(root: HTMLElement) {
  toggle(root)!.click()
  await flushUi()
}

async function expandProgress(root: HTMLElement, index = 0) {
  progressToggles(root)[index]!.click()
  await flushUi()
}

beforeEach(() => {
  localStorage.clear()
  __resetResolvedDirectoryNamesForTests()
  mockGetApproval.mockReset()
  mockGetApprovalHistory.mockReset()
  mockResolveUsers.mockReset()
  mockResolveUsers.mockResolvedValue([])
  mockGetApproval.mockResolvedValue(detailFixture())
  mockGetApprovalHistory.mockResolvedValue([] as never)
  useLocale().setLocale('zh')
})

afterEach(() => {
  while (mountedApps.length > 0) {
    try { mountedApps.pop()!.unmount() } catch { /* already unmounted */ }
  }
  document.body.innerHTML = ''
  __resetResolvedDirectoryNamesForTests()
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('审批进度卡片 — approvals:read gate', () => {
  it('renders NOTHING and reads no instance without approvals:read', async () => {
    const { container } = mountPanel({ permissions: [] })
    await expandPanel(container)

    // The submissions list itself is unchanged — only the progress affordance is withheld.
    expect(q(container, 'record-approval-request-no')).not.toBeNull()
    expect(q(container, 'record-approval-progress')).toBeNull()
    expect(progressToggles(container)).toHaveLength(0)
    expect(mockGetApproval).not.toHaveBeenCalled()
    expect(mockGetApprovalHistory).not.toHaveBeenCalled()
  })

  it('renders NOTHING when the session carries no permission snapshot at all', async () => {
    const { container } = mountPanel({ permissions: null })
    await expandPanel(container)
    expect(q(container, 'record-approval-progress')).toBeNull()
  })

  it('renders the collapsed affordance WITH approvals:read — and still reads no instance', async () => {
    const { container } = mountPanel()
    await expandPanel(container)

    const toggles = progressToggles(container)
    expect(toggles).toHaveLength(1)
    expect(toggles[0]!.textContent).toContain('查看进度')
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(q(container, 'record-approval-progress-body')).toBeNull()
    // LAZY: expanding the PANEL read the submissions list, nothing else.
    expect(mockGetApproval).not.toHaveBeenCalled()
    expect(mockGetApprovalHistory).not.toHaveBeenCalled()
  })

  it('offers no card for a submission that has no approvalInstanceId', async () => {
    const { container } = mountPanel({ client: fakeClient([CREATING_SUBMISSION, PENDING_SUBMISSION]) })
    await expandPanel(container)
    expect(qa(container, 'record-approval-entry')).toHaveLength(2)
    expect(progressToggles(container)).toHaveLength(1)
    expect(progressToggles(container)[0]!.getAttribute('data-instance')).toBe('inst_1')
  })
})

describe('审批进度卡片 — lazy fetch + cache', () => {
  it('fetches BOTH reads exactly once on first expand and serves the cache afterwards', async () => {
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    expect(mockGetApproval).toHaveBeenCalledTimes(1)
    expect(mockGetApproval).toHaveBeenCalledWith('inst_1')
    expect(mockGetApprovalHistory).toHaveBeenCalledTimes(1)
    expect(mockGetApprovalHistory).toHaveBeenCalledWith('inst_1')
    expect(progressToggles(container)[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(q(container, 'record-approval-progress-body')).not.toBeNull()

    // collapse → expand again: cached, no second pair of reads
    await expandProgress(container)
    expect(q(container, 'record-approval-progress-body')).toBeNull()
    await expandProgress(container)
    expect(mockGetApproval).toHaveBeenCalledTimes(1)
    expect(mockGetApprovalHistory).toHaveBeenCalledTimes(1)
    expect(q(container, 'record-approval-progress-step')!.textContent).toContain('第 2 / 3 步')
  })

  it('reads each row independently (expanding one card never reads the other instance)', async () => {
    const { container } = mountPanel({ client: fakeClient([PENDING_SUBMISSION, APPROVED_SUBMISSION]) })
    await expandPanel(container)
    expect(progressToggles(container)).toHaveLength(2)

    await expandProgress(container, 1)
    expect(mockGetApproval).toHaveBeenCalledTimes(1)
    expect(mockGetApproval).toHaveBeenCalledWith('inst_3')
  })
})

describe('审批进度卡片 — rendering', () => {
  it('renders 步骤, 当前待处理人 (shared directory resolver) and history from snake_case rows', async () => {
    mockResolveUsers.mockResolvedValue([{ id: 'u_manager', name: '李四' }])
    mockGetApprovalHistory.mockResolvedValue([
      // Platform branch shape: snake_case, no camelCase siblings (approvals/api.ts documents the drift).
      { id: 'h2', action: 'approve', actor_id: 'u_1', actor_name: '张三', comment: '同意', from_status: 'pending', to_status: 'pending', occurred_at: '2026-09-15T04:00:00.000Z' },
      { id: 'h1', action: 'created', actor_id: 'u_1', actor_name: '张三', comment: null, from_status: null, to_status: 'pending', occurred_at: '2026-09-15T02:00:00.000Z' },
    ] as never)

    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    expect(q(container, 'record-approval-progress-step')!.textContent).toContain('第 2 / 3 步')

    // The batch resolve was kicked off for the ids this card shows, and the resolved name is rendered
    // (never the raw internal user id, never the 「成员 N」 fallback once a name lands).
    expect(mockResolveUsers).toHaveBeenCalled()
    const approvers = q(container, 'record-approval-progress-approvers')!.textContent!
    expect(approvers).toContain('当前待处理人')
    expect(approvers).toContain('李四')
    expect(approvers).not.toContain('u_manager')
    // Only the ACTIVE assignment at the CURRENT node.
    expect(approvers).not.toContain('u_done')
    expect(approvers).not.toContain('u_later')

    const rows = qa(container, 'record-approval-progress-history-row')
    expect(rows).toHaveLength(2)
    // OLDEST FIRST, regardless of the order the server sent.
    expect(rows[0]!.textContent).toContain('发起')
    expect(rows[1]!.textContent).toContain('通过')
    expect(rows[1]!.textContent).toContain('张三')
    expect(rows[1]!.textContent).toContain('同意')
    expect(q(container, 'record-approval-progress-history-more')).toBeNull()
  })

  it('renders camelCase history rows (the PLM branch / UnifiedApprovalHistoryDTO shape) identically', async () => {
    mockGetApprovalHistory.mockResolvedValue([
      { id: 'h1', action: 'created', actorId: 'u_1', actorName: '张三', comment: null, fromStatus: null, toStatus: 'pending', occurredAt: '2026-09-15T02:00:00.000Z', metadata: {} },
      { id: 'h2', action: 'reject', actorId: 'u_2', actorName: '王五', comment: '金额有误', fromStatus: 'pending', toStatus: 'rejected', occurredAt: '2026-09-15T05:00:00.000Z', metadata: {} },
    ] as never)

    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    const rows = qa(container, 'record-approval-progress-history-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('发起')
    expect(rows[0]!.textContent).toContain('张三')
    expect(rows[1]!.textContent).toContain('驳回')
    expect(rows[1]!.textContent).toContain('王五')
    expect(rows[1]!.textContent).toContain('金额有误')
  })

  it('shows an unknown action code RAW rather than dropping the row', async () => {
    mockGetApprovalHistory.mockResolvedValue([
      { id: 'h1', action: 'teleport', actorName: '张三', comment: null, occurredAt: '2026-09-15T02:00:00.000Z' },
    ] as never)
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)
    expect(qa(container, 'record-approval-progress-history-row')).toHaveLength(1)
    expect(q(container, 'record-approval-progress-history-action')!.textContent).toContain('teleport')
  })

  it('caps history at 20 rows (newest kept, still oldest-first) with the 仅显示最近 20 条 note', async () => {
    mockGetApprovalHistory.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        id: `h${i}`,
        action: 'comment',
        actorName: `A${i}`,
        comment: `c${i}`,
        occurredAt: new Date(Date.UTC(2026, 8, 15, 0, i)).toISOString(),
      })) as never,
    )

    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    const rows = qa(container, 'record-approval-progress-history-row')
    expect(rows).toHaveLength(20)
    // Rows 0..4 were dropped: the NEWEST 20 survive, rendered oldest-first.
    expect(rows[0]!.textContent).toContain('A5')
    expect(rows[19]!.textContent).toContain('A24')
    expect(q(container, 'record-approval-progress-history-more')!.textContent).toContain('仅显示最近 20 条')
  })

  it('omits the step line when either number is absent, and says so when there is no history', async () => {
    mockGetApproval.mockResolvedValue(detailFixture({ currentStep: null, totalSteps: 3, currentNodeKey: null, assignments: [] }))
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    expect(q(container, 'record-approval-progress-step')).toBeNull()
    expect(q(container, 'record-approval-progress-approvers')).toBeNull()
    expect(q(container, 'record-approval-progress-history')).toBeNull()
    expect(q(container, 'record-approval-progress-history-empty')!.textContent).toContain('暂无历史记录')
  })

  it('falls back to a values-free ordinal when the directory cannot confirm a name', async () => {
    mockResolveUsers.mockResolvedValue([])
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    const approvers = q(container, 'record-approval-progress-approvers')!.textContent!
    expect(approvers).toContain('成员 1')
    expect(approvers).not.toContain('u_manager')
  })

  it('renders parallel-gateway approvers from currentNodeKeys', async () => {
    mockGetApproval.mockResolvedValue(detailFixture({
      currentNodeKey: 'legal_review',
      currentNodeKeys: ['legal_review', 'compliance_review'],
      assignments: [
        { id: 'a1', type: 'approval', assigneeId: 'u_legal', sourceStep: 1, nodeKey: 'legal_review', isActive: true, metadata: { assigneeName: '法务甲' } },
        { id: 'a2', type: 'approval', assigneeId: 'u_comp', sourceStep: 1, nodeKey: 'compliance_review', isActive: true, metadata: { assigneeName: '合规乙' } },
      ],
    }))
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    const approvers = q(container, 'record-approval-progress-approvers')!.textContent!
    expect(approvers).toContain('法务甲')
    expect(approvers).toContain('合规乙')
  })
})

describe('审批进度卡片 — values-free degradation', () => {
  // utils/api.ts's apiGet throws `new Error('API error: ' + status + ' ' + statusText)` — a GENERIC
  // Error with no status property. These fixtures are that exact shape on purpose.
  const apiError = (status: number, statusText: string) => new Error(`API error: ${status} ${statusText}`)

  it('maps 403 to 无权查看审批进度 with no retry', async () => {
    mockGetApproval.mockRejectedValue(apiError(403, 'Forbidden'))
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    expect(q(container, 'record-approval-progress-error')!.textContent).toContain('无权查看审批进度')
    expect(q(container, 'record-approval-progress-retry')).toBeNull()
  })

  it('maps 404 to the NON-PARTICIPANT sentence, not the permission one', async () => {
    mockGetApproval.mockRejectedValue(apiError(404, 'Not Found'))
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    const text = q(container, 'record-approval-progress-error')!.textContent!
    expect(text).toContain('你不是该审批的参与人，进度不可见')
    expect(text).not.toContain('无权查看审批进度')
    expect(q(container, 'record-approval-progress-retry')).toBeNull()
  })

  it('maps anything else to 进度加载失败 with a manual 重试 that re-reads once', async () => {
    mockGetApproval.mockRejectedValueOnce(apiError(500, 'Internal Server Error'))
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    expect(q(container, 'record-approval-progress-error')!.textContent).toContain('进度加载失败')
    const retry = q(container, 'record-approval-progress-retry')!
    expect(mockGetApproval).toHaveBeenCalledTimes(1)

    // NO auto-retry: the failure sits there until the operator asks.
    await flushUi()
    expect(mockGetApproval).toHaveBeenCalledTimes(1)

    retry.click()
    await flushUi()
    expect(mockGetApproval).toHaveBeenCalledTimes(2)
    expect(q(container, 'record-approval-progress-error')).toBeNull()
    expect(q(container, 'record-approval-progress-step')!.textContent).toContain('第 2 / 3 步')
  })

  it('falls back to the generic failure when the thrown value carries no readable status', async () => {
    mockGetApprovalHistory.mockRejectedValue(new Error('Network request failed'))
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    expect(q(container, 'record-approval-progress-error')!.textContent).toContain('进度加载失败')
    expect(q(container, 'record-approval-progress-retry')).not.toBeNull()
  })

  it('prefers a typed error status over the message when one is present', async () => {
    const typed = Object.assign(new Error('API error: 500 Internal Server Error'), { status: 403 })
    mockGetApproval.mockRejectedValue(typed)
    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    expect(q(container, 'record-approval-progress-error')!.textContent).toContain('无权查看审批进度')
  })
})

describe('审批进度卡片 — freshness', () => {
  it('drops the cache and collapses the card on a refreshToken bump, so the next expand re-reads', async () => {
    const { container, state } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)
    expect(mockGetApproval).toHaveBeenCalledTimes(1)

    state.refreshToken += 1
    await flushUi()

    // Collapsed, and NOT re-read by the invalidation itself (still lazy).
    expect(q(container, 'record-approval-progress-body')).toBeNull()
    expect(progressToggles(container)[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(mockGetApproval).toHaveBeenCalledTimes(1)

    await expandProgress(container)
    expect(mockGetApproval).toHaveBeenCalledTimes(2)
    expect(mockGetApprovalHistory).toHaveBeenCalledTimes(2)
  })

  it('drops the cache on a record version move too', async () => {
    const { container, state } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)
    expect(mockGetApproval).toHaveBeenCalledTimes(1)

    state.record = { ...(RECORD as object), version: 4 } as unknown as MetaRecord
    await flushUi()
    expect(q(container, 'record-approval-progress-body')).toBeNull()

    await expandProgress(container)
    expect(mockGetApproval).toHaveBeenCalledTimes(2)
  })
})

describe('审批进度卡片 — 完成时间', () => {
  it('renders 完成时间 on a terminal row and never on a pending one', async () => {
    const { container } = mountPanel({ client: fakeClient([PENDING_SUBMISSION, APPROVED_SUBMISSION]) })
    await expandPanel(container)

    const completed = qa(container, 'record-approval-completed-at')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.textContent).toContain('完成时间')
    // The formatted value is locale/TZ dependent; pin that it is the completedAt instant, not createdAt.
    expect(completed[0]!.textContent).toContain(new Date('2026-09-14T06:30:00.000Z').toLocaleString())

    const entries = qa(container, 'record-approval-entry')
    expect(entries[0]!.querySelector('[data-test="record-approval-completed-at"]')).toBeNull()
  })

  it('does not render 完成时间 for a non-terminal row that somehow carries one', async () => {
    const odd = { ...PENDING_SUBMISSION, completedAt: '2026-09-14T06:30:00.000Z' }
    const { container } = mountPanel({ client: fakeClient([odd]) })
    await expandPanel(container)
    expect(qa(container, 'record-approval-completed-at')).toHaveLength(0)
  })
})

describe('审批进度卡片 — router-less mount', () => {
  it('adds no NEW [Vue warn] on a router-less mount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { container } = mountPanel()
    await expandPanel(container)
    await expandProgress(container)

    // The panel's own `useRouter()` (line ~194) is an unguarded `inject(routerKey)`, so a router-less
    // mount has ALWAYS logged exactly this warning; PR #5766 is replacing that line with
    // `inject(routerKey, null)` and this assertion stays green either way. Anything the progress card
    // itself might add (a second router API, a missing required prop, a failed injection) is NOT in
    // that allow-list and fails here.
    const unexpected = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => !/injection "Symbol\(router\)" not found/.test(message))
    expect(unexpected).toEqual([])
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual([])
    expect(q(container, 'record-approval-progress-step')).not.toBeNull()
  })
})
