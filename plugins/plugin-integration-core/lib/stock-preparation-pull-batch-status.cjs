'use strict'

// ---------------------------------------------------------------------------------------------------
// 批次标识 (pull batch) — THE STATUS READ, THE BOARD STANZA AND THE READINESS v3 FACTS (batch-identifier design §8.7;
// U05; S6 C-9; register R-65).
//
// ONE derivation for three readers: the ADMIN status route answers it whole (FLAT — `switchOn`, `columns`, … at the top
// level, never under a `pullBatch` key, P-6); pilot readiness v3 reads six booleans off it (ONE memoized call per
// evaluation, critic M5); the operator board answers a small fail-soft stanza (ON only, P-7). Every part answers "ok"
// only on POSITIVE evidence: a probe that throws, an absent host surface, a computed-only field read all read as not ok,
// and one unreadable part never hides the others (each is read on its own and reports itself unreadable).
//
// SWITCH OFF => NO LEDGER IO AND NO ROWS READ (`ledger.readable: null`, `rows: null`): the status answers from host
// reads only, and the pilot readiness evaluation costs what it did before readiness v3 (critic M14).
//
// VALUES-FREE: modes, booleans, closed tokens, counts, a batch number and a label (an ordinal and a day). No field id,
// view id, sheet id, row value or project number leaves this module: `columns.pullBatch` / `columns.firstPullBatch`
// are BOOLEANS (the route suites pin "no fld_ in the response").
// ---------------------------------------------------------------------------------------------------

const {
  PULL_BATCH_BAND_FIELD_IDS,
  isPullBatchEvidenceRow,
  isPullBatchGapRow,
  parsePullBatchLabel,
  rowPullBatchFacts,
  __internals: { isPersonCreatedRow },
} = require('./stock-preparation-pull-batch.cjs')
const { isPullBatchBandProperty } = require('./stock-preparation-templates.cjs')
const { manualPrefixRowsOf } = require('./stock-preparation-manual-rows.cjs')
const { resolveFieldExistence } = require('./stock-preparation-target-provisioning.cjs')

const RESOLVED_HISTORY_STATUSES = Object.freeze(['born_empty', 'backfilled'])

// The two plugin views the band must stay visible in: 备料填写视图 and 待填写 (the templates' logical view ids).
const PULL_BATCH_STATUS_VIEW_LOGICAL_IDS = Object.freeze({ fill: 'prep-fill', todo: 'prep-todo' })

// Closed status reasons (design §8.7). `rows_unreadable`: the project's rows could not be read, so gap rows are unknown.
const PULL_BATCH_STATUS_REASONS = Object.freeze([
  'disabled',
  'not_installed',
  'columns_unproven',
  'columns_partial',
  'lock_unmarked',
  'ledger_unreadable',
  'history_pending',
  'installing',
  'history_gap',
  'rows_unreadable',
  'band_hidden_in_view',
  'landing_not_fill',
  'person_rows_present',
  'locked_rows_present',
])
// Advisory reasons never decide `ready`.
const PULL_BATCH_ADVISORY_REASONS = Object.freeze(['landing_not_fill', 'person_rows_present', 'locked_rows_present'])

// Pilot readiness v3 (design §8.7): inserted immediately before `continuation_support_version`, which stays last (P-8).
const PULL_BATCH_READINESS_CHECK_IDS = Object.freeze([
  'pull_batch_enabled',
  'pull_batch_columns_present',
  'pull_batch_columns_locked',
  'pull_batch_columns_visible',
  'pull_batch_ledger_readable',
  'pull_batch_history_resolved',
])

// The board stanza's closed `paused` reasons.
const PULL_BATCH_BOARD_PAUSED_REASONS = Object.freeze([
  'not_installed',
  'columns_unproven',
  'columns_partial',
  'history_pending',
  'installing',
  'ledger_unreadable',
  'history_gap',
])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

const BAND_KEYS = Object.freeze(['pullBatch', 'firstPullBatch'])

// The web's hidden rule (apps/web/src/multitable/utils/field-permissions.ts): a field whose property says so is hidden
// in every view (critic M13; host parity view-landing.ts).
function propertyHides(property) {
  return isPlainObject(property) && (property.hidden === true || property.visible === false)
}

