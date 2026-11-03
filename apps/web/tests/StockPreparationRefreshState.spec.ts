import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 备料分批拉取第一期 step 4 PR-7 — the PURE half of the web's batch-refresh consumers (design §9.1, §11, §13; plan §8).
//
//   RS-MIRROR  the stanza vocabulary and 「可以导出」 are TRANSCRIPTIONS of the plugin's refresh-state module, driven
//              over the REAL `readProjectRefreshState` for every status × settled (never `exportAllowed`, #6566 N5).
//   RS-PARSE   absent key ⇒ null (older backend); present-but-malformed ⇒ unreadable (fail closed); counts clamped.
//   RS-SPLIT   the board's union count splits into ledger work and holds, clamped (R-62 ⑥).
//   RS-RENDER  the three renderings 未启用 / 读取失败 / 无待处理 are never one for another (plan §8).
//   RS-BANNER  per-status banner copy; the link only for a puller with holds to decide; none when nothing blocks.
//   RS-COPY    every code of the plugin's live step-4 vocabularies has its OWN copy (a backend code without web copy
//              reds here) — #6565 review N6, the five export codes, the PR-3/4/6 codes.
//              PR-7b: plus the pairing core's and the write lock's vocabularies and the codes the PR-7 review found on
//              the generic sentence.
//   RS-WORDS   (PR-7b, review N2 / N8) every token of the plugin's live hold-page vocabularies (hold kinds,
//              not-confirmable reasons, shapes, history, relationship status, comparison status) has words.
//   RS-REASON  `<code>/<reason>` readings (PR-5 pg review N1 lease_in_flight; F-19 'preview again'; PR-7b N9).
//   RS-ERR     the export client carries a CLAMPED `details.reason` / `details.status`, never a value (W2).
//   PS-*       projectSync learns `suspended` / `recovery_pending` / the refresh refusals / 「核对」 (W4).
//   NS-*       the 下一步 bar's rule 3b — puller vs floor, never an action for the floor (R-11) (W5).
//   OH-*       home memory keeps `blocked_pull_state` (#6566 N9) and the fail-closed card fold (W5).

const { wireFetch } = vi.hoisted(() => ({ wireFetch: vi.fn() }))
vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: (...args: unknown[]) => wireFetch(...args) }
})

import {
  STOCK_PREP_REFRESH_STATUS_LABELS_ZH,
  STOCK_PREP_REFRESH_STATUS_TOKENS,
  parseStockPrepRefreshStanza,
  stockPrepFormalSurfaceVerdict,
  stockPrepPendingSplit,
  stockPrepRefreshBanner,
  stockPrepRefreshRailCount,
  stockPrepRefreshRendering,
} from '../src/services/integration/stockPreparation/refreshState'
import {
  STOCK_PREP_ERROR_GENERIC,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_ERROR_REASON_PLAIN,
  STOCK_PREP_LARGE_BOM_ERROR_PLAIN,
  STOCK_PREP_SYNC_REASON_PLAIN,
  STOCK_PREP_REFRESH_COMPARISON_STATUS_PLAIN,
  STOCK_PREP_REFRESH_CONTINUATION_STATUS_PLAIN,
  STOCK_PREP_REFRESH_HISTORY_PLAIN,
  STOCK_PREP_REFRESH_HOLD_KIND_PLAIN,
  STOCK_PREP_REFRESH_NOT_CONFIRMABLE_PLAIN,
  STOCK_PREP_REFRESH_SHAPE_PLAIN,
  stockPrepRefreshTokenPlain,
  stockPrepBoardErrorPlain,
  stockPrepErrorPlain,
  stockPrepExportRefreshGatePlain,
  stockPrepSyncReasonPlain,
  stockPrepSyncVerdictPlain,
} from '../src/services/integration/stockPreparation/plainLanguage'
import {
  StockPreparationProjectSyncCallError,
  classifyPlanStep,
  classifyRefreshApplyFailure,
  runStockPreparationProjectSync,
  runStockPreparationSettlementCheck,
  type StockPreparationProjectSyncApi,
} from '../src/services/integration/stockPreparation/projectSync'
import { exportStockPreparationPrepLines } from '../src/services/integration/stockPreparation/confirmationQueue'
import { StockPreparationConfirmApiError } from '../src/services/integration/stockPreparation/confirmApi'
import { operatorNextStep, type OperatorNextStepInput } from '../src/services/integration/stockPreparation/operatorNextStep'
import { stockPrepPosture } from '../src/services/integration/stockPreparation/projectPosture'
import {
  clearStockPrepOperatorHomeMemory,
  readStockPrepRecentProjects,
  recordStockPrepProjectVisit,
} from '../src/services/integration/stockPreparation/operatorHomeMemory'
import { buildOperatorHomeCards } from '../src/services/integration/stockPreparation/operatorHomeCards'
import type { StockPreparationOperatorProject } from '../src/services/integration/stockPreparation/confirmationQueue'

const nodeRequire = createRequire(import.meta.url)
const PLUGIN_LIB = '../../../plugins/plugin-integration-core/lib/'
const backendState = nodeRequire(`${PLUGIN_LIB}stock-preparation-refresh-state.cjs`) as {
  STATUS_TOKENS: readonly string[]
  STATUS_LABELS_ZH: Record<string, string>
  readProjectRefreshState: (consult: unknown) => Record<string, unknown>
  formalSurfaceVerdict: (state: unknown) => { allowed: boolean; reason: string | null }
}

const SYN_PROJECT = 'SYN-PROJ-0001'
const ISO_OLD = '2026-10-01T00:00:00.000Z'
const ISO_NEW = '2026-10-02T00:00:00.000Z'

/** A synthetic consult answer (the PR-2 reader's contract) — values-free ids only. */
function consult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    pilot: { enabled: true },
    continuations: [],
    holds: [],
    state: null,
    executions: [],
    changePlans: [],
    lock: { state: { leaseLive: false, leaseHeld: false }, generation: { leaseId: null } },
    ...overrides,
  }
}

