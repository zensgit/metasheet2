'use strict'

// PACK-AWARE REFRESH — the productionized half of the factory-A rehearsal.
//
// stock-preparation-customer-pack-rehearsal.test.cjs proved that a refresh CAN be
// filtered by ownership read back off the installed columns. But until now that was
// a SPECIFICATION living in a test: the real conflict planner derived its writable
// set from the FROZEN template and had never heard of `ext_` columns, so "a refresh
// never clobbers a human cell" held by OMISSION — safe by luck, not by decision.
//
// This suite pins the production semantics:
//
//   1. CONTROL — with no installed properties the writable set, the human set and a
//      full four-decision plan are BYTE-IDENTICAL to the pre-change planner. The
//      expected sha256 was captured by running this file's own fixture against the
//      clean base branch (36df394b7) before any edit; see CONTROL_PLAN_SHA256.
//   2. `ext_` + ownership 'plm_system' + extension:true JOINS the writable band, and
//      its values actually land in the ADD record and the UPDATE patch.
//   3. `ext_` + ownership 'human_preserved' — and, independently, a bare
//      preserveOnRefresh:true pin — NEVER joins, and the human WALL now rejects such
//      a column BY NAME (a positive rejection, not an absence).
//   4. FAIL-CLOSED — a missing / malformed / unstamped / unknown ownership property
//      is NOT writable, and the reason is surfaced values-free.
//   5. The rehearsal's local guard and the production function agree.
//
// Hermetic and dependency-free: no DB, no network, no filesystem writes, no clock
// (every timestamp is a fixed literal). Values-free evidence throughout: the only
// literals are schema ids, field ids, frozen reason tokens and synthetic cell text.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  PACK_FIELD_OWNERSHIP_REASONS,
  StockPreparationConflictPlannerError,
  derivePackAwarePlmWritableFields,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
  __internals: plannerInternals,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const {
  applyStockPreparationPlan,
  StockPreparationApplyWriterError,
} = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))

const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const TEMPLATE_FIELDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields

// ── fixture ────────────────────────────────────────────────────────────────────
//
// Fixed run id + fixed plannedAt: the plan must hash the same on every machine and
// every day, or the control assertion below would be a clock test.

const RUN_ID = 'control-baseline-run'
const PLANNED_AT = '2026-01-02T03:04:05.000Z'

/**
 * The pre-change sha256 of `JSON.stringify(plan)` for the fixture below, produced by
 * the clean base branch's planner.
 *
 * HOW IT WAS CAPTURED (repeatable): with the working tree clean at 36df394b7, the
 * fixture and the planStockPreparationConflicts() call in controlIsByteIdentical()
 * were run as a standalone script and the digest recorded. `git stash && node <that
 * script> && git stash pop` reproduces it. If a legitimate change to the CANONICAL
 * plan shape ever moves this digest, it must be re-captured the same way and the move
 * justified — it means the "no pack fields => zero behaviour change" contract broke.
 *
 * RE-PINNED ONCE (was 718f1810…d793f): 备料主表 gained parentComponentCode /
 * parentComponentName / componentSpec. Re-captured by the documented procedure
 * (`git stash && node <that script> && git stash pop`), and the whole plan diffed field
 * by field against the stashed run. EXACTLY two things moved, neither of them a pack
 * fact:
 *   1. `summary.plmSystemFields` — DERIVED from the template's plm_system band, so it
 *      grew the three ids.
 *   2. the CMP-0002 UPDATE patch carries parentComponentCode / parentComponentName. The
 *      patch is a full `pickFields(row, plmFields)` projection, so every plm cell that
 *      is present rides it; `changedFields` did NOT grow (the fixture's existing row
 *      already matches the derived parent), and the decision stays an UPDATE for the
 *      same quantity reason it always was.
 * No count, no decision kind, no conflictSummary, no human field, and no ext_ column
 * moved — the "no pack fields => zero behaviour change" contract is intact.
 *
 * RE-PINNED DELIBERATELY (again, was 16df242d…0ea8f0 after the step above): the canonical template gained the
 * five human_preserved columns `makeOrBuy` / `procurementDone` / `procurementReplyDate` /
 * `warehouseDone` / `actualArrivalDate`, so the plan's `humanPreservedFields` array — the
 * planner's report of what a refresh must NOT touch — is five entries longer.
 *
 * THE MOVE WAS FALSIFIED BEFORE IT WAS ACCEPTED, which is the only reason it is allowed to
 * move at all. Taking the NEW plan and deleting exactly those five ids from that ONE array
 * (nothing else touched, one array rolled back) reproduces the PREVIOUS digest
 * 16df242d…0ea8f0 BYTE-FOR-BYTE. So every decision, every count
 * (add 1 / update 1 / skip 1 / inactive 1 / manual_confirm 0), every row and the whole
 * plmSystemFields band are UNCHANGED: the contract this pin defends — "no pack fields =>
 * zero behaviour change" — still holds. The larger protected set is the intended effect of
 * the template growth, not a behaviour change in the planner.
 */
