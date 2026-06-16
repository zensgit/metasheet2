import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const loadFormContextSpy = vi.fn()
const submitFormSpy = vi.fn()
const apiFetchSpy = vi.fn()

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    loadFormContext: (...args: any[]) => loadFormContextSpy(...args),
    submitForm: (...args: any[]) => submitFormSpy(...args),
  },
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: any[]) => apiFetchSpy(...args),
}))

vi.mock('../src/multitable/components/MetaFormView.vue', () => ({
  default: defineComponent({
    name: 'MetaFormViewStub',
    props: {
      fields: { type: Array, default: () => [] },
      loading: { type: Boolean, default: false },
      readOnly: { type: Boolean, default: false },
      submitting: { type: Boolean, default: false },
      errorMessage: { type: String, default: null },
      formLayout: { type: Object, default: null },
      initialValues: { type: Object, default: null },
    },
    emits: ['submit'],
    template: `
      <div class="meta-form-view-stub">
        <span data-fields>{{ fields.length }}</span>
        <span data-loading>{{ loading }}</span>
        <span data-read-only>{{ readOnly }}</span>
        <span data-error>{{ errorMessage || '' }}</span>
        <span data-prefill>{{ JSON.stringify(initialValues || {}) }}</span>
        <span data-has-layout>{{ formLayout ? 'yes' : 'no' }}</span>
        <button data-submit type="button" @click="$emit('submit', { fld_title: 'Alpha' })">Submit</button>
      </div>
    `,
  }),
}))

