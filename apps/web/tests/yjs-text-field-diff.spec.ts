/**
 * Tests for useYjsTextField's diff-based setText.
 *
 * Covers:
 *   - Pure diff function: prefix/suffix detection, middle edits,
 *     append, prepend, delete, insert, no-op, full replace
 *   - Operation shape against a real Y.Text: transact observer
 *     records only the minimal ops
 *   - Concurrent non-overlapping edits at different offsets against
 *     two Y.Docs synced via Yjs updates — merged text contains both
 *     changes and is NOT the last-write-wins result
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, shallowRef, nextTick, type App } from 'vue'
import * as Y from 'yjs'
import { useYjsTextField } from '../src/multitable/composables/useYjsTextField'

type Composable = ReturnType<typeof useYjsTextField>

function harness(doc: Y.Doc, fieldId = 'fld_title') {
  const docRef = shallowRef<Y.Doc | null>(doc)
  let captured: Composable | null = null

  const Comp = defineComponent({
    setup() {
      captured = useYjsTextField(docRef, fieldId)
      return () => h('div')
    },
  })

  const app = createApp(Comp)
  const host = document.createElement('div')
  app.mount(host)
  return {
    composable: captured!,
    unmount: () => app.unmount(),
    docRef,
  }
}

describe('useYjsTextField diff', () => {
  let app: App | null = null

  beforeEach(() => {
    if (app) { app.unmount(); app = null }
  })

  describe('_diffTextEdit pure function', () => {
    const doc = new Y.Doc()
    const { composable } = harness(doc)
    const diff = composable._diffTextEdit

    it('same string → null (no op)', () => {
      expect(diff('abc', 'abc')).toBeNull()
      expect(diff('', '')).toBeNull()
    })

    it('pure append at end → insert only at tail', () => {
      expect(diff('abc', 'abcd')).toEqual({ deletePos: 3, deleteCount: 0, insertText: 'd' })
    })

    it('pure prepend at start → insert only at head', () => {
      expect(diff('abc', 'xabc')).toEqual({ deletePos: 0, deleteCount: 0, insertText: 'x' })
    })

    it('delete at end → delete only at tail', () => {
      expect(diff('abcd', 'abc')).toEqual({ deletePos: 3, deleteCount: 1, insertText: '' })
    })

    it('delete at start → delete only at head', () => {
      expect(diff('abcd', 'bcd')).toEqual({ deletePos: 0, deleteCount: 1, insertText: '' })
    })

    it('insert in middle → insert only at that position', () => {
      // "hello world" → "hello NEW world": 'hello ' prefix, 'world' suffix
      expect(diff('hello world', 'hello NEW world'))
        .toEqual({ deletePos: 6, deleteCount: 0, insertText: 'NEW ' })
    })

    it('delete from middle → delete only at that position', () => {
      expect(diff('hello NEW world', 'hello world'))
        .toEqual({ deletePos: 6, deleteCount: 4, insertText: '' })
    })

    it('replace in middle → single delete + single insert scoped to range', () => {
      // "abcXYZdef" → "abcQRSdef": prefix "abc" suffix "def"
      expect(diff('abcXYZdef', 'abcQRSdef'))
        .toEqual({ deletePos: 3, deleteCount: 3, insertText: 'QRS' })
    })

    it('full replace (no common prefix/suffix) → delete all + insert all', () => {
      expect(diff('abc', 'xyz'))
        .toEqual({ deletePos: 0, deleteCount: 3, insertText: 'xyz' })
    })

    it('empty → non-empty → plain insert at 0', () => {
      expect(diff('', 'hello'))
        .toEqual({ deletePos: 0, deleteCount: 0, insertText: 'hello' })
    })

    it('non-empty → empty → plain delete all', () => {
      expect(diff('hello', ''))
        .toEqual({ deletePos: 0, deleteCount: 5, insertText: '' })
    })

    it('prefix and suffix must not overlap — "abc" → "abbc" picks prefix', () => {
      // A naive algorithm could find prefix=2 and suffix=2 (both "ab"
      // and "bc") which would imply deleting a negative slice.
      const result = diff('abc', 'abbc')!
      // The cap ensures prefix+suffix <= min(len) - so we end up
      // inserting exactly one 'b' somewhere consistent, never with a
      // negative deleteCount.
      expect(result.deleteCount).toBeGreaterThanOrEqual(0)
      expect(result.deletePos + result.deleteCount).toBeLessThanOrEqual(3)
      expect(result.insertText.length).toBe(1 + result.deleteCount)
    })
  })

  describe('setText emits minimal Y.Text ops', () => {
    it('single-char insert only emits a 1-char insert', () => {
      const doc = new Y.Doc()
      const h = harness(doc)

      h.composable.setText('hello')
      // Seed the field with initial value

      // Record only the follow-up op
      const deltas: any[] = []
      const yText = doc.getMap('fields').get('fld_title') as Y.Text
      yText.observe((event) => {
        deltas.push(event.changes.delta)
      })

      h.composable.setText('helloX')

      expect(deltas.length).toBe(1)
      // Delta shape: [{ retain: 5 }, { insert: 'X' }]
      const delta = deltas[0]
      const inserts = delta.filter((op: any) => typeof op.insert === 'string')
      const deletes = delta.filter((op: any) => typeof op.delete === 'number')
      expect(inserts).toHaveLength(1)
      expect(inserts[0].insert).toBe('X')
      expect(deletes).toHaveLength(0)

      h.unmount()
    })

    it('single-char delete only emits a 1-char delete', () => {
      const doc = new Y.Doc()
      const h = harness(doc)

      h.composable.setText('helloX')

      const deltas: any[] = []
      const yText = doc.getMap('fields').get('fld_title') as Y.Text
      yText.observe((event) => {
        deltas.push(event.changes.delta)
      })

      h.composable.setText('hello')

      expect(deltas.length).toBe(1)
      const delta = deltas[0]
      const inserts = delta.filter((op: any) => typeof op.insert === 'string')
      const deletes = delta.filter((op: any) => typeof op.delete === 'number')
      expect(inserts).toHaveLength(0)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].delete).toBe(1)

      h.unmount()
    })

    it('middle-insert does not replace the whole string', () => {
      const doc = new Y.Doc()
      const h = harness(doc)

      h.composable.setText('hello world')

      const deltas: any[] = []
      const yText = doc.getMap('fields').get('fld_title') as Y.Text
      yText.observe((event) => {
        deltas.push(event.changes.delta)
      })

      h.composable.setText('hello NEW world')

      expect(deltas.length).toBe(1)
      const delta = deltas[0]
      // MUST NOT contain a delete that removes the entire string
      const deletes = delta.filter((op: any) => typeof op.delete === 'number')
      expect(deletes).toHaveLength(0)
      // The insert MUST be only the new substring, not the full "hello NEW world"
      const inserts = delta.filter((op: any) => typeof op.insert === 'string')
      expect(inserts).toHaveLength(1)
      expect(inserts[0].insert).toBe('NEW ')
      expect(inserts[0].insert).not.toBe('hello NEW world')

      h.unmount()
    })
  })

  describe('concurrent non-overlapping edits merge (smoke)', () => {
    it('two editors editing different ranges merge — both changes survive', () => {
      // Editor A's doc
      const docA = new Y.Doc()
      const hA = harness(docA, 'fld_title')
      hA.composable.setText('the quick brown fox')

      // Mirror state to docB
      const docB = new Y.Doc()
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
      const hB = harness(docB, 'fld_title')
      // Ensure the Y.Text ref was attached in B
      expect(hB.composable.text.value).toBe('the quick brown fox')

      // Both editors edit different ranges independently
      hA.composable.setText('the QUICK brown fox') // modifies "quick" → "QUICK"
      hB.composable.setText('the quick brown FOXES') // modifies "fox" → "FOXES"

      // Exchange updates
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)))
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)))

      const aFinal = (docA.getMap('fields').get('fld_title') as Y.Text).toString()
      const bFinal = (docB.getMap('fields').get('fld_title') as Y.Text).toString()

      // Both ends converge to the same result
      expect(aFinal).toBe(bFinal)

      // BOTH concurrent edits survive — the merged text contains
      // BOTH "QUICK" and "FOXES". Under LWW per keystroke, one would
      // overwrite the other.
      expect(aFinal).toContain('QUICK')
      expect(aFinal).toContain('FOXES')

      hA.unmount()
      hB.unmount()
    })
  })
})
