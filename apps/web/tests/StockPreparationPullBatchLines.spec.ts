import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 批次标识 BI-3 (design §11, §5.5; register R-65, rulings C2 / C6 / C10) — the PURE half of the web's pull-batch lines.
//
//   PBL-PARSE    the board stanza: absent / { enabled: false } / non-object ⇒ null (C6); every paused token ⇒ its state;
//                malformed numbers clamped; a present-but-malformed latest ⇒ unknown (critic C-9); a rule outside the two
//                tokens ⇒ null; gapRows only with history_gap.
//   PBL-PREVIEW  every §1.3 shape; { preview: false } ⇒ null.
//   PBL-OUTCOME  every §1.4 shape; { stamped: true } without a label ⇒ null.
//   PBL-COPY     the exact §4 strings, zh and en; rule A ⇒ the two §5.5 sentences; rule F ⇒ its sentence + 本次拉取 + the
//                C10 line and NOT rule A's; rule null ⇒ only 本次拉取; 「共 K 批」 only when K equals the latest batch number
//                (critic C-7); the large lane never says 并入 (critic C-3); the run-stop sentence (critic C-5).
//   PBL-XSIDE    the web lists against the plugin's, read LIVE (the RS-COPY nodeRequire precedent): paused deep-equal;
//                reasons set-equal RESPONSE ∪ PREVIEW; rules equal PULL_BATCH_CONFIG_VALUES.firstPullBatchRule; the C10
//                line shares its phrase with PULL_BATCH_SETTINGS_HELP. status.cjs / lanes.cjs load only node:crypto and
//                plain lib modules, so they are required directly (critic C-8).
//   PBL-MIRROR   the REAL server builders (readPullBatchBoardStanza with fakes, previewStanzaOf, largeChunkAnswerOf) fed
//                through the web parsers — a key rename (latest, gapRows, createdRowCount) turns this red.
//   PBL-VALUES   pullBatch.ts carries no field / sheet id and interpolates no project number.
// Synthetic only: labels 第2批（2026-11-08）, sheet_syn_*, fld_syn_*.

import {
  STOCK_PREP_PULL_BATCH_BOARD_PAUSED,
  STOCK_PREP_PULL_BATCH_MEANING_MATERIAL,
  STOCK_PREP_PULL_BATCH_MEANING_POSITION,
  STOCK_PREP_PULL_BATCH_MEANING_POSITION_CAVEAT,
  STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL,
  STOCK_PREP_PULL_BATCH_REASONS,
  STOCK_PREP_PULL_BATCH_RULES,
  parseStockPrepPullBatchBoardStanza,
  parseStockPrepPullBatchOutcome,
  parseStockPrepPullBatchPreview,
  stockPrepPullBatchBoardLine,
  stockPrepPullBatchMeaning,
  stockPrepPullBatchOutcomeLine,
  stockPrepPullBatchPreviewLine,
  stockPrepPullBatchStepPlain,
  type StockPrepPullBatchBoard,
} from '../src/services/integration/stockPreparation/pullBatch'
import { STOCK_PREP_ERROR_PLAIN } from '../src/services/integration/stockPreparation/plainLanguage'

const nodeRequire = createRequire(import.meta.url)
const PLUGIN_LIB = '../../../plugins/plugin-integration-core/lib/'
const pure = nodeRequire(`${PLUGIN_LIB}stock-preparation-pull-batch.cjs`) as {
  PULL_BATCH_RESPONSE_REASONS: readonly string[]
  PULL_BATCH_CONFIG_VALUES: { firstPullBatchRule: readonly string[] }
  PULL_BATCH_SETTINGS_HELP: { firstPullBatchRule: { predecessor_suffix: Record<string, string> } }
  EXISTING_ROW_PULL_BATCH: symbol
}
const status = nodeRequire(`${PLUGIN_LIB}stock-preparation-pull-batch-status.cjs`) as {
  PULL_BATCH_BOARD_PAUSED_REASONS: readonly string[]
  readPullBatchBoardStanza: (deps: Record<string, unknown>) => Promise<unknown>
}
const lanes = nodeRequire(`${PLUGIN_LIB}stock-preparation-pull-batch-lanes.cjs`) as {
  PULL_BATCH_PREVIEW_REASONS: readonly string[]
  largeChunkAnswerOf: (lane: unknown, job: unknown) => unknown
  __internals: { previewStanzaOf: (evaluation: unknown) => unknown }
}
const templates = nodeRequire(`${PLUGIN_LIB}stock-preparation-templates.cjs`) as {
  pullBatchBandProperty: (locale: string) => unknown
}

