import { describe, expect, it } from 'vitest'
import type { MetaTemplate } from '../src/multitable/types'
import {
  localizeTemplate,
  templateCatalogLabel,
  templateCount,
  templateDefaultBaseName,
  templateMatchCount,
  templateTotal,
} from '../src/multitable/utils/template-localization'

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
      sheets: {
        tasks: {
          name: '任务',
          description: '项目任务流程',
          fields: { task: '任务' },
          views: { grid: '全部任务' },
        },
      },
    },
  },
  sheets: [{
    id: 'tasks',
    name: 'Tasks',
    description: 'Project task pipeline',
    fields: [
      { id: 'task', name: 'Task', type: 'string', order: 0 },
      { id: 'owner', name: 'Owner', type: 'string', order: 1 },
    ],
    views: [
      { id: 'grid', name: 'All Tasks', type: 'grid' },
      { id: 'calendar', name: 'Calendar', type: 'calendar' },
    ],
  }],
}

describe('template localization', () => {
  it('returns canonical English unchanged', () => {
    expect(localizeTemplate(template, 'en')).toBe(template)
  })

  it('localizes translated catalog content and falls back field by field', () => {
    const localized = localizeTemplate(template, 'zh-CN')

    expect(localized).not.toBe(template)
    expect(localized.name).toBe('项目跟进')
    expect(localized.description).toBe('跟踪项目工作。')
    expect(localized.category).toBe('项目管理')
    expect(localized.sheets[0].name).toBe('任务')
    expect(localized.sheets[0].description).toBe('项目任务流程')
    expect(localized.sheets[0].fields.map((field) => field.name)).toEqual(['任务', 'Owner'])
    expect(localized.sheets[0].views.map((view) => view.name)).toEqual(['全部任务', 'Calendar'])
    expect(template.sheets[0].fields[0].name).toBe('Task')
  })

  it('uses the existing category translation for descriptors without locale metadata', () => {
    const salesTemplate = { ...template, category: 'Sales', translations: undefined }
    expect(localizeTemplate(salesTemplate, 'zh-CN').category).toBe('CRM')
  })

  it('builds locale-aware default workspace names and static copy', () => {
    expect(templateDefaultBaseName(template, true)).toBe('项目跟进工作区')
    expect(templateDefaultBaseName(template, false)).toBe('Project Tracker Base')
    expect(templateDefaultBaseName({ ...template, translations: undefined }, true)).toBe('Project Tracker Base')
    expect(templateCatalogLabel('center.title', true)).toBe('模板中心')
    expect(templateCatalogLabel('center.title', false)).toBe('Template Center')
    expect(templateCount(1, false)).toBe('1 template')
    expect(templateCount(2, true)).toBe('2 个')
    expect(templateTotal(2, false)).toBe('2 templates total')
    expect(templateMatchCount(1, 2, true)).toBe('匹配 1 / 2 个模板')
  })
})
