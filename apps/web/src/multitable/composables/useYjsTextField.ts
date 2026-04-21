import { ref, readonly, onUnmounted, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import * as Y from 'yjs'

/**
 * Composable that binds a Y.Text inside a Y.Doc to a Vue ref.
 *
 * The doc is expected to have a top-level Y.Map named "fields", and the
 * Y.Text is stored under the given fieldId key.
 *
 * ## Seed contract (P0)
 *
 * This composable **does NOT create an empty Y.Text** when the fieldId
 * is missing or points to a non-Y.Text value. Doing so previously caused
 * a data-overwrite vector: the backend hadn't seeded Y.Doc from
 * `meta_records.data`, so the first opener of an existing text cell saw
 * an empty textbox and could silently overwrite the real value on
 * confirm.
 *
 * Current behavior:
 *   - Y.Text already at `fields.get(fieldId)` → bind, `yjsActive=true`
 *   - Missing / non-Y.Text → `yjsActive=false`, `text=""`, the caller
 *     MUST fall back to REST for this cell
 *
 * The backend `YjsSyncService` seeds fresh Y.Docs from `meta_records.data`
 * on first creation, so in normal operation Y.Text entries exist for
 * every string field. This guard defends against:
 *   - Race between first subscribe and backend seed completing
 *   - Records whose backend seed failed
 *   - Non-string fields incorrectly routed here by the caller
 *
 * ## Diff semantics
 *
 * `setText(newText)` computes a common-prefix/common-suffix diff
 * against the current Y.Text content and emits scoped `delete` + `insert`
 * ops (not a full replace). See `_diffTextEdit` for the exact algorithm.
 * Concurrent edits to different ranges survive merge; overlapping edits
 * interleave at the closest common anchor.
 */
export function useYjsTextField(
  doc: ShallowRef<Y.Doc | null> | Ref<Y.Doc | null>,
  fieldId: string,
  options?: {
    setActiveField?: (fieldId: string | null) => void
  },
) {
  const text = ref('')
  const yjsActive = ref(false)
  let yText: Y.Text | null = null
  let observer: ((event: Y.YTextEvent) => void) | null = null
  let fieldsMap: Y.Map<unknown> | null = null
  let fieldsObserver: ((event: Y.YMapEvent<unknown>) => void) | null = null

  function attachToYText(next: Y.Text): void {
    yText = next
    text.value = next.toString()
    yjsActive.value = true
    options?.setActiveField?.(fieldId)
    observer = () => {
      text.value = yText!.toString()
    }
    yText.observe(observer)
  }

  function detachYText(): void {
    options?.setActiveField?.(null)
    if (yText && observer) {
      yText.unobserve(observer)
    }
    yText = null
    observer = null
    yjsActive.value = false
    text.value = ''
  }

  function cleanup() {
    detachYText()
    if (fieldsMap && fieldsObserver) {
      fieldsMap.unobserve(fieldsObserver)
    }
    fieldsMap = null
    fieldsObserver = null
  }

  watch(
    doc,
    (newDoc) => {
      cleanup()

      if (!newDoc) return

      fieldsMap = newDoc.getMap('fields')
      const existing = fieldsMap.get(fieldId)

      if (existing instanceof Y.Text) {
        attachToYText(existing)
      }
      // If the field is missing or non-Y.Text, we stay inactive. We also
      // watch the fields map so that when a Y.Text arrives later (server
      // seed delivered after initial sync, or another client creates the
      // field), we attach without forcing a caller reconnect. Never creates
      // a new Y.Text — see seed contract in the file-level JSDoc.
      fieldsObserver = (event) => {
        if (!event.keysChanged.has(fieldId)) return
        const next = fieldsMap!.get(fieldId)
        if (next instanceof Y.Text) {
          if (next !== yText) {
            detachYText()
            attachToYText(next)
          }
        } else {
          detachYText()
        }
      }
      fieldsMap.observe(fieldsObserver)
    },
    { immediate: true },
  )

  /**
   * Apply newText to the bound Y.Text using a minimal diff so concurrent
   * edits on unchanged regions survive.
   *
   * Exported for tests. Pure function that returns the operations it
   * would emit so tests can assert the shape of each edit.
   */
  function diffTextEdit(oldText: string, newText: string): {
    deletePos: number
    deleteCount: number
    insertText: string
  } | null {
    if (oldText === newText) return null

    const maxCommon = Math.min(oldText.length, newText.length)

    let prefix = 0
    while (prefix < maxCommon && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
      prefix += 1
    }

    // Cap suffix so the suffix region does not overlap the prefix in
    // either string. Without this, "abc" → "abbc" finds prefix=2 (ab)
    // and suffix=2 (bc), implying a negative slice delete.
    let suffix = 0
    while (
      suffix < oldText.length - prefix &&
      suffix < newText.length - prefix &&
      oldText.charCodeAt(oldText.length - 1 - suffix)
        === newText.charCodeAt(newText.length - 1 - suffix)
    ) {
      suffix += 1
    }

    const deletePos = prefix
    const deleteCount = oldText.length - prefix - suffix
    const insertText = newText.slice(prefix, newText.length - suffix)

    return { deletePos, deleteCount, insertText }
  }

  function setText(newText: string) {
    if (!yText) return
    const d = yText.doc
    if (!d) return
    const current = yText.toString()
    const edit = diffTextEdit(current, newText)
    if (!edit) return

    d.transact(() => {
      if (edit.deleteCount > 0) {
        yText!.delete(edit.deletePos, edit.deleteCount)
      }
      if (edit.insertText.length > 0) {
        yText!.insert(edit.deletePos, edit.insertText)
      }
    })
  }

  function insertAt(index: number, content: string) {
    yText?.insert(index, content)
  }

  function deleteRange(index: number, length: number) {
    yText?.delete(index, length)
  }

  onUnmounted(cleanup)

  return {
    text: readonly(text),
    /** True only when a Y.Text already exists for this fieldId. */
    yjsActive: readonly(yjsActive),
    setText,
    insertAt,
    deleteRange,
    /** Internal — exposed for tests. Pure, does not touch Y.Text. */
    _diffTextEdit: diffTextEdit,
  }
}