const CONTROL_PLAN_SHA256 = '10bb6cbbf386775d798921947a5d225731bb7c43f2063ee1420822cf88ec71f8'

function expandedRows() {
  return [
    {
      idempotencyKey: 'PRJ-CTL/CMP-0001/1',
      projectNo: 'PRJ-CTL',
      componentSourceId: 'CMP-0001',
      parentSourceId: null,
      path: 'CMP-0001',
      componentCode: 'C-0001',
      componentName: 'component one',
      material: 'Q235',
      sourceVersion: 'v1',
      depth: 0,
      rawQuantity: 3,
      totalQuantity: 3,
      active: true,
    },
    {
      idempotencyKey: 'PRJ-CTL/CMP-0002/1',
      projectNo: 'PRJ-CTL',
      componentSourceId: 'CMP-0002',
      parentSourceId: 'CMP-0001',
      path: 'CMP-0001/CMP-0002',
      componentCode: 'C-0002',
      componentName: 'component two',
      material: 'Q345',
      sourceVersion: 'v2',
      depth: 1,
      rawQuantity: 7,
      totalQuantity: 21,
      active: true,
    },
    {
      idempotencyKey: 'PRJ-CTL/CMP-0003/1',
      projectNo: 'PRJ-CTL',
      componentSourceId: 'CMP-0003',
      parentSourceId: 'CMP-0001',
      path: 'CMP-0001/CMP-0003',
      componentCode: 'C-0003',
      componentName: 'component three',
      material: 'Q235',
      sourceVersion: 'v1',
      depth: 1,
      rawQuantity: 2,
      totalQuantity: 6,
      active: true,
    },
  ]
}

function existingRows() {
  return [
    // UPDATE: same identity + lineage, moved PLM cells.
    {
      idempotencyKey: 'PRJ-CTL/CMP-0002/1',
      projectNo: 'PRJ-CTL',
      componentSourceId: 'CMP-0002',
      parentSourceId: 'CMP-0001',
      // 备料主表's denormalized parent columns, as a sheet at the CURRENT schema carries them.
      // The planner derives these from the in-batch parent (CMP-0001) at record construction, so a
      // fixture that omitted them would model a sheet mid-backfill and turn the SKIP row below into
      // an UPDATE — losing this suite's four-decision coverage for a reason unrelated to packs.
      parentComponentCode: 'C-0001',
      parentComponentName: 'component one',
      path: 'CMP-0001/CMP-0002',
      componentCode: 'C-0002',
      componentName: 'component two',
      material: 'Q345',
      sourceVersion: 'v2',
      depth: 1,
      rawQuantity: 4,
      totalQuantity: 12,
      active: true,
      notes: 'human note kept',
      procurementReply: 'human reply kept',
    },
    // SKIP: unchanged.
    {
      idempotencyKey: 'PRJ-CTL/CMP-0003/1',
      projectNo: 'PRJ-CTL',
      componentSourceId: 'CMP-0003',
      parentSourceId: 'CMP-0001',
      parentComponentCode: 'C-0001',
      parentComponentName: 'component one',
      path: 'CMP-0001/CMP-0003',
      componentCode: 'C-0003',
      componentName: 'component three',
      material: 'Q235',
      sourceVersion: 'v1',
      depth: 1,
      rawQuantity: 2,
      totalQuantity: 6,
      active: true,
    },
    // INACTIVE: gone from the expansion.
    {
      idempotencyKey: 'PRJ-CTL/CMP-0099/1',
      projectNo: 'PRJ-CTL',
      componentSourceId: 'CMP-0099',
      parentSourceId: 'CMP-0001',
      path: 'CMP-0001/CMP-0099',
      componentCode: 'C-0099',
      componentName: 'component gone',
      material: 'Q235',
      sourceVersion: 'v1',
      depth: 1,
      rawQuantity: 1,
      totalQuantity: 3,
      active: true,
      warehouseConfirmation: 'human confirmation kept',
    },
  ]
}

