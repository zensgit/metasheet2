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
    },
    emits: ['submit'],
    template: `
      <div class="meta-form-view-stub">
        <span data-fields>{{ fields.length }}</span>
        <span data-loading>{{ loading }}</span>
        <span data-read-only>{{ readOnly }}</span>
        <span data-error>{{ errorMessage || '' }}</span>
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
})
