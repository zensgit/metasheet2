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

  // P1-A (impl-gate-A5-daily-ops-round1-20260920.md): this component shipped with a CONSTANT DOM
  // id (`session-org-switcher-select`) on its `<select>` and its `<label for=...>`. That was
  // registered as inert in `approval-template-groups-phase1-fe-verification-20260918.md` P3-6
  // ("only one host exists today"), and the daily-ops round made two hosts on one page real: a
  // browser measured `duplicate#ids=2`, where `<label for>` binds to the FIRST match only, so the
  // second control's label was silently detached from it. The page-level fix means one switcher
  // per page again, but the id is now per instance BY CONSTRUCTION (`useId()`) rather than by
  // "there happens to be only one host" — so this case mounts two of them, the configuration that
  // discriminates, instead of asserting uniqueness over a set of one.
  it('two instances on one page get distinct select ids, each paired with its OWN label', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        return () => h('div', [
          h(SessionOrgSwitcher as Component, { tr, orgs: ['org_a', 'org_b'], modelValue: '' }),
          h(SessionOrgSwitcher as Component, { tr, orgs: ['org_a', 'org_b'], modelValue: '' }),
        ])
      },
    })
    app.mount(container)
    await nextTick()

    const selects = Array.from(container.querySelectorAll('select[name="sessionOrgId"]')) as HTMLSelectElement[]
    expect(selects.length).toBe(2)
    const ids = selects.map((select) => select.id)
    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) {
      // Exactly one element carries each id, and exactly one label points at it.
      expect(container.querySelectorAll(`[id="${id}"]`).length).toBe(1)
      expect(container.querySelectorAll(`label[for="${id}"]`).length).toBe(1)
    }
    // Each label is the one wrapping its own select, not the other instance's.
    for (const select of selects) {
      expect(select.closest('label')!.getAttribute('for')).toBe(select.id)
    }
  })
})