function plan(extra = {}) {
  return planStockPreparationConflicts({
    expandedRows: expandedRows(),
    existingRows: existingRows(),
    rowErrors: [],
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    ...extra,
  })
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function decisionFor(result, decision, key) {
  return result.decisions.find((entry) => entry.decision === decision && entry.idempotencyKey === key)
}

// ── installed-property builders ────────────────────────────────────────────────
//
// Byte-for-byte the stanza buildExtensionFieldProperty() stamps in
// stock-preparation-customer-pack-installer.cjs. Restated here rather than imported
// so a silent change to the installer's stamp shows up as a FAILURE of this suite,
// not as a matching drift on both sides.

function installedField(fieldId, stockPreparation) {
  return {
    logicalId: fieldId,
    name: fieldId,
    type: 'string',
    property: stockPreparation === undefined ? {} : { stockPreparation },
  }
}

function packStanza(ownership, overrides = {}) {
  return {
    ownership,
    preserveOnRefresh: ownership === 'human_preserved',
    required: false,
    key: false,
    extension: true,
    packId: 'factory-a',
    packVersion: '1.0.0',
    ...overrides,
  }
}

/** The canonical columns as the sheet actually carries them after provisioning. */
function canonicalInstalledFields() {
  return TEMPLATE_FIELDS.map((field) => installedField(field.id, {
    ownership: field.ownership,
    preserveOnRefresh: field.preserveOnRefresh === true,
    required: field.required === true,
    key: field.key === true,
  }))
}

const EXT_PLM = 'ext_plmDrawingRevision'
const EXT_PLM_SECOND = 'ext_plmSurfaceTreatment'
const EXT_HUMAN = 'ext_stockPrepDate'
const EXT_PINNED = 'ext_createdSource'

/** A realistic installed sheet: 28 canonical columns + a small pack band. */
function installedWithPack(extra = []) {
  return canonicalInstalledFields().concat([
    installedField(EXT_PLM, packStanza('plm_system')),
    installedField(EXT_PLM_SECOND, packStanza('plm_system')),
    installedField(EXT_HUMAN, packStanza('human_preserved')),
    // The rehearsal's "the flag must win" case: a deployer pins a hand-maintained
    // column by setting preserveOnRefresh WITHOUT restating ownership.
    installedField(EXT_PINNED, packStanza('plm_system', { preserveOnRefresh: true })),
  ], extra)
}

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONTROL — no pack properties => nothing moved.
// ───────────────────────────────────────────────────────────────────────────────

function controlIsByteIdentical() {
  const legacy = plan()

  assert.equal(
    sha256(legacy),
    CONTROL_PLAN_SHA256,
    'a pack-unaware plan must be byte-identical to the pre-change planner',
  )

  // The fixture has to actually exercise every write-shaped decision, or the digest
  // above would be pinning an empty plan.
  assert.deepEqual(legacy.counts, { add: 1, update: 1, skip: 1, inactive: 1, manual_confirm: 0 })
  assert.equal(legacy.valid, true)

  // The pack-aware summary stanza must be ABSENT, not present-and-empty: an added key
  // would itself be a behaviour change for every existing consumer of the plan object.
  assert.equal(
    Object.prototype.hasOwnProperty.call(legacy.summary, 'packAwareOwnership'),
    false,
    'a pack-unaware plan must not grow a packAwareOwnership key',
  )
  assert.equal(summarizeConflictPlanForEvidence(legacy).packAwareOwnership, undefined)

  // The bands themselves, independently of the digest.
  const derived = derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS })
  assert.deepEqual(derived.humanPreservedFieldIds, HUMAN_PRESERVED_FIELD_IDS.slice())
  assert.deepEqual(derived.plmWritableFieldIds, legacy.summary.plmSystemFields)
  assert.deepEqual(derived.packPlmWritableFieldIds, [])
  assert.deepEqual(derived.packHumanPreservedFieldIds, [])
  assert.equal(derived.packAware, false)

  // ORDER, not just membership: a set-equal-but-reordered band would still move the
  // digest, so this is the assertion that says WHY if it ever does.
  assert.deepEqual(
    derived.plmWritableFieldIds,
    TEMPLATE_FIELDS
      .filter((field) => field.ownership === 'plm_system')
      .map((field) => field.id)
      .filter((id) => !id.startsWith('lastPlm')),
    'the template band keeps template order',
  )

  // And a sheet carrying ONLY the canonical columns must land in exactly the same
  // place — the pack-aware path engaged, nothing added.
  const canonicalOnly = plan({ installedFieldProperties: canonicalInstalledFields() })
  assert.deepEqual(canonicalOnly.summary.plmSystemFields, legacy.summary.plmSystemFields)
  assert.deepEqual(canonicalOnly.summary.humanPreservedFields, legacy.summary.humanPreservedFields)
  assert.deepEqual(canonicalOnly.counts, legacy.counts)
  assert.deepEqual(canonicalOnly.summary.packAwareOwnership.packPlmWritableFieldIds, [])
  assert.deepEqual(canonicalOnly.summary.packAwareOwnership.unclassifiedPackFieldIds, [])
  // Every canonical column reports as template-governed — an installed property may
  // never re-classify a frozen column.
  assert.equal(
    canonicalOnly.summary.packAwareOwnership.reasons.length,
    TEMPLATE_FIELDS.length,
  )
  for (const entry of canonicalOnly.summary.packAwareOwnership.reasons) {
    assert.equal(entry.reason, 'template_governed')
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 2. A stamped ext_ plm_system column JOINS the writes — and its values land.
// ───────────────────────────────────────────────────────────────────────────────

function stampedPackPlmColumnsJoinTheWrites() {
  const derived = derivePackAwarePlmWritableFields({
    templateFields: TEMPLATE_FIELDS,
    installedFieldProperties: installedWithPack(),
  })

  assert.deepEqual(derived.packPlmWritableFieldIds, [EXT_PLM, EXT_PLM_SECOND].sort())
  assert.ok(derived.plmWritableFieldIds.includes(EXT_PLM))
  assert.equal(derived.packAware, true)
  // The template band is untouched and still leads.
  assert.deepEqual(
    derived.plmWritableFieldIds.slice(0, derived.plmWritableFieldIds.length - 2),
    derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS }).plmWritableFieldIds,
  )

  // ADD: the pack column is carried into the new record.
  const rows = expandedRows()
  rows[0][EXT_PLM] = 'REV-C'
  rows[0][EXT_PLM_SECOND] = 'anodized'
  rows[1][EXT_PLM] = 'REV-D'
  // A cell the refresh must NOT carry, offered by the source anyway.
  rows[0][EXT_HUMAN] = 'source must not decide this'
  rows[0][EXT_PINNED] = 'source must not decide this either'

  const result = planStockPreparationConflicts({
    expandedRows: rows,
    existingRows: existingRows(),
    rowErrors: [],
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    installedFieldProperties: installedWithPack(),
  })

  // THE WIRING, stated as an observable: the plan must PUBLISH the same two bands it
  // planned with. The planner hands `humanFields` to its own assertNoHumanFields wall
  // and to this summary from ONE variable, so a planner that quietly kept the
  // template-only human set — leaving the wall unextended — is caught right here.
  assert.deepEqual(result.summary.plmSystemFields, derived.plmWritableFieldIds)
  assert.deepEqual(result.summary.humanPreservedFields, derived.humanPreservedFieldIds)
  assert.ok(result.summary.humanPreservedFields.includes(EXT_HUMAN), 'the wall must know the pack human column')
  assert.ok(result.summary.humanPreservedFields.includes(EXT_PINNED), 'the wall must know the pinned column')
  assert.deepEqual(
    summarizeConflictPlanForEvidence(result).humanPreservedFields,
    derived.humanPreservedFieldIds,
    'the extended band must reach the evidence surface too',
  )

  const added = decisionFor(result, 'add', 'PRJ-CTL/CMP-0001/1')
  assert.ok(added, 'the new component is still an add')
  assert.equal(added.record[EXT_PLM], 'REV-C', 'the pack PLM value must land')
  assert.equal(added.record[EXT_PLM_SECOND], 'anodized')
  assert.equal(
    Object.prototype.hasOwnProperty.call(added.record, EXT_HUMAN),
    false,
    'a pack human column must never reach an add record',
  )
  assert.equal(Object.prototype.hasOwnProperty.call(added.record, EXT_PINNED), false)

  // UPDATE: a moved pack PLM cell is a real change and lands in the patch.
  const updated = decisionFor(result, 'update', 'PRJ-CTL/CMP-0002/1')
  assert.ok(updated)
  assert.equal(updated.patch[EXT_PLM], 'REV-D')
  assert.ok(updated.changedFields.includes(EXT_PLM), 'the pack column is a detected change')
  assert.equal(Object.prototype.hasOwnProperty.call(updated.patch, EXT_HUMAN), false)

  // A pack PLM cell that moved on its own is enough to turn a would-be SKIP into an
  // UPDATE — otherwise the column would be "writable" in name only.
  const skipRows = expandedRows()
  skipRows[2][EXT_PLM] = 'REV-E'
  const skipExisting = existingRows()
  skipExisting[1][EXT_PLM] = 'REV-A'
  const moved = planStockPreparationConflicts({
    expandedRows: skipRows,
    existingRows: skipExisting,
    rowErrors: [],
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    installedFieldProperties: installedWithPack(),
  })
  const promoted = decisionFor(moved, 'update', 'PRJ-CTL/CMP-0003/1')
  assert.ok(promoted, 'a moved pack PLM cell alone must promote skip -> update')
  assert.deepEqual(promoted.changedFields, [EXT_PLM])

  // INACTIVE keeps its shape: it is a lifecycle patch, never a field projection, so
  // no pack column may leak into it.
  const inactive = decisionFor(result, 'inactive', 'PRJ-CTL/CMP-0099/1')
  assert.ok(inactive)
  assert.deepEqual(Object.keys(inactive.patch).sort(), [
    'active',
    'lastPlmConflictSummary',
    'lastPlmRefreshAt',
    'lastPlmRefreshDecision',
    'lastPlmRefreshRunId',
  ])
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. The human band NEVER joins — and the wall rejects it BY NAME.
// ───────────────────────────────────────────────────────────────────────────────

