'use strict'

// DF-T3b-1 pure resolver tests. Plain node test (throws on failure). Locks the four outcomes, the
// five resolution rules, the contract error-type tokens (unresolved/ambiguous/incomplete-row),
// sourceCode normalization, values-free evidence, and template-error vs data-outcome separation.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  OUTCOME,
  STATUS_TO_ERROR_TYPE,
  UNRESOLVED_PLACEHOLDER,
  buildReferenceMappingIndex,
  resolveReference,
  resolveReferenceFromRows,
  resolveReferenceRuleValue,
  resolveReferenceRulesIntoRecord,
} = require(path.join(__dirname, '..', 'lib', 'reference-mapping-resolver.cjs'))
const { K3_REFERENCE_MAPPING_TEMPLATES, ReferenceMappingTemplateError } = require(path.join(__dirname, '..', 'lib', 'reference-mapping-templates.cjs'))

const byDomain = Object.fromEntries(K3_REFERENCE_MAPPING_TEMPLATES.map((t) => [t.domain, t]))
const UNIT = byDomain.unit // FNumber / require-fnumber-fname
const CATEGORY = byDomain.category // FID / require-fid-fname

// Assert evidence is VALUES-FREE: only the allowed keys, and none of the customer values appear.
function assertEvidenceValuesFree(evidence, forbiddenValues) {
  const allowed = new Set(['field', 'domain', 'sourceCodePresent', 'errorType'])
  for (const k of Object.keys(evidence)) assert.ok(allowed.has(k), `evidence key "${k}" not allowed`)
  const blob = JSON.stringify(evidence)
  for (const v of forbiddenValues) assert.ok(!blob.includes(v), `evidence must not carry customer value "${v}"`)
}