async function readColumns({ provisioning, projectId, objectId, band }) {
  const unavailable = { mode: 'unavailable', present: { pullBatch: false, firstPullBatch: false }, locked: 0, hiddenByProperty: false }
  if (!provisioning || !nonEmptyString(projectId) || !nonEmptyString(objectId)) return unavailable
  if (typeof provisioning.resolveExistingObjectFieldIds !== 'function' && typeof provisioning.resolveFieldIds !== 'function') return unavailable
  let verdict
  try {
    verdict = await resolveFieldExistence({ provisioning, projectId, objectId, fieldIds: BAND_KEYS.map((key) => PULL_BATCH_BAND_FIELD_IDS[key]) })
  } catch {
    return unavailable
  }
  const resolved = verdict && isPlainObject(verdict.resolved) ? verdict.resolved : {}
  const present = {}
  for (const key of BAND_KEYS) {
    const physical = resolved[PULL_BATCH_BAND_FIELD_IDS[key]]
    present[key] = Boolean(band && typeof physical === 'string' && physical === band.fieldIds[key])
  }
  let locked = 0
  let hiddenByProperty = false
  if (verdict.fieldExistenceMode === 'db' && typeof provisioning.getObjectField === 'function') {
    for (const key of BAND_KEYS) {
      if (!present[key]) continue
      try {
        const field = await provisioning.getObjectField({ projectId, objectId, fieldId: PULL_BATCH_BAND_FIELD_IDS[key] })
        const property = field && isPlainObject(field.property) ? field.property : null
        if (isPullBatchBandProperty(property)) locked += 1
        if (propertyHides(property)) hiddenByProperty = true
      } catch {
        // an unreadable property is neither a lock nor visible
        hiddenByProperty = true
      }
    }
  }
  return { mode: verdict.fieldExistenceMode, present, locked, hiddenByProperty }
}

async function readViews({ provisioning, projectId, objectId, band, columns }) {
  const out = { readable: false, fill: false, todo: false, bandHiddenIn: [] }
  if (!provisioning || typeof provisioning.findObjectView !== 'function') return out
  const hiddenIds = new Set(BAND_KEYS.map((key) => PULL_BATCH_BAND_FIELD_IDS[key]))
  if (band) for (const key of BAND_KEYS) hiddenIds.add(band.fieldIds[key])
  try {
    for (const [name, viewId] of Object.entries(PULL_BATCH_STATUS_VIEW_LOGICAL_IDS)) {
      const view = await provisioning.findObjectView({ projectId, objectId, viewId })
      if (!view) continue
      out[name] = true
      const hidden = Array.isArray(view.hiddenFieldIds) ? view.hiddenFieldIds : []
      if ((columns && columns.hiddenByProperty) || hidden.some((id) => hiddenIds.has(typeof id === 'string' ? id.trim() : String(id)))) out.bandHiddenIn.push(name)
    }
  } catch {
    return { readable: false, fill: false, todo: false, bandHiddenIn: [] }
  }
  out.readable = true
  return out
}

async function readLayout({ provisioning, projectId, objectId }) {
  if (!provisioning || typeof provisioning.describeObjectSheetLayout !== 'function') return null
  try {
    const layout = await provisioning.describeObjectSheetLayout({
      projectId,
      objectId,
      candidateViewLogicalIds: Object.values(PULL_BATCH_STATUS_VIEW_LOGICAL_IDS),
      leftInsertCount: 2,
    })
    if (!isPlainObject(layout)) return null
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
    const firstView = typeof layout.firstView === 'string' ? layout.firstView : null
    return {
      firstView: firstView === 'prep-fill' ? 'fill' : firstView === 'prep-todo' ? 'todo' : firstView === null ? null : (firstView === 'default' ? 'default' : 'other'),
      viewsLosingFrozen: count(layout.viewsLosingFrozen),
      personalOrderOverrides: count(layout.personalOrderOverrides),
      trashedRecordCount: count(layout.trashedRecordCount),
    }
  } catch {
    return null
  }
}

