// @vitest-environment jsdom
/**
 * T9-R4 — MetaConfigHistoryModal: the dedicated config-history view. The server gates per entity type (R3); the FE
 * is a FAITHFUL CLIENT — it renders exactly the items the server returned and never filters for security. The
 * entity-type filter only emits a re-fetch (server re-applies the gate). Mounted via createApp + jsdom (Teleport).
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import MetaConfigHistoryModal from '../src/multitable/components/MetaConfigHistoryModal.vue'
import { MultitableApiClient, type MetaConfigRevision, type ConfigRestorePreview } from '../src/multitable/api/client'

const previewOf = (over: Partial<ConfigRestorePreview>): ConfigRestorePreview => ({
  revisionId: 'a', entityType: 'field', entityId: 'fld_1', changedKeys: ['name'],
  current: { name: 'New' }, target: { name: 'Old' }, driftConflict: false, opKind: 'safe', baselineHash: 'h1', previewToken: 'tok1', ...over,
})

const rev = (over: Partial<MetaConfigRevision>): MetaConfigRevision => ({
  id: 'r1', entityType: 'field', entityId: 'fld_1', action: 'create', before: null, after: { name: 'X' },
  changedKeys: [], batchId: null, actorId: 'u1', createdAt: '2026-06-24T00:00:00Z', ...over,
})

type Props = {
  visible: boolean; items: MetaConfigRevision[]; loading: boolean; entityType: string
  recordLabelOf: (id: string) => string; isZh: boolean; onClose: () => void; onFilterChange: (t: string) => void
  previewRevert?: (id: string) => Promise<ConfigRestorePreview>; executeRevert?: (id: string, h: string, confirm?: string) => Promise<void>; onReverted?: () => void
}
const mounted: Array<{ unmount: () => void }> = []
function mountModal(over: Partial<Props>) {
  const props: Props = {
    visible: true, items: [], loading: false, entityType: '', recordLabelOf: (id) => `name:${id}`, isZh: false,
    onClose: vi.fn(), onFilterChange: vi.fn(), ...over,
  }
  const app = createApp(MetaConfigHistoryModal, props as unknown as Record<string, unknown>)
  const c = document.createElement('div'); document.body.appendChild(c); app.mount(c); mounted.push(app); return props
}
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const typeInto = async (selector: string, value: string) => {
  const input = q(selector) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}
// Poll until a condition holds (CI-robust): the real client's fetch→text→parse→render chain takes a variable number
// of ticks, so a fixed `flush()` count races in CI. Retry-with-flush until the predicate is true (or time out).
const waitUntil = async (pred: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries; i++) { if (pred()) return; await flush() }
  throw new Error('waitUntil: condition not met in time')
}
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = '' })

describe('MetaConfigHistoryModal — T9-R4 config-history view', () => {
  it('renders the server revisions FAITHFULLY (action, entity, changed before→after) — no client-side filtering', async () => {
    mountModal({ items: [
      rev({ id: 'a', entityType: 'field', entityId: 'fld_1', action: 'update', changedKeys: ['name'], before: { name: 'Old' }, after: { name: 'New' } }),
      rev({ id: 'b', entityType: 'view', entityId: 'view_1', action: 'create' }),
    ] })
    await nextTick()
    expect(q('[data-test="config-history-list"]')).toBeTruthy()
    expect(document.body.textContent).toContain('name:fld_1') // recordLabelOf resolved
    expect(document.body.textContent).toContain('Old') // before
    expect(document.body.textContent).toContain('New') // after
    expect(document.body.querySelectorAll('.cfg-history__row').length).toBe(2) // BOTH rendered — the FE doesn't drop rows
  })

  it('renders config objects as a compact k: v summary, not a raw JSON blob (diff-rendering depth)', async () => {
    mountModal({ items: [
      rev({ id: 'a', entityType: 'permission', entityId: 'fld_1', action: 'update', changedKeys: ['grant'],
        before: { grant: { visible: true, readOnly: false } }, after: { grant: { visible: false, readOnly: true } } }),
    ] })
    await nextTick()
    expect(document.body.textContent).toContain('visible: false, readOnly: true') // compact human summary
    expect(document.body.textContent).not.toContain('{"visible"') // NOT the raw JSON blob
  })

  it('the entity-type filter EMITS filter-change (server re-fetches; the FE never client-filters for security)', async () => {
    const props = mountModal({ items: [rev({})] })
    await nextTick()
    ;(q('[data-test="config-history-filter-view"]') as HTMLButtonElement).click()
    expect(props.onFilterChange).toHaveBeenCalledWith('view')
    // the list still shows the (unchanged) items — filtering is the server's job on the next load, not a client cull
    expect(document.body.querySelectorAll('.cfg-history__row').length).toBe(1)
  })

  it('shows the loading state', async () => {
    mountModal({ loading: true }); await nextTick()
    expect(q('[data-test="config-history-loading"]')).toBeTruthy()
    expect(q('[data-test="config-history-list"]')).toBeFalsy()
  })

  it('shows the empty state when the server returns nothing (e.g. an actor who manages no config)', async () => {
    mountModal({ items: [] }); await nextTick()
    expect(q('[data-test="config-history-empty"]')).toBeTruthy()
  })

  it('close emits close', async () => {
    const props = mountModal({ items: [rev({})] }); await nextTick()
    ;(q('.cfg-history__close') as HTMLButtonElement).click()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('MetaConfigHistoryModal — S2 aiShortcut prompt-config history rendering', () => {
  const aiShortcut = (over: Record<string, unknown> = {}) => ({
    kind: 'classify',
    sourceFieldIds: ['fld_source'],
    params: { options: ['keep', 'review'], instruction: 'Flag competitor mentions' },
    ...over,
  })
  const propertyWithAi = (over: Record<string, unknown> = {}) => ({ aiShortcut: aiShortcut(over) })

  it('renders field create property.aiShortcut as labeled lines, not a nested raw JSON blob', async () => {
    mountModal({
      recordLabelOf: (id) => id === 'fld_source' ? 'Source Text' : `name:${id}`,
      items: [
        rev({
          id: 'ai-create',
          action: 'create',
          after: { property: propertyWithAi({ kind: 'translate', params: { targetLang: 'French', instruction: 'Translate politely' } }) },
        }),
      ],
    })
    await nextTick()

    const text = document.body.textContent ?? ''
    expect(text).toContain('aiShortcut.kind')
    expect(text).toContain('translate')
    expect(text).toContain('aiShortcut.sourceFieldIds')
    expect(text).toContain('Source Text')
    expect(text).toContain('aiShortcut.params.targetLang')
    expect(text).toContain('French')
    expect(text).toContain('aiShortcut.params.instruction')
    expect(text).toContain('Translate politely')
    expect(text).not.toContain('{"targetLang"')
    expect(text).not.toContain('"instruction"')
  })

  it('renders aiShortcut instruction updates with the existing redactor and never leaks secret-shaped text', async () => {
    mountModal({
      items: [
        rev({
          id: 'ai-update',
          action: 'update',
          changedKeys: ['property'],
          before: { property: propertyWithAi({ params: { instruction: 'Use normal wording' } }) },
          after: { property: propertyWithAi({ params: { instruction: 'Use key sk-123456789012345678901234 for context' } }) },
        }),
      ],
    })
    await nextTick()

    const text = document.body.textContent ?? ''
    expect(text).toContain('aiShortcut.params.instruction')
    expect(text).toContain('Use normal wording')
    expect(text).toContain('sk-<redacted>')
    expect(text).not.toContain('sk-123456789012345678901234')
    expect(text).not.toContain('{"instruction"')
  })

  it('keeps non-aiShortcut property changes on the legacy compact summary path', async () => {
    mountModal({
      items: [
        rev({
          id: 'ordinary-property',
          action: 'update',
          changedKeys: ['property'],
          before: { property: { options: ['A'] } },
          after: { property: { options: ['A', 'B'] } },
        }),
      ],
    })
    await nextTick()

    const text = document.body.textContent ?? ''
    expect(text).toContain('options: A')
    expect(text).toContain('options: A; B')
    expect(text).not.toContain('aiShortcut.kind')
  })

  it('renders mixed aiShortcut property and ordinary name changes without either branch swallowing the other', async () => {
    mountModal({
      items: [
        rev({
          id: 'mixed-update',
          action: 'update',
          changedKeys: ['property', 'name'],
          before: {
            name: 'Old field',
            property: propertyWithAi({ params: { instruction: 'Old instruction' } }),
          },
          after: {
            name: 'New field',
            property: propertyWithAi({ params: { instruction: 'New instruction' } }),
          },
        }),
      ],
    })
    await nextTick()

    const text = document.body.textContent ?? ''
    expect(text).toContain('aiShortcut.params.instruction')
    expect(text).toContain('Old instruction')
    expect(text).toContain('New instruction')
    expect(text).toContain('name')
    expect(text).toContain('Old field')
    expect(text).toContain('New field')
  })

  it('falls back to the raw source field id when the workbench label resolver cannot name it', async () => {
    mountModal({
      recordLabelOf: (id) => id === 'fld_missing' ? id : `name:${id}`,
      items: [
        rev({
          id: 'missing-source-label',
          action: 'create',
          after: { property: propertyWithAi({ sourceFieldIds: ['fld_missing'] }) },
        }),
      ],
    })
    await nextTick()

    expect(document.body.textContent).toContain('fld_missing')
  })
})

describe('MetaConfigHistoryModal — T9-W revert action (server-gated, FE renders the decision)', () => {
  const updateRev = () => rev({ id: 'a', action: 'update', changedKeys: ['name'], before: { name: 'Old' }, after: { name: 'New' } })

  it('no revert button when previewRevert is not provided (read-only mode)', async () => {
    mountModal({ items: [updateRev()] }); await nextTick()
    expect(q('[data-test="config-history-revert"]')).toBeFalsy()
  })

  it('SAFE: revert → preview → confirm → executeRevert(id, previewToken) + reverted emitted', async () => {
    const previewRevert = vi.fn(async () => previewOf({}))
    const executeRevert = vi.fn(async () => {})
    const onReverted = vi.fn()
    mountModal({ items: [updateRev()], previewRevert, executeRevert, onReverted })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()
    expect(previewRevert).toHaveBeenCalledWith('a')
    expect(q('[data-test="config-restore-confirm"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Old') // target
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flush()
    expect(executeRevert).toHaveBeenCalledWith('a', 'tok1', undefined) // the server-minted previewToken, NOT a client hash
    expect(onReverted).toHaveBeenCalledTimes(1)
  })

  it('UNCREATE: create rows open server preview, show the server note, and require typed confirm before execute', async () => {
    const previewRevert = vi.fn(async (): Promise<ConfigRestorePreview> => ({
      revisionId: 'create-1',
      previewToken: 'uncreate-token',
      uncreate: {
        entityType: 'field',
        entityId: 'fld_created',
        entityName: 'Temporary field',
        note: 'Server says this permanently drops the created field and values.',
      },
    }))
    const executeRevert = vi.fn(async () => {})
    mountModal({
      items: [rev({ id: 'create-1', action: 'create', entityId: 'fld_created', after: { name: 'Temporary field' } })],
      previewRevert,
      executeRevert,
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()

    expect(previewRevert).toHaveBeenCalledWith('create-1')
    expect(document.body.textContent).toContain('Server says this permanently drops')
    expect(document.body.textContent).toContain('Temporary field')
    expect((q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).disabled).toBe(true)

    await typeInto('[data-test="config-restore-type-input"]', 'uncreate')
    expect((q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).disabled).toBe(false)
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flush()
    expect(executeRevert).toHaveBeenCalledWith('create-1', 'uncreate-token', 'uncreate')
  })

  it('DESTRUCTIVE execute FAILURE (P3-4): a server 409/422 rejection surfaces config-restore-error, modal stays open', async () => {
    // Runbook (multitable-config-tier-acceptance-runbook-20260705.md §§ii-iv) defines destructive-tier
    // execute-time server rejections (GRANT_DRIFT/PLAN_DRIFT/ID_COLLISION/RESTORE_NOT_SUPPORTED, all
    // non-2xx). The FE surfaces raw e.message generically via confirmRevert's catch — this was never
    // exercised. Drive a real execute-time rejection and assert the error renders + the dialog doesn't
    // silently close (the operator can see what happened, not just an unhandled-rejection void).
    const previewRevert = vi.fn(async (): Promise<ConfigRestorePreview> => ({
      revisionId: 'create-fail',
      previewToken: 'uncreate-token-fail',
      uncreate: {
        entityType: 'field',
        entityId: 'fld_created_fail',
        entityName: 'Field to uncreate',
        note: 'Server says this permanently drops the created field and values.',
      },
    }))
    const executeRevert = vi.fn(async () => { throw new Error('ID_COLLISION: an entity with this id already exists') })
    const onReverted = vi.fn()
    mountModal({
      items: [rev({ id: 'create-fail', action: 'create', entityId: 'fld_created_fail', after: { name: 'Field to uncreate' } })],
      previewRevert,
      executeRevert,
      onReverted,
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()
    await typeInto('[data-test="config-restore-type-input"]', 'uncreate')
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flush()

    expect(executeRevert).toHaveBeenCalledWith('create-fail', 'uncreate-token-fail', 'uncreate')
    expect(q('[data-test="config-restore-error"]')?.textContent).toBe('ID_COLLISION: an entity with this id already exists')
    expect(q('[data-test="config-restore-confirm"]')).toBeTruthy() // the dialog stays open, not silently dismissed
    expect(onReverted).not.toHaveBeenCalled() // no false "success" emission on a failed execute
  })

  it('UNDELETE collision: delete rows show note + idCollision and fail closed without execute', async () => {
    mountModal({
      items: [rev({ id: 'delete-1', action: 'delete', before: { name: 'Deleted field' }, after: null })],
      previewRevert: vi.fn(async (): Promise<ConfigRestorePreview> => ({
        revisionId: 'delete-1',
        previewToken: 'undelete-token',
        undelete: {
          entityType: 'field',
          entityId: 'fld_deleted',
          entityName: 'Deleted field',
          note: 'Definition only; values are not restored.',
          idCollision: true,
        },
      })),
      executeRevert: vi.fn(),
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()

    expect(document.body.textContent).toContain('Definition only')
    expect(document.body.textContent).toContain('ID collision')
    expect(document.body.textContent).toContain('yes')
    expect(q('[data-test="config-restore-type-input"]')).toBeFalsy()
    expect(q('[data-test="config-restore-confirm-btn"]')).toBeFalsy()
  })

  it('UNDELETE non-collision (P3-3): idCollision:false → executable, typed "undelete" confirm executes', async () => {
    // Only the idCollision:true (blocked) branch was ever exercised. This is the executable positive
    // path: idCollision:false must pass canExecutePreview, require the typed "undelete" confirm, and
    // call executeRevert(id, previewToken, 'undelete') — mirroring the UNCREATE test's shape above.
    const previewRevert = vi.fn(async (): Promise<ConfigRestorePreview> => ({
      revisionId: 'delete-2',
      previewToken: 'undelete-token-2',
      undelete: {
        entityType: 'field',
        entityId: 'fld_deleted_2',
        entityName: 'Deleted field 2',
        note: 'Definition only; values are not restored.',
        idCollision: false,
      },
    }))
    const executeRevert = vi.fn(async () => {})
    mountModal({
      items: [rev({ id: 'delete-2', action: 'delete', before: { name: 'Deleted field 2' }, after: null })],
      previewRevert,
      executeRevert,
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()

    expect(previewRevert).toHaveBeenCalledWith('delete-2')
    expect(document.body.textContent).toContain('Definition only')
    // exact-text assertion (not a loose substring — "no" would also match inside "note"/"not"): find the
    // ID-collision row specifically and check its rendered value is exactly "no".
    const idCollisionRow = Array.from(document.body.querySelectorAll('[data-test="config-restore-changes"] .cfg-history__change'))
      .find((row) => row.querySelector('.cfg-history__key')?.textContent === 'ID collision')
    expect(idCollisionRow?.querySelector('.cfg-history__after')?.textContent).toBe('no')
    expect(q('[data-test="config-restore-gated"]')).toBeFalsy() // NOT blocked, unlike the collision case
    expect((q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).disabled).toBe(true)

    await typeInto('[data-test="config-restore-type-input"]', 'undelete')
    expect((q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).disabled).toBe(false)
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flush()
    expect(executeRevert).toHaveBeenCalledWith('delete-2', 'undelete-token-2', 'undelete')
  })

  it('PERMISSION revert: permission rows show direction/note and require revert-permission confirm', async () => {
    const executeRevert = vi.fn(async () => {})
    mountModal({
      items: [rev({ id: 'perm-1', entityType: 'permission', entityId: 'sheet:[\"user\",\"u1\"]', action: 'create' })],
      previewRevert: vi.fn(async (): Promise<ConfigRestorePreview> => ({
        revisionId: 'perm-1',
        previewToken: 'permission-token',
        permissionRevert: {
          scope: 'sheet',
          direction: 'de-escalation',
          supported: true,
          note: "Server says this reduces the subject's access.",
        },
      })),
      executeRevert,
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()

    expect(document.body.textContent).toContain('Direction')
    expect(document.body.textContent).toContain('de-escalation')
    expect(document.body.textContent).toContain('reduces the subject')
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flush()
    expect(executeRevert).not.toHaveBeenCalled()

    await typeInto('[data-test="config-restore-type-input"]', 'revert-permission')
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flush()
    expect(executeRevert).toHaveBeenCalledWith('perm-1', 'permission-token', 'revert-permission')
  })

  it('PERMISSION revert NOT SUPPORTED (P3-1): supported:false + escalation → blocked note shown, no confirm/type surface', async () => {
    // canExecutePreview() reads preview.permissionRevert.supported === true; only the SAFE-supported
    // case above was ever exercised. This is the negative gate: an escalating, server-unsupported revert
    // must render as blocked (the reason) and expose NEITHER the typed-confirm input NOR the confirm button.
    const previewRevert = vi.fn(async (): Promise<ConfigRestorePreview> => ({
      revisionId: 'perm-2',
      previewToken: 'permission-token-2',
      permissionRevert: {
        scope: 'sheet',
        direction: 'escalation',
        supported: false,
        note: 'Server says this would escalate the subject beyond what revert supports.',
      },
    }))
    const executeRevert = vi.fn(async () => {})
    mountModal({
      items: [rev({ id: 'perm-2', entityType: 'permission', entityId: 'sheet:[\"user\",\"u2\"]', action: 'create' })],
      previewRevert,
      executeRevert,
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()

    expect(previewRevert).toHaveBeenCalledWith('perm-2')
    expect(document.body.textContent).toContain('escalation')
    expect(q('[data-test="config-restore-gated"]')).toBeTruthy() // blockedReason() rendered
    expect(document.body.textContent).toContain('would escalate the subject beyond what revert supports')
    expect(q('[data-test="config-restore-type-input"]')).toBeFalsy()
    expect(q('[data-test="config-restore-confirm-btn"]')).toBeFalsy()
    expect(executeRevert).not.toHaveBeenCalled()
  })

  it('END-TO-END wire: Revert button → real client → config-restore-preview then -execute with the SERVER previewToken', async () => {
    // The FULL mount→button→fetch path through a real MultitableApiClient (mocked fetchFn) — not the callback shim —
    // so the token actually flows preview→execute over the wire and execute carries the server token, not a client hash.
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('config-restore-preview')) {
        return new Response(JSON.stringify({ ok: true, data: {
          preview: { revisionId: 'a', entityType: 'field', entityId: 'fld_1', changedKeys: ['name'], current: { name: 'New' }, target: { name: 'Old' }, driftConflict: false, opKind: 'safe', baselineHash: 'h-server' },
          previewToken: 'server-token-xyz',
        } }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: { restored: { revisionId: 'a' } } }), { status: 200 }) // execute
    })
    const client = new MultitableApiClient({ fetchFn })
    const onReverted = vi.fn()
    mountModal({
      items: [updateRev()], onReverted,
      previewRevert: (id: string) => client.getConfigRestorePreview('sheet_1', id),
      executeRevert: (id: string, token: string, confirm) => client.executeConfigRestore('sheet_1', id, token, confirm),
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="config-restore-confirm-btn"]')) // poll until the async preview rendered the confirm panel (CI-robust, not a fixed tick count)
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 2 && onReverted.mock.calls.length >= 1) // poll until the execute fetch fired + reverted emitted
    // the two real fetches happened, in order
    expect(fetchFn.mock.calls[0][0]).toContain('/config-restore-preview')
    expect(fetchFn.mock.calls[1][0]).toContain('/config-restore-execute')
    // the execute body carries the SERVER-minted token (not a client hash) — preview-first can't be bypassed via the UI
    const execBody = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string)
    expect(execBody.previewToken).toBe('server-token-xyz')
    expect(execBody.baselineHash).toBeUndefined()
    expect(onReverted).toHaveBeenCalledTimes(1)
  })

  it('DESTRUCTIVE wire: real client carries previewToken + confirm:"uncreate" to execute', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('config-restore-preview')) {
        return new Response(JSON.stringify({ ok: true, data: {
          uncreate: {
            entityType: 'field',
            entityId: 'fld_created',
            entityName: 'Created Field',
            note: 'Server destructive note.',
          },
          previewToken: 'server-uncreate-token',
        } }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: { uncreated: { entityType: 'field', entityId: 'fld_created' } } }), { status: 200 })
    })
    const client = new MultitableApiClient({ fetchFn })
    const onReverted = vi.fn()
    mountModal({
      items: [rev({ id: 'create-1', action: 'create', entityId: 'fld_created', after: { name: 'Created Field' } })],
      onReverted,
      previewRevert: (id: string) => client.getConfigRestorePreview('sheet_1', id),
      // Workbench-style forwarder: the modal passes the destructive confirm explicitly while safe update bodies stay unchanged.
      executeRevert: (id: string, token: string, confirm) => client.executeConfigRestore('sheet_1', id, token, confirm),
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="config-restore-type-input"]'))
    await typeInto('[data-test="config-restore-type-input"]', 'uncreate')
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 2 && onReverted.mock.calls.length >= 1)

    expect(fetchFn.mock.calls[0][0]).toContain('/config-restore-preview')
    expect(fetchFn.mock.calls[1][0]).toContain('/config-restore-execute')
    const execBody = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string)
    expect(execBody.previewToken).toBe('server-uncreate-token')
    expect(execBody.confirm).toBe('uncreate')
    expect(execBody.baselineHash).toBeUndefined()
    expect(onReverted).toHaveBeenCalledTimes(1)
  })

  it('GATED: the server says opKind=gated → shows the reason, NO confirm button (FE renders, never overrides)', async () => {
    const previewRevert = vi.fn(async () => previewOf({ opKind: 'gated', gatedReason: 'field type reverts are not supported in this slice' }))
    mountModal({ items: [updateRev()], previewRevert, executeRevert: vi.fn() })
    await nextTick(); (q('[data-test="config-history-revert"]') as HTMLButtonElement).click(); await flush()
    expect(q('[data-test="config-restore-gated"]')).toBeTruthy()
    expect(document.body.textContent).toContain('not supported')
    expect(q('[data-test="config-restore-confirm-btn"]')).toBeFalsy()
  })

  it('DRIFT: the server flags driftConflict → warning shown + confirm disabled', async () => {
    const previewRevert = vi.fn(async () => previewOf({ driftConflict: true }))
    mountModal({ items: [updateRev()], previewRevert, executeRevert: vi.fn() })
    await nextTick(); (q('[data-test="config-history-revert"]') as HTMLButtonElement).click(); await flush()
    expect(q('[data-test="config-restore-drift"]')).toBeTruthy()
    expect((q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('pure aiShortcut property updates still rely on the server-gated revert preview, not a new FE restore surface', async () => {
    const previewRevert = vi.fn(async () => previewOf({ opKind: 'gated', gatedReason: 'property reverts are gated' }))
    mountModal({
      items: [
        rev({
          id: 'a',
          action: 'update',
          changedKeys: ['property'],
          before: { property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_a'], params: { instruction: 'old' } } } },
          after: { property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_a'], params: { instruction: 'new' } } } },
        }),
      ],
      previewRevert,
      executeRevert: vi.fn(),
    })
    await nextTick(); (q('[data-test="config-history-revert"]') as HTMLButtonElement).click(); await flush()
    expect(previewRevert).toHaveBeenCalledWith('a')
    expect(q('[data-test="config-restore-gated"]')).toBeTruthy()
    expect(document.body.textContent).toContain('property reverts are gated')
    expect(q('[data-test="config-restore-confirm-btn"]')).toBeFalsy()
  })
})

describe('getConfigHistory — T9-R3↔R4 wire (drift lock)', () => {
  it('round-trips the REAL R3 {ok,data:{items}} envelope (not a fixture) — never silently returns []', async () => {
    // The R3↔R4 seam is drift-prone (cf. dayIndex). R3 returns { ok, data: { items, limit, offset } }; the client's
    // parseJson unwraps .data, so getConfigHistory reads .items off the unwrapped body. Assert against a real-shaped
    // envelope so a future envelope change can't make getConfigHistory always-empty while every isolated test stays green.
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { items: [
        { id: 'cr_1', entityType: 'field', entityId: 'fld_1', action: 'update', before: { name: 'A' }, after: { name: 'B' }, changedKeys: ['name'], batchId: null, actorId: 'u1', createdAt: '2026-06-24T00:00:00Z' },
      ], limit: 50, offset: 0 },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const items = await client.getConfigHistory('sheet_1', { entityType: 'field' })

    expect(items).toHaveLength(1) // NOT [] — the envelope was unwrapped
    expect(items[0].entityId).toBe('fld_1')
    expect(items[0].changedKeys).toEqual(['name'])
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/multitable/sheets/sheet_1/config-history')) // GET passes the URL only
    expect(fetchFn.mock.calls[0][0]).toContain('entityType=field')
  })

  it('getConfigRestorePreview unwraps the REAL {ok,data:{preview}} envelope (not a fixture)', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { preview: { revisionId: 'a', entityType: 'field', entityId: 'fld_1', changedKeys: ['name'], current: { name: 'New' }, target: { name: 'Old' }, driftConflict: false, opKind: 'safe', baselineHash: 'h1' }, previewToken: 'tok1' },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const preview = await client.getConfigRestorePreview('sheet_1', 'a')

    expect(preview.baselineHash).toBe('h1') // unwrapped — NOT undefined
    expect(preview.previewToken).toBe('tok1') // the server token folded in — the execute wire depends on it
    expect(preview.target).toEqual({ name: 'Old' })
    expect(preview.opKind).toBe('safe')
    expect(fetchFn.mock.calls[0][0]).toContain('/config-restore-preview')
  })
})
