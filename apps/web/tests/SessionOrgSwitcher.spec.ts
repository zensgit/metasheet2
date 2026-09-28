import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import SessionOrgSwitcher from '../src/components/SessionOrgSwitcher.vue'

const tr = (en: string, _zh: string) => en

describe('SessionOrgSwitcher', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mount(props: Record<string, unknown>) {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        return () => h(SessionOrgSwitcher as Component, props)
      },
    })
    app.mount(container)
    return container
  }

  it('emits an explicit choice with the generic default copy (no domain-specific wording baked in)', async () => {
    const modelValue = ref('')
    const changed: string[] = []
    const el = mount({
      tr,
      orgs: ['default', 'tenant_42'],
      modelValue: modelValue.value,
      hasUsableClaim: false,
      'onUpdate:modelValue': (value: string) => {
        modelValue.value = value
      },
      onChange: (value: string) => {
        changed.push(value)
      },
    })
    await nextTick()

    expect(el.querySelector('input[name="orgId"]')).toBeNull()
    expect(el.textContent).toContain('Choose an organization. The session will not invent one.')
    // The default hint is domain-neutral — it must not carry the attendance-only "punch history"
    // wording the original component's copy has (design lock §2, 第 8 轮 P3-b: copy travels
    // through a prop precisely so a non-attendance caller never sees it).
    expect(el.textContent).not.toContain('Punch history')

    const select = el.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'tenant_42'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(changed).toEqual(['tenant_42'])
    expect(modelValue.value).toBe('tenant_42')
  })

  it('renders caller-supplied copy overrides in place of the generic defaults', async () => {
    const el = mount({
      tr,
      orgs: ['org_a'],
      modelValue: 'org_a',
      hasUsableClaim: true,
      copy: {
        label: ['Approval organization', '审批组织'],
        defaultHint: ['Approval forms use this organization.', '审批表单使用该组织。'],
      },
    })
    await nextTick()

    expect(el.textContent).toContain('Approval organization')
    expect(el.textContent).toContain('Approval forms use this organization.')
  })

  it('shows the error hint and stays hidden when there is nothing to show', async () => {
    const withError = mount({ tr, orgs: [], modelValue: '', errorMessage: 'SESSION_ORGS_UNAVAILABLE' })
    await nextTick()
    expect(withError.textContent).toContain('SESSION_ORGS_UNAVAILABLE')

    app!.unmount()
    container!.remove()

    const emptyState = mount({ tr, orgs: [], modelValue: '', loading: false })
    await nextTick()
    expect(emptyState.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
  })
})
