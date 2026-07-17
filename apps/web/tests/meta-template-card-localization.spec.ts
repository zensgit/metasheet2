import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaTemplateCard from '../src/multitable/components/MetaTemplateCard.vue'
import type { MetaTemplate } from '../src/multitable/types'

const template: MetaTemplate = {
  id: 'project-tracker',
  name: 'Project Tracker',
  description: 'Track project work.',
  category: 'Project management',
  icon: 'kanban',
  color: '#2563eb',
  translations: {
    'zh-CN': {
      name: '项目跟进',
      description: '跟踪项目工作。',
      category: '项目管理',
    },
  },
  sheets: [],
}

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  useLocale().setLocale('en')
})

describe('MetaTemplateCard localization', () => {
  it('updates catalog content immediately when the active locale changes', async () => {
    useLocale().setLocale('en')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({ setup: () => () => h(MetaTemplateCard, { template }) })
    app.mount(container)

    expect(container.textContent).toContain('Project Tracker')
    expect(container.textContent).toContain('Track project work.')
    expect(container.textContent).toContain('Project management')
    expect(container.textContent).toContain('Use template')

    useLocale().setLocale('zh-CN')
    await nextTick()

    expect(container.textContent).toContain('项目跟进')
    expect(container.textContent).toContain('跟踪项目工作。')
    expect(container.textContent).toContain('项目管理')
    expect(container.textContent).toContain('使用模板')
    expect(container.textContent).not.toContain('Project Tracker')
  })
})
