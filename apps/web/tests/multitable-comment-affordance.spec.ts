import { createApp, h, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import MetaCommentActionChip from '../src/multitable/components/MetaCommentActionChip.vue'
import MetaCommentAffordance from '../src/multitable/components/MetaCommentAffordance.vue'
import type { MultitableCommentPresenceSummary } from '../src/multitable/types'
import {
  resolveCommentAffordance,
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../src/multitable/utils/comment-affordance'

const PRESENCE: MultitableCommentPresenceSummary = {
  containerId: 'sheet_orders',
  targetId: 'rec_1',
  unresolvedCount: 3,
  fieldCounts: {
    fld_title: 2,
    fld_status: 0,
  },
  mentionedCount: 1,
  mentionedFieldCounts: {
    fld_title: 1,
    fld_status: 0,
  },
}

describe('comment affordance helper', () => {
  it('marks explicit unresolved or mention counts as active', () => {
    expect(resolveCommentAffordance(2, 0)).toMatchObject({
      unresolvedCount: 2,
      mentionCount: 0,
      isActive: true,
      isIdle: false,
      showIcon: false,
    })
    expect(resolveCommentAffordance(0, 1)).toMatchObject({
      unresolvedCount: 0,
      mentionCount: 1,
      isActive: true,
      isIdle: false,
      showIcon: false,
    })
  })

  it('marks zero-count affordances as idle and icon-visible', () => {
    expect(resolveCommentAffordance(0, 0)).toMatchObject({
      unresolvedCount: 0,
      mentionCount: 0,
      isActive: false,
      isIdle: true,
      showIcon: true,
    })
  })

  it('resolves record-level affordance from unresolved and mention totals', () => {
    expect(resolveRecordCommentAffordance(PRESENCE)).toMatchObject({
      unresolvedCount: 3,
      mentionCount: 1,
      isActive: true,
    })
  })

  it('derives active and idle suffix classes from a shared base class', () => {
    expect(resolveCommentAffordanceStateClass('meta-grid__field-comment-action', resolveCommentAffordance(2, 0))).toBe(
      'meta-grid__field-comment-action--active',
    )
    expect(resolveCommentAffordanceStateClass('meta-form-view__comment-anchor', resolveCommentAffordance(0, 0))).toBe(
      'meta-form-view__comment-anchor--idle',
    )
  })

  it('resolves field-level affordance from field counts and mentionedFieldCounts', () => {
    expect(resolveFieldCommentAffordance(PRESENCE, 'fld_title')).toMatchObject({
      unresolvedCount: 2,
      mentionCount: 1,
      isActive: true,
      showIcon: false,
    })
  })

  it('falls back to idle for missing field or missing presence', () => {
    expect(resolveFieldCommentAffordance(PRESENCE, 'fld_unknown')).toMatchObject({
      unresolvedCount: 0,
      mentionCount: 0,
      isIdle: true,
      showIcon: true,
    })
    expect(resolveFieldCommentAffordance(null, 'fld_title')).toMatchObject({
      unresolvedCount: 0,
      mentionCount: 0,
      isIdle: true,
      showIcon: true,
    })
  })

  it('renders unresolved then mention badges with no icon for active affordances', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCommentAffordance, {
          state: resolveCommentAffordance(2, 1),
        })
      },
    })

    app.mount(container)
    await nextTick()

    const badges = Array.from(container.querySelectorAll('[data-comment-affordance-badge]')).map((element) => element.textContent)
    expect(container.querySelector('[data-comment-affordance-state="active"]')).not.toBeNull()
    expect(badges).toEqual(['2', '@1'])
    expect(container.querySelector('[data-comment-affordance-icon="true"]')).toBeNull()

    app.unmount()
    container.remove()
  })

  it('renders the fallback icon for idle affordances', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCommentAffordance, {
          state: resolveCommentAffordance(0, 0),
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-comment-affordance-state="idle"]')).not.toBeNull()
    expect(container.querySelector('[data-comment-affordance-icon="true"]')?.textContent).toContain('💬')
    expect(container.querySelector('[data-comment-affordance-badge]')).toBeNull()

    app.unmount()
    container.remove()
  })

  it('renders a labeled active action chip with shared badge ordering', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCommentActionChip, {
          label: 'Comments',
          state: resolveCommentAffordance(3, 2),
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-comment-chip-state="active"]')).not.toBeNull()
    expect(container.textContent).toContain('Comments')
    const badges = Array.from(container.querySelectorAll('[data-comment-affordance-badge]')).map((element) => element.textContent)
    expect(badges).toEqual(['3', '@2'])

    app.unmount()
    container.remove()
  })

  it('renders a labeled idle action chip with icon fallback', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCommentActionChip, {
          label: 'Comments',
          state: resolveCommentAffordance(0, 0),
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.querySelector('[data-comment-chip-state="idle"]')).not.toBeNull()
    expect(container.textContent).toContain('Comments')
    expect(container.querySelector('[data-comment-affordance-icon="true"]')?.textContent).toContain('💬')

    app.unmount()
    container.remove()
  })
})
