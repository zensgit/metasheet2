/**
 * 记录抽屉 审批面板 / MetaRecordApprovalPanel — 多维表 × 审批 阶段二 PR 2b (design
 * docs/development/takeover-beiliao-20260821/multitable-approval-phase2-record-submit-design-20260915.md
 * §5 "抽屉新面板", verification matrix §6 "前端" row).
 *
 * What this file pins (and the mutation that breaks each):
 *  1. LAZY: no request on record open; the list is read on FIRST EXPAND only, and collapse/re-expand
 *     does NOT re-read (drop the `if (loaded.value || loading.value) return` guard, or fetch from the
 *     watcher/`onMounted` instead of `onToggle` ⇒ red).
 *  2. SELF-GATING: no apiClient / no sheetId / no record ⇒ the section is absent, not broken — the
 *     shape several FROZEN drawer specs mount (design §2 item 10).
 *  3. A router-less mount does not crash and shows the request number as plain text; with a router it
 *     is a RouterLink to `approval-detail`.
 *  4. StatusTag renders the submission status through the shared status renderer.
 *  5. The drift notice shows a COUNT ("送审后数据已变更（N 个字段）") and never a field name or value.
 *  6. A record switch resets the panel (the next record must not show the previous one's approvals);
 *     a version bump / refreshToken bump re-reads immediately while OPEN and invalidates the cache while
 *     COLLAPSED (so the next expand re-reads) — the panel stays lazy either way, but a change is never
 *     dropped. A signal that lands mid-read is queued, not swallowed.
 *  7. `{ changed: true, changedFieldIds: [] }` (the answer for an actor whose field-read mask hides every
 *     changed field) renders the COUNT-FREE notice, never "0 个字段".
 *  8. The two submission-only statuses ('creating'/'failed') render localized copy rather than the raw
 *     English token StatusTag's neutral fallback would print; a failed row explains itself by CODE.
 *  9. The refresh watcher compares its two sources PER ELEMENT: an id-equal, version-equal `record`
 *     replacement (what an ordinary grid re-read hands down) fires NO request while expanded.
 *     Collapse the source back into one getter returning an array ⇒ red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MetaRecordApprovalPanel from '../src/multitable/components/MetaRecordApprovalPanel.vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord, MetaRecordApprovalSubmission } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FIELDS = [{ id: 'fld_title', name: 'Title', type: 'string' }] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 3, data: { fld_title: 'Alpha' } } as unknown as MetaRecord

const SUBMISSIONS: MetaRecordApprovalSubmission[] = [
  {
    id: 'sub_1',
    templateId: 'tpl_leave',
    templateName: '请假申请',
    status: 'pending',
    approvalInstanceId: 'inst_1',
    requestNo: 'AP-2026-0001',
    submittedBy: 'u_1',
    submittedByName: '张三',
    createdAt: '2026-09-15T02:00:00.000Z',
    drift: { changed: true, changedFieldIds: ['fld_qty', 'fld_note'] },
  },
  {
    id: 'sub_0',
    templateId: 'tpl_purchase',
    status: 'approved',
    submittedBy: 'u_2',
    createdAt: '2026-09-14T02:00:00.000Z',
    drift: { changed: false, changedFieldIds: [] },
  },
]

const mountedApps: App[] = []

function fakeClient(rows: MetaRecordApprovalSubmission[] | Error = SUBMISSIONS) {
  return {
    listRecordApprovals: rows instanceof Error
      ? vi.fn().mockRejectedValue(rows)
      : vi.fn().mockResolvedValue(rows),
  }
}

interface PanelOptions {
  client?: ReturnType<typeof fakeClient> | null
  sheetId?: string | undefined
  record?: MetaRecord | null
  withRouter?: boolean
}

function mountPanel(options: PanelOptions = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const client = options.client === undefined ? fakeClient() : options.client
  const state = reactive({
    record: 'record' in options ? options.record : RECORD,
    refreshToken: 0,
  })
  const app = createApp({
    render() {
      return h(MetaRecordApprovalPanel, {
        record: state.record as MetaRecord | null,
        sheetId: 'sheetId' in options ? options.sheetId : 'sheet_1',
        ...(client ? { apiClient: client as never } : {}),
        refreshToken: state.refreshToken,
      })
    },
  })
  if (options.withRouter) {
    app.use(createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div />' } },
        { path: '/approvals/:id', name: 'approval-detail', component: { template: '<div />' } },
      ],
    }))
  }
  app.mount(container)
  mountedApps.push(app)
  return { container, app, client, state }
}

const section = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-test="record-approval"]')
const toggle = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-test="record-approval-toggle"]')
const entries = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-test="record-approval-entry"]'))

async function expand(root: HTMLElement) {
  toggle(root)!.click()
  await flushUi(6)
}

afterEach(() => {
  while (mountedApps.length > 0) {
    try { mountedApps.pop()!.unmount() } catch { /* already unmounted */ }
  }
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('MetaRecordApprovalPanel — lazy, self-gated', () => {
  it('renders collapsed with NO request on record open, and fetches on FIRST expand only', async () => {
    const { container, client } = mountPanel()
    await flushUi()
    expect(section(container)).not.toBeNull()
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(client!.listRecordApprovals).not.toHaveBeenCalled()

    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)
    expect(client!.listRecordApprovals).toHaveBeenCalledWith('sheet_1', 'rec_1')
    expect(entries(container)).toHaveLength(2)

    // collapse → expand again: the loaded list is reused, no second read
    await expand(container)
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('false')
    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)
    expect(entries(container)).toHaveLength(2)
  })

  it('hides itself entirely when there is no apiClient (frozen drawer-spec mount shape)', async () => {
    const { container } = mountPanel({ client: null })
    await flushUi()
    expect(section(container)).toBeNull()
  })

  it('hides itself entirely when there is no sheetId', async () => {
    const { container, client } = mountPanel({ sheetId: undefined })
    await flushUi()
    expect(section(container)).toBeNull()
    expect(client!.listRecordApprovals).not.toHaveBeenCalled()
  })

  it('hides itself entirely when there is no record', async () => {
    const { container } = mountPanel({ record: null })
    await flushUi()
    expect(section(container)).toBeNull()
  })
})

