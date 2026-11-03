import { createApp } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AttendancePayrollTemplateHelp from '../src/views/attendance/AttendancePayrollTemplateHelp.vue'
import AttendancePayrollCycleHelp from '../src/views/attendance/AttendancePayrollCycleHelp.vue'

const tr = (en: string, zh: string) => zh

describe('payroll help', () => {
  const containers: HTMLElement[] = []

  afterEach(() => {
    containers.splice(0).forEach((node) => node.remove())
  })

  function mount(component: object): HTMLElement {
    const container = document.createElement('div')
    document.body.appendChild(container)
    containers.push(container)
    createApp(component as never, { tr }).mount(container)
    return container
  }

  it('explains the template window, timezone, and summary field order', () => {
    const container = mount(AttendancePayrollTemplateHelp)
    const help = container.querySelector('[data-attendance-help="payroll-template"]')
    expect(help?.textContent).toContain('起始日')
    expect(help?.textContent).toContain('台北')
    expect(help?.textContent).toContain('Asia/Taipei')
    expect(help?.textContent).toContain('summaryFieldCodes')
    expect(help?.textContent).toContain('创建周期')
    expect(help?.textContent).toContain('1 日–29 日')
  })

  it('explains single create and batch generation', () => {
    const container = mount(AttendancePayrollCycleHelp)
    const help = container.querySelector('[data-attendance-help="payroll-cycle"]')
    expect(help?.textContent).toContain('年-月-日')
    expect(help?.textContent).toContain('yyyy-mm-dd')
    expect(help?.textContent).toContain('手工')
    expect(help?.textContent).toContain('加载汇总')
    expect(help?.textContent).toContain('1–36')
    expect(help?.textContent).toContain('跳过')
    expect(help?.textContent).toContain('+1 个月')
  })
})
