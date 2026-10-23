'use strict'

// Batch-refresh step 2b — demand evidence captured before root selection (pure, not wired).
//
// What this suite pins (the golden suite pins that no existing hash moves):
//   * DETERMINISM — the same source twice, a shuffled source, and read-ahead width 1 / 4 / absent
//     all give a deep-equal evidence object and the same fingerprint; the one residual (two 总图
//     tied on version) is pinned as a residual, with the rows showing the same dependence.
//   * WHAT IS RECORDED — dash drops with every dash parent as a ref; a variant child that is NOT in
//     its dash parent's BOM (so the dropped demand is not expanded anywhere: count 0); 钣金 ordered
//     alone and inside the 总图 (kept, counted below depth 0, never deduped); a second order line
//     for the chosen 总图; a cancelled-and-re-ordered line (rows and revision identical, only the
//     evidence moves); the same part on two order lines; subtree roots.
//   * UNKNOWNS ARE STATUS OBJECTS — detail-line id not_declared / present / blank / column_absent /
//     column_ambiguous; a blank order head; never null, never omitted.
//   * COMPLETENESS — max_rows_exceeded, read_cursor_broken, read_row_mismatch, read_failed,
//     truncated row errors, the observation cap, a missing part.
//   * COUNTS agree with what the walk already reports (rootsFilteredOut, rootSelectionReport,
//     subtree.rootsSkippedAlreadyExpanded).
//   * QUANTITY SEMANTICS — a root's orderQuantity is its rawQuantity; an edge usage never appears as
//     an orderQuantity.
//   * SAFETY — capture issues no extra read, a bad option or a faulting recorder never reaches the
//     walk, the evidence never enters rows / summary / dry-run evidence.
//   * LARGE-LANE PARITY — the same project through small-lane and large-lane expander options gives
//     the same body and fingerprint; a small-lane cap overflow is incomplete where the large lane
//     is complete; the large job's artifact revision is identical with capture on and off.
//
// VALUES-FREE: synthetic project numbers (SDE-…), part ids and drawing numbers only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  DEFAULT_ROOT_SELECTION,
  expandPlmProjectBom,
  normalizeRootSelection,
  summarizeBomExpansionForEvidence,
  __internals: { explainRootSelection, selectOrderRootCandidates },
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const demandEvidenceModule = require(path.join(LIB, 'stock-preparation-demand-evidence.cjs'))
const {
  DEMAND_EVIDENCE_SCHEME,
  DEFAULT_MAX_OBSERVATIONS,
  MAX_OBSERVATIONS_CEILING,
  StockPreparationDemandEvidenceError,
  normalizeDemandEvidenceOptions,
  openDemandEvidenceCapture,
  fingerprintOfDemandEvidence,
  __internals: { readDetailLineId, RECORDER_HOOKS },
} = demandEvidenceModule
const {
  dryRunStockPreparationAction,
  largeBomBackgroundExpansionCaps,
  normalizeStockPreparationActionConfig,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  createLargeBomBackgroundExpansionJob,
  runLargeBomBackgroundExpansionJob,
} = require(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs'))

let passed = 0
let failed = 0

async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failed += 1
    console.error(`FAIL: ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// ── synthetic source ──────────────────────────────────────────────────────────────────────────

function createAdapter(data, behaviour = {}) {
  const calls = []
  const adapter = {
    async read(input = {}) {
      calls.push(clone(input))
      if ((behaviour.failObjects || []).includes(input.object)) {
        const error = new Error('synthetic read failure')
        error.code = 'SYNTHETIC_READ_FAILURE'
        throw error
      }
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      let matches = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      if (behaviour.reverse) matches = matches.slice().reverse()
      if (behaviour.mismatchObject === input.object) matches = matches.concat([{ ...matches[0], [Object.keys(input.filters)[0]]: 'SDE-NOT-THE-FILTER' }])
      if (behaviour.brokenCursorObject === input.object) return { records: matches.map(clone), done: false, nextCursor: null }
      return { records: matches.map(clone), done: true, nextCursor: null }
    },
  }
  return { adapter, calls }
}

function part(id, code, version = 'V1', extra = {}) {
  return { OBJ_ID: id, IdentityNo: code, IdentityName: `SDE ${code}`, Material: 'SDE-STEEL', SysVer: version, ...extra }
}

function project(projectNo, { heads, parts, bomHeads = [], bomDetails = [], extra = {} }) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: `${projectNo}-PATH` }],
    DN_PDM_PathInfo: [{ OBJ_ID: `${projectNo}-PATH` }],
    DN_PDM_OrderHeadInfo: heads.map((head) => ({ OBJ_ID: head.id, path_id: `${projectNo}-PATH` })),
    DN_PDM_OrderDetailInfo: heads.flatMap((head) => head.lines.map((line, index) => ({
      order_id: head.id,
      sort_id: String((index + 1) * 10),
      ...line,
    }))),
    DN_PDM_PartLibraryInfo: parts,
    DN_PDM_BomHeadInfo: bomHeads,
    DN_PDM_BomDetailsInfo: bomDetails,
    ...extra,
  }
}

function bomHead(partId, bomId, version = 'V1', extra = {}) {
  return { part_id: partId, bom_id: bomId, SysVer: version, bom_able: true, ...extra }
}

function bomLine(bomId, partId, usage, sort = '1') {
  return { bom_pid: bomId, part_id: partId, Bom_ExAttr1: usage, sort_id: sort }
}

async function expand(projectNo, data, extra = {}, behaviour = {}) {
  const { adapter, calls } = createAdapter(data, behaviour)
  const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo, ...extra })
  return { result, calls, evidence: result.demandEvidence }
}

function obsBy(evidence, componentSourceId) {
  return evidence.observations.filter((observation) => observation.componentSourceId === componentSourceId)
}

// A P/S dash project with a 总图-less order: P is the dash parent of S, and S is in P's BOM.
function dashProject(projectNo = 'SDE-DASH-1') {
  return project(projectNo, {
    heads: [{ id: `${projectNo}-ORDER-P`, lines: [{ part_id: 'SDE-P', quantity: '2' }] },
      { id: `${projectNo}-ORDER-S`, lines: [{ part_id: 'SDE-S', quantity: '5' }] }],
    parts: [part('SDE-P', 'P8100-01'), part('SDE-S', 'P8100-01-03'), part('SDE-C', 'C8100-7')],
    bomHeads: [bomHead('SDE-P', 'SDE-BOM-P'), bomHead('SDE-S', 'SDE-BOM-S')],
    bomDetails: [bomLine('SDE-BOM-P', 'SDE-S', '2'), bomLine('SDE-BOM-S', 'SDE-C', '7')],
  })
}

async function main() {
  // ── opt-in contract ─────────────────────────────────────────────────────────────────────────
  await run('opt-in: absent / null / false => no recorder and no key; true / object => recorder', async () => {
    for (const request of [undefined, null, false]) {
      assert.equal(openDemandEvidenceCapture(request, {}), null)
      const { result } = await expand('SDE-DASH-1', dashProject(), request === undefined ? {} : { demandEvidence: request })
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'demandEvidence'), false)
    }
    const { evidence } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    assert.equal(evidence.scheme, DEMAND_EVIDENCE_SCHEME)
    const { evidence: withObject } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: { maxObservations: 10 } })
    assert.equal(withObject.fingerprint, evidence.fingerprint, 'a cap that is not reached changes nothing')
  })

  await run('opt-in gate: every non-object other than `true` (0, \'\', NaN, 1, \'yes\', []) is OFF — no key, walk identical', async () => {
    const off = await expand('SDE-DASH-1', dashProject())
    for (const request of [0, '', Number.NaN, 1, 'yes', []]) {
      assert.equal(openDemandEvidenceCapture(request, {}), null, JSON.stringify(request))
      const { result, calls } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: request })
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'demandEvidence'), false, `no key for ${JSON.stringify(request)}`)
      assert.deepEqual(result, off.result)
      assert.deepEqual(calls, off.calls)
    }
  })

  await run('opt-in: closed key set and bounds are refused at config time', () => {
    assert.deepEqual(normalizeDemandEvidenceOptions(true), { orderDetailLineIdField: undefined, maxObservations: DEFAULT_MAX_OBSERVATIONS })
    assert.deepEqual(normalizeDemandEvidenceOptions({ orderDetailLineIdField: ' ID ' }), { orderDetailLineIdField: 'ID', maxObservations: DEFAULT_MAX_OBSERVATIONS })
    for (const bad of [
      'yes', 1, [], { lineIdField: 'ID' }, { orderDetailLineIdField: 'ID; drop' }, { orderDetailLineIdField: '' },
      { maxObservations: 0 }, { maxObservations: 1.5 }, { maxObservations: MAX_OBSERVATIONS_CEILING + 1 }, { maxObservations: '10' },
    ]) {
      assert.throws(() => normalizeDemandEvidenceOptions(bad), StockPreparationDemandEvidenceError, JSON.stringify(bad))
    }
  })

  await run('opt-in: an invalid option never reaches the walk — capture_error/options_invalid, walk byte-identical', async () => {
    const off = await expand('SDE-DASH-1', dashProject())
    const bad = await expand('SDE-DASH-1', dashProject(), { demandEvidence: { unknownKey: true } })
    assert.deepEqual(bad.evidence, { scheme: DEMAND_EVIDENCE_SCHEME, completeness: { status: 'capture_error', reasons: ['options_invalid'] } })
    const { demandEvidence, ...rest } = bad.result
    assert.deepEqual(rest, off.result)
    assert.deepEqual(bad.calls, off.calls)
  })

  await run('safety: a recorder that throws from every hook leaves the walk identical and says capture_error', async () => {
    const real = demandEvidenceModule.createDemandEvidenceRecorder
    const hookCalls = []
    demandEvidenceModule.createDemandEvidenceRecorder = () => new Proxy({}, {
      get(_, name) {
        return () => {
          hookCalls.push(String(name))
          throw new Error('injected')
        }
      },
    })
    try {
      const off = await expand('SDE-DASH-1', dashProject())
      const faulty = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
      const { demandEvidence, ...rest } = faulty.result
      assert.deepEqual(rest, off.result)
      assert.deepEqual(faulty.calls, off.calls)
      assert.deepEqual(demandEvidence.completeness, { status: 'capture_error', reasons: ['recorder_fault'] })
      assert.deepEqual(hookCalls, ['pathNode'], 'the first fault switches recording off for the rest of the run')
    } finally {
      demandEvidenceModule.createDemandEvidenceRecorder = real
    }
  })

  await run('safety: capture issues no read of its own and never reaches rows / summary / dry-run evidence', async () => {
    const off = await expand('SDE-DASH-1', dashProject())
    const on = await expand('SDE-DASH-1', dashProject(), { demandEvidence: { orderDetailLineIdField: 'ID' } })
    assert.deepEqual(on.calls, off.calls, 'identical read sequence')
    assert.deepEqual(on.result.rows, off.result.rows)
    assert.deepEqual(on.result.summary, off.result.summary)
    assert.deepEqual(summarizeBomExpansionForEvidence(on.result), summarizeBomExpansionForEvidence(off.result))
    const keys = Object.keys(on.result)
    assert.equal(keys[keys.length - 1], 'demandEvidence', 'mounted as the last sibling key')
    for (const row of on.result.rows) {
      for (const key of Object.keys(row)) assert.equal(/order|demand|evidence/i.test(key), false, `row key ${key}`)
    }
  })

  await run('safety: every guarded hook returns undefined', () => {
    const capture = openDemandEvidenceCapture(true, { plan: PLM_STOCK_PREPARATION_BOM_READ_PLAN, rootSelection: DEFAULT_ROOT_SELECTION, explainRootSelection })
    for (const name of RECORDER_HOOKS) assert.equal(capture[name](), undefined, name)
  })

  // ── determinism ─────────────────────────────────────────────────────────────────────────────
  await run('determinism: same source twice => deep-equal evidence and fingerprint', async () => {
    const a = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    const b = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    assert.deepEqual(a.evidence, b.evidence)
    assert.equal(fingerprintOfDemandEvidence(a.evidence, 'SDE-DASH-1'), a.evidence.fingerprint, 'the fingerprint recomputes')
    assert.notEqual(fingerprintOfDemandEvidence(a.evidence, 'SDE-OTHER'), a.evidence.fingerprint, 'and is bound to the project')
    assert.equal(JSON.stringify(a.evidence).includes('2026'), false, 'no timestamp in the body')
  })

  await run('determinism: a reversed source (every read, heads, lines and BOM) => same evidence', async () => {
    const data = dashProject()
    data.DN_PDM_OrderDetailInfo.push({ order_id: 'SDE-DASH-1-ORDER-P', part_id: 'SDE-C', quantity: '1', sort_id: '20' })
    const forward = await expand('SDE-DASH-1', data, { demandEvidence: true })
    const reversed = await expand('SDE-DASH-1', data, { demandEvidence: true }, { reverse: true })
    assert.deepEqual(reversed.evidence, forward.evidence)
  })

  await run('determinism: readConcurrency absent / 1 / 4 => same evidence', async () => {
    const base = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    for (const readConcurrency of [1, 4]) {
      const other = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, readConcurrency })
      assert.deepEqual(other.evidence, base.evidence, `readConcurrency ${readConcurrency}`)
    }
  })

  await run('determinism RESIDUAL: two 总图 tied on version follow read order — in the rows as much as in the evidence', async () => {
    const data = project('SDE-TIE-1', {
      heads: [{ id: 'SDE-TIE-1-ORDER', lines: [{ part_id: 'SDE-M-A', quantity: '1' }, { part_id: 'SDE-M-B', quantity: '1' }] }],
      parts: [part('SDE-M-A', 'J8200-00', 'V3'), part('SDE-M-B', 'J8200-00', 'V3')],
    })
    const forward = await expand('SDE-TIE-1', data, { demandEvidence: true })
    const reversed = await expand('SDE-TIE-1', data, { demandEvidence: true }, { reverse: true })
    assert.notDeepEqual(forward.result.rows, reversed.result.rows, 'the residual is inherited: the rows already depend on read order')
    assert.notEqual(forward.evidence.fingerprint, reversed.evidence.fingerprint)
    for (const evidence of [forward.evidence, reversed.evidence]) {
      const loser = evidence.observations.find((observation) => observation.rule === 'main_drawing_not_chosen')
      assert.deepEqual(loser.ruleDetail, { sameComponentAsChosen: false, versionAgainstChosen: 'tie' }, 'the tie is NAMED as a tie')
    }
  })

  // ── what is recorded ────────────────────────────────────────────────────────────────────────
  await run('dash rule: the dropped child names its dash parent; the order head id survives', async () => {
    const { evidence, result } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    const [p] = obsBy(evidence, 'SDE-P')
    const [s] = obsBy(evidence, 'SDE-S')
    assert.equal(p.decision, 'selected')
    assert.equal(p.rule, 'not_dash_descendant')
    assert.equal(s.decision, 'dropped')
    assert.equal(s.rule, 'dash_descendant')
    assert.deepEqual(s.relatedRefs, [p.ref])
    assert.equal(s.orderHead, 'SDE-DASH-1-ORDER-S', 'the head id the walk used to drop is kept')
    assert.equal(s.orderQuantity, 5)
    assert.equal(s.expandedOccurrences.count, 1, 'S is still demanded inside P')
    assert.deepEqual(s.expandedOccurrences.paths, [JSON.stringify(['SDE-P', 'SDE-S'])])
    assert.equal(result.summary.rootsFilteredOut, 1)
  })

  await run('dash rule: a VARIANT child not in its dash parent\'s BOM is dropped with nothing expanding it (count 0)', async () => {
    const data = dashProject('SDE-DASH-2')
    data.DN_PDM_BomDetailsInfo = [bomLine('SDE-BOM-S', 'SDE-C', '7')]
    const { evidence, result } = await expand('SDE-DASH-2', data, { demandEvidence: true })
    const [s] = obsBy(evidence, 'SDE-S')
    assert.equal(s.decision, 'dropped')
    assert.equal(s.expandedOccurrences.count, 0, 'the dropped demand is not in any expanded row — visible only here')
    assert.equal(result.rows.some((row) => row.componentSourceId === 'SDE-S'), false)
  })

  await run('dash rule: every dash parent is a ref, not only the first', async () => {
    const data = project('SDE-DASH-3', {
      heads: [{ id: 'SDE-DASH-3-ORDER', lines: [{ part_id: 'SDE-G', quantity: '1' }, { part_id: 'SDE-H', quantity: '1' }, { part_id: 'SDE-K', quantity: '1' }] }],
      parts: [part('SDE-G', 'P8300-01'), part('SDE-H', 'P8300-01-02'), part('SDE-K', 'P8300-01-02-05')],
    })
    const { evidence } = await expand('SDE-DASH-3', data, { demandEvidence: true })
    const [g] = obsBy(evidence, 'SDE-G')
    const [h] = obsBy(evidence, 'SDE-H')
    const [k] = obsBy(evidence, 'SDE-K')
    assert.deepEqual(k.relatedRefs, [g.ref, h.ref].sort())
    assert.equal(k.relatedCount, 2)
    assert.deepEqual(h.relatedRefs, [g.ref])
  })

  await run('钣金 ordered alone AND inside the 总图: kept as sheet_metal, counted below depth 0, never deduped', async () => {
    const data = project('SDE-SM-1', {
      heads: [{ id: 'SDE-SM-1-ORDER', lines: [{ part_id: 'SDE-J', quantity: '1' }, { part_id: 'SDE-JA', quantity: '3' }] }],
      parts: [part('SDE-J', 'J8400-00', 'V2'), part('SDE-JA', 'J8400-A')],
      bomHeads: [bomHead('SDE-J', 'SDE-BOM-J', 'V2')],
      bomDetails: [bomLine('SDE-BOM-J', 'SDE-JA', '2')],
    })
    const { evidence, result } = await expand('SDE-SM-1', data, { demandEvidence: true })
    const [ja] = obsBy(evidence, 'SDE-JA')
    assert.equal(ja.decision, 'selected')
    assert.equal(ja.rule, 'sheet_metal')
    assert.equal(ja.expandedOccurrences.count, 1)
    assert.equal(result.rows.filter((row) => row.componentSourceId === 'SDE-JA').length, 2, 'two rows, as the walk produces')
    assert.equal(obsBy(evidence, 'SDE-J')[0].rule, 'main_drawing_chosen')
  })

  await run('a second order line for the CHOSEN 总图 is dropped today — named sameComponentAsChosen', async () => {
    const data = project('SDE-MAIN-2', {
      heads: [{ id: 'SDE-MAIN-2-ORDER', lines: [{ part_id: 'SDE-J2', quantity: '1' }, { part_id: 'SDE-J2', quantity: '2' }, { part_id: 'SDE-J1', quantity: '1' }] }],
      parts: [part('SDE-J2', 'J8500-00', 'V2'), part('SDE-J1', 'J8500-00', 'V1')],
    })
    const { evidence, result } = await expand('SDE-MAIN-2', data, { demandEvidence: true })
    const lines = obsBy(evidence, 'SDE-J2')
    assert.equal(lines.length, 2, 'two order lines, two observations')
    const chosen = lines.find((observation) => observation.decision === 'selected')
    const second = lines.find((observation) => observation.decision === 'dropped')
    assert.equal(chosen.rule, 'main_drawing_chosen')
    assert.deepEqual(second.ruleDetail, { sameComponentAsChosen: true, versionAgainstChosen: 'tie' })
    assert.deepEqual(second.relatedRefs, [chosen.ref])
    const [v1] = obsBy(evidence, 'SDE-J1')
    assert.deepEqual(v1.ruleDetail, { sameComponentAsChosen: false, versionAgainstChosen: 'lower' })
    assert.deepEqual(chosen.relatedRefs, [second.ref, v1.ref].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))))
    assert.equal(result.summary.rootsFilteredOut, 2)
  })

  await run('order cancelled then re-ordered: rows, summary and dry-run revision identical; only the evidence moves', async () => {
    const before = dashProject('SDE-REORDER-1')
    const after = clone(before)
    after.DN_PDM_OrderHeadInfo = after.DN_PDM_OrderHeadInfo.map((head) => (head.OBJ_ID === 'SDE-REORDER-1-ORDER-S' ? { ...head, OBJ_ID: 'SDE-REORDER-1-ORDER-S2' } : head))
    after.DN_PDM_OrderDetailInfo = after.DN_PDM_OrderDetailInfo.map((line) => (line.order_id === 'SDE-REORDER-1-ORDER-S' ? { ...line, order_id: 'SDE-REORDER-1-ORDER-S2' } : line))
    const a = await expand('SDE-REORDER-1', before, { demandEvidence: true })
    const b = await expand('SDE-REORDER-1', after, { demandEvidence: true })
    const unchanged = await expand('SDE-REORDER-1', clone(before), { demandEvidence: true })
    assert.deepEqual(b.result.rows, a.result.rows)
    assert.deepEqual(b.result.summary, a.result.summary)
    assert.notEqual(b.evidence.fingerprint, a.evidence.fingerprint, 'the head id change is visible only in the evidence')
    assert.equal(unchanged.evidence.fingerprint, a.evidence.fingerprint, 'control: nothing changed => nothing moves')
    assert.equal(obsBy(b.evidence, 'SDE-S')[0].orderHead, 'SDE-REORDER-1-ORDER-S2')
    assert.equal(obsBy(b.evidence, 'SDE-P')[0].orderHead, 'SDE-REORDER-1-ORDER-P', 'P\'s own order is still the same live head')
    // Same through the real dry-run: the revision (token, ledger input) does not see the head id.
    const revisionOf = async (data) => {
      const map = new Map()
      const out = await dryRunStockPreparationAction({
        action: { actionId: 'plm.stock-preparation.pull-bom.v1', source: { externalSystemId: 'plm_sde', kind: 'data-source:sql-readonly' }, target: { sheetId: 'sheet_sde', objectId: 'stockPreparationMain' } },
        parameters: { projectNo: 'SDE-REORDER-1' },
        sourceAdapter: createAdapter(data).adapter,
        recordsApi: { async queryRecords() { return [] }, async createRecord() { throw new Error('no write') }, async patchRecord() { throw new Error('no write') } },
        tokenStore: { async get(key) { return map.get(key) || null }, async set(key, value) { map.set(key, value) }, async delete(key) { map.delete(key) } },
        plannedAt: '2026-10-22T00:00:00.000Z',
      })
      return out.revision
    }
    assert.equal(await revisionOf(after), await revisionOf(before))
  })

  await run('the same part on two order lines => two observations, never deduped', async () => {
    const data = project('SDE-TWICE-1', {
      heads: [{ id: 'SDE-TWICE-1-ORDER', lines: [{ part_id: 'SDE-W', quantity: '2' }, { part_id: 'SDE-W', quantity: '2' }] }],
      parts: [part('SDE-W', 'W8600-1')],
    })
    const { evidence } = await expand('SDE-TWICE-1', data, { demandEvidence: true })
    assert.equal(obsBy(evidence, 'SDE-W').length, 2)
    assert.equal(evidence.counts.observations, 2)
  })

  await run('subtree on: skipped roots and folder roots are observations; counts match the walk\'s subtree counters', async () => {
    const plan = {
      ...clone(PLM_STOCK_PREPARATION_BOM_READ_PLAN),
      maxReadCount: 500,
      projectSubtree: { pathInfo: { parentIdField: 'parent_id' }, bomHead: { pathIdField: 'path_id' }, maxSubtreeDepth: 2 },
    }
    const data = project('SDE-TREE-1', {
      heads: [{ id: 'SDE-TREE-1-ORDER', lines: [{ part_id: 'SDE-T0', quantity: '2' }] }],
      parts: [part('SDE-T0', 'T8700-0'), part('SDE-T1', 'T8700-1'), part('SDE-T2', 'T8700-2')],
      bomHeads: [bomHead('SDE-T0', 'SDE-BOM-T0', 'V1', { path_id: 'SDE-TREE-1-PATH' }), bomHead('SDE-T1', 'SDE-BOM-T1', 'V1', { path_id: 'SDE-TREE-1-PATH-2' })],
      bomDetails: [bomLine('SDE-BOM-T0', 'SDE-T2', '1'), bomLine('SDE-BOM-T1', 'SDE-T2', '4')],
      extra: { DN_PDM_PathInfo: [{ OBJ_ID: 'SDE-TREE-1-PATH' }, { OBJ_ID: 'SDE-TREE-1-PATH-2', parent_id: 'SDE-TREE-1-PATH' }] },
    })
    const { evidence, result } = await expand('SDE-TREE-1', data, { demandEvidence: true, readPlan: plan })
    const skipped = evidence.observations.filter((observation) => observation.exclusion === 'subtree_already_expanded')
    assert.equal(skipped.length, result.summary.subtree.rootsSkippedAlreadyExpanded)
    const folderRoot = evidence.observations.find((observation) => observation.rule === 'project_subtree_root')
    assert.equal(folderRoot.componentSourceId, 'SDE-T1')
    assert.equal(folderRoot.pathId, 'SDE-TREE-1-PATH-2')
    assert.deepEqual(folderRoot.orderHead, { status: 'not_applicable' })
    assert.deepEqual(folderRoot.orderQuantity, { status: 'not_applicable' })
    assert.equal(folderRoot.quantitySemantics, 'subtree_default')
    assert.equal(evidence.counts.subtreeDecisions.selected, result.summary.subtree.rootsExpanded)
    assert.equal(evidence.header.projectSubtree, 'enabled')
  })

  await run('counts agree with rootsFilteredOut and rootSelectionReport', async () => {
    for (const [projectNo, data] of [['SDE-DASH-1', dashProject()], ['SDE-DASH-2', (() => {
      const d = dashProject('SDE-DASH-2')
      d.DN_PDM_OrderDetailInfo.push({ order_id: 'SDE-DASH-2-ORDER-P', part_id: 'SDE-C', quantity: '1', sort_id: '30' })
      return d
    })()]]) {
      const { evidence, result } = await expand(projectNo, data, { demandEvidence: true })
      assert.equal(evidence.counts.orderDecisions.dropped || 0, result.summary.rootsFilteredOut || 0)
      assert.equal(evidence.counts.orderRules.dash_descendant || 0, result.summary.rootSelectionReport.dashDescendantsDropped)
      assert.equal(evidence.counts.orderDecisions.selected || 0, result.rows.filter((row) => row.depth === 0).length)
    }
    const main = project('SDE-MAIN-3', {
      heads: [{ id: 'SDE-MAIN-3-ORDER', lines: [{ part_id: 'SDE-J', quantity: '1' }, { part_id: 'SDE-JB', quantity: '1' }, { part_id: 'SDE-L', quantity: '1' }] }],
      parts: [part('SDE-J', 'J8800-00'), part('SDE-JB', 'J8800-B'), part('SDE-L', 'L8800-1')],
    })
    const { evidence, result } = await expand('SDE-MAIN-3', main, { demandEvidence: true })
    const report = result.summary.rootSelectionReport
    assert.equal((evidence.counts.orderRules.main_drawing_chosen || 0) + (evidence.counts.orderRules.main_drawing_not_chosen || 0), report.mainDrawingCandidates)
    assert.equal(evidence.counts.orderRules.sheet_metal || 0, report.sheetMetalRoots)
    assert.equal(evidence.counts.orderRules.not_main_or_sheet_metal || 0, report.otherCandidatesDropped)
  })

  await run('root selection off: every candidate root_selection_disabled and selected', async () => {
    const { evidence } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, rootSelection: { enabled: false } })
    assert.ok(evidence.observations.every((observation) => observation.rule === 'root_selection_disabled' && observation.decision === 'selected'))
    assert.equal(evidence.header.rootSelection.mode, 'disabled')
    const keepAll = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, rootSelection: { dropDashDescendants: false } })
    assert.ok(keepAll.evidence.observations.every((observation) => observation.rule === 'no_main_drawing_keep_all'))
    assert.notEqual(keepAll.evidence.header.rootSelection.rulesDigest, evidence.header.rootSelection.rulesDigest)
  })

  await run('explainRootSelection labels, never decides: a result it cannot explain is `unexplained`', () => {
    const rules = normalizeRootSelection(undefined)
    const candidates = [
      { componentSourceId: 'A', componentCode: 'P9-01', sourceVersion: 'V1' },
      { componentSourceId: 'B', componentCode: 'P9-01-02', sourceVersion: 'V1' },
    ]
    const real = selectOrderRootCandidates(candidates, rules)
    assert.deepEqual(explainRootSelection(candidates, real, rules).map((entry) => entry.rule), ['not_dash_descendant', 'dash_descendant'])
    const forged = { selected: candidates.slice() }
    const labels = explainRootSelection(candidates, forged, rules)
    assert.equal(labels[1].rule, 'unexplained')
    assert.equal(labels[1].decision, 'selected', 'the decision is always the real one')
  })

  await run('rowProduced: true when the root row was pushed, false when maxRows refused it, not_reached after the walk stopped', async () => {
    const data = project('SDE-ROWS-1', {
      heads: [{ id: 'SDE-ROWS-1-ORDER', lines: [{ part_id: 'SDE-A1', quantity: '1' }, { part_id: 'SDE-A2', quantity: '1' }, { part_id: 'SDE-A3', quantity: '1' }] }],
      parts: [part('SDE-A1', 'A9400-1'), part('SDE-A2', 'A9400-2'), part('SDE-A3', 'A9400-3')],
    })
    const { evidence, result } = await expand('SDE-ROWS-1', data, { demandEvidence: true, maxRows: 1 })
    assert.equal(result.rows.length, 1)
    assert.equal(obsBy(evidence, 'SDE-A1')[0].rowProduced, true)
    assert.equal(obsBy(evidence, 'SDE-A2')[0].rowProduced, false)
    assert.deepEqual(obsBy(evidence, 'SDE-A3')[0].rowProduced, { status: 'not_reached' })
    assert.equal(evidence.counts.rowsProduced, 1)
    const dash = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    assert.equal(obsBy(dash.evidence, 'SDE-P')[0].rowProduced, true)
    assert.equal(obsBy(dash.evidence, 'SDE-S')[0].rowProduced, false, 'a dropped line produced no root row')
  })

  // ── quantity semantics ──────────────────────────────────────────────────────────────────────
  await run('a root\'s orderQuantity IS its rawQuantity; an edge usage is never an orderQuantity', async () => {
    const { evidence, result } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    const produced = evidence.observations.filter((entry) => entry.rowProduced === true)
    assert.ok(produced.length > 0, 'not vacuous')
    for (const observation of produced) {
      const root = result.rows.find((row) => row.depth === 0 && row.componentSourceId === observation.componentSourceId)
      assert.equal(observation.orderQuantity, root.rawQuantity)
      assert.equal(observation.orderQuantity, root.totalQuantity)
    }
    const usages = new Set(result.rows.filter((row) => row.depth > 0).map((row) => row.rawQuantity))
    assert.ok(usages.has(7))
    assert.equal(evidence.observations.some((observation) => observation.orderQuantity === 7), false)
    assert.ok(evidence.observations.every((observation) => observation.quantitySemantics === 'order_line'))
    assert.equal(evidence.header.quantityField, 'quantity')
  })

  // ── unknowns ────────────────────────────────────────────────────────────────────────────────
  await run('detail-line identity: not_declared / present / blank / column_absent / column_ambiguous', async () => {
    assert.deepEqual(readDetailLineId({ ID: 'L1' }, undefined), { status: 'not_declared' })
    assert.equal(readDetailLineId({ ID: ' L1 ' }, 'ID'), 'L1')
    assert.equal(readDetailLineId({ id: 'L1' }, 'ID'), 'L1', 'one case-insensitive match, the expander\'s rule')
    assert.deepEqual(readDetailLineId({ ID: '  ' }, 'ID'), { status: 'blank' })
    assert.deepEqual(readDetailLineId({ ID: null }, 'ID'), { status: 'blank' })
    assert.deepEqual(readDetailLineId({ other: 1 }, 'ID'), { status: 'column_absent' })
    assert.deepEqual(readDetailLineId({ id: 'a', Id: 'b' }, 'ID'), { status: 'column_ambiguous' })

    const data = dashProject('SDE-LINE-1')
    data.DN_PDM_OrderDetailInfo = data.DN_PDM_OrderDetailInfo.map((line, index) => ({ ...line, ID: `SDE-LINE-${index + 1}` }))
    const declared = await expand('SDE-LINE-1', data, { demandEvidence: { orderDetailLineIdField: 'ID' } })
    assert.deepEqual(obsBy(declared.evidence, 'SDE-P')[0].detailLine, 'SDE-LINE-1')
    assert.deepEqual(declared.evidence.header.identity.orderDetailLine, { status: 'declared', field: 'ID' })
    const absent = await expand('SDE-DASH-1', dashProject(), { demandEvidence: { orderDetailLineIdField: 'ID' } })
    assert.deepEqual(obsBy(absent.evidence, 'SDE-P')[0].detailLine, { status: 'column_absent' })
    const undeclared = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true })
    assert.deepEqual(obsBy(undeclared.evidence, 'SDE-P')[0].detailLine, { status: 'not_declared' })
    assert.deepEqual(undeclared.evidence.header.identity.orderDetailLine, { status: 'not_declared' })
  })

  await run('no null and no omitted key anywhere in an observation', async () => {
    const data = dashProject('SDE-NULLS-1')
    data.DN_PDM_OrderDetailInfo.push({ order_id: 'SDE-NULLS-1-ORDER-P', part_id: '  ', quantity: '1' })
    data.DN_PDM_OrderDetailInfo.push({ order_id: 'SDE-NULLS-1-ORDER-P', part_id: 'SDE-C', quantity: null })
    const { evidence } = await expand('SDE-NULLS-1', data, { demandEvidence: true })
    const walk = (value, where) => {
      assert.notEqual(value, null, `null at ${where}`)
      assert.notEqual(value, undefined, `undefined at ${where}`)
      if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) walk(entry, `${where}.${key}`)
    }
    walk(evidence, 'evidence')
    const keys = Object.keys(evidence.observations[0]).sort()
    for (const observation of evidence.observations) assert.deepEqual(Object.keys(observation).sort(), keys)
    const missing = evidence.observations.find((observation) => observation.exclusion === 'component_id_missing')
    assert.deepEqual(missing.componentSourceId, { status: 'blank' })
    const invalid = evidence.observations.find((observation) => observation.exclusion === 'quantity_invalid')
    assert.deepEqual(invalid.orderQuantity, { status: 'invalid' })
    assert.deepEqual(evidence.completeness.reasons, ['component_id_missing', 'quantity_invalid'])
  })

  await run('a blank order head is recorded as blank and makes the evidence incomplete (missing_order_id)', async () => {
    const data = dashProject('SDE-BLANKHEAD-1')
    data.DN_PDM_OrderHeadInfo.push({ OBJ_ID: '  ', path_id: 'SDE-BLANKHEAD-1-PATH' })
    const { evidence } = await expand('SDE-BLANKHEAD-1', data, { demandEvidence: true })
    assert.ok(evidence.orderHeads.some((head) => JSON.stringify(head.orderHead) === JSON.stringify({ status: 'blank' })))
    assert.equal(evidence.completeness.status, 'incomplete')
    assert.deepEqual(evidence.completeness.reasons, ['missing_order_id'])
  })

  // ── completeness ────────────────────────────────────────────────────────────────────────────
  await run('incomplete reads are named: max_rows_exceeded / read_cursor_broken / read_row_mismatch / read_failed', async () => {
    const cases = [
      [{ maxRows: 1 }, {}, 'max_rows_exceeded'],
      [{ requireCompleteBatch: true }, { brokenCursorObject: 'DN_PDM_OrderDetailInfo' }, 'read_cursor_broken'],
      [{}, { mismatchObject: 'DN_PDM_OrderDetailInfo' }, 'read_row_mismatch'],
      [{}, { failObjects: ['DN_PDM_PartLibraryInfo'] }, 'read_failed'],
      [{}, { failObjects: ['DN_PDM_PathExAttrInfo'] }, 'read_failed'],
    ]
    for (const [extra, behaviour, reason] of cases) {
      const { evidence, result } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, ...extra }, behaviour)
      assert.equal(evidence.completeness.status, 'incomplete', reason)
      assert.ok(evidence.completeness.reasons.includes(reason), `${reason}: ${evidence.completeness.reasons}`)
      assert.ok(result.errors.length > 0)
    }
  })

  await run('a part read that throws leaves its line as part_not_read, never as a known part', async () => {
    const { evidence } = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true }, { failObjects: ['DN_PDM_PartLibraryInfo'] })
    assert.equal(evidence.observations.length, 1, 'the walk stopped after the first line')
    assert.equal(evidence.observations[0].exclusion, 'part_not_read')
    assert.deepEqual(evidence.observations[0].componentCode, { status: 'unavailable' })
    assert.deepEqual(evidence.completeness.reasons, ['part_not_read', 'read_failed'])
  })

  await run('truncated row errors, the observation cap and a missing / ambiguous part are named', async () => {
    const data = project('SDE-CAP-1', {
      heads: [{ id: 'SDE-CAP-1-ORDER', lines: [{ part_id: 'SDE-GONE-1', quantity: '1' }, { part_id: 'SDE-GONE-2', quantity: '1' }, { part_id: 'SDE-TWO', quantity: '1' }] }],
      parts: [part('SDE-TWO', 'Z8900-1'), part('SDE-TWO', 'Z8900-1b')],
    })
    const truncated = await expand('SDE-CAP-1', data, { demandEvidence: true, rowErrorLimit: 1 })
    assert.equal(truncated.result.summary.rowErrorsTruncated, true)
    assert.deepEqual(truncated.evidence.completeness.reasons, ['part_ambiguous', 'part_missing', 'row_errors_truncated'])
    const capped = await expand('SDE-CAP-1', data, { demandEvidence: { maxObservations: 2 } })
    assert.equal(capped.evidence.observations.length, 2)
    assert.equal(capped.evidence.counts.observations, 3, 'true total kept')
    assert.deepEqual(capped.evidence.completeness.totals, { observations: 3, observationsRetained: 2 })
    assert.ok(capped.evidence.completeness.reasons.includes('observation_cap_exceeded'))
  })

  await run('the observation cap keeps the canonical first N whatever the read order', async () => {
    const lines = Array.from({ length: 6 }, (_, index) => ({ part_id: `SDE-N${index}`, quantity: String(index + 1) }))
    const data = project('SDE-CAP-2', {
      heads: [{ id: 'SDE-CAP-2-ORDER', lines }],
      parts: lines.map((line, index) => part(line.part_id, `N8950-${index}`)),
    })
    const forward = await expand('SDE-CAP-2', data, { demandEvidence: { maxObservations: 3 } })
    const reversed = await expand('SDE-CAP-2', data, { demandEvidence: { maxObservations: 3 } }, { reverse: true })
    assert.deepEqual(reversed.evidence, forward.evidence)
  })

  await run('the default cap is 5000 observations', async () => {
    const count = DEFAULT_MAX_OBSERVATIONS + 1
    const lines = Array.from({ length: count }, (_, index) => ({ part_id: `SDE-BIG-${index}`, quantity: '1' }))
    const data = project('SDE-CAP-3', {
      heads: [{ id: 'SDE-CAP-3-ORDER', lines }],
      parts: lines.map((line, index) => part(line.part_id, `B9000-${index}`)),
    })
    // An indexed source, so the 5001 part reads stay cheap.
    const byObject = new Map()
    const index = (object, field) => {
      const key = `${object}|${field}`
      if (!byObject.has(key)) {
        const map = new Map()
        for (const row of data[object] || []) {
          if (!map.has(row[field])) map.set(row[field], [])
          map.get(row[field]).push(row)
        }
        byObject.set(key, map)
      }
      return byObject.get(key)
    }
    const adapter = {
      async read(input) {
        const [[field, value]] = Object.entries(input.filters)
        return { records: (index(input.object, field).get(value) || []).map(clone), done: true }
      },
    }
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'SDE-CAP-3', demandEvidence: true, maxRows: 20000, rootSelection: { enabled: false } })
    assert.equal(result.demandEvidence.observations.length, DEFAULT_MAX_OBSERVATIONS)
    assert.equal(result.demandEvidence.counts.observations, count)
    assert.deepEqual(result.demandEvidence.completeness.reasons, ['observation_cap_exceeded'])
  })

  await run('path nodes the walk could not use are named: missing_path_id / missing_path / ambiguous_path', async () => {
    const data = dashProject('SDE-PATHS-1')
    data.DN_PDM_PathExAttrInfo.push(
      { FileCode: 'SDE-PATHS-1', Parent_OBJ_ID: ' ' },
      { FileCode: 'SDE-PATHS-1', Parent_OBJ_ID: 'SDE-PATHS-1-GHOST' },
      { FileCode: 'SDE-PATHS-1', Parent_OBJ_ID: 'SDE-PATHS-1-TWIN' },
    )
    data.DN_PDM_PathInfo.push({ OBJ_ID: 'SDE-PATHS-1-TWIN' }, { OBJ_ID: 'SDE-PATHS-1-TWIN' })
    const { evidence } = await expand('SDE-PATHS-1', data, { demandEvidence: true })
    assert.deepEqual(evidence.pathNodes.map((node) => node.outcome).sort(), ['ambiguous_path', 'missing_path', 'missing_path_id', 'ok'])
    const blank = evidence.pathNodes.find((node) => node.outcome === 'missing_path_id')
    assert.deepEqual(blank.pathId, { status: 'blank' })
    assert.deepEqual(blank.orderHeadCount, { status: 'not_applicable' })
    assert.deepEqual(evidence.completeness.reasons, ['ambiguous_path', 'missing_path', 'missing_path_id'])
  })

  await run('more than 20 related lines: refs capped, true count kept, related_refs_truncated', async () => {
    const lines = Array.from({ length: 22 }, (_, index) => ({ part_id: `SDE-JV${index}`, quantity: '1' }))
    const data = project('SDE-REL-1', {
      heads: [{ id: 'SDE-REL-1-ORDER', lines }],
      parts: lines.map((line, index) => part(line.part_id, 'J9100-00', `V${index + 1}`)),
    })
    const { evidence } = await expand('SDE-REL-1', data, { demandEvidence: true })
    const chosen = evidence.observations.find((observation) => observation.rule === 'main_drawing_chosen')
    assert.equal(chosen.componentSourceId, 'SDE-JV21')
    assert.equal(chosen.relatedCount, 21)
    assert.equal(chosen.relatedRefs.length, 20)
    assert.deepEqual(evidence.completeness.reasons, ['related_refs_truncated'])
  })

  await run('a part below depth 0 more than 20 times: paths capped, true count kept, occurrence_paths_truncated', async () => {
    const roots = Array.from({ length: 21 }, (_, index) => `SDE-R${index}`)
    const data = project('SDE-OCC-1', {
      heads: [{ id: 'SDE-OCC-1-ORDER', lines: roots.map((id) => ({ part_id: id, quantity: '1' })).concat([{ part_id: 'SDE-X', quantity: '9' }]) }],
      parts: roots.map((id, index) => part(id, `R92${String(index).padStart(2, '0')}`)).concat([part('SDE-X', 'X9300')]),
      bomHeads: roots.map((id) => bomHead(id, `${id}-BOM`)),
      bomDetails: roots.map((id) => bomLine(`${id}-BOM`, 'SDE-X', '1')),
    })
    const { evidence } = await expand('SDE-OCC-1', data, { demandEvidence: true })
    const [x] = obsBy(evidence, 'SDE-X')
    assert.equal(x.expandedOccurrences.count, 21)
    assert.equal(x.expandedOccurrences.paths.length, 20)
    assert.equal(x.expandedOccurrences.truncated, true)
    assert.deepEqual(x.expandedOccurrences.paths, x.expandedOccurrences.paths.slice().sort())
    assert.deepEqual(evidence.completeness.reasons, ['occurrence_paths_truncated'])
  })

  await run('a root-selection label the explainer could not derive makes the evidence incomplete', () => {
    const recorder = demandEvidenceModule.createDemandEvidenceRecorder({
      options: normalizeDemandEvidenceOptions(true),
      plan: PLM_STOCK_PREPARATION_BOM_READ_PLAN,
      rootSelection: DEFAULT_ROOT_SELECTION,
      explainRootSelection: (candidates) => candidates.map(() => ({ decision: 'selected', rule: 'unexplained', related: [] })),
    })
    const candidate = { componentSourceId: 'SDE-U', componentCode: 'U1', sourceVersion: 'V1' }
    recorder.pathNode('SDE-U-PATH', 'ok')
    recorder.orderHeadsRead(1)
    recorder.orderHead('SDE-U-ORDER')
    recorder.orderLinesRead(1)
    recorder.orderLine({ detail: { part_id: 'SDE-U', quantity: '1' }, componentSourceId: 'SDE-U', quantity: { ok: true, value: 1 } })
    recorder.orderLinePart('found', candidate)
    recorder.rootSelection([candidate], { selected: [candidate] })
    const evidence = recorder.finalize({ projectNo: 'SDE-U', result: { status: 'expanded', rows: [], errors: [], summary: {} } })
    assert.deepEqual(evidence.completeness.reasons, ['root_selection_unexplained'])
  })

  await run('not_found and an entry-read failure still produce evidence', async () => {
    const notFound = await expand('SDE-ABSENT-1', { DN_PDM_PathExAttrInfo: [] }, { demandEvidence: true })
    assert.equal(notFound.evidence.completeness.status, 'project_not_found')
    assert.deepEqual(notFound.evidence.observations, [])
    const failedEntry = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true }, { failObjects: ['DN_PDM_PathExAttrInfo'] })
    assert.equal(failedEntry.result.status, 'failed')
    assert.deepEqual(failedEntry.evidence.completeness.reasons, ['read_failed'])
  })

  // ── large-lane parity (pure) ────────────────────────────────────────────────────────────────
  const smallLaneAction = normalizeStockPreparationActionConfig({
    actionId: 'plm.stock-preparation.pull-bom.v1',
    source: { externalSystemId: 'plm_sde', kind: 'data-source:sql-readonly' },
    target: { sheetId: 'sheet_sde', objectId: 'stockPreparationMain' },
    maxRows: 2,
  })
  // The small lane's expander options as computeDryRun builds them, and the large lane's as the
  // background job does (`largeBomBackgroundExpansionCaps` + the stored rootSelection).
  const smallLaneOptions = (action) => ({
    readPlan: action.source.readPlan,
    pageLimit: action.pageLimit,
    maxPages: action.maxPages,
    maxReadCount: action.maxReadCount,
    maxElapsedMs: action.maxElapsedMs,
    maxDepth: action.maxDepth,
    maxRows: action.maxRows,
    rowErrorLimit: action.rowErrorLimit,
    rootSelection: action.rootSelection,
    readConcurrency: 4,
  })
  const largeLaneOptions = (action) => ({ rootSelection: action.rootSelection, ...largeBomBackgroundExpansionCaps(action) })

  await run('large-lane parity: a project that fits both lanes => identical evidence body and fingerprint', async () => {
    const roomy = normalizeStockPreparationActionConfig({ ...clone(smallLaneAction), maxRows: 100 })
    const small = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, ...smallLaneOptions(roomy) })
    const large = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, ...largeLaneOptions(roomy) })
    assert.deepEqual(large.evidence, small.evidence)
  })

  await run('large-lane parity: a small-lane cap overflow is incomplete where the large lane is complete', async () => {
    const small = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, ...smallLaneOptions(smallLaneAction) })
    const large = await expand('SDE-DASH-1', dashProject(), { demandEvidence: true, ...largeLaneOptions(smallLaneAction) })
    assert.equal(small.evidence.completeness.status, 'incomplete')
    assert.ok(small.evidence.completeness.reasons.includes('max_rows_exceeded'))
    assert.equal(large.evidence.completeness.status, 'complete')
    assert.notEqual(large.evidence.fingerprint, small.evidence.fingerprint)
  })

  await run('large-lane parity: the background job\'s artifact revision is identical with capture on and off', async () => {
    const artifactFor = async (expansionOptions) => {
      const map = new Map()
      const storage = { durable: true, async get(key) { return map.has(key) ? clone(map.get(key)) : null }, async set(key, value) { map.set(key, clone(value)) } }
      const scope = { tenantId: 'tenant_sde', workspaceId: 'workspace_sde' }
      const now = () => new Date('2026-10-22T03:00:00.000Z')
      await createLargeBomBackgroundExpansionJob({
        storage, ...scope, action: smallLaneAction, parameters: { projectNo: 'SDE-DASH-1' }, principal: 'principal_sde', createJobId: () => 'job_sde', now,
      })
      return runLargeBomBackgroundExpansionJob({
        storage, ...scope, actionId: smallLaneAction.actionId, jobId: 'job_sde', sourceAdapter: createAdapter(dashProject()).adapter, expansionOptions, now,
      })
    }
    const off = await artifactFor(largeBomBackgroundExpansionCaps(smallLaneAction))
    const on = await artifactFor({ ...largeBomBackgroundExpansionCaps(smallLaneAction), demandEvidence: true })
    assert.equal(off.status, 'completed')
    assert.equal(on.artifactRevision, off.artifactRevision)
    assert.deepEqual(on.artifact, off.artifact)
    assert.equal(JSON.stringify(on).includes('demandEvidence'), false, 'the stored job carries no evidence')
  })

  console.log(`stock-preparation-demand-evidence: ${passed} passed, ${failed} failed`)
  if (failed > 0) throw new Error(`${failed} check(s) failed`)
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-demand-evidence.test.cjs', main)
