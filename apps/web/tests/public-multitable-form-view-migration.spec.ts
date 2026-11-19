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
    },
    emits: ['submit'],
    template: `
      <div class="meta-form-view-stub">
        <button data-submit type="button" @click="$emit('submit', { fld_title: 'Alpha' })">Submit</button>
      </div>
    `,
  }),
}))

const mounted: VueApp<Element>[] = []
const containers: HTMLDivElement[] = []

function mountPublicForm(PublicMultitableFormView: any, props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
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
  const app = createApp(Root)
  app.mount(container)
  mounted.push(app)
  return container
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  while (containers.length) containers.pop()!.remove()
  document.body.innerHTML = ''
  loadFormContextSpy.mockReset()
  submitFormSpy.mockReset()
  apiFetchSpy.mockReset()
})

describe('PublicMultitableFormView — MtButton migration (UI-P2-1c batch5)', () => {
  it.each([
    ['DINGTALK_BIND_REQUIRED', 'Ask an administrator about the available options'],
    ['DINGTALK_GRANT_REQUIRED', 'This form only accepts DingTalk-authorized users.'],
  ])('keeps %s errors closed without a self-binding retry control', async (code, message) => {
    loadFormContextSpy.mockRejectedValue(Object.assign(new Error('provider detail must not be shown'), { code }))

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    const container = mountPublicForm(PublicMultitableFormView)
    await flushUi()

    expect(container.querySelector('[data-dingtalk-bind]')).toBeNull()
    expect(container.textContent).toContain(message)
    expect(container.textContent).not.toContain('provider detail must not be shown')
    expect(apiFetchSpy).not.toHaveBeenCalled()
    expect(submitFormSpy).not.toHaveBeenCalled()
  })

  it('resetForm: renders as a native <button> (MtButton, variant="primary") and clicking it runs resetForm, returning to the live form', async () => {
    loadFormContextSpy.mockResolvedValue({
      mode: 'form',
      readOnly: false,
      sheet: { id: 'sheet_orders', name: 'Orders' },
      view: { id: 'view_form', sheetId: 'sheet_orders', name: 'Request form', type: 'form' },
      fields: [{ id: 'fld_title', name: 'Title', type: 'string' }],
      capabilities: {
        canRead: true, canCreateRecord: true, canEditRecord: false, canDeleteRecord: false,
        canManageFields: false, canManageSheetAccess: false, canManageViews: false,
        canComment: false, canManageAutomation: false, canExport: false,
      },
    })
    submitFormSpy.mockResolvedValue({ mode: 'create', record: { id: 'rec_1', version: 1, data: {} } })

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    const container = mountPublicForm(PublicMultitableFormView)
    await flushUi()

    container.querySelector<HTMLButtonElement>('[data-submit]')!.click()
    await flushUi()
    expect(container.textContent).toContain('Submission received')

    const resetBtn = container.querySelector<HTMLButtonElement>('.public-multitable-form__button:not([data-dingtalk-bind])')!
    expect(resetBtn.tagName).toBe('BUTTON')
    expect(resetBtn.classList.contains('mt-button--primary')).toBe(true)
    expect(resetBtn.textContent).toContain('Submit another response')

    resetBtn.click()
    await flushUi()

    // resetForm() clears submitted/submissionResult and bumps formKey — the live form (stub) is back.
    expect(container.textContent).not.toContain('Submission received')
    expect(container.querySelector('.meta-form-view-stub')).not.toBeNull()
  })
})
