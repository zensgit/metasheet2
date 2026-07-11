// UI-P2-1c batch5: PublicMultitableFormView's error-state DingTalk-bind retry and success-state "Submit
// another response" reset control — both sharers of `.public-multitable-form__button` (migrated together per
// the shared-class rule) — were migrated from bespoke <button> elements to the shared MtButton primitive:
// the error/`--error` control = variant="danger" (the bespoke #be123c fill is a semantic danger match), the
// success/base control = variant="primary" (the bespoke #14532d fill is normalized to the single
// --ms-color-primary token, same category as prior sanctioned shade normalizations). Behavior-preservation
// proof: both stay a native <button>, the bind control keeps its :disabled="bindingToDingTalk" gate, and
// clicking either still runs the SAME handler (launchDingTalkBinding / resetForm) as before.
//
// The form's own Submit button (rendered inside MetaFormView.vue, stubbed here) is out of scope: it is
// `type="submit"` inside the author-facing form flow, not byte-equivalent to MtButton's hardcoded
// `type="button"` — same exclusion already documented for MultitableHomeView's create-and-open control.
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
  it('DingTalk-bind retry: renders as a native <button> (MtButton, variant="danger") and clicking it runs launchDingTalkBinding', async () => {
    loadFormContextSpy.mockRejectedValue(Object.assign(new Error('DingTalk binding is required for this form'), {
      code: 'DINGTALK_BIND_REQUIRED',
    }))
    apiFetchSpy.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { url: 'https://login.dingtalk.com/oauth2/auth?bind=1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    const container = mountPublicForm(PublicMultitableFormView)
    await flushUi()

    const btn = container.querySelector<HTMLButtonElement>('[data-dingtalk-bind]')!
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--danger')).toBe(true)
    expect(btn.disabled).toBe(false)

    btn.click()
    await flushUi()

    expect(apiFetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/dingtalk/launch?intent=bind&redirect='),
      expect.objectContaining({ suppressUnauthorizedRedirect: true }),
    )
    expect(container.textContent).toContain('Redirecting to DingTalk binding…')
  })

  it('DingTalk-bind retry: after a failed launch, the error state (and the same MtButton) re-appears un-disabled and a second click retries the SAME handler', async () => {
    // launchDingTalkBinding sets bindingToDingTalk=true synchronously (before its first await), which
    // flips the view to the "Redirecting…" branch (v-if="... || bindingToDingTalk") and unmounts this
    // button for that instant — so :disabled="bindingToDingTalk" (preserved byte-for-byte from the bespoke
    // markup) never has an observable "visible + disabled" frame. What IS observable, and what this test
    // pins, is the full round-trip: on failure the catch path resets bindingToDingTalk=false and restores
    // loadErrorCode, so the SAME bind button re-mounts un-disabled and a second click reaches the handler
    // again — proving :disabled is wired to real state, not a dead prop, and the click binding survives re-mounts.
    loadFormContextSpy.mockRejectedValue(Object.assign(new Error('bind required'), { code: 'DINGTALK_BIND_REQUIRED' }))
    apiFetchSpy.mockRejectedValueOnce(new Error('network down'))

    const { default: PublicMultitableFormView } = await import('../src/views/PublicMultitableFormView.vue')
    const container = mountPublicForm(PublicMultitableFormView)
    await flushUi()

    container.querySelector<HTMLButtonElement>('[data-dingtalk-bind]')!.click()
    await flushUi()

    expect(apiFetchSpy).toHaveBeenCalledTimes(1)
    const btnAfterFailure = container.querySelector<HTMLButtonElement>('[data-dingtalk-bind]')
    expect(btnAfterFailure).not.toBeNull() // re-mounted (error branch showing again)
    expect(btnAfterFailure!.disabled).toBe(false) // bindingToDingTalk reset to false on the catch path
    expect(btnAfterFailure!.classList.contains('mt-button--danger')).toBe(true)

    apiFetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true, data: { url: 'https://login.dingtalk.com/oauth2/auth?bind=1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    btnAfterFailure!.click()
    await flushUi()

    expect(apiFetchSpy).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Redirecting to DingTalk binding…')
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
