'use strict'

// #3751 stock-prep MVP: bridge PLM BOM expansion output rows -> bom-snapshot-line shape.
//
// AUDIT BUG (readonly MVP): expandPlmProjectBom() (stock-preparation-bom-expansion.cjs) emits rows
// keyed componentCode / sourceVersion / path / rawQuantity / totalQuantity / depth (+ a `missing_child_bom`
// rowError that is never stamped onto any row), BUT planBomSnapshotDiff (stock-preparation-snapshot-diff.cjs)
// and generateStockPreparationMvp (stock-preparation-mvp-generation.cjs) consume childDrawingNo /
// childVersion / pathKey / designQty / designUnit / lineStatus / sourceFingerprint. This is a hard
// field-vocabulary mismatch, and because the expansion emits `missing_child_bom` as a rowError (no row),
// the diff/generation `missing_child_bom` branch is unreachable end-to-end.
//
// This module is the missing bridge. It is PURE and DETERMINISTIC: no route, no I/O, no external
// call, no MetaSheet / PLM / ERP / K3 read or write, no SQL. It only reshapes already-in-memory
// expansion output. The mapping is keyed to PLM_STOCK_PREPARATION_BOM_READ_PLAN (DN_PDM default):
// the plan declares part.codeField (IdentityNo -> componentCode -> childDrawingNo),
// part.versionField (SysVer -> sourceVersion -> childVersion) and bomDetail/orderDetail.quantityField
// (-> rawQuantity -> designQty). The plan declares NO unit field, so designUnit is only stamped when
// the caller supplies opts.defaultDesignUnit — it is never invented.
//
// It builds ONTO landed helpers: the field-vocabulary primitives (firstValue / firstNumber) and the
// deterministic hashing helpers (stableHash / stableJson / stableFingerprint) are reused from
// stock-preparation-common.cjs + stock-preparation-readonly-intake.cjs so both intake paths agree.

const {
  firstValue,
  isPlainObject,
  optionalString,
} = require('./stock-preparation-common.cjs')
const {
  __internals: { firstNumber, stableFingerprint, stableHash, stableJson },
} = require('./stock-preparation-readonly-intake.cjs')
const { PLM_STOCK_PREPARATION_BOM_READ_PLAN } = require('./stock-preparation-bom-expansion.cjs')

const LINE_STATUSES = Object.freeze({
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  INCOMPLETE: 'incomplete',
})

// The expansion emits `missing_child_bom` rowErrors (a parent BOM head with no detail rows). Both the
// diff engine (currentHasMissingChildBom) and generation (MISSING_CHILD_BOM exception) detect a line via
// `missingChildBom === true`, so that boolean is the marker we stamp onto a synthesized incomplete line.
const MISSING_CHILD_BOM_ROW_ERROR = 'missing_child_bom'

// designQty maps to the PLAN's declared quantityField (surfaced by the expansion as rawQuantity) and
// NOT the derived totalQuantity rollup — "use the plan's declared field, do not invent". Ordering mirrors
// stock-preparation-readonly-intake.cjs so routing an expansion row through either path yields one value.
const DESIGN_QTY_KEYS = Object.freeze(['designQty', 'rawQuantity', 'totalQuantity'])

// 规格. The expansion emits `spec` only where the read plan DECLARED a spec column
// (readPlan.part.specField); `specification` is accepted so a row that came in through the readonly
// intake vocabulary maps identically. Closed list, same discipline as DESIGN_QTY_KEYS.
const SPEC_KEYS = Object.freeze(['spec', 'specification'])

class StockPreparationExpansionSnapshotMapperError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationExpansionSnapshotMapperError'
    this.details = details
  }
}