describe('MetaRecordApprovalPanel — rows', () => {
  it('renders template name (falling back to templateId), StatusTag, submitter and timestamp', async () => {
    const { container } = mountPanel()
    await flushUi()
    await expand(container)
    const rows = entries(container)
    expect(rows[0].querySelector('[data-test="record-approval-template"]')!.textContent).toBe('请假申请')
    // No templateName on the second row ⇒ the id is shown rather than a blank cell.
    expect(rows[1].querySelector('[data-test="record-approval-template"]')!.textContent).toBe('tpl_purchase')
    const tags = container.querySelectorAll('.ms-status-tag')
    expect(tags).toHaveLength(2)
    expect(tags[0].getAttribute('data-domain')).toBe('approvalInstance')
    expect(tags[0].getAttribute('data-status')).toBe('pending')
    expect(tags[0].textContent).toBe('Pending')
    expect(tags[1].getAttribute('data-status')).toBe('approved')
    expect(rows[0].querySelector('[data-test="record-approval-submitted-by"]')!.textContent).toContain('张三')
    expect(rows[0].querySelector('[data-test="record-approval-created-at"]')).not.toBeNull()
  })

  it('shows the drift notice as a COUNT — never a field id and never a value', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountPanel()
    await flushUi()
    await expand(container)
    const drift = container.querySelector('[data-test="record-approval-drift"]')
    expect(drift).not.toBeNull()
    expect(drift!.textContent).toBe('送审后数据已变更（2 个字段）')
    expect(container.textContent).not.toContain('fld_qty')
    // The clean row carries no notice at all.
    expect(entries(container)[1].querySelector('[data-test="record-approval-drift"]')).toBeNull()
  })

  it('without a router the request number is plain text (no crash, no link)', async () => {
    const { container } = mountPanel()
    await flushUi()
    await expand(container)
    expect(container.querySelector('[data-test="record-approval-request-text"]')!.textContent).toBe('AP-2026-0001')
    expect(container.querySelector('[data-test="record-approval-request-link"]')).toBeNull()
  })

  it('with a router the request number links to the approval instance', async () => {
    const { container } = mountPanel({ withRouter: true })
    await flushUi()
    await expand(container)
    const link = container.querySelector<HTMLAnchorElement>('[data-test="record-approval-request-link"]')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/approvals/inst_1')
    expect(link!.textContent).toBe('AP-2026-0001')
  })

  it('an empty list shows the empty state, a failed read shows the error state', async () => {
    const { container } = mountPanel({ client: fakeClient([]) })
    await flushUi()
    await expand(container)
    expect(container.querySelector('[data-test="record-approval-empty"]')).not.toBeNull()

    const failed = mountPanel({ client: fakeClient(new Error('boom')) })
    await flushUi()
    await expand(failed.container)
    expect(failed.container.querySelector('[data-test="record-approval-error"]')).not.toBeNull()
    expect(failed.container.querySelector('[data-test="record-approval-list"]')).toBeNull()
  })
})

