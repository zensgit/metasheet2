import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'

// B3-04 D-2 — ApprovalUserPicker is the ONE reusable remote participant picker wired into
// transfer / add-sign / fill-form user field / delegation delegatee, replacing the hardcoded
// 李四/王五/赵六/张三 fake option lists (see approvalDetailViewFakePickers / approvalNewViewFakePickers
// / myDelegationViewFakePickers site-level specs for the per-site tripwire + presence assertions).
// This file covers the component's OWN contract in isolation.
const searchSpy = vi.fn()
vi.mock('../src/approvals/api', () => ({
  searchApprovalDirectoryUsers: (...args: unknown[]) => searchSpy(...args),
}))

import ApprovalUserPicker from '../src/approvals/components/ApprovalUserPicker.vue'

// Minimal el-select/el-option stubs exposing JUST the surface ApprovalUserPicker depends on:
// `remote-method` invoked on typed input (a plain <input>, since a native <select> has no
// search-box concept), `update:modelValue` on pick (a plain <select> change), `loading`/
// `disabled`/`placeholder` as fallthrough-visible attrs. Real Element Plus renders far more
// (popper, keyboard nav) — this stub only proves ApprovalUserPicker wires the CONTRACT correctly.
const ElSelect = defineComponent({
  name: 'ElSelect',
  props: {
    modelValue: { type: String, default: undefined },
    loading: Boolean,
    disabled: Boolean,
    placeholder: String,
    filterable: Boolean,
    remote: Boolean,
    clearable: Boolean,
    remoteMethod: { type: Function, default: undefined },
  },
  emits: ['update:modelValue', 'visible-change'],
  render() {
    const remoteMethod = this.remoteMethod as ((q: string) => void) | undefined
    return h('div', { 'data-el-select-stub': 'true' }, [
      h('input', {
        'data-testid': 'stub-query-input',
        onInput: (e: Event) => remoteMethod?.((e.target as HTMLInputElement).value),
      }),
      h('select', {
        'data-testid': 'stub-select',
        value: this.modelValue ?? '',
        onChange: (e: Event) => {
          const value = (e.target as HTMLSelectElement).value
          this.$emit('update:modelValue', value)
        },
      }, this.$slots.default?.()),
    ])
  },
})

const ElOption = defineComponent({
  name: 'ElOption',
  props: { label: String, value: String },
  render() { return h('option', { value: this.value }, this.label) },
})

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ApprovalUserPicker', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    searchSpy.mockReset()
    searchSpy.mockResolvedValue([])
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    vi.useRealTimers()
  })

  async function mountPicker(props: Record<string, unknown> = {}) {
    const events: { 'update:modelValue': unknown[]; select: unknown[] } = {
      'update:modelValue': [],
      select: [],
    }
    const Host = defineComponent({
      setup() {
        return () =>
          h(ApprovalUserPicker, {
            ...props,
            'onUpdate:modelValue': (value: unknown) => events['update:modelValue'].push(value),
            onSelect: (option: unknown) => events.select.push(option),
          })
      },
    })
    app = createApp(Host)
    app.component('ElSelect', ElSelect)
    app.component('ElOption', ElOption)
    app.mount(container!)
    await flushUi()
    return events
  }

  it('renders with the canonical testid and shows the returned options on mount (eager empty-query search)', async () => {
    searchSpy.mockResolvedValue([
      { id: 'u1', name: 'Alice', email: 'a@x.io' },
      { id: 'u2', name: 'Bob', email: '' },
    ])
    await mountPicker()

    expect(container!.querySelector('[data-testid="approval-user-picker"]')).toBeTruthy()
    expect(searchSpy).toHaveBeenCalledWith('')
    const options = Array.from(container!.querySelectorAll('option'))
    expect(options.map((o) => o.textContent)).toEqual(['Alice · a@x.io', 'Bob'])
  })

  it('debounces remote-method (~300ms): rapid typing fires exactly one search, for the LAST query', async () => {
    vi.useFakeTimers()
    await mountPicker()
    searchSpy.mockClear() // drop the mount-time eager call; this test is about the typed path

    const input = container!.querySelector('[data-testid="stub-query-input"]') as HTMLInputElement
    input.value = 'a'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(100)
    input.value = 'al'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(100)
    input.value = 'ali'
    input.dispatchEvent(new Event('input'))

    // Still inside the 300ms settle window since the last keystroke — no search yet.
    await vi.advanceTimersByTimeAsync(200)
    expect(searchSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)
    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy).toHaveBeenCalledWith('ali')
  })

  it('selecting an option emits the id via update:modelValue and the full option via select', async () => {
    searchSpy.mockResolvedValue([{ id: 'u1', name: 'Alice', email: 'a@x.io' }])
    const events = await mountPicker()

    const select = container!.querySelector('[data-testid="stub-select"]') as HTMLSelectElement
    select.value = 'u1'
    select.dispatchEvent(new Event('change'))
    await flushUi()

    expect(events['update:modelValue']).toEqual(['u1'])
    expect(events.select).toEqual([{ id: 'u1', name: 'Alice', email: 'a@x.io' }])
  })

  it('api failure degrades to empty options — no throw, no crash', async () => {
    searchSpy.mockRejectedValue(new Error('boom'))

    await expect(mountPicker()).resolves.toBeTruthy()
    expect(container!.querySelectorAll('option').length).toBe(0)
    expect(container!.querySelector('[data-testid="approval-user-picker"]')).toBeTruthy()
  })

  it('initialOption stays visible until a fetched page includes a matching id', async () => {
    searchSpy.mockResolvedValue([{ id: 'u9', name: 'Nina', email: '' }])
    await mountPicker({ initialOption: { id: 'u-preset', name: 'Preset Person', email: '' } })

    let labels = Array.from(container!.querySelectorAll('option')).map((o) => o.textContent)
    expect(labels).toEqual(['Preset Person', 'Nina'])

    // Once a fetched page DOES include the same id, the fetched (authoritative) entry wins —
    // no duplicate option for that id.
    searchSpy.mockResolvedValue([{ id: 'u-preset', name: 'Real Name', email: 'real@x.io' }])
    const input = container!.querySelector('[data-testid="stub-query-input"]') as HTMLInputElement
    input.value = 'preset'
    input.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 320))
    await flushUi()

    labels = Array.from(container!.querySelectorAll('option')).map((o) => o.textContent)
    expect(labels).toEqual(['Real Name · real@x.io'])
  })
})
