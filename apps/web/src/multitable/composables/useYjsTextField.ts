import { ref, readonly, onUnmounted, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import * as Y from 'yjs'

/**
 * Composable that binds a Y.Text inside a Y.Doc to a Vue ref.
 *
 * The doc is expected to have a top-level Y.Map named "fields",
 * and the Y.Text is stored under the given fieldId key.
 *
 * Scope: two-way sync between a local plain string and a Y.Text value.
 *
 * `setText(newText)` computes a common-prefix/common-suffix diff against
 * the current Y.Text content and emits minimal `delete` + `insert` ops
 * instead of replacing the entire string. That means:
 *
 *  - Typing one character emits `insert(pos, char)` — not a full replace
 *  - Deleting one character emits `delete(pos, 1)` — not a full replace
 *  - Editing in the middle only touches the changed range
 *
 * Because each local edit becomes a range-scoped op, two concurrent
 * editors changing *different* ranges of the same text merge per-char
 * (Yjs CRDT semantics on Y.Text). If they change *overlapping* ranges
 * the two inserts interleave at the nearest common anchor — still no
 * whole-string replacement.
 *
 * Known limitation: the diff uses a trivial prefix/suffix heuristic
 * (not a full LCS). If the user replaces the middle of a string in one
 * go (e.g. paste-replace a selection), we emit ONE `delete` for the
 * removed slice and ONE `insert` for the new slice — correct, but
 * coarser than a true character-level diff would produce.
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

  /**
   * Apply newText to the bound Y.Text using a minimal diff so
   * concurrent edits on unchanged regions survive.
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

    // Cap suffix so that the suffix region does not overlap the prefix
    // region in EITHER string. Without this cap, a case like
    // oldText="abc" newText="abbc" would find prefix=2 (ab), suffix=2
    // (bc), which together imply removing a negative slice.
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
      // Order matters: delete first, then insert at the same position.
      // After delete, the suffix shifts left by deleteCount, but the
      // insert position stays at `deletePos` because we haven't moved
      // through the suffix region.
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
    setText,
    insertAt,
    deleteRange,
    /** Internal — exposed for tests. Pure, does not touch Y.Text. */
    _diffTextEdit: diffTextEdit,
  }
}
