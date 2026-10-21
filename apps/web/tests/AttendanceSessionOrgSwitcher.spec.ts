import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AttendanceSessionOrgSwitcher from '../src/views/attendance/AttendanceSessionOrgSwitcher.vue'

const tr = (en: string, _zh: string) => en

describe('AttendanceSessionOrgSwitcher', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('emits an explicit choice and never writes a punch/history orgId input', async () => {
    const modelValue = ref('')
    const changed: string[] = []
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp({
      setup() {
        return () => h(AttendanceSessionOrgSwitcher as Component, {
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
      },
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('input[name="orgId"]')).toBeNull()
    expect(container.textContent).toContain('Choose an organization. The session will not invent one.')

    const select = container.querySelector('select[name="sessionOrgId"]') as HTMLSelectElement
    select.value = 'tenant_42'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(changed).toEqual(['tenant_42'])
    expect(modelValue.value).toBe('tenant_42')
  })
})