describe('MetaRecordApprovalPanel — refresh signals', () => {
  it('switching record resets the panel (collapsed, no stale rows, no eager read)', async () => {
    const { container, client, state } = mountPanel()
    await flushUi()
    await expand(container)
    expect(entries(container)).toHaveLength(2)

    state.record = { id: 'rec_2', version: 1, data: {} } as unknown as MetaRecord
    await flushUi(6)
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(entries(container)).toHaveLength(0)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)

    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(2)
    expect(client!.listRecordApprovals).toHaveBeenLastCalledWith('sheet_1', 'rec_2')
  })

  it('a record-updated refresh (version bump) re-reads while OPEN, and stays lazy while collapsed', async () => {
    const { container, client, state } = mountPanel()
    await flushUi()
    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)

    state.record = { ...(RECORD as object), version: 4 } as unknown as MetaRecord
    await flushUi(6)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(2)

    // collapsed: a further version bump must NOT fetch
    await expand(container)
    state.record = { ...(RECORD as object), version: 5 } as unknown as MetaRecord
    await flushUi(6)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(2)
  })

  it('an equal-version record replacement (an ordinary grid re-read) does NOT re-fetch while OPEN', async () => {
    // Regression (阶段二 前端裁判 item 2): the refresh watcher's source used to be ONE getter returning a
    // fresh array — `() => [props.record?.version, props.refreshToken] as const`. `watch` compares a
    // getter's RESULT with Object.is, and two arrays holding the same two numbers are never Object.is
    // equal, so the callback fired on every re-evaluation, i.e. every time MultitableWorkbench handed
    // this panel a NEW `record` object for the SAME row at the SAME version — which any grid page
    // reload / unrelated re-read does. An expanded panel therefore issued a GET per reload with nothing
    // to show for it. Restore the single-getter source and the first `toHaveBeenCalledTimes(1)` below
    // goes red (2 calls). The multi-source form compares PER ELEMENT.
    const { container, client, state } = mountPanel()
    await flushUi()
    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('true')

    // Same id, same version, brand-new object identity — exactly what a re-read hands down.
    state.record = { id: 'rec_1', version: 3, data: { fld_title: 'Alpha' } } as unknown as MetaRecord
    await flushUi(6)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)
    // Still open, still showing the rows it already had — the cache was not invalidated either.
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(entries(container)).toHaveLength(2)

    // A REAL change still re-reads, exactly once (the fix narrows the trigger, it does not remove it).
    state.record = { id: 'rec_1', version: 4, data: { fld_title: 'Beta' } } as unknown as MetaRecord
    await flushUi(6)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(2)
  })

  it('a version bump that lands while COLLAPSED is picked up by the next expand (never dropped)', async () => {
    // Mirrors the refreshToken case below. Before the fix the collapsed branch only invalidated for a
    // token change, so an edit made while the panel was closed left `loaded === true` and the next
    // expand was a no-op — the stale rows (and a stale "no drift" state) were shown for the whole mount.
    const { container, client, state } = mountPanel()
    await flushUi()
    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)

    await expand(container) // collapse
    expect(toggle(container)!.getAttribute('aria-expanded')).toBe('false')
    state.record = { ...(RECORD as object), version: 5 } as unknown as MetaRecord
    await flushUi(6)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1) // still lazy: nothing fetched yet

    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(2)
  })

  it('a refresh signal that lands DURING a read is queued, not swallowed', async () => {
    let resolveFirst: (rows: MetaRecordApprovalSubmission[]) => void = () => {}
    const first = new Promise<MetaRecordApprovalSubmission[]>((resolve) => { resolveFirst = resolve })
    const listRecordApprovals = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(SUBMISSIONS)
    const { container, state } = mountPanel({ client: { listRecordApprovals } as never })
    await flushUi()

    toggle(container)!.click()
    await flushUi(2)
    expect(listRecordApprovals).toHaveBeenCalledTimes(1)

    // The post-submit signal arrives while the first read is still in flight.
    state.refreshToken += 1
    await flushUi(2)
    resolveFirst([])
    await flushUi(8)

    expect(listRecordApprovals).toHaveBeenCalledTimes(2)
    expect(entries(container)).toHaveLength(2)
  })

  it('a refreshToken bump after a submit re-reads while open, and invalidates the cache while collapsed', async () => {
    const { container, client, state } = mountPanel()
    await flushUi()
    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(1)

    state.refreshToken += 1
    await flushUi(6)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(2)

    // collapse, bump again (submit from a closed panel), then expand: the list is re-read, not reused.
    await expand(container)
    state.refreshToken += 1
    await flushUi(6)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(2)
    await expand(container)
    expect(client!.listRecordApprovals).toHaveBeenCalledTimes(3)
  })
})