async function readLedger({ store, tenantId, sheetId, projectNo }) {
  const unreadable = { readable: false, historyStatus: null, historyMode: null, historyBatchCount: null, batchCount: null, openBatchNo: null, latest: null, captured: null, placement: null }
  if (!store || typeof store.readSheetState !== 'function') return unreadable
  try {
    const state = await store.readSheetState({ tenantId, sheetId, projectNo })
    const batches = Array.isArray(state.batches) ? state.batches : []
    const live = batches.filter((batch) => batch && batch.status !== 'void')
    const open = batches.find((batch) => batch && batch.status === 'open') || null
    const newest = live.reduce((best, batch) => (best === null || batch.batchNo > best.batchNo ? batch : best), null)
    const sheet = state.sheet
    return {
      readable: true,
      historyStatus: sheet ? sheet.historyStatus : null,
      historyMode: sheet ? sheet.historyMode : null,
      historyBatchCount: sheet ? sheet.historyBatchCount : null,
      batchCount: live.length,
      openBatchNo: open ? open.batchNo : null,
      latest: newest ? { label: newest.label, batchNo: newest.batchNo } : null,
      captured: sheet ? { firstPullBatchRule: sheet.firstPullBatchRule, labelFormat: sheet.labelFormat, labelLocale: sheet.labelLocale } : null,
      placement: sheet ? sheet.bandPlacement : null,
    }
  } catch {
    return unreadable
  }
}

