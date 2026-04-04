import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaMentionPopover from '../src/multitable/components/MetaMentionPopover.vue'
import type { CommentMentionSummaryItem, MetaField, MetaRecord } from '../src/multitable/types'

let app: VueApp | null = null
let container: HTMLDivElement | null = null

function mountPopover(props: {
  visible: boolean
  items: CommentMentionSummaryItem[]
  rows: MetaRecord[]
  fields?: MetaField[]
  displayFieldId: string | null
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(MetaMentionPopover, {
    ...props,
    onClose: () => {},
    'onSelect-record': () => {},
  })
  app.mount(container)
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

const ROWS: MetaRecord[] = [
  { id: 'r1', version: 1, data: { title: 'Alpha' } },
  { id: 'r2', version: 1, data: { title: 'Beta' } },
]

const FIELDS: MetaField[] = [
  { id: 'f1', name: 'Title', type: 'string' },
  { id: 'f2', name: 'Status', type: 'select' },
]

const ITEMS: CommentMentionSummaryItem[] = [
  { rowId: 'r1', mentionedCount: 3, unreadCount: 2, mentionedFieldIds: ['f1'] },
  { rowId: 'r2', mentionedCount: 1, unreadCount: 0, mentionedFieldIds: ['f1', 'f2'] },
]

describe('MetaMentionPopover', () => {
  it('renders unread affordances and record labels', async () => {
    mountPopover({ visible: true, items: ITEMS, rows: ROWS, fields: FIELDS, displayFieldId: 'title' })
    await nextTick()

    const itemEls = container!.querySelectorAll('.meta-mention-popover__item')
    expect(itemEls).toHaveLength(2)
    expect(itemEls[0].classList.contains('meta-mention-popover__item--unread')).toBe(true)
    expect(itemEls[0].querySelector('.meta-mention-popover__unread-dot')).not.toBeNull()
    expect(itemEls[0].querySelector('.meta-mention-popover__label')!.textContent).toBe('Alpha')
    expect(itemEls[1].querySelector('.meta-mention-popover__fields')!.textContent!.trim()).toBe('Title +1 more')
  })

  it('emits the selected row and field scope', async () => {
    let emittedPayload: any = null
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MetaMentionPopover, {
      visible: true,
      items: ITEMS,
      rows: ROWS,
      fields: FIELDS,
      displayFieldId: 'title',
      onClose: () => {},
      'onSelect-record': (payload: any) => { emittedPayload = payload },
    })
    app.mount(container)
    await nextTick()

    ;(container!.querySelectorAll('.meta-mention-popover__item')[0] as HTMLButtonElement).click()
    await nextTick()

    expect(emittedPayload).toEqual({
      rowId: 'r1',
      fieldId: 'f1',
      mentionedFieldIds: ['f1'],
    })
  })
})