// Ground the childDrawingNo/childVersion mapping in the read plan rather than inventing it: the plan
// must declare the part code field the expansion's componentCode was sourced from.
function assertPlanGrounded(plan) {
  const part = (isPlainObject(plan) && isPlainObject(plan.part)) ? plan.part : {}
  const codeField = optionalString(part.codeField)
  if (!codeField) {
    throw new StockPreparationExpansionSnapshotMapperError(
      'readPlan.part.codeField is required — childDrawingNo mapping must be grounded in the read plan',
      { field: 'readPlan.part.codeField' },
    )
  }
  return { codeField, versionField: optionalString(part.versionField) }
}

// D-C (stock-preparation-bom-expansion.cjs ROW_ERROR_LIMIT). `expansion.rowErrors` is capped at 5000
// entries, so the array this module reads is a SAMPLE, not the set — and this module's whole job is
// to turn `missing_child_bom` rowErrors into the incomplete snapshot lines the diff engine and
// generation branch on. A project whose `missing_child_bom` entries all landed past the cap would
// therefore be mapped as if it had none: `status` flips 'incomplete' -> 'mapped', the incomplete
// lines are never synthesized, `stock-preparation-sync-run-plan.cjs` computes no flags off them and
// the run is persisted as SUCCEEDED. That is the same fail-open the cap opened in
// `hasHardApplyBlockingRowErrors`, in the second place the array is mistaken for the facts.
//
// The expander publishes the TRUE per-type totals whenever it truncated, and they ride on
// `expansion.summary`, which the live callers already hand over whole. This reads them.
//
// Returns `null` for every expansion under the cap, so nothing below it changes by a byte.
function rowErrorTruncationOf(rowsArg, retainedMissingChildBom) {
  const summary = (isPlainObject(rowsArg) && isPlainObject(rowsArg.summary)) ? rowsArg.summary : null
  if (!summary || summary.rowErrorsTruncated !== true) return null
  const counts = isPlainObject(summary.rowErrorTypeCounts) ? summary.rowErrorTypeCounts : {}
  const trueMissingChildBom = Number(counts[MISSING_CHILD_BOM_ROW_ERROR] || 0)
  const total = Number(summary.rowErrorsTotal || 0)
  return {
    rowErrorsTotal: Number.isFinite(total) ? total : 0,
    // The count this mapper could NOT synthesize a line for. Non-zero is the whole point: it is the
    // number of incomplete lines the batch is knowingly short, and it is what forbids 'mapped'.
    unstampedMissingChildBom: Number.isFinite(trueMissingChildBom) && trueMissingChildBom > retainedMissingChildBom
      ? trueMissingChildBom - retainedMissingChildBom
      : 0,
    trueMissingChildBom: Number.isFinite(trueMissingChildBom) ? trueMissingChildBom : 0,
  }
}

function extractRowsAndErrors(rowsArg, options) {
  const optRowErrors = Array.isArray(options.rowErrors) ? options.rowErrors : null
  if (isPlainObject(rowsArg) && Array.isArray(rowsArg.rows)) {
    const rowErrors = optRowErrors || (Array.isArray(rowsArg.rowErrors) ? rowsArg.rowErrors : [])
    return { rows: rowsArg.rows, rowErrors }
  }
  if (rowsArg === undefined || rowsArg === null) {
    return { rows: [], rowErrors: optRowErrors || [] }
  }
  if (!Array.isArray(rowsArg)) {
    throw new StockPreparationExpansionSnapshotMapperError(
      'rows must be an array of expansion rows or an expansion result object',
      { field: 'rows' },
    )
  }
  return { rows: rowsArg, rowErrors: optRowErrors || [] }
}

// componentSourceId -> row, so a child's parentSourceId can resolve to the parent's drawing/version.
// The expansion emits componentSourceId + parentSourceId precisely to allow this in-batch join; the
// part code/version are identical across every path a component appears on, so first-occurrence wins.
function buildParentIndex(rows) {
  const index = new Map()
  for (const row of rows) {
    const sourceId = optionalString(row && row.componentSourceId)
    if (sourceId && !index.has(sourceId)) index.set(sourceId, row)
  }
  return index
}

