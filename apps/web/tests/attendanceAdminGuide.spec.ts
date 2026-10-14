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
})
