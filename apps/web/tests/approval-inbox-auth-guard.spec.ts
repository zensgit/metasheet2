import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import ApprovalInboxView from '../src/views/ApprovalInboxView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    isZh: ref(true),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('../src/views/approvalInboxActionPayload', () => ({
  buildApprovalInboxActionPayload: vi.fn(),
  canActOnApprovalInboxEntry: vi.fn(() => true),
  canSubmitApprovalInboxAction: vi.fn(() => true),
  formatApprovalInboxVersion: vi.fn(() => '1'),
  resolveApprovalActionVersion: vi.fn(() => 1),
}))

vi.mock('../src/views/approvalInboxFeedback', () => ({
  readApprovalInboxErrorRecord: vi.fn(async () => ({
    code: null,
    currentVersion: null,
    message: '401 Unauthorized',
  })),
  readApprovalInboxError: vi.fn(async () => '401 Unauthorized'),
  reconcileApprovalInboxConflictVersion: vi.fn((entries: unknown[]) => entries),
  resolveApprovalInboxActionStatusAfterRefresh: vi.fn(() => ''),
}))

vi.mock('../src/views/plm/plmApprovalHistoryDisplay', () => ({
  resolvePlmApprovalHistoryActorLabel: vi.fn(() => 'actor'),
  resolvePlmApprovalHistoryVersionLabel: vi.fn(() => '1'),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ApprovalInboxView auth guard', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: '401 Unauthorized' } }),
    })

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('suppresses global unauthorized redirects when loading approvals', async () => {
    app = createApp(ApprovalInboxView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/approvals/pending?limit=50&offset=0',
      expect.objectContaining({ suppressUnauthorizedRedirect: true }),
    )
    expect(container?.textContent).toContain('401 Unauthorized')
  })
})
