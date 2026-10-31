'use strict'

// THE truth table of the `manual:` namespace (ADR adr-stock-prep-manual-rows-20261030 §2.2) — one row per input shape,
// over the four inputs both sides judge on: the bound target's / registry row's objectId, the record's creator
// (meta_records.created_by), the record id, and the key-column value. Not a suite (it lives under support/, so the
// chain-completeness walk does not see it).
//
// The plugin suite (stock-preparation-manual-rows.test.cjs) runs every row through lib/stock-preparation-manual-rows.cjs.
// B2 adds the host module (packages/core-backend/src/multitable/stock-preparation-manual-rows.ts) and its contract test
// runs the SAME rows through the host predicate and pins the two prefix constants byte-equal (precedent:
// stock-preparation-project-sheet-schema-clamp.ts), so M (host) and M′ (plugin) cannot drift apart. Host-only
// conditions — (a) the registry row's plugin_name, (b) exactly one key column — are the host suite's own cases; every
// row here assumes both hold.
//
//   prefix  — the key is in the reserved namespace (RAW `startsWith('manual:')`, no trim, case-sensitive);
//   manual  — M / M′ holds (a manual supplementary row);
//   kind    — the plugin reader's classification: 'manual' | 'unbound_prefix' | null (not a prefix row);
//   source  — the export's 来源 token: 'manual_supplement' | 'manual_other' | 'plm'.
//
// Every value is synthetic.

const PROJECT_OBJECT_ID = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
const RECORD_ID = 'rec_mr_truth_0001'
const OTHER_RECORD_ID = 'rec_mr_truth_0002'
const OWN_KEY = `manual:v1:${RECORD_ID}`
const PLM_KEY = JSON.stringify({ projectNo: 'SYN-MR-0001', componentSourceId: 'SYN-PART-1', parentSourceId: null, path: '["SYN-PART-1"]' })
const CREATOR = 'u_mr_truth'

const MANUAL = Object.freeze({ prefix: true, manual: true, kind: 'manual', source: 'manual_supplement' })
const UNBOUND = Object.freeze({ prefix: true, manual: false, kind: 'unbound_prefix', source: 'manual_other' })
const PERSON_NOT_PREFIX = Object.freeze({ prefix: false, manual: false, kind: null, source: 'manual_other' })
const PLM = Object.freeze({ prefix: false, manual: false, kind: null, source: 'plm' })

const MANUAL_ROWS_TRUTH_TABLE = Object.freeze([
  { name: 'the manual supplementary row', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: OWN_KEY }, expected: MANUAL },
  { name: 'no creator (null)', input: { objectId: PROJECT_OBJECT_ID, createdBy: null, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'no creator (absent)', input: { objectId: PROJECT_OBJECT_ID, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'empty creator', input: { objectId: PROJECT_OBJECT_ID, createdBy: '', recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'whitespace creator', input: { objectId: PROJECT_OBJECT_ID, createdBy: '   ', recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'the key names ANOTHER row\'s id', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: `manual:v1:${OTHER_RECORD_ID}` }, expected: UNBOUND },
  { name: 'the env main sheet', input: { objectId: 'plm_stock_preparation_main', createdBy: CREATOR, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'a hand-named sandbox twin', input: { objectId: 'plm_stock_preparation_sandbox_twin', createdBy: CREATOR, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'a project-sheet-like id with UPPERCASE hex', input: { objectId: 'plm_stock_preparation_sandbox_p_0123456789ABCDEF01234567', createdBy: CREATOR, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'a project-sheet-like id with a short digest', input: { objectId: 'plm_stock_preparation_sandbox_p_0123', createdBy: CREATOR, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'no objectId', input: { createdBy: CREATOR, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
  { name: 'another version tag', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: `manual:v2:${RECORD_ID}` }, expected: UNBOUND },
  { name: 'the bare namespace', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: 'manual:' }, expected: UNBOUND },
  { name: 'the own key plus a trailing space (exact equality)', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: `${OWN_KEY} ` }, expected: UNBOUND },
  { name: 'no record id (null)', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: null, key: 'manual:v1:' }, expected: UNBOUND },
  { name: 'an empty record id', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: '', key: 'manual:v1:' }, expected: UNBOUND },
  // The key IS `'manual:v1:' + recordId` here, so only the blank-id rule keeps it out of M (same as the two rows above).
  { name: 'a whitespace-only record id', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: '   ', key: 'manual:v1:   ' }, expected: UNBOUND },
  { name: 'a LEADING space is not the namespace (raw comparison), and the creator makes it non-PLM', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: ` ${OWN_KEY}` }, expected: PERSON_NOT_PREFIX },
  { name: 'the namespace is case-sensitive', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: `MANUAL:v1:${RECORD_ID}` }, expected: PERSON_NOT_PREFIX },
  { name: 'a PLM key written by the plugin', input: { objectId: PROJECT_OBJECT_ID, createdBy: null, recordId: RECORD_ID, key: PLM_KEY }, expected: PLM },
  { name: 'a PLM key on a person-created row (a pre-#6598 right-click copy)', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: PLM_KEY }, expected: PERSON_NOT_PREFIX },
  { name: 'a keyless person-created row', input: { objectId: PROJECT_OBJECT_ID, createdBy: CREATOR, recordId: RECORD_ID, key: null }, expected: PERSON_NOT_PREFIX },
  { name: 'a keyless plugin row', input: { objectId: PROJECT_OBJECT_ID, createdBy: null, recordId: RECORD_ID, key: null }, expected: PLM },
  { name: 'a non-string key', input: { objectId: PROJECT_OBJECT_ID, createdBy: null, recordId: RECORD_ID, key: 123 }, expected: PLM },
  { name: 'the own key on the env sheet with no creator', input: { objectId: 'plm_stock_preparation_main', createdBy: null, recordId: RECORD_ID, key: OWN_KEY }, expected: UNBOUND },
])

module.exports = {
  CREATOR,
  MANUAL_ROWS_TRUTH_TABLE,
  OTHER_RECORD_ID,
  OWN_KEY,
  PLM_KEY,
  PROJECT_OBJECT_ID,
  RECORD_ID,
}
