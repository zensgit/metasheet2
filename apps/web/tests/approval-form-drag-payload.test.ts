import { describe, expect, it, vi } from 'vitest'

import {
  APPROVAL_FORM_DRAG_MIME,
  createApprovalFormDragSession,
  dataTransferSignalsApprovalFormDrag,
  decodeApprovalFormDragPayload,
  encodeApprovalFormDragPayload,
  readApprovalFormDragPayload,
  writeApprovalFormDragPayload,
  type ApprovalFormDragPayload,
} from '../src/approvals/approvalFormDragPayload'
import { AUTHORABLE_FIELD_TYPES } from '../src/approvals/templateAuthoring'

/** Minimal DataTransfer double (jsdom has no DataTransfer constructor). */
function makeDataTransfer(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries))
  return {
    get types(): string[] {
      return Array.from(store.keys())
    },
    setData(type: string, value: string): void {
      store.set(type, String(value))
    },
    getData(type: string): string {
      return store.get(type) ?? ''
    },
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  } as unknown as DataTransfer
}

describe('approvalFormDragPayload codec (delta §3.1)', () => {
  it('round-trips both payload kinds for EVERY authorable field type (positive control)', () => {
    for (const fieldType of AUTHORABLE_FIELD_TYPES) {
      const payload: ApprovalFormDragPayload = {
        version: 1,
        kind: 'palette',
        fieldType,
      }
      expect(
        decodeApprovalFormDragPayload(encodeApprovalFormDragPayload(payload)),
      ).toEqual(payload)
    }
    const move: ApprovalFormDragPayload = {
      version: 1,
      kind: 'field',
      localId: 'fldloc_ab12',
    }
    expect(
      decodeApprovalFormDragPayload(encodeApprovalFormDragPayload(move)),
    ).toEqual(move)
  })

  it.each([
    ['empty string', ''],
    ['not JSON', 'text'],
    ['bare field type string (legacy text/plain shape)', 'select'],
    ['JSON array', '[]'],
    ['JSON null', 'null'],
    ['JSON string', '"select"'],
    ['unknown version', JSON.stringify({ version: 2, kind: 'palette', fieldType: 'text' })],
    ['missing version', JSON.stringify({ kind: 'palette', fieldType: 'text' })],
    ['string version', JSON.stringify({ version: '1', kind: 'palette', fieldType: 'text' })],
    ['unknown kind', JSON.stringify({ version: 1, kind: 'palette-field', fieldType: 'text' })],
    ['prompt-divergent existing-field kind', JSON.stringify({ version: 1, kind: 'existing-field', localId: 'x' })],
    ['extra property on palette', JSON.stringify({ version: 1, kind: 'palette', fieldType: 'text', label: '秘密' })],
    ['extra property on field', JSON.stringify({ version: 1, kind: 'field', localId: 'x', index: 3 })],
    ['missing fieldType', JSON.stringify({ version: 1, kind: 'palette' })],
    ['non-authorable fieldType (attachment stays fail-closed)', JSON.stringify({ version: 1, kind: 'palette', fieldType: 'attachment' })],
    ['unknown fieldType', JSON.stringify({ version: 1, kind: 'palette', fieldType: 'wormhole' })],
    ['non-string localId', JSON.stringify({ version: 1, kind: 'field', localId: 7 })],
    ['blank localId', JSON.stringify({ version: 1, kind: 'field', localId: '   ' })],
    ['palette keys under field kind', JSON.stringify({ version: 1, kind: 'field', fieldType: 'text' })],
  ])('strict decode rejects %s as null, never a command', (_name, raw) => {
    expect(decodeApprovalFormDragPayload(raw)).toBeNull()
  })

  it('rejects a __proto__-carrying body (own extra key under JSON.parse)', () => {
    // JSON.parse uses CreateDataProperty, so `__proto__` in the text becomes
    // an OWN enumerable key — the exact-key-set check must reject it.
    expect(
      decodeApprovalFormDragPayload(
        '{"version":1,"kind":"field","localId":"x","__proto__":{}}',
      ),
    ).toBeNull()
  })

  it('write() stores under the application MIME ONLY — no text/plain mirror', () => {
    const dataTransfer = makeDataTransfer()
    writeApprovalFormDragPayload(dataTransfer, {
      version: 1,
      kind: 'palette',
      fieldType: 'user',
    })
    expect(Array.from(dataTransfer.types)).toEqual([APPROVAL_FORM_DRAG_MIME])
    expect(dataTransfer.getData('text/plain')).toBe('')
    expect(
      decodeApprovalFormDragPayload(
        dataTransfer.getData(APPROVAL_FORM_DRAG_MIME),
      ),
    ).toEqual({ version: 1, kind: 'palette', fieldType: 'user' })
  })

  it('read() NEVER consults text/plain: a foreign generic payload is not a command', () => {
    // Foreign drag carrying a perfectly command-shaped JSON body — but under
    // the generic type. Must decode to null.
    const foreign = makeDataTransfer({
      'text/plain': JSON.stringify({
        version: 1,
        kind: 'palette',
        fieldType: 'text',
      }),
    })
    expect(readApprovalFormDragPayload(foreign)).toBeNull()
    // Positive control: the SAME body under the application MIME decodes.
    const internal = makeDataTransfer({
      [APPROVAL_FORM_DRAG_MIME]: JSON.stringify({
        version: 1,
        kind: 'palette',
        fieldType: 'text',
      }),
    })
    expect(readApprovalFormDragPayload(internal)).toEqual({
      version: 1,
      kind: 'palette',
      fieldType: 'text',
    })
  })

  it('read() handles a null dataTransfer and a throwing getData as null', () => {
    expect(readApprovalFormDragPayload(null)).toBeNull()
    const throwing = {
      getData() {
        throw new Error('denied')
      },
      types: [] as string[],
    } as unknown as DataTransfer
    expect(readApprovalFormDragPayload(throwing)).toBeNull()
  })

  it('dragover candidate signal is MIME-type presence, not content', () => {
    expect(
      dataTransferSignalsApprovalFormDrag(
        makeDataTransfer({ [APPROVAL_FORM_DRAG_MIME]: '' }),
      ),
    ).toBe(true)
    expect(
      dataTransferSignalsApprovalFormDrag(
        makeDataTransfer({ 'text/plain': 'text' }),
      ),
    ).toBe(false)
    expect(dataTransferSignalsApprovalFormDrag(null)).toBe(false)
  })
})

describe('approvalFormDragSession transient store (delta §3.1)', () => {
  it('begin/active/clear transitions notify subscribers; clear is idempotent', () => {
    const session = createApprovalFormDragSession()
    const seen: (ApprovalFormDragPayload | null)[] = []
    const unsubscribe = session.subscribe((active) => seen.push(active))
    expect(session.active()).toBeNull()

    const payload: ApprovalFormDragPayload = {
      version: 1,
      kind: 'field',
      localId: 'fldloc_1',
    }
    session.begin(payload)
    expect(session.active()).toEqual(payload)
    session.clear()
    expect(session.active()).toBeNull()
    // Idempotent: a second clear does not re-notify.
    session.clear()
    expect(seen).toEqual([payload, null])

    unsubscribe()
    session.begin(payload)
    expect(seen).toHaveLength(2)
  })

  it('positive control: a listener registered while active fires on the clear transition', () => {
    const session = createApprovalFormDragSession()
    session.begin({ version: 1, kind: 'palette', fieldType: 'date' })
    const listener = vi.fn()
    session.subscribe(listener)
    session.clear()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(null)
  })
})