describe('PublicMultitableFormView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    loadFormContextSpy.mockReset()
    submitFormSpy.mockReset()
    apiFetchSpy.mockReset()
  })

  it('loads form context anonymously and submits with the public token', async () => {
    loadFormContextSpy.mockResolvedValue({
      mode: 'form',
      readOnly: false,
      submitPath: '/api/multitable/views/view_form/submit',
      sheet: { id: 'sheet_orders', name: 'Orders' },
      view: { id: 'view_form', sheetId: 'sheet_orders', name: 'Request form', type: 'form' },
      fields: [{ id: 'fld_title', name: 'Title', type: 'string' }],
      capabilities: {
        canRead: true,
        canCreateRecord: true,
        canEditRecord: false,
        canDeleteRecord: false,
        canManageFields: false,
        canManageSheetAccess: false,
        canManageViews: false,
        canComment: false,
        canManageAutomation: false,
        canExport: false,
      },
    })
    submitFormSpy.mockResolvedValue({
      mode: 'create',
      record: { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } },
      commentsScope: {
        targetType: 'meta_record',
        targetId: 'rec_1',
        containerType: 'meta_sheet',
        containerId: 'sheet_orders',
      },
    })

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')

    container = document.createElement('div')
    document.body.appendChild(container)

    const Root = defineComponent({
      render() {
        return h(PublicMultitableFormView, {
          sheetId: 'sheet_orders',
          viewId: 'view_form',
          publicToken: 'pub_123',
        })
      },
    })

    app = createApp(Root)
    app.mount(container)

    expect(container.textContent).toContain('Loading secure form access...')

    await flushUi()

    expect(loadFormContextSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_form',
      publicToken: 'pub_123',
    })
    expect(container.textContent).toContain('Public multitable form')
    expect(container.textContent).toContain('Orders · Request form')

    container.querySelector<HTMLButtonElement>('[data-submit]')?.click()
    await flushUi()

    expect(submitFormSpy).toHaveBeenCalledWith('view_form', expect.objectContaining({
      publicToken: 'pub_123',
      data: { fld_title: 'Alpha' },
    }))
    expect(container.textContent).toContain('Submission received')
    expect(container.textContent).toContain('Your response has been submitted successfully.')
  })

  it('launches DingTalk sign-in when the form requires authenticated DingTalk access', async () => {
    loadFormContextSpy.mockRejectedValue(Object.assign(new Error('DingTalk sign-in is required for this form'), {
      code: 'DINGTALK_AUTH_REQUIRED',
    }))
    apiFetchSpy.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { url: 'https://login.dingtalk.com/oauth2/auth?demo=1' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')

    container = document.createElement('div')
    document.body.appendChild(container)

    const Root = defineComponent({
      render() {
        return h(PublicMultitableFormView, {
          sheetId: 'sheet_orders',
          viewId: 'view_form',
          publicToken: 'pub_123',
        })
      },
    })

    app = createApp(Root)
    app.mount(container)
    await flushUi()

    expect(apiFetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/dingtalk/launch?redirect='),
      expect.objectContaining({ suppressUnauthorizedRedirect: true }),
    )
    expect(container.textContent).toContain('Redirecting to DingTalk sign-in…')
  })

  it('offers DingTalk binding when a signed-in user is not bound', async () => {
    loadFormContextSpy.mockRejectedValue(Object.assign(new Error('DingTalk binding is required for this form'), {
      code: 'DINGTALK_BIND_REQUIRED',
    }))
    apiFetchSpy.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { url: 'https://login.dingtalk.com/oauth2/auth?bind=1' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')

    container = document.createElement('div')
    document.body.appendChild(container)

    const Root = defineComponent({
      render() {
        return h(PublicMultitableFormView, {
          sheetId: 'sheet_orders',
          viewId: 'view_form',
          publicToken: 'pub_123',
        })
      },
    })

    app = createApp(Root)
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('This form only accepts users with a bound DingTalk account.')
    const bindButton = container.querySelector<HTMLButtonElement>('[data-dingtalk-bind]')
    expect(bindButton?.textContent).toContain('Bind DingTalk and return to this form')

    bindButton?.click()
    await flushUi()

    expect(apiFetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/dingtalk/launch?intent=bind&redirect='),
      expect.objectContaining({ suppressUnauthorizedRedirect: true }),
    )
    expect(container.textContent).toContain('Redirecting to DingTalk binding…')
  })

  it('shows an allowlist message when the DingTalk user is not selected for the form', async () => {
    loadFormContextSpy.mockRejectedValue(Object.assign(new Error('Only selected system users or member groups can access this form'), {
      code: 'DINGTALK_FORM_NOT_ALLOWED',
    }))

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')

    container = document.createElement('div')
    document.body.appendChild(container)

    const Root = defineComponent({
      render() {
        return h(PublicMultitableFormView, {
          sheetId: 'sheet_orders',
          viewId: 'view_form',
          publicToken: 'pub_123',
        })
      },
    })

    app = createApp(Root)
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('This form only accepts selected system users or member groups.')
  })

  // --- A4: thank-you customization, post-submit redirect, prefill plumbing ---

  function baseFormContext(extra: Record<string, unknown> = {}) {
    return {
      mode: 'form',
      readOnly: false,
      submitPath: '/api/multitable/views/view_form/submit',
      sheet: { id: 'sheet_orders', name: 'Orders' },
      view: { id: 'view_form', sheetId: 'sheet_orders', name: 'Request form', type: 'form' },
      fields: [{ id: 'fld_title', name: 'Title', type: 'string' }],
      capabilities: {
        canRead: true,
        canCreateRecord: true,
        canEditRecord: false,
        canDeleteRecord: false,
        canManageFields: false,
        canManageSheetAccess: false,
        canManageViews: false,
        canComment: false,
        canManageAutomation: false,
        canExport: false,
      },
      ...extra,
    }
  }

  function mountPublicForm(PublicMultitableFormView: any, props: Record<string, unknown>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Root = defineComponent({
      render() {
        return h(PublicMultitableFormView, {
          sheetId: 'sheet_orders',
          viewId: 'view_form',
          publicToken: 'pub_123',
          ...props,
        })
      },
    })
    app = createApp(Root)
    app.mount(container)
  }

  it('renders the author-customized thank-you title/body after submit', async () => {
    loadFormContextSpy.mockResolvedValue(baseFormContext({
      formLayout: { confirmation: { title: 'All done!', body: 'We received your request.' } },
    }))
    submitFormSpy.mockResolvedValue({ mode: 'create', record: { id: 'rec_1', version: 1, data: {} } })

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    mountPublicForm(PublicMultitableFormView, {})
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-submit]')?.click()
    await flushUi()

    expect(container!.textContent).toContain('All done!')
    expect(container!.textContent).toContain('We received your request.')
    expect(container!.textContent).not.toContain('Submission received')
  })

  it('falls back to the default English thank-you copy when unset', async () => {
    loadFormContextSpy.mockResolvedValue(baseFormContext())
    submitFormSpy.mockResolvedValue({ mode: 'create', record: { id: 'rec_1', version: 1, data: {} } })

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    mountPublicForm(PublicMultitableFormView, {})
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-submit]')?.click()
    await flushUi()

    expect(container!.textContent).toContain('Submission received')
    expect(container!.textContent).toContain('Your response has been submitted successfully.')
  })

  it('redirects to a same-origin relative URL after submit (window.location.assign)', async () => {
    const assignSpy = vi.fn()
    const originalLocation = window.location
    // jsdom's location.assign is non-configurable; replace the whole location.
    Object.defineProperty(window, 'location', { value: { assign: assignSpy }, configurable: true })

    loadFormContextSpy.mockResolvedValue(baseFormContext({
      formLayout: { redirect: { url: '/thanks' } },
    }))
    submitFormSpy.mockResolvedValue({ mode: 'create', record: { id: 'rec_1', version: 1, data: {} } })

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    mountPublicForm(PublicMultitableFormView, {})
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-submit]')?.click()
    await flushUi()

    expect(assignSpy).toHaveBeenCalledWith('/thanks')

    Object.defineProperty(window, 'location', { value: originalLocation, configurable: true })
  })

  it('does NOT redirect to a javascript:/cross-origin URL — shows the normal success state', async () => {
    const assignSpy = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', { value: { assign: assignSpy }, configurable: true })

    // A projection should already have stripped this, but assert the client
    // re-validates: an unsafe URL that slipped through must not navigate.
    loadFormContextSpy.mockResolvedValue(baseFormContext({
      formLayout: { redirect: { url: 'https://evil.com/steal' } },
    }))
    submitFormSpy.mockResolvedValue({ mode: 'create', record: { id: 'rec_1', version: 1, data: {} } })

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    mountPublicForm(PublicMultitableFormView, {})
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-submit]')?.click()
    await flushUi()

    expect(assignSpy).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('Submission received')

    Object.defineProperty(window, 'location', { value: originalLocation, configurable: true })
  })

  it('plumbs allowlisted prefill query into MetaFormView, filtering non-allowlisted fields', async () => {
    loadFormContextSpy.mockResolvedValue(baseFormContext({
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_secret', name: 'Secret', type: 'string' },
      ],
      formLayout: { prefill: { prefillableFieldIds: ['fld_title'] } },
    }))

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    mountPublicForm(PublicMultitableFormView, {
      prefillQuery: { prefill_fld_title: 'Hello', prefill_fld_secret: 'leak' },
    })
    await flushUi()

    const prefill = JSON.parse(container!.querySelector('[data-prefill]')?.textContent || '{}')
    expect(prefill).toEqual({ fld_title: 'Hello' })
    expect(container!.querySelector('[data-has-layout]')?.textContent).toBe('yes')
  })
})