async function readRows({ readExistingStockPreparationRows, recordsApi, target, projectNo, band }) {
  if (typeof readExistingStockPreparationRows !== 'function' || !recordsApi || !target || !nonEmptyString(projectNo)) return null
  let rows
  try {
    rows = await readExistingStockPreparationRows(recordsApi, target, projectNo, { pullBatchBand: band || undefined })
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const counts = { total: rows.length, machine: 0, labelled: 0, gap: 0, unknown: 0, person: 0, manual: 0, unboundPrefix: 0, nonPlugin: 0, locked: 0 }
  // The reader parks every `manual:` prefix row off the array (B1); counted from its Symbol (critic M10: may be null).
  const parked = manualPrefixRowsOf(rows)
  counts.manual = parked && Array.isArray(parked.manualRows) ? parked.manualRows.length : 0
  counts.unboundPrefix = parked && Number.isSafeInteger(parked.unboundKeyCount) ? parked.unboundKeyCount : 0
  for (const row of rows) {
    const facts = rowPullBatchFacts(row)
    if (facts.locked) counts.locked += 1
    if (isPersonCreatedRow(row)) {
      counts.person += 1
      continue
    }
    // C4: a creator-less row is evidence only when it is a plugin row with a RUN stamp; the rest are counted apart.
    if (!isPullBatchEvidenceRow(row)) {
      counts.nonPlugin += 1
      continue
    }
    counts.machine += 1
    if (facts.pullBatch.trim() !== '' && facts.firstPullBatch.trim() !== '') counts.labelled += 1
    if (isPullBatchGapRow(row)) counts.gap += 1
    if (parsePullBatchLabel(facts.firstPullBatch).kind === 'unknown') counts.unknown += 1
  }
  return counts
}

/**
 * The status of ONE project sheet's pull-batch band (design §8.7). `deps` (server-held, never request-supplied):
 *   enabled, provisioning, projectId, objectId, tenantId, sheetId, projectNo, store, recordsApi, target,
 *   readExistingStockPreparationRows, band ({ fieldIds } — the derived physical ids).
 * Never throws for a fact it cannot read: the part answers unreadable and `ready` is false.
 */
async function readPullBatchStatus(deps = {}) {
  const enabled = deps.enabled === true
  const band = deps.band && isPlainObject(deps.band.fieldIds) ? deps.band : null
  const columns = await readColumns({ ...deps, band })
  const views = await readViews({ ...deps, band, columns })
  const layout = await readLayout(deps)
  // OFF => zero ledger IO and no rows read.
  const ledger = enabled
    ? await readLedger(deps)
    : { readable: null, historyStatus: null, historyMode: null, historyBatchCount: null, batchCount: null, openBatchNo: null, latest: null, captured: null, placement: null }
  const rows = enabled ? await readRows({ ...deps, band }) : null
  const reasons = []
  if (!enabled) reasons.push('disabled')
  const both = columns.present.pullBatch && columns.present.firstPullBatch
  if (columns.mode !== 'db') reasons.push('columns_unproven')
  else if (!columns.present.pullBatch && !columns.present.firstPullBatch) reasons.push('not_installed')
  else if (!both) reasons.push('columns_partial')
  if (columns.mode === 'db' && both && columns.locked < 2) reasons.push('lock_unmarked')
  if (enabled) {
    if (ledger.readable !== true) reasons.push('ledger_unreadable')
    else if (ledger.historyStatus === 'installing') reasons.push('installing')
    else if (!RESOLVED_HISTORY_STATUSES.includes(ledger.historyStatus)) reasons.push('history_pending')
    if (rows === null) reasons.push('rows_unreadable')
    else if (rows.gap > 0) reasons.push('history_gap')
  }
  // LIVE (S6 C-9): the band hidden in a plugin view that EXISTS (its hidden list, physical or logical id, or the field
  // property's hidden rule). An absent view hides nothing (its existence is views_present's check); views the host cannot
  // read are unknown, so they block.
  if (!views.readable || views.bandHiddenIn.length > 0) reasons.push('band_hidden_in_view')
  if (layout && layout.firstView !== null && layout.firstView !== 'fill') reasons.push('landing_not_fill')
  if (rows && rows.person > 0) reasons.push('person_rows_present')
  if (rows && rows.locked > 0) reasons.push('locked_rows_present')
  const blocking = reasons.filter((reason) => !PULL_BATCH_ADVISORY_REASONS.includes(reason))
  return Object.freeze({
    switchOn: enabled,
    columns: Object.freeze({ mode: columns.mode, pullBatch: columns.present.pullBatch, firstPullBatch: columns.present.firstPullBatch, locked: columns.locked }),
    placement: ledger.placement || null,
    views: Object.freeze({
      readable: views.readable,
      fill: views.fill,
      todo: views.todo,
      bandHiddenIn: Object.freeze(views.bandHiddenIn.slice()),
      layout: layout ? Object.freeze({ firstView: layout.firstView, viewsLosingFrozen: layout.viewsLosingFrozen, personalOrderOverrides: layout.personalOrderOverrides }) : null,
    }),
    ledger: Object.freeze({
      readable: ledger.readable,
      historyStatus: ledger.historyStatus,
      historyMode: ledger.historyMode,
      historyBatchCount: ledger.historyBatchCount,
      batchCount: ledger.batchCount,
      openBatchNo: ledger.openBatchNo,
      captured: ledger.captured ? Object.freeze({ ...ledger.captured }) : null,
    }),
    rows: rows ? Object.freeze({ ...rows }) : null,
    trashedRecordCount: layout ? layout.trashedRecordCount : null,
    ready: enabled && blocking.length === 0,
    reasons: Object.freeze(reasons),
  })
}

// The status readiness v3 reads while the switch is OFF: no host read, no ledger read, no rows read — the OFF pilot
// GET / enable cost what they did before readiness v3 (critic M14); all six v3 checks are false.
const PULL_BATCH_STATUS_SWITCH_OFF = Object.freeze({
  switchOn: false,
  columns: Object.freeze({ mode: 'unread', pullBatch: false, firstPullBatch: false, locked: 0 }),
  placement: null,
  views: Object.freeze({ readable: false, fill: false, todo: false, bandHiddenIn: Object.freeze([]), layout: null }),
  ledger: Object.freeze({ readable: null, historyStatus: null, historyMode: null, historyBatchCount: null, batchCount: null, openBatchNo: null, captured: null }),
  rows: null,
  trashedRecordCount: null,
  ready: false,
  reasons: Object.freeze(['disabled']),
})

/** Readiness v3's ONE status read: the full status while the switch is on; the fixed OFF status (zero IO) otherwise. */
async function readPullBatchReadinessStatus(deps = {}) {
  return deps.enabled === true ? readPullBatchStatus(deps) : PULL_BATCH_STATUS_SWITCH_OFF
}

/** The six readiness v3 booleans off one status (S6 C-9: present, locked, LIVE visible, readable, resolved). */
function pullBatchReadinessChecks(status) {
  const s = isPlainObject(status) ? status : {}
  const columns = isPlainObject(s.columns) ? s.columns : {}
  const views = isPlainObject(s.views) ? s.views : {}
  const ledger = isPlainObject(s.ledger) ? s.ledger : {}
  const rows = isPlainObject(s.rows) ? s.rows : null
  const present = columns.mode === 'db' && columns.pullBatch === true && columns.firstPullBatch === true
  return Object.freeze({
    pull_batch_enabled: s.switchOn === true,
    pull_batch_columns_present: present,
    pull_batch_columns_locked: present && columns.locked === 2,
    pull_batch_columns_visible: present && views.readable === true && Array.isArray(views.bandHiddenIn) && views.bandHiddenIn.length === 0,
    pull_batch_ledger_readable: ledger.readable === true,
    pull_batch_history_resolved: ledger.readable === true && RESOLVED_HISTORY_STATUSES.includes(ledger.historyStatus) && rows !== null && rows.gap === 0,
  })
}

/**
 * The operator board's stanza (design §8.7; P-7: ON only — the route passes this reader only while the switch is on).
 * FAIL-SOFT (G10): the board never fails for it. Reads: the band probe (two ids) -> the ledger -> the rows only when
 * resolved. `deps` as for `readPullBatchStatus` (the route passes enabled: true).
 */
async function readPullBatchBoardStanza(deps = {}) {
  const failSoft = Object.freeze({ enabled: true, ready: false, latest: null, batchCount: null, paused: 'ledger_unreadable' })
  try {
    if (!deps.target || !nonEmptyString(deps.sheetId)) return Object.freeze({ enabled: true, ready: false, latest: null, batchCount: null, paused: 'not_installed' })
    const band = deps.band && isPlainObject(deps.band.fieldIds) ? deps.band : null
    const columns = await readColumns({ ...deps, band })
    const both = columns.present.pullBatch && columns.present.firstPullBatch
    let paused = null
    if (columns.mode !== 'db') paused = 'columns_unproven'
    else if (!columns.present.pullBatch && !columns.present.firstPullBatch) paused = 'not_installed'
    else if (!both) paused = 'columns_partial'
    if (paused) return Object.freeze({ enabled: true, ready: false, latest: null, batchCount: null, paused })
    const ledger = await readLedger(deps)
    if (ledger.readable !== true) return failSoft
    if (ledger.historyStatus === 'installing') paused = 'installing'
    else if (!RESOLVED_HISTORY_STATUSES.includes(ledger.historyStatus)) paused = 'history_pending'
    let gapRows = null
    if (!paused) {
      const rows = await readRows({ ...deps, band })
      if (rows === null) return failSoft
      if (rows.gap > 0) {
        paused = 'history_gap'
        gapRows = rows.gap
      }
    }
    return Object.freeze({
      enabled: true,
      ready: paused === null,
      latest: ledger.latest ? Object.freeze({ ...ledger.latest }) : null,
      batchCount: ledger.batchCount,
      paused,
      ...(gapRows !== null ? { gapRows } : {}),
      // 批次标识 BI-3 S-1 (R-65): the sheet's CAPTURED 首次批次 rule, one closed token, so the board's meaning copy follows
      // it (design §5.5). Present only when the ledger holds a _sheet row; every early return and the fail-soft shape are
      // unchanged.
      ...(ledger.captured && typeof ledger.captured.firstPullBatchRule === 'string' ? { firstPullBatchRule: ledger.captured.firstPullBatchRule } : {}),
    })
  } catch {
    return failSoft
  }
}

module.exports = {
  PULL_BATCH_ADVISORY_REASONS,
  PULL_BATCH_BOARD_PAUSED_REASONS,
  PULL_BATCH_READINESS_CHECK_IDS,
  PULL_BATCH_STATUS_REASONS,
  PULL_BATCH_STATUS_SWITCH_OFF,
  PULL_BATCH_STATUS_VIEW_LOGICAL_IDS,
  pullBatchReadinessChecks,
  readPullBatchBoardStanza,
  readPullBatchReadinessStatus,
  readPullBatchStatus,
}