const SETTLED_STATE = { settledAt: ISO_NEW, settledSheetMachineDigest: 'd'.repeat(64), settledExecutionId: 'exec_syn_1' }

/** One consult per status token (and both settled variants where the status allows). */
function consultsPerStatus(): Array<{ label: string; consult: unknown }> {
  return [
    { label: 'unreadable', consult: { ok: false, failure: { store: 'continuation', operation: 'read_continuations' } } },
    { label: 'not_governed', consult: consult({ pilot: null }) },
    { label: 'executing', consult: consult({ lock: { state: { leaseLive: true, leaseHeld: true }, generation: { leaseId: 'lease_syn' } } }) },
    { label: 'failed_pending_recovery', consult: consult({ executions: [{ id: 'exec_syn_1', status: 'failed', leaseId: null, startedAt: ISO_OLD }] }) },
    { label: 'pending_confirmation', consult: consult({ holds: [{ id: 'hold_syn_1', status: 'open', kind: 'continuation_candidate', confirmable: true }] }) },
    { label: 'change_pending_review', consult: consult({ changePlans: [{ id: 'plan_syn_1', status: 'written' }] }) },
    { label: 'confirmed_pending_execution', consult: consult({ continuations: [{ id: 'cont_syn_1', status: 'active', revision: 1, executedExecutionId: null, confirmedAt: ISO_NEW }] }) },
    { label: 'executed_pending_settlement', consult: consult({ executions: [{ id: 'exec_syn_2', status: 'succeeded', leaseId: null, startedAt: ISO_OLD }], state: { settledAt: null, settledExecutionId: null } }) },
    { label: 'complete (never settled)', consult: consult() },
    { label: 'complete (settled)', consult: consult({ state: SETTLED_STATE }) },
    { label: 'complete (settled, executed)', consult: consult({ executions: [{ id: 'exec_syn_1', status: 'succeeded', leaseId: null, startedAt: ISO_OLD }], state: SETTLED_STATE }) },
  ]
}

describe('RS — the board stanza on the web (refreshState.ts)', () => {
  it('RS-MIRROR: tokens and zh labels are byte-equal to the plugin module', () => {
    expect([...STOCK_PREP_REFRESH_STATUS_TOKENS]).toEqual([...backendState.STATUS_TOKENS])
    expect({ ...STOCK_PREP_REFRESH_STATUS_LABELS_ZH }).toEqual({ ...backendState.STATUS_LABELS_ZH })
  })

  it('RS-MIRROR: 「可以导出」 is the server verdict over the REAL derivation, for every status × settled', () => {
    const seen = new Set<string>()
    for (const entry of consultsPerStatus()) {
      const state = backendState.readProjectRefreshState(entry.consult)
      seen.add(String(state.status))
      const web = stockPrepFormalSurfaceVerdict(parseStockPrepRefreshStanza(JSON.parse(JSON.stringify(state))))
      expect(web, entry.label).toEqual({ ...backendState.formalSurfaceVerdict(state) })
    }
    // Every status token is covered by the matrix above.
    expect([...seen].sort()).toEqual([...backendState.STATUS_TOKENS].sort())
    // #6566 review N5, the one the key name invites: complete + exportAllowed:true + settled:false is NOT exportable.
    const neverSettled = backendState.readProjectRefreshState(consult())
    expect(neverSettled.exportAllowed).toBe(true)
    expect(neverSettled.settled).toBe(false)
    expect(stockPrepFormalSurfaceVerdict(parseStockPrepRefreshStanza(neverSettled))).toEqual({ allowed: false, reason: 'not_settled' })
  })

  it('RS-PARSE: absent ⇒ null; malformed / unknown ⇒ unreadable; counts clamped; failure tokens only', () => {
    expect(parseStockPrepRefreshStanza(undefined)).toBeNull()
    for (const malformed of [null, 'complete', 3, [], {}]) {
      const parsed = parseStockPrepRefreshStanza(malformed)
      expect(parsed?.status, JSON.stringify(malformed)).toBe('unreadable')
      expect(parsed?.readable).toBe(false)
    }
    expect(parseStockPrepRefreshStanza({ readable: true, status: 'not_a_status' })?.status).toBe('unreadable')
    // `readable` must be literally true for a governed status to stand.
    expect(parseStockPrepRefreshStanza({ readable: 'yes', status: 'complete', settled: true })?.status).toBe('unreadable')
    const parsed = parseStockPrepRefreshStanza({
      readable: true,
      status: 'pending_confirmation',
      governed: 'pilot',
      settled: false,
      exportAllowed: false,
      counts: { pendingConfirm: 3, confirmable: -1, openExecutions: 1.5, pendingReviews: '2', continuations: 0 },
    })
    expect(parsed?.counts).toEqual({ pendingConfirm: 3, confirmable: null, openExecutions: null, pendingReviews: null, continuations: 0 })
    const unreadable = parseStockPrepRefreshStanza({ readable: false, status: 'unreadable', unreadable: { reason: 'store_read_failed', store: 'continuation', operation: SYN_PROJECT } })
    expect(unreadable?.unreadable).toEqual({ reason: 'store_read_failed', store: 'continuation' })
  })

  it('RS-SPLIT: ledger = clamp(union − holds); an absent / unreadable stanza leaves the union as ledger', () => {
    const pending = (n: number) => parseStockPrepRefreshStanza({ readable: true, status: 'pending_confirmation', governed: 'pilot', settled: false, counts: { pendingConfirm: n } })
    expect(stockPrepPendingSplit({ pendingDecisionCount: 5 }, pending(3))).toEqual({ ledger: 2, holds: 3 })
    expect(stockPrepPendingSplit({ pendingDecisionCount: 2 }, pending(3))).toEqual({ ledger: 0, holds: 3 })
    expect(stockPrepPendingSplit({ pendingDecisionCount: 4 }, null)).toEqual({ ledger: 4, holds: 0 })
    expect(stockPrepPendingSplit({ pendingDecisionCount: 4 }, parseStockPrepRefreshStanza({}))).toEqual({ ledger: 4, holds: 0 })
  })

  it('RS-RENDER: 未启用 / 读取失败 / 无待处理 are three distinct renderings', () => {
    expect(stockPrepRefreshRendering(null)).toBe('absent')
    expect(stockPrepRefreshRendering(parseStockPrepRefreshStanza({ readable: true, status: 'not_governed', governed: 'none' }))).toBe('not_governed')
    expect(stockPrepRefreshRendering(parseStockPrepRefreshStanza({ readable: false, status: 'unreadable' }))).toBe('unreadable')
    const complete = parseStockPrepRefreshStanza({ readable: true, status: 'complete', governed: 'pilot', settled: true, counts: { pendingConfirm: 0 } })
    expect(stockPrepRefreshRendering(complete)).toBe('none_pending')
    const pending = parseStockPrepRefreshStanza({ readable: true, status: 'pending_confirmation', governed: 'pilot', counts: { pendingConfirm: 2 } })
    expect(stockPrepRefreshRendering(pending)).toBe('pending')
    expect(stockPrepRefreshRendering(pending, { pendingHolds: 0 })).toBe('none_pending')
  })

  it('RS-BANNER: per status; link only for a puller with holds; none for not_governed / complete ∧ settled / absent', () => {
    const stanza = (status: string, extra: Record<string, unknown> = {}) => parseStockPrepRefreshStanza({ readable: true, status, governed: 'pilot', settled: false, counts: { pendingConfirm: 3 }, ...extra })
    expect(stockPrepRefreshBanner(null)).toBeNull()
    expect(stockPrepRefreshBanner(stanza('not_governed'))).toBeNull()
    expect(stockPrepRefreshBanner(stanza('complete', { settled: true }))).toBeNull()
    const pending = stockPrepRefreshBanner(stanza('pending_confirmation'), { canOpenQueue: true })
    expect(pending?.zh).toBe('本项目有 3 项待拉取人员确认,正式导出已暂停。')
    expect(pending?.link).toBe(true)
    expect(stockPrepRefreshBanner(stanza('pending_confirmation'), { canOpenQueue: false })?.link).toBe(false)
    expect(stockPrepRefreshBanner(stanza('executed_pending_settlement'), { canOpenQueue: true })?.link).toBe(false)
    expect(stockPrepRefreshBanner(stanza('complete'))?.key).toBe('unsettled')
    expect(stockPrepRefreshBanner(stanza('complete'))?.zh).toContain('待核对')
    expect(stockPrepRefreshBanner(stanza('failed_pending_recovery'))?.zh).toContain('执行失败待恢复')
    expect(stockPrepRefreshBanner(stanza('change_pending_review'))?.zh).toContain('变更待复核')
    expect(stockPrepRefreshBanner(parseStockPrepRefreshStanza({ readable: false, status: 'unreadable' }))?.zh).toContain('读取失败')
    for (const status of STOCK_PREP_REFRESH_STATUS_TOKENS) {
      const banner = stockPrepRefreshBanner(status === 'unreadable' ? parseStockPrepRefreshStanza({ readable: false, status }) : stanza(status))
      if (status === 'not_governed') expect(banner).toBeNull()
      else expect(banner?.zh, status).toContain('正式导出')
    }
    expect(stockPrepRefreshRailCount(stanza('pending_confirmation'))).toBe(3)
    expect(stockPrepRefreshRailCount(stanza('pending_confirmation', { counts: { pendingConfirm: 0 } }))).toBeNull()
  })
})