function packHumanColumnsNeverJoinAndTheWallRejectsThem() {
  const derived = derivePackAwarePlmWritableFields({
    templateFields: TEMPLATE_FIELDS,
    installedFieldProperties: installedWithPack(),
  })

  // Both roads into the human band: declared ownership, and a bare pin.
  assert.deepEqual(derived.packHumanPreservedFieldIds, [EXT_PINNED, EXT_HUMAN].sort())
  assert.equal(derived.plmWritableFieldIds.includes(EXT_HUMAN), false)
  assert.equal(derived.plmWritableFieldIds.includes(EXT_PINNED), false)
  assert.ok(derived.humanPreservedFieldIds.includes(EXT_HUMAN))
  assert.ok(derived.humanPreservedFieldIds.includes(EXT_PINNED))

  // The pin WINS over an ownership that says otherwise — EXT_PINNED is stamped
  // plm_system and would be writable on ownership alone.
  const pinnedOnly = derivePackAwarePlmWritableFields({
    templateFields: TEMPLATE_FIELDS,
    installedFieldProperties: [installedField(EXT_PINNED, packStanza('plm_system', { preserveOnRefresh: true }))],
  })
  assert.deepEqual(pinnedOnly.packPlmWritableFieldIds, [])
  assert.deepEqual(pinnedOnly.packHumanPreservedFieldIds, [EXT_PINNED])
  assert.deepEqual(pinnedOnly.reasons, [{ fieldId: EXT_PINNED, reason: 'preserve_on_refresh_pinned' }])

  // A human column can never be talked into the writable band, whatever else the
  // stanza claims — including the extension stamp the PLM band requires.
  for (const overrides of [{}, { extension: true }, { preserveOnRefresh: false }, { required: true }]) {
    const forced = derivePackAwarePlmWritableFields({
      templateFields: TEMPLATE_FIELDS,
      installedFieldProperties: [installedField(EXT_HUMAN, packStanza('human_preserved', overrides))],
    })
    assert.deepEqual(forced.packPlmWritableFieldIds, [], 'human_preserved never joins the writes')
    assert.deepEqual(forced.packHumanPreservedFieldIds, [EXT_HUMAN])
  }

  // ── THE WALL, positively ─────────────────────────────────────────────────────
  // Not "the payload happens not to contain it" but "a payload that DOES contain it
  // is thrown out". First at the planner's own wall.
  assert.throws(
    () => plannerInternals.assertNoHumanFields(
      { componentCode: 'C-0001', [EXT_HUMAN]: 'a cell 备料 typed' },
      derived.humanPreservedFieldIds,
      'add record',
    ),
    (error) => error instanceof StockPreparationConflictPlannerError && error.details.field === EXT_HUMAN,
    'the extended planner wall must reject a pack human column by name',
  )
  assert.throws(
    () => plannerInternals.assertNoHumanFields(
      { componentCode: 'C-0001', [EXT_PINNED]: 'a pinned cell' },
      derived.humanPreservedFieldIds,
      'update patch',
    ),
    (error) => error instanceof StockPreparationConflictPlannerError && error.details.field === EXT_PINNED,
  )
  // The same payload passes the UNEXTENDED wall — which is precisely the gap this
  // change closes, stated as an assertion rather than as prose.
  assert.doesNotThrow(() => plannerInternals.assertNoHumanFields(
    { [EXT_HUMAN]: 'a cell 备料 typed' },
    HUMAN_PRESERVED_FIELD_IDS,
    'add record',
  ))
  // Canonical human fields are still rejected — the wall only ever GREW.
  for (const fieldId of HUMAN_PRESERVED_FIELD_IDS) {
    assert.throws(() => plannerInternals.assertNoHumanFields({ [fieldId]: 'x' }, derived.humanPreservedFieldIds, 'add record'))
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3b. The SAME wall at the apply writer, driven end to end.
// ───────────────────────────────────────────────────────────────────────────────

function createRecordingRecordsApi() {
  const writes = []
  return {
    writes,
    api: {
      async queryRecords() { return [] },
      async createRecord(input) {
        writes.push({ op: 'create', input })
        return { id: `rec_${writes.length}` }
      },
      async patchRecord(input) {
        writes.push({ op: 'patch', input })
        return { id: input.recordId }
      },
    },
  }
}

const APPLY_TARGET = Object.freeze({
  sheetId: 'sheet_stock_preparation',
  objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
  keyField: 'idempotencyKey',
  fieldIdMap: {},
})

async function applyWriterWallRejectsPackHumanColumns() {
  // A CRAFTED plan — the shape a derivation bug, a hand-edited plan, or a future
  // caller could produce. The writer is the last thing between it and the sheet.
  const craftedPlan = {
    valid: true,
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    decisions: [
      {
        decision: 'add',
        idempotencyKey: 'PRJ-CTL/CMP-0001/1',
        record: {
          idempotencyKey: 'PRJ-CTL/CMP-0001/1',
          componentCode: 'C-0001',
          [EXT_HUMAN]: 'a cell the warehouse typed',
        },
      },
    ],
    counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 },
    summary: {},
  }

  // WITHOUT the projection: the legacy posture. The writer cannot know the column is
  // human, so it writes it. This is the gap, asserted so it cannot be misread as a fix.
  const legacyApi = createRecordingRecordsApi()
  const legacy = await applyStockPreparationPlan({
    permission: 'admin',
    plan: craftedPlan,
    target: APPLY_TARGET,
    recordsApi: legacyApi.api,
  })
  assert.equal(legacy.counts.created, 1)
  assert.equal(legacy.counts.failed, 0)

  // WITH the projection: rejected by name, before any write.
  const guardedApi = createRecordingRecordsApi()
  const guarded = await applyStockPreparationPlan({
    permission: 'admin',
    plan: craftedPlan,
    target: APPLY_TARGET,
    recordsApi: guardedApi.api,
    installedFieldProperties: installedWithPack(),
  })
  assert.equal(guarded.counts.created, 0, 'nothing may be written')
  assert.equal(guarded.counts.failed, 1)
  assert.deepEqual(guardedApi.writes, [], 'the wall must bite BEFORE the records API')

  // A canonical human field is still rejected with the projection supplied — the
  // extension must not have replaced the original wall.
  const canonicalApi = createRecordingRecordsApi()
  const canonical = await applyStockPreparationPlan({
    permission: 'admin',
    plan: {
      ...craftedPlan,
      decisions: [{
        decision: 'add',
        idempotencyKey: 'PRJ-CTL/CMP-0001/1',
        record: { idempotencyKey: 'PRJ-CTL/CMP-0001/1', notes: 'a human note' },
      }],
    },
    target: APPLY_TARGET,
    recordsApi: canonicalApi.api,
    installedFieldProperties: installedWithPack(),
  })
  assert.equal(canonical.counts.failed, 1)
  assert.deepEqual(canonicalApi.writes, [])

  // And the writable band really is writable end to end: the pack PLM column lands.
  const okApi = createRecordingRecordsApi()
  const ok = await applyStockPreparationPlan({
    permission: 'admin',
    plan: {
      ...craftedPlan,
      decisions: [{
        decision: 'add',
        idempotencyKey: 'PRJ-CTL/CMP-0001/1',
        record: { idempotencyKey: 'PRJ-CTL/CMP-0001/1', componentCode: 'C-0001', [EXT_PLM]: 'REV-C' },
      }],
    },
    target: APPLY_TARGET,
    recordsApi: okApi.api,
    installedFieldProperties: installedWithPack(),
  })
  assert.equal(ok.counts.created, 1)
  assert.equal(ok.counts.failed, 0)
  assert.equal(okApi.writes.length, 1)
  assert.equal(okApi.writes[0].input.data[EXT_PLM], 'REV-C')

  // The apply-writer's OWN wall default is untouched (hard rule: never weakened).
  assert.throws(
    () => require(path.join(LIB, 'stock-preparation-apply-writer.cjs')).__internals.assertNoHumanFields(
      { notes: 'x' },
      'add record',
    ),
    (error) => error instanceof StockPreparationApplyWriterError && error.details.field === 'notes',
  )
}

// ───────────────────────────────────────────────────────────────────────────────
// 4. FAIL-CLOSED — anything less than a complete, stamped classification.
// ───────────────────────────────────────────────────────────────────────────────

function malformedOwnershipIsNeverWritable() {
  const cases = [
    // [label, installed entry, expected reason]
    ['no property at all', installedField('ext_noProperty', undefined), 'missing_property_stanza'],
    ['property but no stanza', { logicalId: 'ext_noStanza', property: { options: [] } }, 'missing_property_stanza'],
    ['stanza is not an object', { logicalId: 'ext_stanzaString', property: { stockPreparation: 'plm_system' } }, 'malformed_property_stanza'],
    ['stanza is an array', { logicalId: 'ext_stanzaArray', property: { stockPreparation: ['plm_system'] } }, 'malformed_property_stanza'],
    ['stanza is null', { logicalId: 'ext_stanzaNull', property: { stockPreparation: null } }, 'malformed_property_stanza'],
    ['ownership missing', installedField('ext_noOwnership', { extension: true, required: false }), 'missing_ownership'],
    ['ownership blank', installedField('ext_blankOwnership', { ownership: '   ', extension: true }), 'missing_ownership'],
    ['ownership unknown', installedField('ext_weirdOwnership', { ownership: 'erp_system', extension: true }), 'unknown_ownership'],
    ['ownership is not a string', installedField('ext_numericOwnership', { ownership: 7, extension: true }), 'unknown_ownership'],
    // The extension STAMP is what says "a pack installer made this column".
    ['no extension stamp', installedField('ext_unstamped', { ownership: 'plm_system' }), 'missing_extension_stamp'],
    ['extension is truthy but not true', installedField('ext_truthyStamp', { ownership: 'plm_system', extension: 1 }), 'missing_extension_stamp'],
    ['extension is the string true', installedField('ext_stringStamp', { ownership: 'plm_system', extension: 'true' }), 'missing_extension_stamp'],
    ['extension false', installedField('ext_falseStamp', { ownership: 'plm_system', extension: false }), 'missing_extension_stamp'],
    // Outside the tenant-extension namespace entirely.
    ['not ext_ namespaced', installedField('customColumn', packStanza('plm_system')), 'not_extension_namespace'],
    ['bare prefix', installedField('ext_', packStanza('plm_system')), 'not_extension_namespace'],
  ]

  for (const [label, entry, expectedReason] of cases) {
    const derived = derivePackAwarePlmWritableFields({
      templateFields: TEMPLATE_FIELDS,
      installedFieldProperties: [entry],
    })
    assert.deepEqual(derived.packPlmWritableFieldIds, [], `${label}: must not be writable`)
    assert.deepEqual(derived.packHumanPreservedFieldIds, [], `${label}: must not be human either`)
    assert.deepEqual(
      derived.reasons.map((reason) => reason.reason),
      [expectedReason],
      `${label}: the reason must be surfaced`,
    )
    assert.ok(
      PACK_FIELD_OWNERSHIP_REASONS.includes(expectedReason),
      `${label}: the reason must come from the frozen vocabulary`,
    )
    // Fail-closed both ways: unclassified is not silently human either — except for
    // the namespace rejections, which are not pack columns at all.
    if (expectedReason !== 'not_extension_namespace') {
      assert.deepEqual(derived.unclassifiedPackFieldIds, [entry.logicalId], `${label}: surfaced as unclassified`)
    }
  }

  // A blank/absent id, and a duplicate id, are both refused rather than guessed at.
  const noisy = derivePackAwarePlmWritableFields({
    templateFields: TEMPLATE_FIELDS,
    installedFieldProperties: [
      { property: { stockPreparation: packStanza('plm_system') } },
      installedField(EXT_PLM, packStanza('plm_system')),
      installedField(EXT_PLM, packStanza('human_preserved')),
    ],
  })
  assert.deepEqual(noisy.packPlmWritableFieldIds, [EXT_PLM], 'first classification wins; the repeat is refused')
  assert.deepEqual(noisy.packHumanPreservedFieldIds, [])
  assert.deepEqual(
    noisy.reasons.map((reason) => reason.reason).sort(),
    ['duplicate_field_id', 'invalid_field_id'],
  )

  // An unclassified column stays out of the writes in a REAL plan, not just in the
  // derivation — and its reason travels values-free in the summary.
  const rows = expandedRows()
  rows[0].ext_unstamped = 'a value nobody classified'
  const result = planStockPreparationConflicts({
    expandedRows: rows,
    existingRows: existingRows(),
    rowErrors: [],
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    installedFieldProperties: installedWithPack([
      installedField('ext_unstamped', { ownership: 'plm_system' }),
    ]),
  })
  const added = decisionFor(result, 'add', 'PRJ-CTL/CMP-0001/1')
  assert.equal(Object.prototype.hasOwnProperty.call(added.record, 'ext_unstamped'), false)
  assert.deepEqual(result.summary.packAwareOwnership.unclassifiedPackFieldIds, ['ext_unstamped'])
  assert.ok(result.summary.packAwareOwnership.reasons.some(
    (reason) => reason.fieldId === 'ext_unstamped' && reason.reason === 'missing_extension_stamp',
  ))

  // VALUES-FREE: the evidence carries ids, frozen tokens and counts — never a cell.
  const serialized = JSON.stringify(summarizeConflictPlanForEvidence(result).packAwareOwnership)
  assert.equal(serialized.includes('a value nobody classified'), false)
  assert.equal(serialized.includes('factory-a'), false, 'no pack provenance leaks into evidence')
  for (const reason of result.summary.packAwareOwnership.reasons) {
    assert.ok(PACK_FIELD_OWNERSHIP_REASONS.includes(reason.reason), `${reason.reason} must be a frozen token`)
  }

  // Structural refusals: a shape the planner cannot interpret is an error, not a
  // silent empty band.
  assert.throws(
    () => derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS, installedFieldProperties: 'ext_plm' }),
    (error) => error instanceof StockPreparationConflictPlannerError,
  )
  assert.throws(
    () => derivePackAwarePlmWritableFields({ templateFields: 'nope' }),
    (error) => error instanceof StockPreparationConflictPlannerError,
  )
}