describe('MetaRecordApprovalPanel — server answers that are not the happy path', () => {
  const masked: MetaRecordApprovalSubmission[] = [{
    id: 'sub_m',
    templateId: 'tpl_leave',
    status: 'pending',
    submittedBy: 'u_1',
    // The route's own answer when the version moved but every changed field is outside this viewer's
    // field-read mask (record-approval-submission-service.ts computeRecordApprovalDrift).
    drift: { changed: true, changedFieldIds: [] },
  }]

  it('renders the COUNT-FREE drift notice when the server masked every changed field id', async () => {
    useLocale().setLocale('zh-CN')
    const { container } = mountPanel({ client: fakeClient(masked) })
    await flushUi()
    await expand(container)
    const drift = container.querySelector('[data-test="record-approval-drift"]')
    expect(drift).not.toBeNull()
    expect(drift!.textContent).toBe('送审后数据已变更')
    expect(drift!.textContent).not.toContain('0 个字段')
  })

  it('localizes the two submission-only statuses instead of printing the raw English token', async () => {
    useLocale().setLocale('zh-CN')
    const rows: MetaRecordApprovalSubmission[] = [
      { id: 'sub_f', templateId: 'tpl_leave', status: 'failed', error: 'RECORD_APPROVAL_PERMISSION_DENIED', drift: { changed: false, changedFieldIds: [] } },
      { id: 'sub_c', templateId: 'tpl_leave', status: 'creating', drift: { changed: false, changedFieldIds: [] } },
    ]
    const { container } = mountPanel({ client: fakeClient(rows) })
    await flushUi()
    await expand(container)
    const tags = Array.from(container.querySelectorAll('[data-test="record-approval-local-status"]'))
    expect(tags.map((tag) => tag.textContent)).toEqual(['提交失败', '提交中'])
    expect(container.textContent).not.toContain('failed')
    expect(container.textContent).not.toContain('creating')
    // A failed row explains itself by CODE — localized copy, never the raw token, never a value.
    const reason = container.querySelector('[data-test="record-approval-failure"]')!
    expect(reason.textContent).toContain('没有送审权限')
    expect(reason.textContent).not.toContain('RECORD_APPROVAL_PERMISSION_DENIED')
    // StatusTag still owns every status it knows: these two rows carry none.
    expect(container.querySelectorAll('.ms-status-tag')).toHaveLength(0)
  })

  it('an UNKNOWN failure code prints nothing rather than a raw token', async () => {
    const rows: MetaRecordApprovalSubmission[] = [
      { id: 'sub_f', templateId: 'tpl_leave', status: 'failed', error: 'SOME_NEW_CODE', drift: { changed: false, changedFieldIds: [] } },
    ]
    const { container } = mountPanel({ client: fakeClient(rows) })
    await flushUi()
    await expand(container)
    expect(container.querySelector('[data-test="record-approval-failure"]')).toBeNull()
    expect(container.textContent).not.toContain('SOME_NEW_CODE')
  })
})

describe('MetaRecordApprovalPanel inside the record inspector', () => {
  it('sits in the 详情 tab and is mounted with the inspector sheetId/apiClient', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const client = {
      getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
      listRecordHistory: vi.fn().mockResolvedValue([]),
      listRecordApprovals: vi.fn().mockResolvedValue(SUBMISSIONS),
    }
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: RECORD,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          sheetId: 'sheet_1',
          apiClient: client as never,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    await flushUi()
    expect(section(container)).not.toBeNull()
    expect(client.listRecordApprovals).not.toHaveBeenCalled()
    await expand(container)
    expect(client.listRecordApprovals).toHaveBeenCalledWith('sheet_1', 'rec_1')
    expect(entries(container)).toHaveLength(2)
  })

  it('is absent from the inspector when it is mounted with no apiClient (frozen drawer harness)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: RECORD,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    await flushUi()
    expect(section(container)).toBeNull()
  })
})
