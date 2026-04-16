import { ref, readonly, onUnmounted, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import * as Y from 'yjs'

/**
 * Composable that binds a Y.Text inside a Y.Doc to a Vue ref.
 *
 * The doc is expected to have a top-level Y.Map named "fields",
 * and the Y.Text is stored under the given fieldId key.
 *
 * POC scope: single text field, two-way sync, character-level merge.
 */
export function useYjsTextField(
  doc: ShallowRef<Y.Doc | null> | Ref<Y.Doc | null>,
  fieldId: string,
  options?: {
    setActiveField?: (fieldId: string | null) => void
  },
) {
  const text = ref('')
  let yText: Y.Text | null = null
  let observer: ((event: Y.YTextEvent) => void) | null = null

  function cleanup() {
    options?.setActiveField?.(null)
    if (yText && observer) {
      yText.unobserve(observer)
    }
    yText = null
    observer = null
  }

  watch(
    doc,
    (newDoc) => {
      cleanup()

      if (!newDoc) {
        text.value = ''
        return
      }

      const fields = newDoc.getMap('fields')
      let existing = fields.get(fieldId)
      if (!(existing instanceof Y.Text)) {
        existing = new Y.Text()
        fields.set(fieldId, existing)
      }
      yText = existing as Y.Text

      text.value = yText.toString()
      options?.setActiveField?.(fieldId)

      observer = () => {
        text.value = yText!.toString()
      }
      yText.observe(observer)
    },
    { immediate: true },
  )

  function setText(newText: string) {
    if (!yText) return
    const d = yText.doc
    if (!d) return
    d.transact(() => {
      yText!.delete(0, yText!.length)
      yText!.insert(0, newText)
    })
  }

  function insertAt(index: number, content: string) {
    yText?.insert(index, content)
  }

  function deleteRange(index: number, length: number) {
    yText?.delete(index, length)
  }

  onUnmounted(cleanup)

  return { text: readonly(text), setText, insertAt, deleteRange }
}
