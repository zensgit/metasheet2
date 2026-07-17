import type { MetaTemplate } from '../types'
import { categoryLabel } from './category-labels'

export type TemplateCatalogLocale = 'en' | 'zh-CN'

export type TemplateCatalogLabelKey =
  | 'home.aria'
  | 'home.title'
  | 'home.viewAll'
  | 'home.loading'
  | 'home.empty'
  | 'home.loadFailed'
  | 'center.eyebrow'
  | 'center.title'
  | 'center.subtitle'
  | 'center.back'
  | 'center.refresh'
  | 'center.refreshing'
  | 'center.controlsAria'
  | 'center.categoriesAria'
  | 'center.all'
  | 'center.search'
  | 'center.searchPlaceholder'
  | 'center.retry'
  | 'center.loading'
  | 'center.empty'
  | 'center.noMatch'
  | 'center.loadFailed'
  | 'install.noView'
  | 'install.failed'

const TEMPLATE_CATALOG_LABELS: Record<TemplateCatalogLabelKey, { en: string; zh: string }> = {
  'home.aria': { en: 'Template quick start', zh: '模板快速开始' },
  'home.title': { en: 'Start from a template', zh: '模板快速开始' },
  'home.viewAll': { en: 'View all templates →', zh: '查看全部模板 →' },
  'home.loading': { en: 'Loading templates...', zh: '正在加载模板...' },
  'home.empty': {
    en: 'No templates are available. You can still create a blank base.',
    zh: '暂无可用模板。你仍可直接新建空白工作区。',
  },
  'home.loadFailed': {
    en: 'Failed to load templates. You can still create a blank base.',
    zh: '模板加载失败，可继续新建空白工作区。',
  },
  'center.eyebrow': { en: 'Multitable Templates', zh: '多维表模板' },
  'center.title': { en: 'Template Center', zh: '模板中心' },
  'center.subtitle': {
    en: 'Start a new multitable workspace from an industry template. Installation opens the default view automatically.',
    zh: '从行业模板新建多维表工作区。安装后会自动打开默认视图。',
  },
  'center.back': { en: '← Back to multitable home', zh: '← 返回多维表首页' },
  'center.refresh': { en: 'Refresh', zh: '刷新' },
  'center.refreshing': { en: 'Loading...', zh: '加载中...' },
  'center.controlsAria': { en: 'Filter and search templates', zh: '筛选与搜索模板' },
  'center.categoriesAria': { en: 'Template categories', zh: '模板分类筛选' },
  'center.all': { en: 'All', zh: '全部' },
  'center.search': { en: 'Search templates', zh: '搜索模板' },
  'center.searchPlaceholder': {
    en: 'Search by name, description, or category',
    zh: '按名称、描述或分类搜索',
  },
  'center.retry': { en: 'Retry', zh: '重试' },
  'center.loading': { en: 'Loading templates...', zh: '正在加载模板...' },
  'center.empty': {
    en: 'No templates are available. Refresh or return home to create a blank base.',
    zh: '暂无可用模板。请刷新或返回首页直接新建空白工作区。',
  },
  'center.noMatch': {
    en: 'No templates match. Adjust the category or search query.',
    zh: '没有匹配的模板。请调整分类或搜索关键词。',
  },
  'center.loadFailed': { en: 'Failed to load templates', zh: '加载模板失败' },
  'install.noView': {
    en: 'The template was created, but its default view is not ready. Refresh and try again.',
    zh: '模板已创建，但默认视图尚未就绪。请刷新后重试。',
  },
  'install.failed': { en: 'Failed to create template workspace', zh: '模板工作区创建失败' },
}

function translatedText(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function templateCatalogLabel(key: TemplateCatalogLabelKey, isZh: boolean): string {
  const entry = TEMPLATE_CATALOG_LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function localizeTemplate(template: MetaTemplate, locale: TemplateCatalogLocale): MetaTemplate {
  if (locale !== 'zh-CN') return template

  const translation = template.translations?.['zh-CN']
  const localizedCategory = translatedText(
    translation?.category,
    categoryLabel(template.category, locale),
  )

  return {
    ...template,
    name: translatedText(translation?.name, template.name),
    description: translatedText(translation?.description, template.description),
    category: localizedCategory,
    sheets: template.sheets.map((sheet) => {
      const translatedSheet = translation?.sheets?.[sheet.id]
      return {
        ...sheet,
        name: translatedText(translatedSheet?.name, sheet.name),
        description: translatedText(translatedSheet?.description, sheet.description ?? ''),
        fields: sheet.fields.map((field) => ({
          ...field,
          name: translatedText(translatedSheet?.fields?.[field.id], field.name),
        })),
        views: sheet.views.map((view) => ({
          ...view,
          name: translatedText(translatedSheet?.views?.[view.id], view.name),
        })),
      }
    }),
  }
}

export function templateDefaultBaseName(template: MetaTemplate, isZh: boolean): string {
  const translatedName = template.translations?.['zh-CN']?.name
  if (isZh && translatedName?.trim()) return `${translatedName}工作区`
  return `${template.name} Base`
}

export function templateCount(count: number, isZh: boolean): string {
  return isZh ? `${count} 个` : `${count} template${count === 1 ? '' : 's'}`
}

export function templateTotal(count: number, isZh: boolean): string {
  return isZh ? `共 ${count} 个模板` : `${count} template${count === 1 ? '' : 's'} total`
}

export function templateMatchCount(shown: number, total: number, isZh: boolean): string {
  return isZh
    ? `匹配 ${shown} / ${total} 个模板`
    : `${shown} of ${total} templates match`
}
