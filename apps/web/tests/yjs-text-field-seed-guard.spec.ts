/**
 * P0 guard tests for `useYjsTextField` seed contract.
 *
 * Reviewer finding on PR #960 (2026-04-20):
 *
 *   "对缺失字段直接创建空 Y.Text；active 后输入框切到 yjsText。但后端
 *    只加载 Yjs snapshot/update，没有从 meta_records.data seed。结果：
 *    首次打开未被 Yjs 初始化过的已有文本格，会显示为空；用户继续输入/
 *    确认可能把原值覆盖成部分输入。"
 *
 * These tests lock in the fix:
 *   1. When the Y.Doc has no Y.Text for the fieldId, `yjsActive` stays
 *      false and `text` stays `""` — no empty Y.Text is created in the
 *      doc.
 *   2. When the Y.Doc HAS a seeded Y.Text (from backend seed), the
 *      composable picks up the existing value immediately and
 *      `yjsActive` flips true.
 *   3. Calling setText when inactive is a no-op — no ghost Y.Text is
 *      created, no "empty → typed text" overwrite vector.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef, type App } from 'vue'
import * as Y from 'yjs'
import { useYjsTextField } from '../src/multitable/composables/useYjsTextField'

type Composable = ReturnType<typeof useYjsTextField>

function mount(doc: Y.Doc | null, fieldId = 'fld_title'): {
  composable: Composable
  docRef: ReturnType<typeof shallowRef<Y.Doc | null>>
  app: App
} {
  const docRef = shallowRef<Y.Doc | null>(doc)
  let captured: Composable | null = null
  const Comp = defineComponent({
    setup() {
      captured = useYjsTextField(docRef, fieldId)
      return () => h('div')
    },
  })
  const app = createApp(Comp)
  app.mount(document.createElement('div'))
  return { composable: captured!, docRef, app }
}

describe('useYjsTextField seed guard (P0)', () => {
  let mounted: { app: App } | null = null
  beforeEach(() => {
    if (mounted) { mounted.app.unmount(); mounted = null }
  })

  it('empty Y.Doc: yjsActive stays false, text stays "", no Y.Text created in doc', () => {
    const doc = new Y.Doc()
    const { composable, app } = mount(doc)
    mounted = { app }

    expect(composable.yjsActive.value).toBe(false)
    expect(composable.text.value).toBe('')
    // The doc must remain untouched — no stray Y.Text inserted.
    expect(doc.getMap('fields').size).toBe(0)
  })

  it('non-string entry at fieldId (e.g. number): yjsActive stays false and entry is preserved', () => {
    const doc = new Y.Doc()
    const fields = doc.getMap('fields')
    // Simulate backend having seeded something that is NOT a Y.Text
    // (shouldn't happen for text fields, but defend against it).
    fields.set('fld_count', 42)

    const { composable, app } = mount(doc, 'fld_count')
    mounted = { app }

    expect(composable.yjsActive.value).toBe(false)
    // The stored non-Y.Text value is preserved, not overwritten by an
    // empty Y.Text (old buggy behavior).
    expect(fields.get('fld_count')).toBe(42)
  })

  it('doc with seeded Y.Text: yjsActive true, text reflects seeded value (NOT empty)', () => {
    const doc = new Y.Doc()
    const seeded = new Y.Text()
    seeded.insert(0, 'existing value')
    doc.getMap('fields').set('fld_title', seeded)

    const { composable, app } = mount(doc)
    mounted = { app }

    expect(composable.yjsActive.value).toBe(true)
    // Must expose the seeded value immediately — if this ever returns
    // "" the cell editor shows an empty input and the user can
    // overwrite the original on confirm.
    expect(composable.text.value).toBe('existing value')
  })

  it('setText while inactive is a no-op — no overwrite vector', () => {
    const doc = new Y.Doc()
    const { composable, app } = mount(doc)
    mounted = { app }

    expect(composable.yjsActive.value).toBe(false)
    composable.setText('attempted overwrite')

    // No Y.Text was ever created; the doc remains empty.
    expect(doc.getMap('fields').size).toBe(0)
    // The composable's own text ref stays empty.
    expect(composable.text.value).toBe('')
  })

  it('doc swapped from null to seeded: yjsActive transitions false → true with correct text', async () => {
    const { composable, docRef, app } = mount(null)
    mounted = { app }

    expect(composable.yjsActive.value).toBe(false)
    expect(composable.text.value).toBe('')

    const seeded = new Y.Doc()
    const y = new Y.Text()
    y.insert(0, 'seeded value')
    seeded.getMap('fields').set('fld_title', y)

    docRef.value = seeded
    await nextTick()

    expect(composable.yjsActive.value).toBe(true)
    expect(composable.text.value).toBe('seeded value')
  })

  it('doc swapped from seeded to empty: yjsActive transitions true → false with text cleared', async () => {
    const seeded = new Y.Doc()
    const y = new Y.Text()
    y.insert(0, 'v1')
    seeded.getMap('fields').set('fld_title', y)
    const { composable, docRef, app } = mount(seeded)
    mounted = { app }

    expect(composable.yjsActive.value).toBe(true)

    docRef.value = null
    await nextTick()

    expect(composable.yjsActive.value).toBe(false)
    expect(composable.text.value).toBe('')
  })
})