// ───────────────────────────────────────────────────────────────────────────────
// 5. Input-shape tolerance + agreement with the rehearsal's guard.
// ───────────────────────────────────────────────────────────────────────────────

function acceptsTheShapesACallerActuallyHolds() {
  const asArray = installedWithPack()
  const expected = derivePackAwarePlmWritableFields({
    templateFields: TEMPLATE_FIELDS,
    installedFieldProperties: asArray,
  })

  // The host fields map: keyed by PHYSICAL id, logical id on the row.
  const asMap = new Map(asArray.map((row, index) => [`fld_${index}`, row]))
  assert.deepEqual(
    derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS, installedFieldProperties: asMap }).plmWritableFieldIds,
    expected.plmWritableFieldIds,
  )

  // A plain object keyed by logical id.
  const asObject = {}
  for (const row of asArray) asObject[row.logicalId] = { property: row.property }
  assert.deepEqual(
    derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS, installedFieldProperties: asObject }).plmWritableFieldIds,
    expected.plmWritableFieldIds,
  )

  // The template may be handed over whole rather than as its field list.
  assert.deepEqual(
    derivePackAwarePlmWritableFields({
      templateFields: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
      installedFieldProperties: asArray,
    }).plmWritableFieldIds,
    expected.plmWritableFieldIds,
  )

  // Deterministic regardless of the caller's iteration order.
  const shuffled = asArray.slice().reverse()
  assert.deepEqual(
    derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS, installedFieldProperties: shuffled }).plmWritableFieldIds,
    expected.plmWritableFieldIds,
  )
}