const LABEL = '第2批（2026-11-08）'

function board(overrides: Record<string, unknown> = {}): StockPrepPullBatchBoard {
  const parsed = parseStockPrepPullBatchBoardStanza({
    enabled: true, ready: true, latest: { label: LABEL, batchNo: 2 }, batchCount: 2, paused: null, firstPullBatchRule: 'material', ...overrides,
  })
  if (!parsed) throw new Error('fixture did not parse')
  return parsed
}

describe('PBL-PARSE — the board stanza', () => {
  it('absent, { enabled: false }, enabled not exactly true and a non-object are null (C6)', () => {
    for (const value of [undefined, null, { enabled: false }, { enabled: 'true', ready: true, paused: null }, 'true', 1, [], [{ enabled: true }]]) {
      expect(parseStockPrepPullBatchBoardStanza(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('every paused token maps to its state; an unknown token, or ready:false with paused:null, is unknown', () => {
    const expected: Record<string, string> = {
      not_installed: 'not_installed',
      columns_unproven: 'unknown',
      columns_partial: 'partial',
      history_pending: 'pending',
      installing: 'installing',
      ledger_unreadable: 'unknown',
      history_gap: 'gap',
    }
    expect(Object.keys(expected).sort()).toEqual([...STOCK_PREP_PULL_BATCH_BOARD_PAUSED].sort())
    for (const paused of STOCK_PREP_PULL_BATCH_BOARD_PAUSED) {
      expect(board({ ready: false, paused }).state, paused).toBe(expected[paused])
    }
    expect(board({ ready: false, paused: 'some_future_pause' }).state).toBe('unknown')
    expect(board({ ready: false, paused: null }).state).toBe('unknown')
    expect(board().state).toBe('ready')
  })

  it('numbers are clamped; a present-but-malformed latest is unknown (critic C-9); the label is kept verbatim', () => {
    expect(board().latest).toEqual({ label: LABEL, batchNo: 2 })
    expect(board({ latest: { label: '第3批（推定，2026-11-01）', batchNo: 3 }, batchCount: 3 }).latest?.label).toBe('第3批（推定，2026-11-01）')
    for (const latest of [{ label: '', batchNo: 2 }, { label: LABEL }, { label: LABEL, batchNo: -1 }, { label: LABEL, batchNo: 1.5 }, { label: 'x'.repeat(65), batchNo: 2 }, 'x', []]) {
      const parsed = board({ latest })
      expect(parsed.state, JSON.stringify(latest)).toBe('unknown')
      expect(parsed.latest).toBeNull()
    }
    // Even beside a zero count, a malformed latest never reads as 「还没有拉取批次」.
    expect(board({ latest: { label: LABEL, batchNo: 'two' }, batchCount: 0 }).state).toBe('unknown')
    expect(board({ latest: { label: 'x'.repeat(64), batchNo: 2 } }).latest?.label).toHaveLength(64)
    for (const batchCount of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) expect(board({ batchCount }).batchCount).toBeNull()
    // A ready sheet with no latest batch says 「还没有拉取批次」 only when it also says zero batches.
    expect(board({ latest: null, batchCount: 0 }).state).toBe('ready')
    expect(board({ latest: null, batchCount: null }).state).toBe('unknown')
    expect(board({ latest: null, batchCount: 3 }).state).toBe('unknown')
  })

  it('the rule is one of the two tokens or null; gapRows is read only with history_gap', () => {
    expect(board({ firstPullBatchRule: 'predecessor_suffix' }).rule).toBe('predecessor_suffix')
    for (const rule of [undefined, null, 'off', 'MATERIAL', 'position', 1]) expect(board({ firstPullBatchRule: rule }).rule).toBeNull()
    expect(board({ ready: false, paused: 'history_gap', gapRows: 3 }).gapRows).toBe(3)
    expect(board({ ready: false, paused: 'history_gap', gapRows: -3 }).gapRows).toBeNull()
    expect(board({ ready: false, paused: 'history_pending', gapRows: 3 }).gapRows).toBeNull()
    expect(board({ gapRows: 3 }).gapRows).toBeNull()
  })
})

describe('PBL-PREVIEW / PBL-OUTCOME — the run answers', () => {
  it('previews: would stamp, every reason, gapRows only with history_gap, an unknown reason is other; not a preview is null', () => {
    expect(parseStockPrepPullBatchPreview({ preview: true, wouldStamp: true, reason: null })).toEqual({ wouldStamp: true, reason: null, gapRows: null })
    for (const reason of lanes.PULL_BATCH_PREVIEW_REASONS) {
      expect(parseStockPrepPullBatchPreview({ preview: true, wouldStamp: false, reason, gapRows: 2 })).toEqual({ wouldStamp: false, reason, gapRows: reason === 'history_gap' ? 2 : null })
    }
    expect(parseStockPrepPullBatchPreview({ preview: true, wouldStamp: false, reason: 'some_future_reason' })?.reason).toBe('other')
    for (const value of [undefined, null, { preview: false, wouldStamp: true }, { wouldStamp: true }, 'preview', []]) {
      expect(parseStockPrepPullBatchPreview(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('outcomes: stamped, joined, no_creates, disabled, unstamped with a reason; malformed is null', () => {
    expect(parseStockPrepPullBatchOutcome({ stamped: true, label: LABEL, batchNo: 2, joined: false, createdRowCount: 3 }))
      .toEqual({ kind: 'stamped', label: LABEL, batchNo: 2, joined: false, createdRowCount: 3 })
    expect(parseStockPrepPullBatchOutcome({ stamped: true, label: LABEL, batchNo: 2, joined: true, createdRowCount: 0 }))
      .toEqual({ kind: 'stamped', label: LABEL, batchNo: 2, joined: true, createdRowCount: 0 })
    expect(parseStockPrepPullBatchOutcome({ stamped: false, reason: 'no_creates' })).toEqual({ kind: 'no_creates' })
    expect(parseStockPrepPullBatchOutcome({ stamped: false, reason: 'disabled' })).toEqual({ kind: 'disabled' })
    expect(parseStockPrepPullBatchOutcome({ stamped: false, reason: 'history_gap', gapRows: 5 })).toEqual({ kind: 'unstamped', reason: 'history_gap', gapRows: 5 })
    expect(parseStockPrepPullBatchOutcome({ stamped: false, reason: 'columns_partial', gapRows: 5 })).toEqual({ kind: 'unstamped', reason: 'columns_partial', gapRows: null })
    expect(parseStockPrepPullBatchOutcome({ stamped: false, reason: 'some_future_reason' })).toEqual({ kind: 'unstamped', reason: 'other', gapRows: null })
    for (const value of [
      undefined, null, {}, { stamped: true }, { stamped: true, label: LABEL, batchNo: 2 }, { stamped: true, label: '', batchNo: 2, createdRowCount: 1 },
      { stamped: true, label: LABEL, batchNo: 0, createdRowCount: 1 }, { stamped: 'true', label: LABEL, batchNo: 2, createdRowCount: 1 }, [],
    ]) {
      expect(parseStockPrepPullBatchOutcome(value), JSON.stringify(value)).toBeNull()
    }
  })
})

describe('PBL-COPY — the customer sentences (zh and en)', () => {
  it('§4.1 the board line, per state', () => {
    expect(stockPrepPullBatchBoardLine(board())).toEqual({ zh: `最近拉取批次：${LABEL} · 共 2 批`, en: `Latest pull batch: ${LABEL} · 2 in all` })
    expect(stockPrepPullBatchBoardLine(board({ batchCount: null }))).toEqual({ zh: `最近拉取批次：${LABEL}`, en: `Latest pull batch: ${LABEL}` })
    // Critic C-7: an unknown-history sheet's first live batch is 第6批 while the ledger holds one row — never 「共 1 批」.
    const undercount = stockPrepPullBatchBoardLine(board({ latest: { label: '第6批（2026-11-08）', batchNo: 6 }, batchCount: 1 }))
    expect(undercount.zh).toBe('最近拉取批次：第6批（2026-11-08）')
    expect(undercount.en).toBe('Latest pull batch: 第6批（2026-11-08）')
    // Labels verbatim (critic: never recomposed from batchNo) — an inferred label keeps its 推定 marker.
    expect(stockPrepPullBatchBoardLine(board({ latest: { label: '第2批（推定，2026-10-01）', batchNo: 2 } })).zh).toBe('最近拉取批次：第2批（推定，2026-10-01） · 共 2 批')
    expect(stockPrepPullBatchBoardLine(board({ latest: null, batchCount: 0 }))).toEqual({
      zh: '批次标识已启用，还没有拉取批次；下一次有新增物料的拉取会记为一个新批次。',
      en: 'Pull batches are on; no batch yet. The next pull that adds materials becomes a new batch.',
    })
    expect(stockPrepPullBatchBoardLine(board({ ready: false, paused: 'not_installed' }))).toEqual({
      zh: '批次标识：未启用',
      en: 'Pull batches: not enabled',
      zhNext: '这张表还没有安装批次列；如需使用，请联系备料主管理员。',
      enNext: 'This sheet has no batch columns yet; ask the stock-prep admin if you need them.',
    })
    expect(stockPrepPullBatchBoardLine(board({ ready: false, paused: 'installing' }))).toMatchObject({
      zh: '批次标识安装中，暂停拉取',
      zhNext: '安装完成后即可拉取；如果长时间未完成，请联系备料主管理员。',
    })
    expect(stockPrepPullBatchBoardLine(board({ ready: false, paused: 'history_gap', gapRows: 7 }))).toMatchObject({
      zh: '批次标识暂停：有 7 行未登记批次，请联系管理员补登记',
      en: 'Pull batches paused: 7 rows have no batch recorded; ask the administrator to backfill them',
      zhNext: '补登记之前，拉取照常进行，但新增的行不记批次。',
    })
    expect(stockPrepPullBatchBoardLine(board({ ready: false, paused: 'history_gap' })).zh).toBe('批次标识暂停：有未登记批次的行，请联系管理员补登记')
    expect(stockPrepPullBatchBoardLine(board({ ready: false, paused: 'history_pending' }))).toMatchObject({
      zh: '批次标识尚未就绪：历史批次还没有登记完成',
      zhNext: '在此之前，拉取照常进行，但新增的行不记批次；请联系备料主管理员完成安装。',
    })
    expect(stockPrepPullBatchBoardLine(board({ ready: false, paused: 'columns_partial' }))).toMatchObject({
      zh: '批次标识异常：批次列不完整',
      zhNext: '拉取暂不记批次；请联系备料主管理员检查。',
    })
    for (const paused of ['columns_unproven', 'ledger_unreadable', 'some_future_pause']) {
      expect(stockPrepPullBatchBoardLine(board({ ready: false, paused }))).toMatchObject({
        zh: '批次标识状态暂时读不到',
        en: 'The pull-batch status cannot be read right now',
        zhNext: '请稍后刷新本页；如果一直如此，请联系管理员。',
      })
    }
  })

  it('§4.2 / §5.5 the meaning copy follows the captured rule; rule null never defaults to rule A', () => {
    expect(STOCK_PREP_PULL_BATCH_MEANING_MATERIAL.zh).toBe('首次批次：这个物料在本项目第几批拉取时第一次出现；不表示这一行已经备过料。')
    expect(STOCK_PREP_PULL_BATCH_MEANING_POSITION.zh).toBe('首次批次：这一位置的需求在本项目第几批拉取时第一次出现；不表示这一行已经备过料。')
    expect(STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL.zh).toBe('本次拉取：这一行是在第几批拉取时建立的。')
    expect(STOCK_PREP_PULL_BATCH_MEANING_POSITION_CAVEAT.zh).toBe('按位置判定时，带「推定」的首次批次是按今天的「有效」状态推算的，可能与当时实时拉取会写入的不同。')
    for (const state of ['ready', 'gap', 'installing', 'pending'] as const) {
      expect(stockPrepPullBatchMeaning('material', state)).toEqual([STOCK_PREP_PULL_BATCH_MEANING_MATERIAL, STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL])
      const ruleF = stockPrepPullBatchMeaning('predecessor_suffix', state)
      expect(ruleF).toEqual([STOCK_PREP_PULL_BATCH_MEANING_POSITION, STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL, STOCK_PREP_PULL_BATCH_MEANING_POSITION_CAVEAT])
      expect(ruleF).not.toContain(STOCK_PREP_PULL_BATCH_MEANING_MATERIAL)
      expect(stockPrepPullBatchMeaning(null, state)).toEqual([STOCK_PREP_PULL_BATCH_MEANING_THIS_PULL])
    }
    for (const state of ['not_installed', 'partial', 'unknown'] as const) {
      for (const rule of ['material', 'predecessor_suffix', null] as const) expect(stockPrepPullBatchMeaning(rule, state)).toEqual([])
    }
  })

  it('§4.3 / §4.5 the after-apply line; not_installed / disabled / absent say nothing; the large lane never says 并入', () => {
    const stamped = parseStockPrepPullBatchOutcome({ stamped: true, label: LABEL, batchNo: 2, joined: false, createdRowCount: 3 })
    const joined = parseStockPrepPullBatchOutcome({ stamped: true, label: LABEL, batchNo: 2, joined: true, createdRowCount: 3 })
    expect(stockPrepPullBatchOutcomeLine(stamped)).toEqual({ zh: `本次新增 3 行，记为 ${LABEL}`, en: `3 rows added this time, recorded as ${LABEL}` })
    expect(stockPrepPullBatchOutcomeLine(joined)).toEqual({
      zh: `本次新增 3 行，并入 ${LABEL}（同一次拉取的重试）`,
      en: `3 rows added this time, joined to ${LABEL} (a retry of the same pull)`,
    })
    expect(stockPrepPullBatchOutcomeLine(joined, { lane: 'large' })).toEqual(stockPrepPullBatchOutcomeLine(stamped))
    expect(stockPrepPullBatchOutcomeLine(parseStockPrepPullBatchOutcome({ stamped: false, reason: 'no_creates' }))).toEqual({
      zh: '本次没有新增物料，不产生新的拉取批次',
      en: 'No materials were added this time, so no new pull batch was created',
    })
    const fragments: Record<string, [string, string]> = {
      columns_unproven: ['暂时无法确认批次列是否存在', 'the batch columns could not be confirmed'],
      columns_partial: ['批次列不完整', 'the batch columns are incomplete'],
      history_pending: ['历史批次还没有登记完成', 'the batch history is not recorded yet'],
      history_gap: ['有未登记批次的行，需要管理员补登记', 'some rows have no batch recorded and need a backfill'],
      installing: ['批次列正在安装', 'the batch columns are being installed'],
      ledger_unreadable: ['批次记录暂时读不到', 'the batch record cannot be read right now'],
      some_future_reason: ['其他原因', 'another reason'],
    }
    for (const [reason, [zh, en]] of Object.entries(fragments)) {
      expect(stockPrepPullBatchOutcomeLine(parseStockPrepPullBatchOutcome({ stamped: false, reason })), reason).toEqual({
        zh: `本次未标记批次：${zh}`,
        en: `No batch was recorded this time: ${en}`,
      })
    }
    expect(stockPrepPullBatchOutcomeLine(parseStockPrepPullBatchOutcome({ stamped: false, reason: 'history_gap', gapRows: 4 }))?.zh).toBe('本次未标记批次：有 4 行未登记批次，需要管理员补登记')
    for (const value of [{ stamped: false, reason: 'not_installed' }, { stamped: false, reason: 'disabled' }, undefined, { stamped: true }]) {
      expect(stockPrepPullBatchOutcomeLine(parseStockPrepPullBatchOutcome(value)), JSON.stringify(value)).toBeNull()
    }
  })

  it('§4.4 the create path write prompt; installing and ledger_unreadable say the write is refused (critic C-4)', () => {
    const preview = (value: Record<string, unknown>) => parseStockPrepPullBatchPreview({ preview: true, ...value })
    expect(stockPrepPullBatchPreviewLine(preview({ wouldStamp: true, reason: null }), 5)).toEqual({ zh: '将新增 5 行（记入新的拉取批次）', en: '5 rows will be added (recorded as a new pull batch)' })
    expect(stockPrepPullBatchPreviewLine(preview({ wouldStamp: false, reason: 'installing' }), 5)?.zh).toBe('将新增 5 行；但这张表正在安装批次列，现在写入会被拒绝，请等安装完成。')
    expect(stockPrepPullBatchPreviewLine(preview({ wouldStamp: false, reason: 'ledger_unreadable' }), 5)).toEqual({
      zh: '将新增 5 行；但批次记录暂时读不到，现在写入会被拒绝，请稍后再试。',
      en: '5 rows would be added, but the batch record cannot be read right now; a write now is refused, so try again shortly.',
    })
    expect(stockPrepPullBatchPreviewLine(preview({ wouldStamp: false, reason: 'history_pending' }), 5)).toEqual({
      zh: '将新增 5 行（这次不记批次：历史批次还没有登记完成）',
      en: '5 rows will be added (no batch this time: the batch history is not recorded yet)',
    })
    for (const [value, add] of [[{ wouldStamp: true, reason: null }, 0], [{ wouldStamp: false, reason: 'not_installed' }, 5], [{ wouldStamp: true, reason: null }, -1]] as const) {
      expect(stockPrepPullBatchPreviewLine(preview(value), add)).toBeNull()
    }
    expect(stockPrepPullBatchPreviewLine(null, 5)).toBeNull()
  })

  it('critic C-5: step ③ of a pull-batch refusal / run stop; partial 1 or unreported never says nothing was written', () => {
    const step = (detail: Record<string, string | number>) => ({ id: 'apply', status: 'fail', reason: 'WRITE_FAILED', detail })
    expect(stockPrepPullBatchStepPlain(step({ code: 'STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS', partial: 0 }))).toEqual(STOCK_PREP_ERROR_PLAIN.STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS)
    expect(stockPrepPullBatchStepPlain(step({ code: 'STOCK_PREP_PULL_BATCH_CONFLICT', reason: 'settings_changed', partial: 0 }))?.zh).toBe('这张表的「首次批次」规则刚被修改,这次拉取停了下来。')
    for (const partial of [1, undefined]) {
      const detail: Record<string, string | number> = { code: 'STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS', ...(partial === undefined ? {} : { partial }) }
      const plain = stockPrepPullBatchStepPlain(step(detail))
      expect(plain?.zh).not.toContain('没有写入')
      expect(plain?.zh).not.toContain('数据没有变化')
      expect(plain?.zhNext).toBe(STOCK_PREP_ERROR_PLAIN.STOCK_PREP_PULL_BATCH_INSTALL_IN_PROGRESS.zhNext)
    }
    expect(stockPrepPullBatchStepPlain(step({ code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED', partial: 1 }))?.zh).toContain('可能已写进一部分行')
    for (const other of [
      step({ code: 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', partial: 1 }),
      { id: 'apply', status: 'fail', reason: 'WRITE_INTERRUPTED', detail: { code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED' } },
      { id: 'dry-run', status: 'fail', reason: 'WRITE_FAILED', detail: { code: 'STOCK_PREP_PULL_BATCH_STORE_FAILED' } },
      step({}),
      null,
    ]) {
      expect(stockPrepPullBatchStepPlain(other), JSON.stringify(other)).toBeNull()
    }
  })
})

describe('PBL-XSIDE — the web lists equal the plugin lists (read live)', () => {
  it('paused deep-equals PULL_BATCH_BOARD_PAUSED_REASONS', () => {
    expect([...STOCK_PREP_PULL_BATCH_BOARD_PAUSED]).toEqual([...status.PULL_BATCH_BOARD_PAUSED_REASONS])
  })

  it('reasons set-equal PULL_BATCH_RESPONSE_REASONS ∪ PULL_BATCH_PREVIEW_REASONS, and each has a fragment or a silent rule', () => {
    const server = new Set([...pure.PULL_BATCH_RESPONSE_REASONS, ...lanes.PULL_BATCH_PREVIEW_REASONS])
    expect([...STOCK_PREP_PULL_BATCH_REASONS].sort()).toEqual([...server].sort())
    for (const reason of server) {
      const outcome = parseStockPrepPullBatchOutcome({ stamped: false, reason })
      expect(outcome, reason).not.toBeNull()
      if (outcome && outcome.kind === 'unstamped') expect(outcome.reason, reason).toBe(reason)
    }
  })

  it('rules equal PULL_BATCH_CONFIG_VALUES.firstPullBatchRule; the C10 line shares the settings help phrase', () => {
    expect([...STOCK_PREP_PULL_BATCH_RULES]).toEqual([...pure.PULL_BATCH_CONFIG_VALUES.firstPullBatchRule])
    const help = pure.PULL_BATCH_SETTINGS_HELP.firstPullBatchRule.predecessor_suffix['zh-CN']
    const phrase = '今天的「有效」状态'
    expect(help).toContain(phrase)
    expect(STOCK_PREP_PULL_BATCH_MEANING_POSITION_CAVEAT.zh).toContain(phrase)
  })
})

describe('PBL-MIRROR — the real server builders through the web parsers', () => {
  const BAND = Object.freeze({ fieldIds: Object.freeze({ pullBatch: 'fld_syn_pb', firstPullBatch: 'fld_syn_fpb' }) })
  const key = (part: string) => JSON.stringify({ projectNo: 'SYN-S', componentSourceId: part, parentSourceId: null, path: [part] })
  function row(part: string, pullBatch: string): Record<string | symbol, unknown> {
    const out: Record<string | symbol, unknown> = { projectNo: 'SYN-S', idempotencyKey: key(part), componentSourceId: part, lastPlmRefreshDecision: 'add' }
    out[pure.EXISTING_ROW_PULL_BATCH] = Object.freeze({ pullBatch, firstPullBatch: pullBatch, createdAt: '2026-11-08T01:00:00.000Z', locked: false })
    return out
  }
  function deps({ rule = 'material', rows = [row('P1', LABEL)], batches = [{ batchNo: 2, status: 'closed', label: LABEL }, { batchNo: 1, status: 'closed', label: '第1批（2026-11-01）' }] } = {}) {
    const property = templates.pullBatchBandProperty('zh-CN')
    return {
      enabled: true,
      provisioning: {
        async resolveFieldIds({ fieldIds }: { fieldIds: string[] }) { return Object.fromEntries(fieldIds.map((id) => [id, id === 'pullBatch' ? BAND.fieldIds.pullBatch : BAND.fieldIds.firstPullBatch])) },
        async resolveExistingObjectFieldIds({ fieldIds }: { fieldIds: string[] }) { return Object.fromEntries(fieldIds.map((id) => [id, id === 'pullBatch' ? BAND.fieldIds.pullBatch : BAND.fieldIds.firstPullBatch])) },
        async getObjectField({ fieldId }: { fieldId: string }) { return { id: `fld_${fieldId}`, property: JSON.parse(JSON.stringify(property)) } },
        async findObjectView({ viewId }: { viewId: string }) { return { id: `view_${viewId}`, hiddenFieldIds: [] } },
      },
      projectId: 'syn_staging',
      objectId: 'obj_syn',
      tenantId: 'tenant-syn',
      sheetId: 'sheet_syn',
      projectNo: 'SYN-S',
      store: {
        async readSheetState() {
          return { sheet: { historyStatus: 'backfilled', historyMode: 'inferred', historyBatchCount: 1, firstPullBatchRule: rule, labelFormat: 'ordinal_date', labelLocale: 'zh-CN', bandPlacement: 'left' }, batches }
        },
      },
      recordsApi: {},
      target: { sheetId: 'sheet_syn', objectId: 'obj_syn' },
      readExistingStockPreparationRows: async () => rows,
      band: BAND,
    }
  }

  it('readPullBatchBoardStanza → parseStockPrepPullBatchBoardStanza: ready with the label, the count and the rule; a gap with its rows', async () => {
    const ready = parseStockPrepPullBatchBoardStanza(await status.readPullBatchBoardStanza(deps({ rule: 'predecessor_suffix' })))
    expect(ready).toEqual({ state: 'ready', latest: { label: LABEL, batchNo: 2 }, batchCount: 2, gapRows: null, rule: 'predecessor_suffix' })
    const gap = parseStockPrepPullBatchBoardStanza(await status.readPullBatchBoardStanza(deps({ rows: [row('P1', ''), row('P2', '')] })))
    expect(gap?.state).toBe('gap')
    expect(gap?.gapRows).toBe(2)
    const soft = parseStockPrepPullBatchBoardStanza(await status.readPullBatchBoardStanza({ ...deps(), store: { async readSheetState() { throw new Error('down') } } }))
    expect(soft).toEqual({ state: 'unknown', latest: null, batchCount: null, gapRows: null, rule: null })
  })

  it('previewStanzaOf and largeChunkAnswerOf → the web parsers', () => {
    expect(parseStockPrepPullBatchPreview(lanes.__internals.previewStanzaOf({ ready: true }))).toEqual({ wouldStamp: true, reason: null, gapRows: null })
    expect(parseStockPrepPullBatchPreview(lanes.__internals.previewStanzaOf({ ready: false, reason: 'history_gap', gapRows: 3 }))).toEqual({ wouldStamp: false, reason: 'history_gap', gapRows: 3 })
    const lane = { enabled: true }
    expect(parseStockPrepPullBatchOutcome(lanes.largeChunkAnswerOf(lane, { pullBatchRun: { allocated: true, batchNo: 2, label: LABEL, joined: true }, pullBatchStampedRowCount: 7 })))
      .toEqual({ kind: 'stamped', label: LABEL, batchNo: 2, joined: true, createdRowCount: 7 })
    expect(parseStockPrepPullBatchOutcome(lanes.largeChunkAnswerOf(lane, { pullBatchRun: { allocated: false, reason: 'no_creates' } }))).toEqual({ kind: 'no_creates' })
    expect(parseStockPrepPullBatchOutcome(lanes.largeChunkAnswerOf(lane, { pullBatchRun: { allocated: false, reason: 'history_gap', gapRows: 4 } })))
      .toEqual({ kind: 'unstamped', reason: 'history_gap', gapRows: 4 })
    expect(parseStockPrepPullBatchOutcome(lanes.largeChunkAnswerOf({ enabled: false }, { pullBatchRun: { allocated: true } }))).toBeNull()
  })
})

describe('PBL-VALUES — pullBatch.ts is values-free', () => {
  it('carries no field / sheet / view id literal and interpolates no project number', () => {
    const source = readFileSync(resolve(__dirname, '../src/services/integration/stockPreparation/pullBatch.ts'), 'utf8')
    expect(source).not.toMatch(/\bfld_[a-z0-9]/)
    expect(source).not.toMatch(/\bsheet_[a-z0-9]/)
    expect(source).not.toMatch(/\bview_[a-z0-9]/)
    expect(source).not.toMatch(/\$\{[^}]*projectNo/)
    expect(source).not.toMatch(/from '(\.\.\/)+.*plugins\//)
    expect(source).not.toMatch(/apiFetch|fetch\(/)
  })
})
