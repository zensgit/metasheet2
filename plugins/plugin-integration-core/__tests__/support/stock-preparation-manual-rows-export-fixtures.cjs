'use strict'

// Export fixtures for 人工补充行 B1 (ADR adr-stock-prep-manual-rows-20261030 §6). Not a suite (support/ is outside the
// chain-completeness walk). Shared by stock-preparation-manual-rows-export.test.cjs and by the one-off capture of the
// pre-B1 goldens from main's own export module, so the goldens and the suite read the very same records.
//
// Records are host-shaped envelopes (`{ id, version, data, createdBy? }`, ids sorting like `rec_<uuid>`) on a LOGICAL
// target (empty fieldIdMap). Every value is synthetic.

const PROJECT_NO = 'SYN-MR-EXP'
const PROJECT_OBJECT_ID = 'plm_stock_preparation_sandbox_p_00112233445566778899aabb'
const ENV_OBJECT_ID = 'plm_stock_preparation_sandbox_mr_env'
const SHEET_ID = 'sheet_mr_export'
const PERSON = 'u_mr_export_person'

const pathOf = (...tokens) => JSON.stringify(tokens)
const keyOf = (...tokens) => JSON.stringify({ projectNo: PROJECT_NO, componentSourceId: tokens[tokens.length - 1], parentSourceId: tokens.length > 1 ? tokens[tokens.length - 2] : null, path: tokens })

function plm(id, tokens, cells = {}) {
  return {
    id,
    version: 1,
    data: {
      projectNo: PROJECT_NO,
      active: true,
      idempotencyKey: keyOf(...tokens),
      path: pathOf(...tokens),
      componentSourceId: tokens[tokens.length - 1],
      parentSourceId: tokens.length > 1 ? tokens[tokens.length - 2] : null,
      componentSpec: '',
      material: 'SYN-MAT',
      rawQuantity: 1,
      totalQuantity: 1,
      ...cells,
    },
  }
}

// A person's row: envelope `createdBy`, key `manual:v1:<own id>` unless told otherwise; no path, no part id.
function person(id, cells = {}, { key, createdBy = PERSON } = {}) {
  return {
    id,
    version: 1,
    ...(createdBy === null ? {} : { createdBy }),
    data: {
      projectNo: PROJECT_NO,
      active: true,
      idempotencyKey: key === undefined ? `manual:v1:${id}` : key,
      componentSpec: '',
      material: 'SYN-MAT',
      rawQuantity: 1,
      totalQuantity: 1,
      ...cells,
    },
  }
}

// The PLM tree every case starts from: root R with children C1 / C2, an orphan O whose parent P-X is not in the
// batch, a pure-PLM display twin under R (collapsed by the export's dedupe, exactly as before B1), and one inactive.
function plmTree({ rootSortNo } = {}) {
  return [
    plm('rec_5_root', ['P-R'], { componentCode: 'SYN-R', componentName: 'Root', ...(rootSortNo === undefined ? {} : { ext_componentSortNo: rootSortNo }) }),
    plm('rec_6_c1', ['P-R', 'P-C1'], { parentComponentCode: 'SYN-R', parentComponentName: 'Root', componentCode: 'SYN-C1', componentName: 'Child one', totalQuantity: 2 }),
    plm('rec_7_c2', ['P-R', 'P-C2'], { parentComponentCode: 'SYN-R', parentComponentName: 'Root', componentCode: 'SYN-C2', componentName: 'Child two', totalQuantity: 3 }),
    plm('rec_8_twin', ['P-R', 'P-C2B'], { parentComponentCode: 'SYN-R', parentComponentName: 'Root', componentCode: 'SYN-C2', componentName: 'Child two', totalQuantity: 3 }),
    plm('rec_9_orphan', ['P-X', 'P-O'], { parentComponentCode: 'SYN-X', parentComponentName: 'Gone parent', componentCode: 'SYN-O', componentName: 'Orphan', totalQuantity: 4 }),
    plm('rec_a_inactive', ['P-R', 'P-OLD'], { parentComponentCode: 'SYN-R', componentCode: 'SYN-OLD', componentName: 'Old', active: false }),
  ]
}

// A row that copies root R's display key (parent blank, 图号, 名称, 规格 blank, 材料, 单层用量) — the probe's case 1/2.
const rootCopy = (id, options) => person(id, { componentCode: 'SYN-R', componentName: 'Root', totalQuantity: 7 }, options)
// A row that copies the orphan's display key (parent 'SYN-X', 图号 'SYN-O', ...) — the probe's case 3.
const orphanCopy = (id, options) => person(id, { parentComponentCode: 'SYN-X', componentCode: 'SYN-O', componentName: 'Orphan', totalQuantity: 8 }, options)

// A live 沿用关系 naming the orphan as a continued member (so the 沿用说明 column appears).
function continuationFor(memberRecordId = 'rec_9_orphan') {
  return {
    continuations: [{ id: 'cont_mr_export_0001', status: 'active', newParentComponentSourceId: 'P-R', newRootPathTokens: ['P-R', 'P-O'], parentEdgeUsage: 2 }],
    members: [{ continuationId: 'cont_mr_export_0001', oldRecordId: memberRecordId, claimActive: true }],
  }
}

