import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { commentAuthorLabel } from '../src/multitable/utils/meta-comment-labels'
import MultitableCommentInboxView from '../src/views/MultitableCommentInboxView.vue'
import PublicMultitableFormView from '../src/views/PublicMultitableFormView.vue'

const mocks = vi.hoisted(() => ({
  listCommentInbox: vi.fn(),
  getCommentUnreadCount: vi.fn(),
  markCommentRead: vi.fn(),
  loadContext: vi.fn(),
  loadFormContext: vi.fn(),
  submitForm: vi.fn(),
  push: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock('../src/multitable/api/client', () => ({ multitableClient: mocks }))
vi.mock('../src/multitable/composables/useMultitableCommentInboxRealtime', () => ({
  useMultitableCommentInboxRealtime: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../src/utils/api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({
  default: defineComponent({
    props: ['readOnly', 'errorMessage', 'fieldErrors', 'fieldPermissions'],
    emits: ['submit'],
    template: `<div data-form>
      <span data-read-only>{{ readOnly }}</span>
      <span data-error>{{ errorMessage }}</span>
      <span data-field-errors>{{ JSON.stringify(fieldErrors) }}</span>
      <span data-permissions>{{ JSON.stringify(fieldPermissions) }}</span>
      <button data-submit @click="$emit('submit', { title: 'Synthetic' })">Submit</button>
    </div>`,
  }),
}))

const mounted: Array<{ app: App; container: HTMLDivElement }> = []
const publicProps = { sheetId: 'sheet-synthetic', viewId: 'view-synthetic', publicToken: 'token-synthetic' }

function mount(component: Component, props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(component, props) })
  app.mount(container)
  mounted.push({ app, container })
  return container
}

async function flushUi() {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function comment(authorName?: string) {
  return {
    id: 'comment-synthetic', containerId: 'sheet-synthetic', targetId: 'record-synthetic',
    sheetId: 'sheet-synthetic', viewId: 'view-synthetic', authorId: '00000000-0000-4000-8000-000000000001',
    authorName, content: '用户原文 / Original content', resolved: false, mentions: [],
    createdAt: '2026-01-01T00:00:00Z', unread: true, mentioned: true,
  }
}

function formContext() {
  return {
    mode: 'form', readOnly: false, fields: [],
    sheet: { id: 'sheet-synthetic' }, view: { id: 'view-synthetic' },
    fieldPermissions: { hidden: { visible: false, readOnly: true } },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  useLocale().setLocale('en')
  mocks.listCommentInbox.mockResolvedValue({ items: [comment()], total: 1 })
  mocks.getCommentUnreadCount.mockResolvedValue(1)
  mocks.loadFormContext.mockResolvedValue(formContext())
  mocks.submitForm.mockResolvedValue({ mode: 'create', record: { id: 'record-synthetic' } })
})

afterEach(() => {
  for (const { app, container } of mounted.splice(0)) {
    app.unmount()
    container.remove()
  }
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe.each(['en', 'zh-CN'])('comment and public form localization (%s)', (locale) => {
  const isZh = locale === 'zh-CN'
  beforeEach(() => useLocale().setLocale(locale))

  it('falls back for every missing author label without using an ID', () => {
    for (const authorName of [undefined, null, '', ' \t ']) {
      expect(commentAuthorLabel(authorName, isZh)).toBe(isZh ? '未知用户' : 'Unknown user')
    }
    expect(commentAuthorLabel('  王 Demo  ', isZh)).toBe('王 Demo')
  })

  it('localizes inbox chrome, preserves content and opens the unchanged target', async () => {
    const container = mount(MultitableCommentInboxView)
    await flushUi()
    expect(container.querySelector('h1')?.textContent).toBe(isZh ? '多维表格评论收件箱' : 'Multitable Comment Inbox')
    expect(container.textContent).toContain(isZh ? '未知用户' : 'Unknown user')
    expect(container.textContent).not.toContain(comment().authorId)
    expect(container.textContent).not.toContain('/api/comments/inbox')
    expect(container.textContent).toContain(comment().content)
    const buttons = container.querySelectorAll<HTMLButtonElement>('.mt-comment-inbox__button')
    expect(buttons[0].textContent).toContain(isZh ? '打开' : 'Open')
    expect(buttons[1].textContent).toContain(isZh ? '标记已读' : 'Mark read')
    buttons[0].click()
    await flushUi()
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({
      params: { sheetId: 'sheet-synthetic', viewId: 'view-synthetic' },
      query: expect.objectContaining({ recordId: 'record-synthetic', commentId: 'comment-synthetic', openComments: 'true' }),
    }))
    expect(buttons[1].disabled).toBe(true)
    expect(mocks.markCommentRead).not.toHaveBeenCalled()
  })

  it.each([true, false])('uses the server author label and preserves raw server open errors (Error=%s)', async (asError) => {
    mocks.listCommentInbox.mockResolvedValue({ items: [comment('王 Demo')], total: 1 })
    const failure = Object.assign(asError ? new Error('SHEET_ACCESS_DENIED: synthetic') : { message: 'SHEET_ACCESS_DENIED: synthetic' }, { code: 'SHEET_ACCESS_DENIED' })
    mocks.push.mockRejectedValue(failure)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const container = mount(MultitableCommentInboxView)
    await flushUi()
    expect(container.textContent).toContain('王 Demo')
    container.querySelector<HTMLButtonElement>('.mt-comment-inbox__button')!.click()
    await flushUi()
    expect(container.querySelector('.mt-comment-inbox__error')?.textContent).toBe(failure.message)
    expect(failure.code).toBe('SHEET_ACCESS_DENIED')
    expect(mocks.markCommentRead).not.toHaveBeenCalled()
  })

  it('localizes an empty inbox and the frontend open-error fallback', async () => {
    mocks.listCommentInbox.mockResolvedValueOnce({ items: [], total: 0 })
    const empty = mount(MultitableCommentInboxView)
    await flushUi()
    expect(empty.textContent).toContain(isZh ? '收件箱暂无评论。' : 'No comments in inbox yet.')
    mocks.push.mockRejectedValue({})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = mount(MultitableCommentInboxView)
    await flushUi()
    failing.querySelector<HTMLButtonElement>('.mt-comment-inbox__button')!.click()
    await flushUi()
    expect(failing.textContent).toContain(isZh ? '打开评论失败' : 'Failed to open comment')
  })

  it('localizes form loading and success without changing the token or field permissions', async () => {
    const container = mount(PublicMultitableFormView, publicProps)
    expect(container.textContent).toContain(isZh ? '正在加载表单…' : 'Loading form…')
    await flushUi()
    expect(container.querySelector('h1')?.textContent).toBe(isZh ? '公开多维表格表单' : 'Public multitable form')
    expect(container.querySelector('[data-permissions]')?.textContent).toBe(JSON.stringify(formContext().fieldPermissions))
    expect(mocks.loadFormContext).toHaveBeenCalledWith(publicProps)
    container.querySelector<HTMLButtonElement>('[data-submit]')!.click()
    await flushUi()
    expect(mocks.submitForm).toHaveBeenCalledWith('view-synthetic', expect.objectContaining({
      publicToken: 'token-synthetic', data: { title: 'Synthetic' },
    }))
    expect(container.textContent).toContain(isZh ? '已收到提交' : 'Submission received')
    expect(container.textContent).toContain(isZh ? '您的回复已提交成功。' : 'Your response has been submitted successfully.')
    expect(container.textContent).toContain(isZh ? '再提交一份' : 'Submit another response')
  })

  it.each([
    ['DINGTALK_BIND_REQUIRED', 'This form only accepts users with a bound DingTalk account.', '此表单仅接受已绑定钉钉账户的用户。'],
    ['DINGTALK_GRANT_REQUIRED', 'This form only accepts DingTalk-authorized users.', '此表单仅接受已获钉钉授权的用户。'],
    ['DINGTALK_FORM_NOT_ALLOWED', 'This form only accepts selected system users or member groups.', '此表单仅接受指定系统用户或成员组。'],
  ])('localizes %s without granting access or changing the error code', async (code, en, zh) => {
    const failure = Object.assign(new Error('Synthetic access denial'), { code })
    mocks.loadFormContext.mockRejectedValue(failure)
    const container = mount(PublicMultitableFormView, publicProps)
    await flushUi()
    expect(container.querySelector('.public-multitable-form__state-message')?.textContent).toBe(isZh ? zh : en)
    expect(container.querySelector('[data-form]')).toBeNull()
    expect(Boolean(container.querySelector('[data-dingtalk-bind]'))).toBe(code === 'DINGTALK_BIND_REQUIRED')
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(mocks.submitForm).not.toHaveBeenCalled()
    expect(failure.code).toBe(code)
  })

  it('retains raw server errors and field validation, and localizes missing-token failures', async () => {
    const failure = Object.assign(new Error('Synthetic validation message'), {
      code: 'VALIDATION_ERROR', fieldErrors: { title: 'Synthetic required field' },
    })
    mocks.submitForm.mockRejectedValue(failure)
    const container = mount(PublicMultitableFormView, publicProps)
    await flushUi()
    container.querySelector<HTMLButtonElement>('[data-submit]')!.click()
    await flushUi()
    expect(container.querySelector('[data-error]')?.textContent).toBe(failure.message)
    expect(container.querySelector('[data-field-errors]')?.textContent).toBe(JSON.stringify(failure.fieldErrors))
    expect(failure.code).toBe('VALIDATION_ERROR')
    mocks.loadFormContext.mockClear()
    const missing = mount(PublicMultitableFormView, { ...publicProps, publicToken: '' })
    await flushUi()
    expect(missing.textContent).toContain(isZh ? '缺少公开表单令牌' : 'Missing public token')
    expect(mocks.loadFormContext).not.toHaveBeenCalled()
  })

  it('keeps read-only and author-authored copy unchanged', async () => {
    mocks.loadFormContext.mockResolvedValue({
      ...formContext(), readOnly: true, view: { id: 'view-synthetic', name: 'Original 表单' },
    })
    const container = mount(PublicMultitableFormView, publicProps)
    await flushUi()
    expect(container.querySelector('h1')?.textContent).toBe('Original 表单')
    expect(container.querySelector('[data-read-only]')?.textContent).toBe('true')
    expect(mocks.submitForm).not.toHaveBeenCalled()
  })

  it('localizes missing load and submit error messages without granting access', async () => {
    mocks.loadFormContext.mockRejectedValueOnce({})
    const failed = mount(PublicMultitableFormView, publicProps)
    await flushUi()
    expect(failed.textContent).toContain(isZh ? '加载公开表单失败' : 'Failed to load public form')
    expect(failed.querySelector('[data-form]')).toBeNull()
    mocks.submitForm.mockRejectedValueOnce({})
    const form = mount(PublicMultitableFormView, publicProps)
    await flushUi()
    form.querySelector<HTMLButtonElement>('[data-submit]')!.click()
    await flushUi()
    expect(form.querySelector('[data-error]')?.textContent).toBe(isZh ? '提交公开表单失败' : 'Failed to submit public form')
    expect(form.querySelector('.public-multitable-form__state--success')).toBeNull()
  })

  it('preserves custom confirmation as text rather than translating or executing it', async () => {
    mocks.loadFormContext.mockResolvedValue({
      ...formContext(), formLayout: { confirmation: { title: '<b>Custom 标题</b>', body: 'Custom 正文' } },
    })
    const container = mount(PublicMultitableFormView, publicProps)
    await flushUi()
    container.querySelector<HTMLButtonElement>('[data-submit]')!.click()
    await flushUi()
    expect(container.querySelector('h2')?.textContent).toBe('<b>Custom 标题</b>')
    expect(container.querySelector('h2 b')).toBeNull()
    expect(container.textContent).toContain('Custom 正文')
  })
})

it('updates inbox and public-form chrome when the application locale changes', async () => {
  const inbox = mount(MultitableCommentInboxView)
  const form = mount(PublicMultitableFormView, publicProps)
  await flushUi()
  useLocale().setLocale('zh-CN')
  await nextTick()
  expect(inbox.querySelector('h1')?.textContent).toBe('多维表格评论收件箱')
  expect(inbox.textContent).toContain('未知用户')
  expect(form.querySelector('h1')?.textContent).toBe('公开多维表格表单')
})