/**
 * The rehearsal derived its own `plmWritableFieldIds` locally, as a SPECIFICATION.
 * That spec is now production code, so the two must agree — otherwise the rehearsal
 * would keep proving something the refresh does not actually do.
 *
 * The rehearsal's guard is deliberately LOOSER (it predates the extension stamp): it
 * admits any classified non-human column. Production is a SUBSET of it, never a
 * superset — production may refuse more, never more permit.
 */
function agreesWithTheRehearsalSpecification() {
  const rehearsalGuard = (fields) => {
    const writable = []
    for (const row of fields.values()) {
      const meta = row.property && row.property.stockPreparation
      if (!meta) continue
      if (meta.ownership !== 'human_preserved' && !meta.preserveOnRefresh) writable.push(row.logicalId)
    }
    return writable
  }

  const fields = new Map(installedWithPack().map((row, index) => [`fld_${index}`, row]))
  const rehearsalWritable = new Set(rehearsalGuard(fields))
  const production = derivePackAwarePlmWritableFields({
    templateFields: TEMPLATE_FIELDS,
    installedFieldProperties: fields,
  })

  // On a properly installed sheet the two are EQUIVALENT: every stamped pack column
  // the rehearsal admits, production admits.
  for (const fieldId of production.packPlmWritableFieldIds) {
    assert.ok(rehearsalWritable.has(fieldId), `${fieldId}: production must not exceed the rehearsal spec`)
  }
  const rehearsalPackWritable = [...rehearsalWritable].filter((fieldId) => fieldId.startsWith('ext_')).sort()
  assert.deepEqual(production.packPlmWritableFieldIds, rehearsalPackWritable)

  // Where they differ is the TIGHTENING: an unstamped column the rehearsal would
  // have admitted is refused by production.
  const unstamped = new Map(fields)
  unstamped.set('fld_unstamped', installedField('ext_unstamped', { ownership: 'plm_system' }))
  assert.ok(rehearsalGuard(unstamped).includes('ext_unstamped'), 'the looser spec admits it')
  assert.equal(
    derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS, installedFieldProperties: unstamped })
      .packPlmWritableFieldIds
      .includes('ext_unstamped'),
    false,
    'production refuses it — the extension stamp is required',
  )

  // Both agree on every human column, which is the assertion that actually matters.
  for (const fieldId of [EXT_HUMAN, EXT_PINNED, ...HUMAN_PRESERVED_FIELD_IDS]) {
    assert.equal(rehearsalWritable.has(fieldId), false)
    assert.equal(production.plmWritableFieldIds.includes(fieldId), false)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  assert.equal(typeof derivePackAwarePlmWritableFields, 'function', 'the production derivation must be exported')

  controlIsByteIdentical()
  stampedPackPlmColumnsJoinTheWrites()
  packHumanColumnsNeverJoinAndTheWallRejectsThem()
  await applyWriterWallRejectsPackHumanColumns()
  malformedOwnershipIsNeverWritable()
  acceptsTheShapesACallerActuallyHolds()
  agreesWithTheRehearsalSpecification()
}

main().then(
  () => {
    console.log('stock-preparation-pack-aware-refresh.test.cjs OK')
  },
  (error) => {
    // An async suite must fail the chain LOUDLY: without this the process could exit
    // before the rejection surfaced and the `&&` chain would march on.
    console.error(error)
    process.exitCode = 1
  },
)