// ── P3 (ADR §12.5, OQ-P2): 人工补充行 under a 父组件图号 ─────────────────────────────────────────────────────────────

// A person's row hung under `parentComponentCode` (a M′ row unless `options` say otherwise).
const hung = (id, parentComponentCode, componentCode, options) =>
  person(id, { parentComponentCode, parentComponentName: `Name of ${parentComponentCode}`, componentCode, componentName: `Manual ${componentCode}` }, options)

// plmTree() plus a child under the collapsed twin: a collapsed subtree's row (SYN-G) is never printed.
function plmTreeWithCollapsedChild() {
  return [...plmTree(), plm('rec_8_twin_child', ['P-R', 'P-C2B', 'P-G'], { parentComponentCode: 'SYN-C2', componentCode: 'SYN-G', componentName: 'Under the twin' })]
}

// The tree without a parsable `path` on any row: the export falls back to the degraded part-id tree; with
// `withPartIds: false` also without part ids, i.e. the flat comparator.
function plmTreeWithoutPaths({ withPartIds = true } = {}) {
  return plmTree().map((record) => {
    const data = { ...record.data }
    delete data.path
    if (!withPartIds) {
      delete data.componentSourceId
      delete data.parentSourceId
    }
    return { ...record, data }
  })
}

// Sheets on which NO prefix row can be spliced, so P3 must print them exactly as B1 (main df83192d9) did. Their
// goldens (sha256 of the whole result's JSON) were captured from main's own export module over these very records.
function p3UnsplicedCases() {
  const parentless = [
    ...plmTree(),
    rootCopy('rec_1_manual'),
    person('rec_3_unbound', { componentCode: 'SYN-U' }, { createdBy: null }),
    person('rec_4_free', { componentCode: 'SYN-A-FREE', componentName: 'Free' }),
  ]
  return [
    { name: 'parentless', records: parentless },
    { name: 'parentless + 沿用说明', records: parentless, continuation: continuationFor() },
    {
      name: 'unspliceable (人工（非补充）, not found, inactive, collapsed, self, cycle)',
      records: [
        ...plmTreeWithCollapsedChild(),
        hung('rec_b_unbound', 'SYN-R', 'SYN-NB1', { createdBy: null }),
        hung('rec_b_other', 'SYN-C1', 'SYN-NB2', { key: 'manual:v1:rec_someone_else' }),
        hung('rec_c_new', 'SYN-NEW', 'SYN-N1'),
        hung('rec_c_inactive', 'SYN-OLD', 'SYN-N2'),
        hung('rec_c_collapsed', 'SYN-G', 'SYN-N3'),
        hung('rec_c_self', 'SYN-N4', 'SYN-N4'),
        hung('rec_d_cycle_a', 'SYN-CB', 'SYN-CA'),
        hung('rec_d_cycle_b', 'SYN-CA', 'SYN-CB'),
        orphanCopy('rec_2_manual'),
        rootCopy('rec_1_manual'),
      ],
    },
    { name: 'degraded part-id tree', records: [...plmTreeWithoutPaths(), hung('rec_c_r', 'SYN-R', 'SYN-M1'), hung('rec_c_c1', 'SYN-C1', 'SYN-M2'), hung('rec_c_m', 'SYN-M1', 'SYN-M3')] },
    { name: 'flat comparator', records: [...plmTreeWithoutPaths({ withPartIds: false }), hung('rec_c_r', 'SYN-R', 'SYN-M1'), hung('rec_c_m', 'SYN-M1', 'SYN-M3')] },
    { name: 'env target', objectId: ENV_OBJECT_ID, records: [...plmTree(), hung('rec_c_r', 'SYN-R', 'SYN-M1'), hung('rec_c_c1', 'SYN-C1', 'SYN-M2')] },
  ]
}

function recordsApiOver(records) {
  const calls = []
  return {
    calls,
    async queryRecords(input = {}) {
      calls.push({ ...input })
      return records
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
        .slice().sort((left, right) => (left.id < right.id ? -1 : (left.id > right.id ? 1 : 0)))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map((record) => JSON.parse(JSON.stringify(record)))
    },
  }
}

const target = (objectId = PROJECT_OBJECT_ID, fieldIdMap = {}) => ({ sheetId: SHEET_ID, objectId, fieldIdMap })

module.exports = {
  ENV_OBJECT_ID,
  PERSON,
  PROJECT_NO,
  PROJECT_OBJECT_ID,
  SHEET_ID,
  continuationFor,
  hung,
  keyOf,
  orphanCopy,
  p3UnsplicedCases,
  pathOf,
  person,
  plm,
  plmTree,
  plmTreeWithCollapsedChild,
  plmTreeWithoutPaths,
  recordsApiOver,
  rootCopy,
  target,
}
