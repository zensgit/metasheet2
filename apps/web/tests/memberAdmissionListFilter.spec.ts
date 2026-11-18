import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MemberAdmissionListFilter, { type MemberAdmissionFilterStatus } from '../src/components/MemberAdmissionListFilter.vue'

type FilterState = {
  namespaces: string[]
  namespace: string
  status: MemberAdmissionFilterStatus
  namespaceEvents: string[]
  statusEvents: MemberAdmissionFilterStatus[]
}

async function flushUi(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

describe('MemberAdmissionListFilter', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  function mountFilter(initial: Partial<FilterState> = {}): { root: HTMLDivElement; state: FilterState } {
    const state = reactive<FilterState>({
      namespaces: initial.namespaces ?? ['attendance', 'crm'],
      namespace: initial.namespace ?? '',
      status: initial.status ?? '',
      namespaceEvents: [],
      statusEvents: [],
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        return () => h(MemberAdmissionListFilter, {
          namespaces: state.namespaces,
          namespace: state.namespace,
          status: state.status,
          'onUpdate:namespace': (namespace: string) => {
            state.namespaceEvents.push(namespace)
            state.namespace = namespace
          },
          'onUpdate:status': (status: MemberAdmissionFilterStatus) => {
            state.statusEvents.push(status)
            state.status = status
          },
        })
      },
    })
    app.mount(container)
    return { root: container, state }
  }

  function namespaceSelect(root: ParentNode): HTMLSelectElement {
    return root.querySelector('[data-testid="member-admission-namespace"]') as HTMLSelectElement
  }

  function statusSelect(root: ParentNode): HTMLSelectElement {
    return root.querySelector('[data-testid="member-admission-status"]') as HTMLSelectElement
  }

  async function choose(select: HTMLSelectElement, value: string): Promise<void> {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
  }

  it('renders native namespace and admission status selects', async () => {
    const { root } = mountFilter()
    await flushUi()
    const namespace = namespaceSelect(root)
    const status = statusSelect(root)
    expect(namespace.tagName).toBe('SELECT')
    expect(status.tagName).toBe('SELECT')
    expect(Array.from(namespace.options).map((option) => option.value)).toEqual(['', 'attendance', 'crm'])
    expect(Array.from(status.options).map((option) => option.textContent)).toEqual(['全部', '已开通', '未开通'])
    const note = root.querySelector('[data-testid="member-admission-filter-note"]')?.textContent || ''
    expect(note).toContain('开通记录')
    expect(note).toContain('角色')
    expect(note).toContain('权限')
  })

  it('does not let status be chosen before a namespace', async () => {
    const { root, state } = mountFilter()
    await flushUi()
    const status = statusSelect(root)
    expect(status.disabled).toBe(true)
    await choose(status, 'enabled')
    expect(state.statusEvents).toEqual([])
    expect(state.status).toBe('')
    expect(status.disabled).toBe(true)
  })

  it('emits namespace and status so the full list can be queried again', async () => {
    const { root, state } = mountFilter()
    await flushUi()
    await choose(namespaceSelect(root), 'attendance')
    expect(state.namespaceEvents).toEqual(['attendance'])
    expect(state.statusEvents).toEqual([])
    expect(statusSelect(root).disabled).toBe(false)
    await choose(statusSelect(root), 'enabled')
    expect(state.statusEvents).toEqual(['enabled'])
    await choose(namespaceSelect(root), 'crm')
    expect(state.namespaceEvents).toEqual(['attendance', 'crm'])
    expect(state.status).toBe('enabled')
    expect(statusSelect(root).value).toBe('enabled')
  })

  it('clears status when the namespace filter is cleared', async () => {
    const { root, state } = mountFilter({ namespace: 'crm', status: 'disabled' })
    await flushUi()
    expect(statusSelect(root).disabled).toBe(false)
    expect(statusSelect(root).value).toBe('disabled')
    await choose(namespaceSelect(root), '')
    expect(state.namespaceEvents).toEqual([''])
    expect(state.statusEvents).toEqual([''])
    expect(state.namespace).toBe('')
    expect(state.status).toBe('')
    expect(statusSelect(root).disabled).toBe(true)
    expect(statusSelect(root).value).toBe('')
  })

  it('hides the filter when no namespace is available', async () => {
    const { root } = mountFilter({ namespaces: [] })
    await flushUi()
    expect(root.querySelector('[data-testid="member-admission-filter"]')).toBeNull()
    expect(root.querySelector('select')).toBeNull()
  })
})