describe('RS-COPY — every step-4 code has its own copy (the cross-side tripwire)', () => {
  function liveCodes(): string[] {
    const codes = new Set<string>()
    const add = (map: Record<string, string>) => Object.values(map).forEach((code) => codes.add(code))
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-refresh-decisions.cjs`) as { REFRESH_DECISION_ERROR_CODES: Record<string, string> }).REFRESH_DECISION_ERROR_CODES)
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-refresh-lanes.cjs`) as { REFRESH_LANE_ERROR_CODES: Record<string, string> }).REFRESH_LANE_ERROR_CODES)
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-continuation-store.cjs`) as { REFRESH_STORE_ERROR_CODES: Record<string, string> }).REFRESH_STORE_ERROR_CODES)
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-refresh-governance.cjs`) as { REFRESH_GOVERNANCE_ERROR_CODES: Record<string, string> }).REFRESH_GOVERNANCE_ERROR_CODES)
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-export-gate.cjs`) as { EXPORT_GATE_ERROR_CODES: Record<string, string> }).EXPORT_GATE_ERROR_CODES)
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-governed-sheet-probe.cjs`) as { GOVERNED_SHEET_WRITE_CODES: Record<string, string> }).GOVERNED_SHEET_WRITE_CODES)
    // PR-7b (PR-7 review: generic copy remained for step-4-adjacent codes): the pairing core's and the write lock's
    // own vocabularies, and the pilot marker's STATE_MOVED, read LIVE too.
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-continuation-pairing.cjs`) as { CONTINUATION_ERROR_CODES: Record<string, string> }).CONTINUATION_ERROR_CODES)
    add((nodeRequire(`${PLUGIN_LIB}stock-preparation-project-write-lock.cjs`) as { PROJECT_WRITE_ERROR_CODES: Record<string, string> }).PROJECT_WRITE_ERROR_CODES)
    codes.add((nodeRequire(`${PLUGIN_LIB}stock-preparation-project-target-store.cjs`) as { PROJECT_TARGET_PILOT_STATE_MOVED_CODE: string }).PROJECT_TARGET_PILOT_STATE_MOVED_CODE)
    for (const literal of [
      'STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE',
      'LARGE_BOM_APPLY_PLAN_SUSPENDED',
      'LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED',
      'STOCK_PREP_CONTINUATION_PROJECTION_INCONSISTENT',
      'AUDIT_STORE_UNAVAILABLE',
      // PR-7b: thrown by name (no exported map) — the large-BOM job store and the table-actions archive lane.
      'LARGE_BOM_APPLY_JOB_SCAN_INVALID',
      'LARGE_BOM_JOB_STORE_UNAVAILABLE',
      'LARGE_BOM_PLAN_GOVERNANCE_VERDICT_INVALID',
      'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY',
    ]) codes.add(literal)
    return [...codes].sort()
  }

  it('RS-COPY (PR-7b): the thirteen codes the PR-7 review found on the generic sentence each have their own two lines', () => {
    // The literal codes above are each thrown by the plugin source (a rename there must rename them here).
    const libSource = (name: string) => readFileSync(resolve(__dirname, PLUGIN_LIB, name), 'utf8')
    expect(libSource('stock-preparation-large-bom-jobs.cjs')).toContain("'LARGE_BOM_APPLY_JOB_SCAN_INVALID'")
    expect(libSource('stock-preparation-large-bom-jobs.cjs')).toContain("'LARGE_BOM_JOB_STORE_UNAVAILABLE'")
    expect(libSource('stock-preparation-large-bom-jobs.cjs')).toContain("'LARGE_BOM_PLAN_GOVERNANCE_VERDICT_INVALID'")
    expect(libSource('stock-preparation-table-actions.cjs')).toContain("'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY'")
    for (const code of [
      'LARGE_BOM_APPLY_JOB_SCAN_INVALID',
      'LARGE_BOM_JOB_STORE_UNAVAILABLE',
      'LARGE_BOM_PLAN_GOVERNANCE_VERDICT_INVALID',
      'STOCK_PREP_CONTINUATION_INPUT_INVALID',
      'STOCK_PREP_CONTINUATION_POSTCONDITION_VIOLATED',
      'STOCK_PREP_PILOT_STATE_MOVED',
      'STOCK_PREP_PROJECT_WRITE_GUARD_SCOPE_MISMATCH',
      'STOCK_PREP_SHEET_DIGEST_RECORD_REF_MISSING',
      'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY',
      'STOCK_PREPARATION_PROJECT_TARGET_PLM_LOCK_OBJECT_REFUSED',
      'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID',
      'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID',
      'STOCK_PREPARATION_PROJECT_TARGET_STORE_UNAVAILABLE',
    ]) {
      const plain = stockPrepErrorPlain(code)
      expect(plain, code).not.toBe(STOCK_PREP_ERROR_GENERIC)
      for (const key of ['zh', 'en', 'zhNext', 'enNext'] as const) expect(String(plain[key] ?? '').trim().length, `${code}.${key}`).toBeGreaterThan(0)
      expect(plain.zh, `${code}: no raw token inside the sentence`).not.toMatch(/[A-Z]{3,}_[A-Z_]+/)
    }
    // The archive refused for a suspended pull reads by its reason.
    expect(stockPrepErrorPlain('STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY', 'refresh_suspended').zhNext).toContain('拉取待确认')
  })

  it('RS-COPY: each code resolves to its OWN entry (not the generic) with both lines', () => {
    const codes = liveCodes()
    expect(codes.length).toBeGreaterThanOrEqual(25)
    const missing = codes.filter((code) => !Object.prototype.hasOwnProperty.call(STOCK_PREP_ERROR_PLAIN, code))
    expect(missing, `codes without web copy:\n${missing.join('\n')}`).toEqual([])
    for (const code of codes) {
      const plain = stockPrepErrorPlain(code)
      expect(plain, code).not.toBe(STOCK_PREP_ERROR_GENERIC)
      expect(String(plain.zhNext ?? '').length, `${code}.zhNext`).toBeGreaterThan(0)
    }
    // #6565 review N6: the transient store failure says "try again" AND names who to ask.
    expect(stockPrepErrorPlain('STOCK_PREP_REFRESH_STORE_FAILED').zhNext).toContain('稍后再试')
    // The large panel reads its own table first: the two job-level refusals are there too.
    expect(STOCK_PREP_LARGE_BOM_ERROR_PLAIN.LARGE_BOM_APPLY_PLAN_SUSPENDED).toBeDefined()
    expect(STOCK_PREP_LARGE_BOM_ERROR_PLAIN.LARGE_BOM_APPLY_GOVERNANCE_UNCONSULTED).toBeDefined()
    // The board READ's own refusals read as a read (PR-5 bd N4).
    for (const code of ['STOCK_PREP_REFRESH_TARGET_RETARGETED', 'STOCK_PREP_REFRESH_TENANT_MISMATCH', 'STOCK_PREP_REFRESH_STORE_FAILED']) {
      expect(stockPrepBoardErrorPlain(code).zh, code).toContain('没有显示')
    }
  })

  it('RS-REASON: `<code>/<reason>` readings resolve first; unknown reasons fall back to the code', () => {
    const lease = stockPrepErrorPlain('STOCK_PREP_EXPORT_BLOCKED', 'lease_in_flight')
    const state = stockPrepErrorPlain('STOCK_PREP_EXPORT_BLOCKED', 'state')
    const notSettled = stockPrepErrorPlain('STOCK_PREP_EXPORT_BLOCKED', 'not_settled')
    expect(new Set([lease.zh, state.zh, notSettled.zh]).size).toBe(3)
    // PR-5 pg review N1: the remedy names the TIER that can clear an abandoned lease.
    expect(lease.zhNext).toContain('拉取人员')
    expect(lease.zhNext).toContain('试算')
    // PR-7b (PR-7 review N9): only an APPLICABLE preview clears an abandoned lease (the generation bump runs only
    // when the preview is about to issue an applicable result) — the remedy says so.
    expect(lease.zhNext).toContain('能应用的试算')
    expect(lease.enNext).toContain('can be applied')
    expect(stockPrepErrorPlain('STOCK_PREP_EXPORT_BLOCKED', 'not_a_reason')).toBe(STOCK_PREP_ERROR_PLAIN.STOCK_PREP_EXPORT_BLOCKED)
    // F-19: STATE_MOVED during a preview reads "preview again", with the cause.
    const moved = stockPrepErrorPlain('STOCK_PREP_PULL_STATE_MOVED', 'execution_finished_during_preview')
    expect(moved.zh).toContain('写入刚好结束')
    expect(moved.zhNext).toContain('重新试算')
    // Delta review N-7: no count recorded.
    expect(stockPrepErrorPlain('STOCK_PREP_CONTINUATION_END_OUTCOME_NOT_ADMISSIBLE', 'facts_missing').zh).toContain('没有记录新位置数')
    // Every reason key names a code that has its own entry.
    for (const key of Object.keys(STOCK_PREP_ERROR_REASON_PLAIN)) {
      const code = key.split('/')[0]
      expect(Object.prototype.hasOwnProperty.call(STOCK_PREP_ERROR_PLAIN, code), key).toBe(true)
    }
    // 今天要处理's card export resolves the gate codes; anything else is not its business.
    expect(stockPrepExportRefreshGatePlain('STOCK_PREP_EXPORT_BLOCKED', 'not_settled')).toBe(notSettled)
    expect(stockPrepExportRefreshGatePlain('FORBIDDEN', null)).toBeNull()
  })
})

// PR-7b (PR-7 review N2 / N8; plan W7) — RS-WORDS: every token of the plugin's LIVE closed vocabularies that the
// 「拉取待确认」 page shows has words of its own, so a new server token without words reds here (the RS-COPY pattern).
describe('RS-WORDS — every hold-page token has words (the cross-side tripwire)', () => {
  const pairing = nodeRequire(`${PLUGIN_LIB}stock-preparation-continuation-pairing.cjs`) as {
    HOLD_KINDS: readonly string[]
    NOT_CONFIRMABLE_REASONS: readonly string[]
    SHAPE_TOKENS: readonly string[]
  }
  const store = nodeRequire(`${PLUGIN_LIB}stock-preparation-continuation-store.cjs`) as {
    EVIDENCE_HISTORY_STATUSES: readonly string[]
    CONTINUATION_ROW_STATUSES: readonly string[]
  }

  /** The field statuses `compareSevenItems` assigns, scanned out of the plugin source (they are not exported). */
  function comparisonStatuses(): string[] {
    const source = readFileSync(resolve(__dirname, PLUGIN_LIB, 'stock-preparation-continuation-pairing.cjs'), 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf('function compareSevenItems(')
    expect(start, 'compareSevenItems in the pairing source').toBeGreaterThan(0)
    const end = source.indexOf('\nfunction ', start + 1)
    const body = source.slice(start, end > start ? end : undefined)
    const tokens = new Set<string>()
    for (const match of body.matchAll(/\bstatus(?: =|:) '([a-z_]+)'/g)) tokens.add(match[1])
    // `status = <test> ? 'equal' : 'differs'` (the field's status only, not the item's `outcome`).
    for (const match of body.matchAll(/\bstatus = [^\n]*\? '([a-z_]+)' : '([a-z_]+)'/g)) { tokens.add(match[1]); tokens.add(match[2]) }
    return [...tokens].sort()
  }

  function expectWords(label: string, map: Record<string, { zh: string; en: string }>, tokens: readonly string[], minimum: number): void {
    expect(tokens.length, `${label}: the live list`).toBeGreaterThanOrEqual(minimum)
    const missing = tokens.filter((token) => stockPrepRefreshTokenPlain(map, token) === null)
    expect(missing, `${label} without words:\n${missing.join('\n')}`).toEqual([])
    for (const token of tokens) {
      const entry = map[token]
      expect(entry.zh.trim().length, `${label}.${token}.zh`).toBeGreaterThan(0)
      expect(entry.en.trim().length, `${label}.${token}.en`).toBeGreaterThan(0)
      // Words, not the token again.
      expect(entry.zh, `${label}.${token}: no raw token`).not.toMatch(/[a-z]+_[a-z_]+/)
    }
    // Nothing stale either: every key of the map is a live token.
    expect(Object.keys(map).filter((key) => !tokens.includes(key)), `${label}: words for tokens the server no longer has`).toEqual([])
  }

  it('RS-WORDS: hold kinds, not-confirmable reasons, shapes, history, relationship status and comparison status', () => {
    expectWords('hold kind', STOCK_PREP_REFRESH_HOLD_KIND_PLAIN, pairing.HOLD_KINDS, 14)
    expectWords('not-confirmable reason', STOCK_PREP_REFRESH_NOT_CONFIRMABLE_PLAIN, pairing.NOT_CONFIRMABLE_REASONS, 8)
    expectWords('shape', STOCK_PREP_REFRESH_SHAPE_PLAIN, pairing.SHAPE_TOKENS, 6)
    expectWords('history', STOCK_PREP_REFRESH_HISTORY_PLAIN, store.EVIDENCE_HISTORY_STATUSES, 3)
    expectWords('relationship status', STOCK_PREP_REFRESH_CONTINUATION_STATUS_PLAIN, store.CONTINUATION_ROW_STATUSES, 3)
    const statuses = comparisonStatuses()
    expect(statuses).toEqual(expect.arrayContaining(['equal', 'differs', 'incomplete']))
    expectWords('comparison status', STOCK_PREP_REFRESH_COMPARISON_STATUS_PLAIN, statuses, 5)
    // An unknown token is null (the page then says 「未识别」 and shows the token apart from the sentence).
    expect(stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_HOLD_KIND_PLAIN, 'not_a_kind')).toBeNull()
    expect(stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_HOLD_KIND_PLAIN, 'toString')).toBeNull()
    expect(stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_HOLD_KIND_PLAIN, null)).toBeNull()
  })
})

describe('RS-ERR — the export client carries clamped tokens (W2)', () => {
  afterEach(() => wireFetch.mockReset())

  async function exportError(details: Record<string, unknown>): Promise<StockPreparationConfirmApiError> {
    wireFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'STOCK_PREP_EXPORT_BLOCKED', message: 'blocked', details } }), { status: 409 }))
    try {
      await exportStockPreparationPrepLines({ tenantId: 'tenant-syn', projectNo: SYN_PROJECT })
    } catch (error) {
      return error as StockPreparationConfirmApiError
    }
    throw new Error('expected a refusal')
  }

  it('RS-ERR: reason / status kept when token-shaped, dropped when value-shaped', async () => {
    const lease = await exportError({ reason: 'lease_in_flight', status: 'not_governed', partial: false })
    expect(lease).toBeInstanceOf(StockPreparationConfirmApiError)
    expect(lease.code).toBe('STOCK_PREP_EXPORT_BLOCKED')
    expect(lease.reason).toBe('lease_in_flight')
    expect(lease.refreshStatus).toBe('not_governed')
    const valued = await exportError({ reason: SYN_PROJECT, status: 'Status With Spaces' })
    expect(valued.reason).toBeNull()
    expect(valued.refreshStatus).toBeNull()
    expect(JSON.stringify({ ...valued, message: valued.message })).not.toContain(SYN_PROJECT)
  })
})

// ---------------------------------------------------------------------------
// PS — projectSync (W4)
// ---------------------------------------------------------------------------

function syncApi(overrides: Partial<StockPreparationProjectSyncApi> = {}): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn().mockResolvedValue({ status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 1, update: 0, skip: 2, inactive: 0, manual_confirm: 0 } }),
    reconcile: vi.fn().mockResolvedValue({ counts: { pending: 0 } }),
    apply: vi.fn().mockResolvedValue({ status: 'succeeded', apply: { counts: { created: 1, updated: 0, inactive: 0, skipped: 2, held: 0, failed: 0 } } }),
    archive: vi.fn().mockResolvedValue({ status: 'created', persisted: true, created: { batch: 1, lines: 3, run: 1 } }),
    ...overrides,
  } as StockPreparationProjectSyncApi
}

const SUSPENDED_PLAN = {
  status: 'suspended',
  canApply: false,
  dryRunToken: null,
  counts: { add: 0, update: 0, skip: 4, inactive: 0, manual_confirm: 1 },
  refreshHold: { held: true, holdCount: 2, confirmableCount: 1, kinds: { syn_kind_sentinel: 2 }, holdSetFingerprint: 'f'.repeat(64) },
}

function callError(status: number, code: string, details: { reason?: string; partial?: boolean; holdCount?: number } = {}): StockPreparationProjectSyncCallError {
  return new StockPreparationProjectSyncCallError(status, 'route', { code, detailReason: details.reason ?? null, detailPartial: details.partial, detailHoldCount: details.holdCount })
}

describe('PS — projectSync learns the batch refresh (W4)', () => {
  it('PS-SUS-1: suspended ⇒ ① OK with counts, ② deferred, ③ skip (never apply), ④ not attempted, verdict suspended', async () => {
    const api = syncApi({ dryRun: vi.fn().mockResolvedValue(SUSPENDED_PLAN) })
    const report = await runStockPreparationProjectSync(api, SYN_PROJECT)
    expect(report.steps.map((step) => [step.id, step.status, step.reason])).toEqual([
      ['dry-run', 'ok', 'PLAN_SUSPENDED'],
      ['confirm-queue', 'skip', 'RECONCILE_DEFERRED_SUSPENDED'],
      ['apply', 'skip', 'WRITE_PULL_SUSPENDED'],
      ['archive', 'skip', 'BATCH_ARCHIVE_NOT_ATTEMPTED'],
    ])
    expect(report.steps[0].detail).toMatchObject({ planStatus: 'suspended', holdCount: 2, confirmableCount: 1 })
    expect(report.verdict).toBe('suspended')
    expect(report.pass).toBe(true)
    expect(report.refresh).toEqual({ holdCount: 2, confirmableCount: 1, openExecutions: null })
    expect(api.reconcile).not.toHaveBeenCalled()
    expect(api.apply).not.toHaveBeenCalled()
    expect(api.archive).not.toHaveBeenCalled()
    // Values-free: the kinds map never reaches a step or the report.
    expect(JSON.stringify(report)).not.toContain('syn_kind_sentinel')
    expect(stockPrepSyncVerdictPlain('suspended')?.zh).toContain('挂起')
  })

  it('PS-REC-1: recovery_pending ⇒ ① FAIL PLAN_RECOVERY_PENDING with openExecutions, verdict awaiting_recovery, not the source sentence', async () => {
    const api = syncApi({ dryRun: vi.fn().mockResolvedValue({ status: 'recovery_pending', canApply: false, dryRunToken: null, counts: {}, refreshRecovery: { pending: true, openExecutions: 1 } }) })
    const report = await runStockPreparationProjectSync(api, SYN_PROJECT)
    expect(report.steps).toHaveLength(1)
    expect(report.steps[0]).toMatchObject({ id: 'dry-run', status: 'fail', reason: 'PLAN_RECOVERY_PENDING' })
    expect(report.steps[0].detail.openExecutions).toBe(1)
    expect(report.verdict).toBe('awaiting_recovery')
    const plain = stockPrepSyncReasonPlain('PLAN_RECOVERY_PENDING')
    expect(`${plain?.zh}${plain?.zhNext}`).toContain('平台管理员')
    expect(`${plain?.zh}${plain?.zhNext}`).not.toContain('源数据里有拦路的问题')
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('PS-SM-1: 409 STATE_MOVED ⇒ PLAN_STATE_MOVED with the reason kept — never 「没能连上取数」', async () => {
    const api = syncApi({ dryRun: vi.fn().mockRejectedValue(callError(409, 'STOCK_PREP_PULL_STATE_MOVED', { reason: 'execution_finished_during_preview' })) })
    const report = await runStockPreparationProjectSync(api, SYN_PROJECT)
    expect(report.steps[0]).toMatchObject({ status: 'fail', reason: 'PLAN_STATE_MOVED' })
    expect(report.steps[0].detail).toEqual({ status: 409, code: 'STOCK_PREP_PULL_STATE_MOVED', reason: 'execution_finished_during_preview' })
    const plain = stockPrepSyncReasonPlain('PLAN_STATE_MOVED')
    expect(`${plain?.zh}${plain?.zhNext}`).toContain('重新试算')
    expect(`${plain?.zh}${plain?.zhNext}`).not.toContain('没能连上')
  })

  it('PS-SF-1 / PS-RT-1: 503 STORE_FAILED ⇒ PLAN_REFRESH_STORE_UNAVAILABLE; 409 RETARGETED ⇒ PLAN_REFRESH_SCOPE_CHANGED', () => {
    expect(classifyPlanStep(1, null, { status: 503, errorCode: 'STOCK_PREP_REFRESH_STORE_FAILED' }).reason).toBe('PLAN_REFRESH_STORE_UNAVAILABLE')
    expect(classifyPlanStep(1, null, { status: 409, errorCode: 'STOCK_PREP_REFRESH_TARGET_RETARGETED' }).reason).toBe('PLAN_REFRESH_SCOPE_CHANGED')
    expect(classifyPlanStep(1, null, { status: 409, errorCode: 'STOCK_PREP_REFRESH_TENANT_MISMATCH' }).reason).toBe('PLAN_REFRESH_SCOPE_CHANGED')
    // An unrelated 503 stays the transient bucket.
    expect(classifyPlanStep(1, null, { status: 503, errorCode: 'SOURCE_UNAVAILABLE' }).reason).toBe('PLAN_READ_FAILED')
  })

  it('PS-AP-1..5: the apply refusals — suspended is a SKIP, the rest name their next step; unknown stays WRITE_FAILED', async () => {
    const run = (error: StockPreparationProjectSyncCallError) => runStockPreparationProjectSync(syncApi({ apply: vi.fn().mockRejectedValue(error) }), SYN_PROJECT)
    const suspended = await run(callError(409, 'STOCK_PREP_PULL_SUSPENDED', { partial: false, holdCount: 3 }))
    const write = suspended.steps.find((step) => step.id === 'apply')!
    expect(write).toMatchObject({ status: 'skip', reason: 'WRITE_PULL_SUSPENDED' })
    expect(write.detail).toMatchObject({ holdCount: 3, partial: 0 })
    expect(suspended.verdict).toBe('suspended')
    expect(suspended.steps.find((step) => step.id === 'archive')?.reason).toBe('BATCH_ARCHIVE_NOT_ATTEMPTED')
    expect((await run(callError(409, 'STOCK_PREP_REFRESH_BINDING_STALE', { reason: 'continuations' }))).steps.find((step) => step.id === 'apply')).toMatchObject({ status: 'fail', reason: 'WRITE_BINDING_STALE' })
    expect((await run(callError(409, 'STOCK_PREP_REFRESH_RECOVERY_PENDING'))).verdict).toBe('awaiting_recovery')
    const stored = await run(callError(503, 'STOCK_PREP_REFRESH_STORE_FAILED', { partial: true }))
    expect(stored.steps.find((step) => step.id === 'apply')).toMatchObject({ status: 'fail', reason: 'WRITE_REFRESH_STORE_UNAVAILABLE' })
    expect(stored.steps.find((step) => step.id === 'apply')?.detail.partial).toBe(1)
    expect((await run(callError(409, 'SOME_OTHER_REFUSAL'))).steps.find((step) => step.id === 'apply')?.reason).toBe('WRITE_FAILED')
    expect(classifyRefreshApplyFailure('STOCK_PREP_PROJECT_WRITE_LOCKED')).toBeNull()
  })

  it('PS-CHK-1..4: 「核对」 is ONE dry run — settled / changes_pending / suspended — and never reconcile / apply / archive', async () => {
    const clean = syncApi({ dryRun: vi.fn().mockResolvedValue({ status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 0, update: 0, skip: 5, inactive: 0, manual_confirm: 0 } }) })
    expect((await runStockPreparationSettlementCheck(clean, SYN_PROJECT)).outcome).toBe('settled')
    const changes = syncApi({ dryRun: vi.fn().mockResolvedValue({ status: 'ready', canApply: true, dryRunToken: 'tok_syn', counts: { add: 3, update: 0, skip: 5, inactive: 0, manual_confirm: 0 } }) })
    expect((await runStockPreparationSettlementCheck(changes, SYN_PROJECT)).outcome).toBe('changes_pending')
    const suspended = syncApi({ dryRun: vi.fn().mockResolvedValue(SUSPENDED_PLAN) })
    expect((await runStockPreparationSettlementCheck(suspended, SYN_PROJECT)).outcome).toBe('suspended')
    const failed = syncApi({ dryRun: vi.fn().mockRejectedValue(callError(503, 'STOCK_PREP_REFRESH_STORE_FAILED')) })
    expect(await runStockPreparationSettlementCheck(failed, SYN_PROJECT)).toMatchObject({ outcome: 'failed', reason: 'PLAN_REFRESH_STORE_UNAVAILABLE' })
    for (const api of [clean, changes, suspended, failed]) {
      expect(api.dryRun).toHaveBeenCalledTimes(1)
      expect(api.reconcile).not.toHaveBeenCalled()
      expect(api.apply).not.toHaveBeenCalled()
      expect(api.archive).not.toHaveBeenCalled()
    }
  })

  it('PS-COPY: every new projectSync reason has sync-panel copy with a second line', () => {
    for (const reason of [
      'PLAN_SUSPENDED', 'PLAN_RECOVERY_PENDING', 'PLAN_STATE_MOVED', 'PLAN_REFRESH_STORE_UNAVAILABLE', 'PLAN_REFRESH_SCOPE_CHANGED',
      'RECONCILE_DEFERRED_SUSPENDED', 'WRITE_PULL_SUSPENDED', 'WRITE_BINDING_STALE', 'WRITE_RECOVERY_PENDING', 'WRITE_STATE_MOVED',
      'WRITE_REFRESH_STORE_UNAVAILABLE', 'WRITE_REFRESH_SCOPE_CHANGED',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(STOCK_PREP_SYNC_REASON_PLAIN, reason), reason).toBe(true)
      expect(String(STOCK_PREP_SYNC_REASON_PLAIN[reason].zhNext ?? '').length, reason).toBeGreaterThan(0)
    }
    expect(stockPrepSyncVerdictPlain('awaiting_recovery')?.zhNext).toContain('平台管理员')
  })
})

// ---------------------------------------------------------------------------
// NS — the 下一步 bar's rule 3b (W5)
// ---------------------------------------------------------------------------

function nextStepInput(overrides: Partial<OperatorNextStepInput> = {}): OperatorNextStepInput {
  return {
    boardFound: true,
    pulledRowCount: 12,
    missingComponentsCount: 0,
    pendingDecisionCount: 0,
    justConfirmed: false,
    hasExported: false,
    isCurrentHandler: false,
    canPull: true,
    ...overrides,
  }
}

describe('NS — rule 3b: an unfinished batch refresh, puller vs floor', () => {
  it('NS-1: a puller gets the action; a floor operator the sentence that names the 拉取人员 and NO action', () => {
    const rows: Array<[string, string | null]> = [
      ['pending_confirmation', 'go-refresh-queue'],
      ['executed_pending_settlement', 'check'],
      ['confirmed_pending_execution', 'resync'],
      ['executing', null],
      ['failed_pending_recovery', null],
      ['change_pending_review', null],
      ['unreadable', null],
    ]
    for (const [status, pullerAction] of rows) {
      const puller = operatorNextStep(nextStepInput({ refreshStatus: status, refreshSettled: false, refreshPendingConfirmCount: 3, canOpenRefreshQueue: true }))
      expect(puller.action, `${status} puller`).toBe(pullerAction)
      expect(['refresh', 'check', 'resync'], status).toContain(puller.key)
      const floor = operatorNextStep(nextStepInput({ refreshStatus: status, refreshSettled: false, refreshPendingConfirmCount: 3, canOpenRefreshQueue: false, canPull: false }))
      expect(floor.action, `${status} floor`).toBeNull()
    }
    expect(operatorNextStep(nextStepInput({ refreshStatus: 'pending_confirmation', refreshPendingConfirmCount: 3, canOpenRefreshQueue: false, canPull: false })).zh).toContain('请联系拉取人员')
    expect(operatorNextStep(nextStepInput({ refreshStatus: 'complete', refreshSettled: false, canOpenRefreshQueue: true })).action).toBe('check')
  })

  it('NS-2: absent / not_governed / complete ∧ settled never fire rule 3b (dormancy)', () => {
    const base = operatorNextStep(nextStepInput())
    expect(operatorNextStep(nextStepInput({ refreshStatus: null }))).toEqual(base)
    expect(operatorNextStep(nextStepInput({ refreshStatus: 'not_governed', canOpenRefreshQueue: true }))).toEqual(base)
    expect(operatorNextStep(nextStepInput({ refreshStatus: 'complete', refreshSettled: true, canOpenRefreshQueue: true }))).toEqual(base)
  })

  it('NS-3: rule order — ledger pending (rule 3) wins over holds, with the LEDGER count', () => {
    const step = operatorNextStep(nextStepInput({ pendingDecisionCount: 2, refreshStatus: 'pending_confirmation', refreshPendingConfirmCount: 3, canOpenRefreshQueue: true }))
    expect(step.key).toBe('pending')
    expect(step.zh).toContain('2 件')
  })

  it('NS-4: the posture never says 「可以导出」 for complete ∧ NOT settled (#6566 review N5)', () => {
    expect(stockPrepPosture({ pulledRowCount: 5, refreshStatus: 'complete', refreshSettled: false }).key).toBe('blocked_pull_state')
    expect(stockPrepPosture({ pulledRowCount: 5, refreshStatus: 'complete', refreshSettled: true }).key).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// OH — home memory and the card fold (W5)
// ---------------------------------------------------------------------------

describe('OH — 今天要处理 keeps 刷新未完成', () => {
  const MEMORY_SCOPE = { tenantId: 'tenant-syn' }

  beforeEach(() => clearStockPrepOperatorHomeMemory())
  afterEach(() => clearStockPrepOperatorHomeMemory())

  function registryRow(overrides: Partial<StockPreparationOperatorProject> = {}): StockPreparationOperatorProject {
    return {
      projectId: null,
      projectNo: SYN_PROJECT,
      projectName: null,
      projectStatus: 'active',
      lastSyncRunId: null,
      snapshotBatchCount: 0,
      openExceptionCount: 0,
      heldLineCount: 0,
      readyLineCount: 0,
      pendingDecisionCount: 0,
      archived: false,
      pulledRowCount: 12,
      missingComponentsCount: 0,
      ...overrides,
    } as StockPreparationOperatorProject
  }

  it('OH-MEM: a remembered blocked_pull_state survives the read (#6566 review N9)', () => {
    recordStockPrepProjectVisit(SYN_PROJECT, 'blocked_pull_state', MEMORY_SCOPE)
    const recent = readStockPrepRecentProjects(MEMORY_SCOPE)
    expect(recent.map((entry) => [entry.projectNo, entry.postureKey])).toEqual([[SYN_PROJECT, 'blocked_pull_state']])
    const cards = buildOperatorHomeCards([], recent)
    expect(cards[0].posture.key).toBe('blocked_pull_state')
  })

  it('OH-FOLD: registry 「可以导出」 + remembered blocked ⇒ 刷新未完成; remembered ready ⇒ 可以导出', () => {
    const blocked = buildOperatorHomeCards([registryRow()], [{ projectNo: SYN_PROJECT, updatedAt: ISO_NEW, postureKey: 'blocked_pull_state' }])
    expect(blocked[0].posture.key).toBe('blocked_pull_state')
    expect(blocked[0].postureFromMemory).toBe(true)
    const ready = buildOperatorHomeCards([registryRow()], [{ projectNo: SYN_PROJECT, updatedAt: ISO_NEW, postureKey: 'ready' }])
    expect(ready[0].posture.key).toBe('ready')
    const none = buildOperatorHomeCards([registryRow()], [])
    expect(none[0].posture.key).toBe('ready')
    // A live pending count still decides on its own.
    const live = buildOperatorHomeCards([registryRow({ pendingDecisionCount: 2 })], [{ projectNo: SYN_PROJECT, updatedAt: ISO_NEW, postureKey: 'blocked_pull_state' }])
    expect(live[0].posture.key).toBe('pending_decision')
  })
})
