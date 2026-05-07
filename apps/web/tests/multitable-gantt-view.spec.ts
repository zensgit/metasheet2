import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MetaGanttView from '../src/multitable/components/MetaGanttView.vue'
import { resolveGanttViewConfig } from '../src/multitable/utils/view-config'

describe('MetaGanttView', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('resolves sensible defaults from date, title, progress and group fields', () => {
    const config = resolveGanttViewConfig([
      { id: 'fld_name', name: 'Name', type: 'string' },
      { id: 'fld_start', name: 'Start', type: 'date' },
      { id: 'fld_end', name: 'End', type: 'date' },
      { id: 'fld_progress', name: 'Progress', type: 'number' },
      { id: 'fld_status', name: 'Status', type: 'select' },
    ])

    expect(config).toEqual({
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      titleFieldId: 'fld_name',
      progressFieldId: 'fld_progress',
      groupFieldId: null,
      dependencyFieldId: null,
      zoom: 'week',
    })
  })

  it('resolves and validates dependency field config', () => {
    const fields = [
      { id: 'fld_name', name: 'Name', type: 'string' as const },
      { id: 'fld_start', name: 'Start', type: 'dateTime' as const },
      { id: 'fld_end', name: 'End', type: 'dateTime' as const },
      { id: 'fld_deps', name: 'Depends on', type: 'link' as const },
      { id: 'fld_status', name: 'Status', type: 'select' as const },
    ]

    expect(resolveGanttViewConfig(fields, { dependencyFieldId: 'fld_deps' })).toEqual(expect.objectContaining({
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      dependencyFieldId: 'fld_deps',
    }))
    expect(resolveGanttViewConfig(fields, { dependencyFieldId: 'fld_status' }).dependencyFieldId).toBeNull()
  })

  it('renders grouped task bars and emits record selection', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const selectSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          canCreate: true,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_progress', name: 'Progress', type: 'number' },
            { id: 'fld_status', name: 'Status', type: 'select' },
          ],
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_name: 'Design',
                fld_start: '2026-04-01',
                fld_end: '2026-04-10',
                fld_progress: 60,
                fld_status: 'Open',
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
            progressFieldId: 'fld_progress',
            groupFieldId: 'fld_status',
          },
          groupInfo: { fieldId: 'fld_status' },
          onSelectRecord: selectSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Open')
    expect(container.textContent).toContain('Design')
    expect(container.querySelector('.meta-gantt__bar-progress')?.getAttribute('style')).toContain('width: 60%')

    ;(container.querySelector('.meta-gantt__row') as HTMLButtonElement).click()
    await nextTick()

    expect(selectSpy).toHaveBeenCalledWith('rec_1')

    app.unmount()
  })

  it('renders dependency arrows from the configured dependency field', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_deps', name: 'Depends on', type: 'link' },
          ],
          rows: [
            {
              id: 'rec_design',
              version: 1,
              data: {
                fld_name: 'Design',
                fld_start: '2026-04-01',
                fld_end: '2026-04-03',
              },
            },
            {
              id: 'rec_build',
              version: 1,
              data: {
                fld_name: 'Build',
                fld_start: '2026-04-05',
                fld_end: '2026-04-09',
                fld_deps: ['rec_design'],
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
            dependencyFieldId: 'fld_deps',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const arrow = container.querySelector('.meta-gantt__dependency-arrow') as HTMLElement | null
    expect(arrow).not.toBeNull()
    expect(arrow?.getAttribute('title')).toBe('Design \u2192 Build')
    expect(arrow?.getAttribute('style')).toContain('width:')

    app.unmount()
  })

  it('emits patch-dates when resizing a task end handle', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const patchSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          canEdit: true,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          rows: [
            {
              id: 'rec_build',
              version: 7,
              data: {
                fld_name: 'Build',
                fld_start: '2026-04-01',
                fld_end: '2026-04-03',
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
          },
          onPatchDates: patchSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const barArea = container.querySelector('.meta-gantt__bar-area') as HTMLElement | null
    const endHandle = container.querySelector('.meta-gantt__resize-handle--end') as HTMLElement | null
    expect(barArea).not.toBeNull()
    expect(endHandle).not.toBeNull()

    Object.defineProperty(barArea!, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 300, top: 0, height: 40, right: 300, bottom: 40 }),
    })

    endHandle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 150 }))
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300 }))
    await nextTick()

    expect(patchSpy).toHaveBeenCalledWith({
      recordId: 'rec_build',
      version: 7,
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      startValue: '2026-04-01',
      endValue: '2026-04-04',
    })

    app.unmount()
  })

  it('does not expose resize handles for read-only Gantt tasks', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          canEdit: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          rows: [
            {
              id: 'rec_build',
              version: 1,
              data: {
                fld_name: 'Build',
                fld_start: '2026-04-01',
                fld_end: '2026-04-03',
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.querySelector('.meta-gantt__resize-handle')).toBeNull()

    app.unmount()
  })

  it('emits persisted Gantt config and groupInfo from toolbar changes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_status', name: 'Status', type: 'select' },
          ],
          rows: [],
          viewConfig: { startFieldId: 'fld_start', endFieldId: 'fld_end' },
          onUpdateViewConfig: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const controls = Array.from(container.querySelectorAll('.meta-gantt__control select')) as HTMLSelectElement[]
    const groupSelect = controls[4]
    groupSelect.value = 'fld_status'
    groupSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith({
      config: expect.objectContaining({ groupFieldId: 'fld_status' }),
      groupInfo: { fieldId: 'fld_status' },
    })

    app.unmount()
  })

  it('rejects non-link fields configured as dependencyFieldId', () => {
    const fields = [
      { id: 'fld_start', name: 'Start', type: 'date' as const },
      { id: 'fld_end', name: 'End', type: 'date' as const },
      { id: 'fld_link', name: 'Depends on', type: 'link' as const },
      { id: 'fld_multi', name: 'Tags', type: 'multiSelect' as const },
      { id: 'fld_string', name: 'Notes', type: 'string' as const },
      { id: 'fld_select', name: 'Status', type: 'select' as const },
    ]

    expect(resolveGanttViewConfig(fields, { dependencyFieldId: 'fld_link' }).dependencyFieldId).toBe('fld_link')
    expect(resolveGanttViewConfig(fields, { dependencyFieldId: 'fld_multi' }).dependencyFieldId).toBeNull()
    expect(resolveGanttViewConfig(fields, { dependencyFieldId: 'fld_string' }).dependencyFieldId).toBeNull()
    expect(resolveGanttViewConfig(fields, { dependencyFieldId: 'fld_select' }).dependencyFieldId).toBeNull()
  })

  it('only lists link fields in the dependency dropdown', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_deps', name: 'Depends on', type: 'link' },
            { id: 'fld_tags', name: 'Tags', type: 'multiSelect' },
            { id: 'fld_notes', name: 'Notes', type: 'string' },
          ],
          rows: [],
          viewConfig: { startFieldId: 'fld_start', endFieldId: 'fld_end' },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const controls = Array.from(container.querySelectorAll('.meta-gantt__control select')) as HTMLSelectElement[]
    const dependencySelect = controls[5]
    const optionLabels = Array.from(dependencySelect.options).map((opt) => opt.textContent?.trim())

    expect(optionLabels).toContain('Depends on')
    expect(optionLabels).not.toContain('Tags')
    expect(optionLabels).not.toContain('Notes')

    app.unmount()
  })

  it('filters self-dependencies and skips dependencies whose record is missing', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_deps', name: 'Depends on', type: 'link' },
          ],
          rows: [
            {
              id: 'rec_solo',
              version: 1,
              data: {
                fld_name: 'Solo',
                fld_start: '2026-04-01',
                fld_end: '2026-04-03',
                fld_deps: ['rec_solo', 'rec_missing'],
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
            dependencyFieldId: 'fld_deps',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.querySelectorAll('.meta-gantt__dependency-arrow')).toHaveLength(0)

    app.unmount()
  })

  it('renders one arrow per predecessor when a task has multiple dependencies', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_deps', name: 'Depends on', type: 'link' },
          ],
          rows: [
            { id: 'rec_a', version: 1, data: { fld_name: 'A', fld_start: '2026-04-01', fld_end: '2026-04-03' } },
            { id: 'rec_b', version: 1, data: { fld_name: 'B', fld_start: '2026-04-02', fld_end: '2026-04-04' } },
            {
              id: 'rec_c',
              version: 1,
              data: {
                fld_name: 'C',
                fld_start: '2026-04-08',
                fld_end: '2026-04-12',
                fld_deps: ['rec_a', 'rec_b'],
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
            dependencyFieldId: 'fld_deps',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const arrows = Array.from(container.querySelectorAll('.meta-gantt__dependency-arrow'))
    const titles = arrows.map((arrow) => arrow.getAttribute('title')).sort()

    expect(arrows).toHaveLength(2)
    expect(titles).toEqual(['A → C', 'B → C'])

    app.unmount()
  })

  it('renders both arrows for a cycle (A->B->A) without crashing or recursing', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_deps', name: 'Depends on', type: 'link' },
          ],
          rows: [
            {
              id: 'rec_a',
              version: 1,
              data: {
                fld_name: 'A',
                fld_start: '2026-04-01',
                fld_end: '2026-04-04',
                fld_deps: ['rec_b'],
              },
            },
            {
              id: 'rec_b',
              version: 1,
              data: {
                fld_name: 'B',
                fld_start: '2026-04-06',
                fld_end: '2026-04-09',
                fld_deps: ['rec_a'],
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
            dependencyFieldId: 'fld_deps',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const arrows = Array.from(container.querySelectorAll('.meta-gantt__dependency-arrow'))
    const backwardArrows = arrows.filter((arrow) => arrow.classList.contains('meta-gantt__dependency-arrow--backward'))
    expect(arrows).toHaveLength(2)
    expect(backwardArrows).toHaveLength(1)

    app.unmount()
  })
})
