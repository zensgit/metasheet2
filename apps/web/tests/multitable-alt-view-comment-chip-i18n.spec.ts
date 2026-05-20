import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'
import MetaGalleryView from '../src/multitable/components/MetaGalleryView.vue'
import MetaHierarchyView from '../src/multitable/components/MetaHierarchyView.vue'
import MetaKanbanView from '../src/multitable/components/MetaKanbanView.vue'
import MetaTimelineView from '../src/multitable/components/MetaTimelineView.vue'

const titleField = { id: 'fld_title', name: 'Title', type: 'string' }
const dateField = { id: 'fld_date', name: 'Date', type: 'date' }
const endDateField = { id: 'fld_end', name: 'End', type: 'date' }
const parentField = { id: 'fld_parent', name: 'Parent', type: 'link' }
const statusField = {
  id: 'fld_status',
  name: 'Status',
  type: 'select',
  options: [{ value: 'Todo', color: '#409eff' }],
}

function todayIso(): string {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

async function mountComponent(component: Component, props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(component, props)
    },
  })
  app.mount(container)
  await nextTick()
  return {
    container,
    chipLabels: () => Array.from(container.querySelectorAll('.meta-comment-action-chip__label')).map((item) => item.textContent?.trim()),
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

async function mountAltViews() {
  const date = todayIso()
  const record = {
    id: 'rec_1',
    version: 1,
    data: {
      fld_title: 'Roadmap',
      fld_date: date,
      fld_end: date,
      fld_status: 'Todo',
    },
  }
  const mounted = [
    await mountComponent(MetaCalendarView, {
      rows: [record],
      fields: [titleField, dateField],
      loading: false,
      canComment: true,
      viewConfig: { dateFieldId: 'fld_date', titleFieldId: 'fld_title', defaultView: 'day' },
    }),
    await mountComponent(MetaGalleryView, {
      rows: [record],
      fields: [titleField],
      loading: false,
      canComment: true,
      currentPage: 1,
      totalPages: 1,
      viewConfig: { titleFieldId: 'fld_title', fieldIds: [], columns: 1, cardSize: 'small' },
    }),
    await mountComponent(MetaHierarchyView, {
      rows: [record],
      fields: [titleField, parentField],
      loading: false,
      canComment: true,
      viewConfig: { parentFieldId: 'fld_parent', titleFieldId: 'fld_title', defaultExpandDepth: 1 },
    }),
    await mountComponent(MetaTimelineView, {
      rows: [record],
      fields: [titleField, dateField, endDateField],
      loading: false,
      canComment: true,
      viewConfig: { startFieldId: 'fld_date', endFieldId: 'fld_end', labelFieldId: 'fld_title', zoom: 'week' },
    }),
    await mountComponent(MetaKanbanView, {
      rows: [record],
      fields: [titleField, statusField],
      loading: false,
      canComment: true,
      viewConfig: { groupFieldId: 'fld_status', cardFieldIds: [] },
    }),
  ]
  return mounted
}

afterEach(() => {
  useLocale().setLocale('en')
})

describe('alternative view comment chip i18n', () => {
  it('localizes row comment chip labels in zh-CN across non-grid views', async () => {
    useLocale().setLocale('zh-CN')
    const mounted = await mountAltViews()

    try {
      for (const view of mounted) {
        expect(view.chipLabels()).toContain('评论')
        expect(view.chipLabels()).not.toContain('Comments')
      }
    } finally {
      mounted.forEach((view) => view.unmount())
    }
  })

  it('keeps English row comment chip labels as the default', async () => {
    useLocale().setLocale('en')
    const mounted = await mountAltViews()

    try {
      for (const view of mounted) {
        expect(view.chipLabels()).toContain('Comments')
        expect(view.chipLabels()).not.toContain('评论')
      }
    } finally {
      mounted.forEach((view) => view.unmount())
    }
  })
})