// Source-identity subset the fingerprint is computed over — a stable hash that changes when the PLM
// source of the line changes, so the diff engine can raise SOURCE_FINGERPRINT_CHANGED. Deterministic
// via stableJson (sorted keys). Never leaks raw values: only the hash is stored.
function sourceIdentity(row) {
  return {
    componentSourceId: optionalString(row && row.componentSourceId),
    componentCode: optionalString(row && row.componentCode),
    sourceVersion: optionalString(row && row.sourceVersion),
    material: optionalString(row && row.material),
    parentSourceId: optionalString(row && row.parentSourceId),
    path: optionalString(row && row.path),
    rawQuantity: firstNumber(row, ['rawQuantity']),
    totalQuantity: firstNumber(row, ['totalQuantity']),
  }
}

function clean(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

function snapshotLineIdFor(snapshotBatchId, pathKey, fallbackSeed) {
  const seed = optionalString(pathKey) || fallbackSeed
  return `stockprep_snapshot_line_${stableHash(`${snapshotBatchId}|${seed}`)}`
}

function toSnapshotLine({ row, parentIndex, snapshotBatchId, defaultDesignUnit }) {
  const pathKey = firstValue(row, ['pathKey', 'path', 'bomPath'])
  const parentSourceId = optionalString(row && row.parentSourceId)
  const parent = parentSourceId ? parentIndex.get(parentSourceId) : null
  const snapshotLineId = firstValue(row, ['snapshotLineId']) ||
    snapshotLineIdFor(snapshotBatchId, pathKey, stableJson(sourceIdentity(row)))
  return clean({
    snapshotLineId,
    snapshotBatchId,
    // parentSourceId is only an OBJ_ID in the expansion output; resolve it to the parent's drawing/version.
    parentDrawingNo: firstValue(row, ['parentDrawingNo', 'parentCode']) ||
      (parent ? firstValue(parent, ['componentCode']) : null),
    parentVersion: firstValue(row, ['parentVersion']) ||
      (parent ? firstValue(parent, ['sourceVersion']) : null),
    // 父组件名称. The expansion never emits a parentName key at all — the parent is only an OBJ_ID on
    // the child row — so it resolves the same way parentDrawingNo/parentVersion already do: through
    // the in-batch parentIndex, reading the PARENT row's componentName. Closed vocabulary, same
    // ordering discipline (explicit key first, then the indexed parent), no invention.
    parentName: firstValue(row, ['parentName']) ||
      (parent ? firstValue(parent, ['componentName']) : null),
    childDrawingNo: firstValue(row, ['childDrawingNo', 'componentCode']),
    childVersion: firstValue(row, ['childVersion', 'sourceVersion']),
    // 当前组件/零件名称. The expansion HAS carried componentName since the MVP (createRow reads the
    // plan's part.nameField); it was read and then dropped here. Persisting it is what lets the
    // material matcher's plmNameOf() see a name instead of a bare drawing number.
    childName: firstValue(row, ['childName', 'componentName']),
    // Fingerprint decomposition (stock-prep-change-adjudication-20260901): material is persisted as a
    // first-class line field so the diff can raise MATERIAL_CHANGED by name. It was ALREADY part of
    // sourceIdentity (hashed below), so the fingerprint computation is unchanged — historical batches
    // simply lack the field and the diff falls back to the fingerprint for that dimension.
    material: firstValue(row, ['material']),
    // 规格. Present only where the deployment DECLARED a spec column on its read plan
    // (readPlan.part.specField). Undeclared => the expansion row has no `spec` key => firstValue
    // yields null => clean() drops it. Absence, never a guessed column and never an empty string.
    spec: firstValue(row, SPEC_KEYS),
    bomLevel: firstNumber(row, ['bomLevel', 'depth']),
    pathKey,
    designQty: firstNumber(row, DESIGN_QTY_KEYS),
    // 总数量. DESIGN_QTY_KEYS deliberately falls back to totalQuantity for designQty, which meant a
    // row carrying BOTH persisted only the per-level number and the rollup was lost. This keeps the
    // rollup as its own field; designQty's own resolution is untouched.
    totalQuantity: firstNumber(row, ['totalQuantity']),
    designUnit: firstValue(row, ['designUnit', 'unit']) || defaultDesignUnit || null,
    lineStatus: firstValue(row, ['lineStatus']) ||
      (row && row.active === false ? LINE_STATUSES.INACTIVE : LINE_STATUSES.ACTIVE),
    sourceFingerprint: firstValue(row, ['sourceFingerprint']) ||
      stableFingerprint(stableJson(sourceIdentity(row))),
  })
}

// Stamp an expansion `missing_child_bom` rowError into a synthetic incomplete snapshot line. The
// rowError carries no path/component, so a deterministic synthetic pathKey is used (non-empty, so the
// diff does not route it to MISSING_PATH_KEY). lineStatus is 'incomplete' AND missingChildBom:true is
// the marker both the diff engine and generation branch on to raise the missing_child_bom case.
function stampMissingChildLine({ rowError, index, snapshotBatchId }) {
  const depth = Number.isInteger(rowError && rowError.depth) ? rowError.depth : undefined
  const pathKey = `missing-child-bom|depth:${depth === undefined ? 'na' : depth}|idx:${index}`
  return clean({
    snapshotLineId: snapshotLineIdFor(snapshotBatchId, pathKey, pathKey),
    snapshotBatchId,
    bomLevel: depth,
    pathKey,
    lineStatus: LINE_STATUSES.INCOMPLETE,
    missingChildBom: true,
    sourceFingerprint: stableFingerprint(stableJson({
      rowError: { type: MISSING_CHILD_BOM_ROW_ERROR, field: optionalString(rowError && rowError.field), depth },
      index,
    })),
  })
}

function summarizeBy(rows, field) {
  const out = {}
  for (const row of rows) {
    const key = optionalString(row && row[field]) || 'unknown'
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function buildValuesFreeEvidence({ expansionRows, rowErrors, mappedLines, stampedLines, plan, rowErrorTruncation }) {
  const allLines = mappedLines.concat(stampedLines)
  const retainedMissingChildBom = rowErrors.filter(
    (entry) => isPlainObject(entry) && optionalString(entry.type) === MISSING_CHILD_BOM_ROW_ERROR,
  ).length
  const truncated = isPlainObject(rowErrorTruncation) ? rowErrorTruncation : null
  return {
    input: {
      expansionRows: expansionRows.length,
      // TRUE TOTALS once D-C truncated, not array lengths — `input` is what
      // `stock-preparation-sync-run-plan.cjs` stringifies into the persisted run's `inputShape`, and
      // a run record that reports the sample size as the input size is a durable false number. The
      // sample size stays available, under its own key, mounted only when the two differ.
      rowErrors: truncated ? Math.max(truncated.rowErrorsTotal, rowErrors.length) : rowErrors.length,
      missingChildBomRowErrors: truncated
        ? Math.max(truncated.trueMissingChildBom, retainedMissingChildBom)
        : retainedMissingChildBom,
      // CONDITIONAL, so every expansion under the cap keeps a byte-identical evidence stanza.
      ...(truncated
        ? { rowErrorsTruncated: true, rowErrorsRetained: rowErrors.length }
        : {}),
    },
    result: {
      lines: allLines.length,
      mappedLines: mappedLines.length,
      stampedMissingChildLines: stampedLines.length,
      byLineStatus: summarizeBy(allLines, 'lineStatus'),
      withParentDrawingNo: mappedLines.filter((line) => optionalString(line.parentDrawingNo)).length,
      missingChildBomMarked: allLines.filter((line) => line.missingChildBom === true).length,
      // The gap between what the expansion FOUND and what this mapper could synthesize a line for.
      // Mounted only when it is non-zero, and it is the reason `status` is forced off 'mapped'.
      ...(truncated && truncated.unstampedMissingChildBom > 0
        ? { unstampedMissingChildBomRowErrors: truncated.unstampedMissingChildBom }
        : {}),
    },
    // readPlanId is a public compile-time template constant (not a secret / tenant / host / private config).
    readPlanId: optionalString(plan && plan.id),
    valuesFree: true,
  }
}

function mapExpansionRowsToSnapshotLines(rows, opts = {}) {
  const options = isPlainObject(opts) ? opts : {}
  const snapshotBatchId = optionalString(options.snapshotBatchId)
  if (!snapshotBatchId) {
    throw new StockPreparationExpansionSnapshotMapperError('opts.snapshotBatchId is required', {
      field: 'opts.snapshotBatchId',
    })
  }
  const plan = isPlainObject(options.readPlan) ? options.readPlan : PLM_STOCK_PREPARATION_BOM_READ_PLAN
  assertPlanGrounded(plan)
  const defaultDesignUnit = optionalString(options.defaultDesignUnit) || undefined

  const { rows: expansionRows, rowErrors } = extractRowsAndErrors(rows, options)
  const normalizedRows = expansionRows.map((row, index) => {
    if (!isPlainObject(row)) {
      throw new StockPreparationExpansionSnapshotMapperError(`rows[${index}] must be an object`, {
        field: `rows[${index}]`,
      })
    }
    return row
  })

  const parentIndex = buildParentIndex(normalizedRows)
  const mappedLines = normalizedRows.map((row) => toSnapshotLine({
    row,
    parentIndex,
    snapshotBatchId,
    defaultDesignUnit,
  }))

  const stampedLines = []
  rowErrors.forEach((rowError, index) => {
    if (isPlainObject(rowError) && optionalString(rowError.type) === MISSING_CHILD_BOM_ROW_ERROR) {
      stampedLines.push(stampMissingChildLine({ rowError, index, snapshotBatchId }))
    }
  })

  // D-C fail-closed. See `rowErrorTruncationOf`: when the cap dropped `missing_child_bom` entries
  // this mapper never saw them, so `stampedLines.length` is short and 'mapped' would be a claim the
  // expansion's own summary contradicts. `null` (and therefore no change at all) below the cap.
  const rowErrorTruncation = rowErrorTruncationOf(rows, stampedLines.length)
  const missingChildBomUnstamped = rowErrorTruncation ? rowErrorTruncation.unstampedMissingChildBom > 0 : false

  const lines = mappedLines.concat(stampedLines)
  return {
    status: (stampedLines.length || missingChildBomUnstamped) ? 'incomplete' : 'mapped',
    snapshotBatchId,
    lines,
    evidence: buildValuesFreeEvidence({
      expansionRows: normalizedRows,
      rowErrors,
      mappedLines,
      stampedLines,
      plan,
      rowErrorTruncation,
    }),
  }
}

function summarizeExpansionSnapshotMappingForEvidence(result = {}) {
  if (!isPlainObject(result.evidence)) {
    return buildValuesFreeEvidence({ expansionRows: [], rowErrors: [], mappedLines: [], stampedLines: [], plan: {} })
  }
  return JSON.parse(JSON.stringify(result.evidence))
}

module.exports = {
  LINE_STATUSES,
  MISSING_CHILD_BOM_ROW_ERROR,
  DESIGN_QTY_KEYS,
  SPEC_KEYS,
  StockPreparationExpansionSnapshotMapperError,
  mapExpansionRowsToSnapshotLines,
  summarizeExpansionSnapshotMappingForEvidence,
  __internals: {
    assertPlanGrounded,
    buildParentIndex,
    extractRowsAndErrors,
    sourceIdentity,
    stampMissingChildLine,
    toSnapshotLine,
  },
}
