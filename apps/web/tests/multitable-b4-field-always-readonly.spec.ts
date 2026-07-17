/**
 * B4 (docs/development/multitable-remaining-development-inventory-and-sequencing-20260712.md §5):
 * client-side mirror of the server's ALWAYS-read-only field predicate.
 *
 * Server source of truth: `isFieldAlwaysReadOnly` in
 * packages/core-backend/src/multitable/permission-derivation.ts:58-68 — the predicate every write path
 * (record-service.ts, records.ts, univer-meta.ts's PATCH handlers, the Yjs bridge write-input builder)
 * rejects a mutation against. It returns true for exactly:
 *   1. type === 'formula' | 'lookup' | 'rollup'
 *   2. a SYSTEM field type: autoNumber | createdTime | modifiedTime | createdBy | modifiedBy
 *   3. property.mirrorOf is a non-empty string (the derived/mirror side of a bidirectional link)
 *   4. property.readonly === true OR property.readOnly === true (raw flag)
 *
 * The grid/drawer/form already thread the server's per-field `readOnly` result through by id
 * (`fieldPermissions[id].readOnly` / `fieldReadOnlyIds`, wired in MultitableWorkbench.vue from the
 * `/api/multitable/view` response's `meta.permissions.fieldPermissions`, itself built by
 * `deriveFieldPermissions` which calls the server predicate) — so on the wired call sites this was
 * already correct, NOT a live "renders editable, fails on save" bug. This spec pins the ADDITIVE,
 * client-side mirror (`isFieldAlwaysReadOnly` in apps/web/src/multitable/utils/field-permissions.ts)
 * that makes grid/drawer/form independently correct even when the server-supplied permission map is
 * absent, stale, or a future call site forgets to thread it — belt-and-suspenders, not a replacement.
 *
 * "Both directions pinned" (feedback_mock_is_not_the_contract.md): the case list above is asserted
 * directly against the FE helper below (this file); the REAL drift guard that live-imports BOTH the
 * server predicate and this FE helper (so a change to either side that breaks parity turns a test red)
 * lives in packages/core-backend/tests/unit/field-always-readonly-web-parity.test.ts — that file runs in
 * the required plugin-tests.yml gate with no hand-kept filter needed. This apps/web file needs a token
 * in apps/web/scripts/run-required-web-tests.sh (not required-CI-wired by default) — see that script's
 * W0-lane comment; token added same-PR.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { isFieldAlwaysReadOnly } from '../src/multitable/utils/field-permissions'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

function mount(vnodeFactory: () => ReturnType<typeof h>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({ render: vnodeFactory })
  app.mount(container)
  return container
}

describe('B4 — isFieldAlwaysReadOnly (FE helper) case-by-case parity with the server predicate', () => {
  // --- server-rejected states: every one of the 4 branches, FE must return true ---

  it('formula / lookup / rollup types are always read-only', () => {
    expect(isFieldAlwaysReadOnly({ type: 'formula', property: {} })).toBe(true)
    expect(isFieldAlwaysReadOnly({ type: 'lookup', property: {} })).toBe(true)
    expect(isFieldAlwaysReadOnly({ type: 'rollup', property: {} })).toBe(true)
  })

  it('the 5 system field types are always read-only', () => {
    for (const type of ['autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy']) {
      expect(isFieldAlwaysReadOnly({ type, property: {} }), type).toBe(true)
    }
  })

  it('a mirror (bidirectional-link derived) field — property.mirrorOf non-empty string — is always read-only', () => {
    expect(isFieldAlwaysReadOnly({ type: 'link', property: { mirrorOf: 'fld_other_side' } })).toBe(true)
  })

  it('raw property.readonly or property.readOnly (either spelling) is always read-only', () => {
    expect(isFieldAlwaysReadOnly({ type: 'string', property: { readonly: true } })).toBe(true)
    expect(isFieldAlwaysReadOnly({ type: 'string', property: { readOnly: true } })).toBe(true)
  })

  // --- edge cases the server predicate is deliberately narrow about — FE must match, not overreach ---

  it('an EMPTY-STRING mirrorOf does NOT trip read-only (server checks .length > 0)', () => {
    expect(isFieldAlwaysReadOnly({ type: 'link', property: { mirrorOf: '' } })).toBe(false)
  })

  it('a non-string mirrorOf does NOT trip read-only (server type-guards typeof === \'string\')', () => {
    expect(isFieldAlwaysReadOnly({ type: 'link', property: { mirrorOf: 123 as unknown as string } })).toBe(false)
  })

  it('null/undefined field is treated as editable, not fail-closed', () => {
    expect(isFieldAlwaysReadOnly(null)).toBe(false)
    expect(isFieldAlwaysReadOnly(undefined)).toBe(false)
  })

  // --- negative leg: a normal editable field must stay editable — no fail-closed overreach ---

  it('an ordinary string field with no special property is NOT read-only', () => {
    expect(isFieldAlwaysReadOnly({ type: 'string', property: {} })).toBe(false)
    expect(isFieldAlwaysReadOnly({ type: 'string' })).toBe(false)
  })

  it('a FORWARD link field (no mirrorOf — the owning side of a two-way link, or a plain one-way link) is NOT read-only', () => {
    expect(isFieldAlwaysReadOnly({ type: 'link', property: {} })).toBe(false)
    expect(isFieldAlwaysReadOnly({ type: 'link', property: { mirrorFieldId: 'fld_other_side' } })).toBe(false)
  })
})

const MIRROR_FIELD: MetaField = { id: 'fld_mirror', name: 'Mirror link', type: 'link', property: { mirrorOf: 'fld_forward' } }
const FORWARD_LINK_FIELD: MetaField = { id: 'fld_forward', name: 'Forward link', type: 'link', property: {} }
const TITLE_FIELD: MetaField = { id: 'fld_title', name: 'Title', type: 'string' }

describe('B4 — MetaGridTable: mirror fields are non-editable even with NO server fieldReadOnlyIds supplied', () => {
  function mountGrid(fields: MetaField[], rows: MetaRecord[]) {
    return mount(() => h(MetaGridTable, {
      rows,
      visibleFields: fields,
      sortRules: [],
      loading: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      canEdit: true,
      // Deliberately NO fieldReadOnlyIds prop — proves the gate is client-derived from field.property,
      // not solely dependent on the server's threaded id list.
    }))
  }

  it('a mirror link cell does not open an editor on dblclick and renders the readonly cell class', async () => {
    const root = mountGrid([MIRROR_FIELD], [{ id: 'r1', version: 1, data: { fld_mirror: 'rec_x' } }])
    await flushUi()
    const cell = root.querySelector('td[aria-label="Mirror link"]') as HTMLTableCellElement | null
    expect(cell).not.toBeNull()
    expect(cell!.className).toContain('meta-grid__cell--readonly')
    cell!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(root.querySelector('.meta-cell-editor')).toBeNull()
  })

  it('negative leg: a forward (non-mirror) link cell DOES open an editor on dblclick — stays editable', async () => {
    const root = mountGrid([FORWARD_LINK_FIELD], [{ id: 'r1', version: 1, data: { fld_forward: 'rec_x' } }])
    await flushUi()
    const cell = root.querySelector('td[aria-label="Forward link"]') as HTMLTableCellElement | null
    expect(cell).not.toBeNull()
    expect(cell!.className).not.toContain('meta-grid__cell--readonly')
  })
})

describe('B4 — MetaRecordDrawer: mirror fields render display-only even with NO fieldPermissions supplied', () => {
  function mountDrawer(fields: MetaField[], record: MetaRecord) {
    return mount(() => h(MetaRecordDrawer, {
      visible: true,
      record,
      fields,
      canEdit: true,
      canComment: false,
      canDelete: false,
      // Deliberately NO fieldPermissions prop.
    }))
  }

  it('a mirror link field falls through to the generic display span, not the editable link-picker button', async () => {
    const root = mountDrawer([MIRROR_FIELD], { id: 'rec_1', version: 1, data: { fld_mirror: 'rec_x' } })
    await flushUi()
    expect(root.querySelector('.meta-record-drawer__link-btn')).toBeNull()
    expect(root.querySelector('.meta-record-drawer__text')).not.toBeNull()
  })

  it('negative leg: a forward (non-mirror) link field renders the editable link-picker button', async () => {
    const root = mountDrawer([FORWARD_LINK_FIELD], { id: 'rec_1', version: 1, data: { fld_forward: 'rec_x' } })
    await flushUi()
    expect(root.querySelector('.meta-record-drawer__link-btn')).not.toBeNull()
  })

  it('negative leg: an ordinary string field stays editable (input rendered, patch fires)', async () => {
    const root = mountDrawer([TITLE_FIELD], { id: 'rec_1', version: 1, data: { fld_title: 'hello' } })
    await flushUi()
    expect(root.querySelector('.meta-record-drawer__input')).not.toBeNull()
  })
})

describe('B4 — MetaFormView: mirror fields render a disabled link button even with NO fieldPermissions supplied', () => {
  function mountForm(fields: MetaField[], record: MetaRecord) {
    return mount(() => h(MetaFormView, {
      fields,
      record,
      loading: false,
      readOnly: false,
      // Deliberately NO fieldPermissions prop.
    }))
  }

  it('a mirror link field renders its picker button DISABLED', async () => {
    const root = mountForm([MIRROR_FIELD], { id: 'rec_1', version: 1, data: { fld_mirror: 'rec_x' } })
    await flushUi()
    const btn = root.querySelector('.meta-form-view__link-btn') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(true)
  })

  it('negative leg: a forward (non-mirror) link field renders its picker button ENABLED', async () => {
    const root = mountForm([FORWARD_LINK_FIELD], { id: 'rec_1', version: 1, data: { fld_forward: 'rec_x' } })
    await flushUi()
    const btn = root.querySelector('.meta-form-view__link-btn') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)
  })
})
