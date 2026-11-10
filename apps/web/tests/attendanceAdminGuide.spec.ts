import { createApp, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import AttendanceAdminGuide from '../src/views/attendance/AttendanceAdminGuide.vue'

const tr = (en: string, zh: string) => zh

async function mount(props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const events: string[] = []
  const app = createApp(AttendanceAdminGuide, {
    tr,
    ...props,
    onSelectSection: (id: string) => events.push(id),
  })
  app.mount(container)
  await nextTick()
  return { container, events, app }
}

describe('attendance admin guide', () => {
  it('covers the management-center topics with code-accurate lines', async () => {
    const { container, app } = await mount()
    const expectTopic = async (id: string, phrase: string) => {
      container.querySelector<HTMLButtonElement>(`[data-attendance-guide-topic="${id}"]`)!.click()
      await nextTick()
      expect(container.querySelector(`[data-attendance-guide-article="${id}"]`)?.textContent).toContain(phrase)
    }
    expect(container.textContent).toContain('我的申请')
    await expectTopic('settings', '自动缺勤')
    await expectTopic('holidays', '节假日同步')
    await expectTopic('payroll', 'summaryFieldCodes')
    await expectTopic('rules', '默认规则')
    await expectTopic('groups', '不计入考勤人员')
    await expectTopic('availability', '366')
    await expectTopic('annual', '2027-01-01')
    await expectTopic('fields', '同步字段目录')
    await expectTopic('import', '10 分钟')
    app.unmount()
    container.remove()
  })

  it('opens the availability article for the team-availability section', async () => {
    const { container, events, app } = await mount({
      activeSectionId: 'attendance-admin-team-availability',
    })
    const article = container.querySelector('[data-attendance-guide-article]')
    expect(article?.getAttribute('data-attendance-guide-article')).toBe('availability')
    expect(article?.textContent).toContain('6000')
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-open]')!.click()
    expect(events).toEqual(['attendance-admin-team-availability'])
    app.unmount()
    container.remove()
  })

  it('filters topics as the search text changes', async () => {
    const { container, app } = await mount()
    const search = container.querySelector<HTMLInputElement>('[data-attendance-guide-search]')
    expect(search).toBeTruthy()
    search!.value = '口径说明'
    search!.dispatchEvent(new Event('input'))
    await nextTick()
    const topics = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-attendance-guide-topic]'))
      .map(button => button.getAttribute('data-attendance-guide-topic'))
    expect(topics).toEqual(['reports'])
    expect(container.querySelector('[data-attendance-guide-article="reports"]')?.textContent).toContain('口径说明')
    search!.value = ''
    search!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(container.querySelector('[data-attendance-guide-topic="settings"]')).toBeTruthy()
    app.unmount()
    container.remove()
  })

  it('switches articles from the topic list', async () => {
    const { container, app } = await mount({ activeSectionId: 'attendance-admin-settings' })
    expect(container.querySelector('[data-attendance-guide-article="settings"]')).toBeTruthy()
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="import"]')!.click()
    await nextTick()
    expect(container.querySelector('[data-attendance-guide-article="import"]')?.textContent).toContain('导入批次')
    app.unmount()
    container.remove()
  })

  it('lays the article out as intro, scenarios, steps, and FAQ with an outline', async () => {
    const { container, app } = await mount()
    const article = container.querySelector('[data-attendance-guide-article="overview"]')
    expect(article?.querySelector('h1')?.textContent).toContain('总览')
    expect(article?.querySelector('[data-attendance-guide-section="intro"]')?.textContent).toContain('功能简介')
    expect(article?.querySelector('[data-attendance-guide-section="scenarios"]')?.textContent).toContain('适用场景')
    expect(article?.querySelector('[data-attendance-guide-section="steps"]')?.textContent).toContain('操作流程')
    expect(article?.querySelector('[data-attendance-guide-section="faq"]')?.textContent).toContain('常见问题')
    expect(article?.querySelector('[data-attendance-guide-section="faq"]')?.textContent).toContain('答')
    const outline = container.querySelector('[data-attendance-guide-outline]')
    expect(outline?.textContent).toContain('功能简介')
    expect(container.querySelector('[data-attendance-guide-group="configure"]')).toBeTruthy()
    app.unmount()
    container.remove()
  })

  it('requires approve or admin to view others’ reports and does not treat export scope as that permission', async () => {
    const { container, app } = await mount()
    for (const id of ['reports', 'records', 'scopes', 'permissions'] as const) {
      container.querySelector<HTMLButtonElement>(`[data-attendance-guide-topic="${id}"]`)!.click()
      await nextTick()
      const article = container.querySelector(`[data-attendance-guide-article="${id}"]`)
      expect(article?.textContent).toContain('attendance:approve')
      expect(article?.textContent).toContain('attendance:admin')
      expect(article?.textContent).not.toContain('或一条覆盖该人的排班导出范围')
      expect(article?.textContent).not.toContain('或包含导出的排班范围')
      expect(article?.textContent).not.toContain('scheduler scope that includes export')
    }
    const exportScopeWording = '排班“导出范围”不授予页面查看他人报表的权限。普通记录导出在缺少查看他人权限时，按该范围校验；已有查看他人权限者不受该范围限制。工资周期导出不采用这个后备检查。'
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="reports"]')!.click()
    await nextTick()
    const reports = container.querySelector('[data-attendance-guide-article="reports"]')
    expect(reports?.textContent).toContain('要查看别人的用户 ID，需要 attendance:approve 或 attendance:admin')
    expect(reports?.textContent).toContain(exportScopeWording)
    expect(reports?.textContent).not.toContain('只限制能导出哪些人的行')
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="records"]')!.click()
    await nextTick()
    const records = container.querySelector('[data-attendance-guide-article="records"]')
    expect(records?.textContent).toContain('查看其他人需要 attendance:approve 或 attendance:admin')
    expect(records?.textContent).toContain(exportScopeWording)
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="scopes"]')!.click()
    await nextTick()
    const scopes = container.querySelector('[data-attendance-guide-article="scopes"]')
    expect(scopes?.textContent).toContain('查看他人仍需要 attendance:approve 或 attendance:admin')
    expect(scopes?.textContent).toContain(exportScopeWording)
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="permissions"]')!.click()
    await nextTick()
    const permissions = container.querySelector('[data-attendance-guide-article="permissions"]')
    expect(permissions?.textContent).toContain(exportScopeWording)
    expect(permissions?.textContent).toContain('attendance:import')
    expect(permissions?.textContent).toContain('管理员：读 + 写 + 审批 + 导入 + 管理')
    expect(permissions?.textContent).not.toContain('管理员：读 + 写 + 审批 + 管理')
    app.unmount()
    container.remove()
  })

  it('counts makeup quota by the work-date period and not by the submit month', async () => {
    const { container, app } = await mount()
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="makeup"]')!.click()
    await nextTick()
    const makeup = container.querySelector('[data-attendance-guide-article="makeup"]')
    expect(makeup?.textContent).toContain('工作日期所在周期')
    expect(makeup?.textContent).toContain('不会因为提交时间到了下个月而换到新周期或恢复额度')
    expect(makeup?.textContent).toContain('不按提交日期的月份')
    expect(makeup?.textContent).not.toContain('MAKEUP_PUNCH_QUOTA_EXCEEDED：等到下个周期')
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="errors"]')!.click()
    await nextTick()
    const errors = container.querySelector('[data-attendance-guide-article="errors"]')
    expect(errors?.textContent).toContain('额度按工作日期所在周期计算')
    expect(errors?.textContent).toContain('不要等到下个自然月再为同一个旧工作日提交')
    expect(errors?.textContent).not.toContain('处理：等到下个自然月')
    app.unmount()
    container.remove()
  })

  it('tells the reader to reload after date, organization, or person filter changes before export', async () => {
    const { container, app } = await mount()
    const reloadWording = '日期、组织或人员筛选变化后，请重新加载数据再导出。'
    for (const id of ['reports', 'records'] as const) {
      container.querySelector<HTMLButtonElement>(`[data-attendance-guide-topic="${id}"]`)!.click()
      await nextTick()
      const article = container.querySelector(`[data-attendance-guide-article="${id}"]`)
      expect(article?.textContent).toContain(reloadWording)
      expect(article?.textContent).not.toContain('筛选过期时导出会被拦住')
      if (id === 'reports') {
        expect(article?.textContent).toContain('重载报表')
        expect(article?.textContent).not.toContain('再导出。然后点')
      }
    }
    app.unmount()
    container.remove()
  })

  it('directs a punch-order conflict to makeup or time correction instead of retrying check-in', async () => {
    const { container, app } = await mount()
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="punch"]')!.click()
    await nextTick()
    const punch = container.querySelector('[data-attendance-guide-article="punch"]')
    expect(punch?.textContent).toContain('ATTENDANCE_PUNCH_ORDER_CONFLICT')
    expect(punch?.textContent).toContain('不要再点「上班打卡」')
    expect(punch?.textContent).toContain('补卡')
    expect(punch?.textContent).toContain('时间更正')
    expect(punch?.textContent).not.toContain('ATTENDANCE_PUNCH_ORDER_CONFLICT：先上班打卡，再下班打卡')
    container.querySelector<HTMLButtonElement>('[data-attendance-guide-topic="errors"]')!.click()
    await nextTick()
    const errors = container.querySelector('[data-attendance-guide-article="errors"]')
    expect(errors?.textContent).toContain('不要再点「上班打卡」')
    expect(errors?.textContent).toContain('漏打上班卡')
    expect(errors?.textContent).toContain('时间更正')
    expect(errors?.textContent).not.toContain('处理：先点「上班打卡」，再点「下班打卡」')
    app.unmount()
    container.remove()
  })
})