function main() {
  // ---- resolved: exactly one enabled+complete row → reference {FNumber,FName}, no errorType ----
  {
    const rows = [{ sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: true }]
    const out = resolveReferenceFromRows(UNIT, rows, 'PCS', { field: 'FUnitID' })
    assert.equal(out.status, OUTCOME.RESOLVED)
    assert.deepEqual(out.reference, { FNumber: '01', FName: 'Each' }, 'resolved reference carries the full object')
    assert.equal(out.evidence.errorType, undefined, 'resolved has no errorType')
    assert.equal(out.evidence.field, 'FUnitID')
    assert.equal(out.evidence.domain, 'unit')
    assert.equal(out.evidence.sourceCodePresent, true)
    assertEvidenceValuesFree(out.evidence, ['01', 'Each', 'PCS'])
  }

  // ---- FID domain (category) resolves {FID,FName} ----
  {
    const rows = [{ sourceCode: 'RAW', fID: '1001', fName: 'Raw', enabled: true }]
    const out = resolveReferenceFromRows(CATEGORY, rows, 'RAW')
    assert.equal(out.status, OUTCOME.RESOLVED)
    assert.deepEqual(out.reference, { FID: '1001', FName: 'Raw' })
  }

  // ---- enabled === false is NOT indexed → that row alone resolves to unresolved ----
  {
    const rows = [{ sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: false }]
    const out = resolveReferenceFromRows(UNIT, rows, 'PCS')
    assert.equal(out.status, OUTCOME.UNRESOLVED, 'disabled row is invisible')
    assert.equal(out.reference, undefined)
  }
  // ---- all-disabled rows for a sourceCode → unresolved (not a distinct "disabled" outcome) ----
  {
    const rows = [
      { sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: false },
      { sourceCode: 'PCS', fNumber: '02', fName: 'Box', enabled: false },
    ]
    assert.equal(resolveReferenceFromRows(UNIT, rows, 'PCS').status, OUTCOME.UNRESOLVED)
  }
  // ---- absent `enabled` is treated as enabled (only `=== false` excludes) ----
  {
    const out = resolveReferenceFromRows(UNIT, [{ sourceCode: 'PCS', fNumber: '01', fName: 'Each' }], 'PCS')
    assert.equal(out.status, OUTCOME.RESOLVED, 'absent enabled → indexed')
  }

  // ---- blank sourceCode rows are ignored (never indexed) ----
  {
    const rows = [{ sourceCode: '   ', fNumber: '01', fName: 'Each', enabled: true }]
    const idx = buildReferenceMappingIndex(UNIT, rows)
    assert.equal(idx.buckets.size, 0, 'blank-sourceCode row not indexed')
  }

  // ---- 0 matches → unresolved ----
  {
    const out = resolveReferenceFromRows(UNIT, [{ sourceCode: 'PCS', fNumber: '01', fName: 'Each' }], 'NOPE')
    assert.equal(out.status, OUTCOME.UNRESOLVED)
    assert.equal(out.evidence.errorType, 'unresolved')
  }

  // ---- 2+ enabled+complete → ambiguous, fail-closed, NO reference, NO pick-first ----
  {
    const rows = [
      { sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: true },
      { sourceCode: 'PCS', fNumber: '02', fName: 'Box', enabled: true },
    ]
    const out = resolveReferenceFromRows(UNIT, rows, 'PCS')
    assert.equal(out.status, OUTCOME.AMBIGUOUS)
    assert.equal(out.reference, undefined, 'ambiguous never picks the first row')
    assert.equal(out.evidence.errorType, 'ambiguous')
  }
  // ---- 2+ IDENTICAL complete rows → STILL ambiguous (no dedup; keeps parity order-independent) ----
  {
    const rows = [
      { sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: true },
      { sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: true },
    ]
    assert.equal(resolveReferenceFromRows(UNIT, rows, 'PCS').status, OUTCOME.AMBIGUOUS, 'identical duplicates do NOT dedup')
  }

  // ---- exactly 1 complete + N incomplete siblings → resolved (single complete wins) ----
  {
    const rows = [
      { sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: true },
      { sourceCode: 'PCS', fNumber: '', fName: 'Broken', enabled: true }, // incomplete sibling
    ]
    const out = resolveReferenceFromRows(UNIT, rows, 'PCS')
    assert.equal(out.status, OUTCOME.RESOLVED, 'one complete wins over incomplete siblings')
    assert.deepEqual(out.reference, { FNumber: '01', FName: 'Each' })
  }

  // ---- incomplete: a matching enabled row missing fName → INCOMPLETE, errorType 'incomplete-row' ----
  {
    const out = resolveReferenceFromRows(UNIT, [{ sourceCode: 'PCS', fNumber: '01', fName: '  ', enabled: true }], 'PCS')
    assert.equal(out.status, OUTCOME.INCOMPLETE)
    assert.equal(out.reference, undefined)
    assert.equal(out.evidence.errorType, 'incomplete-row', 'contract token is incomplete-row, NOT incomplete')
  }
  // ---- incomplete: missing the identifier component (fNumber / fID) ----
  {
    assert.equal(resolveReferenceFromRows(UNIT, [{ sourceCode: 'PCS', fName: 'Each', enabled: true }], 'PCS').status, OUTCOME.INCOMPLETE)
    assert.equal(resolveReferenceFromRows(CATEGORY, [{ sourceCode: 'RAW', fName: 'Raw', enabled: true }], 'RAW').status, OUTCOME.INCOMPLETE)
  }

  // ---- contract error-type token mapping is exactly unresolved/ambiguous/incomplete-row ----
  assert.deepEqual(STATUS_TO_ERROR_TYPE, { unresolved: 'unresolved', ambiguous: 'ambiguous', incomplete: 'incomplete-row' })

  // ---- sourceCode normalization: trimmed + String-coerced, CASE-SENSITIVE ----
  {
    const rows = [{ sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: true }]
    const idx = buildReferenceMappingIndex(UNIT, rows)
    assert.equal(resolveReference(idx, '  PCS  ').status, OUTCOME.RESOLVED, 'surrounding whitespace still matches')
    assert.equal(resolveReference(idx, 'pcs').status, OUTCOME.UNRESOLVED, 'case-mismatch does NOT match (no case-fold)')
  }
  // ---- blank query sourceCode → unresolved, sourceCodePresent false ----
  {
    const idx = buildReferenceMappingIndex(UNIT, [{ sourceCode: 'PCS', fNumber: '01', fName: 'Each' }])
    const out = resolveReference(idx, '   ')
    assert.equal(out.status, OUTCOME.UNRESOLVED)
    assert.equal(out.evidence.sourceCodePresent, false)
  }

  // ---- evidence stays values-free across every non-resolved outcome ----
  {
    const ambiguous = resolveReferenceFromRows(UNIT, [
      { sourceCode: 'DUP', fNumber: 'AA', fName: 'Alpha', enabled: true },
      { sourceCode: 'DUP', fNumber: 'BB', fName: 'Beta', enabled: true },
    ], 'DUP', { field: 'FUnitID' })
    assertEvidenceValuesFree(ambiguous.evidence, ['DUP', 'AA', 'BB', 'Alpha', 'Beta'])
    const incomplete = resolveReferenceFromRows(UNIT, [{ sourceCode: 'BAD', fNumber: 'ZZ', enabled: true }], 'BAD')
    assertEvidenceValuesFree(incomplete.evidence, ['BAD', 'ZZ'])
  }

  // ---- template error THROWS (data conditions never throw) ----
  assert.throws(() => buildReferenceMappingIndex({ id: 'x', domain: 'd', identifier: 'BAD' }, []), ReferenceMappingTemplateError, 'bad template throws')
  assert.throws(() => buildReferenceMappingIndex({ ...UNIT, rows: [{ sourceCode: 'X' }] }, []), ReferenceMappingTemplateError, 'template carrying content throws')

  // ---- index reuse: build ONCE, resolve many ----
  {
    const idx = buildReferenceMappingIndex(UNIT, [
      { sourceCode: 'A', fNumber: '1', fName: 'Alpha', enabled: true },
      { sourceCode: 'B', fNumber: '2', fName: 'Beta', enabled: true },
    ])
    assert.deepEqual(resolveReference(idx, 'A').reference, { FNumber: '1', FName: 'Alpha' })
    assert.deepEqual(resolveReference(idx, 'B').reference, { FNumber: '2', FName: 'Beta' })
    assert.equal(resolveReference(idx, 'C').status, OUTCOME.UNRESOLVED)
  }

  // ====================== DF-T3b-2a: resolveReferenceRuleValue + resolveReferenceRulesIntoRecord ==

  const unitIndex = buildReferenceMappingIndex(UNIT, [{ sourceCode: 'PCS', fNumber: '01', fName: 'Each', enabled: true }])
  const indexes = { unit: unitIndex }
  const rule = { targetField: 'FUnitID', domain: 'unit', sourceField: 'unitSourceCode' }

  // ---- shared decision fn: resolved → reference object; non-resolved → UNRESOLVED_PLACEHOLDER ----
  {
    const ok = resolveReferenceRuleValue(indexes, rule, 'PCS')
    assert.deepEqual(ok.value, { FNumber: '01', FName: 'Each' }, 'resolved → reference object as the value')
    assert.equal(ok.outcome.status, OUTCOME.RESOLVED)
    assert.equal(resolveReferenceRuleValue(indexes, rule, 'NOPE').value, UNRESOLVED_PLACEHOLDER, 'unresolved → sentinel')
    assert.equal(resolveReferenceRuleValue({}, rule, 'PCS').value, UNRESOLVED_PLACEHOLDER, 'no index for domain → sentinel')
    assert.equal(resolveReferenceRuleValue(indexes, { targetField: 'X' }, 'PCS').value, UNRESOLVED_PLACEHOLDER, 'no domain → sentinel')
  }

  // ---- materialize into record: resolved sets the full object; sourceCode field preserved ----
  {
    const { record, outcomes } = resolveReferenceRulesIntoRecord({ FNumber: 'MAT-1', unitSourceCode: 'PCS' }, [rule], indexes)
    assert.deepEqual(record.FUnitID, { FNumber: '01', FName: 'Each' }, 'targetField set to resolved object')
    assert.equal(record.unitSourceCode, 'PCS', 'sourceCode field left intact (schema drops it later)')
    assert.equal(record.FNumber, 'MAT-1', 'other fields preserved')
    assert.equal(outcomes[0].status, OUTCOME.RESOLVED)
  }

  // ---- materialize: all THREE non-resolved statuses → UNRESOLVED_PLACEHOLDER + correct errorType ----
  {
    const cases = [
      { rows: [{ sourceCode: 'OTHER', fNumber: '9', fName: 'X', enabled: true }], sc: 'PCS', status: OUTCOME.UNRESOLVED, errorType: 'unresolved' },
      { rows: [{ sourceCode: 'PCS', fNumber: 'A', fName: 'X', enabled: true }, { sourceCode: 'PCS', fNumber: 'B', fName: 'Y', enabled: true }], sc: 'PCS', status: OUTCOME.AMBIGUOUS, errorType: 'ambiguous' },
      { rows: [{ sourceCode: 'PCS', fNumber: 'A', enabled: true }], sc: 'PCS', status: OUTCOME.INCOMPLETE, errorType: 'incomplete-row' },
    ]
    for (const c of cases) {
      const idx = { unit: buildReferenceMappingIndex(UNIT, c.rows) }
      const { record, outcomes } = resolveReferenceRulesIntoRecord({ unitSourceCode: c.sc }, [rule], idx)
      assert.equal(record.FUnitID, UNRESOLVED_PLACEHOLDER, `${c.status} → sentinel`)
      assert.equal(outcomes[0].status, c.status)
      assert.equal(outcomes[0].evidence.errorType, c.errorType, `${c.status} → errorType ${c.errorType}`)
      // evidence stays values-free even in the materializer outcomes (no sourceCode value leaks)
      assert.ok(!JSON.stringify(outcomes[0].evidence).includes(c.sc), 'materializer evidence carries no sourceCode value')
    }
  }

  // ---- read snapshot = ORIGINAL record; write = materialized out (overlapping source/target rules
  //      must NOT let an earlier rule's WRITE change what a later rule READS) ----
  {
    const idx = { 'unit-group': buildReferenceMappingIndex(byDomain['unit-group'], [{ sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true }]) }
    const overlapRules = [
      { targetField: 'source.unitGroup', domain: 'unit-group', sourceField: 'source.unitGroup' }, // rule 1 writes the read path
      { targetField: 'FUnitGroupID', domain: 'unit-group', sourceField: 'source.unitGroup' }, // rule 2 reads it
    ]
    const original = { source: { unitGroup: 'STD' } }
    const { record, outcomes } = resolveReferenceRulesIntoRecord(original, overlapRules, idx)
    assert.deepEqual(outcomes.map((o) => o.status), [OUTCOME.RESOLVED, OUTCOME.RESOLVED], 'both rules read the ORIGINAL snapshot → both resolved')
    assert.deepEqual(record.FUnitGroupID, { FNumber: '10', FName: 'Each' }, 'rule 2 resolves despite rule 1 writing the same path')
    assert.equal(original.source.unitGroup, 'STD', 'the input record is NOT mutated (writes go to an independent clone)')
  }

  // ---- UNRESOLVED_PLACEHOLDER is a bare <…> sentinel (so findUnfilledPlaceholders catches it) ----
  assert.match(UNRESOLVED_PLACEHOLDER, /^<[^>]+>$/, 'sentinel is a bare placeholder token')

  console.log('reference-mapping-resolver.test.cjs OK')
}

main()
