/**
 * T1 (tester report 20261008, item 1) — user-facing CSV header labels and status words for the
 * approval-center export (`GET /api/approvals?format=csv&header=label&lang=zh|en`).
 *
 * WHAT THIS PINS (the HTTP-level behaviour — 400s, defaults, the JSON list staying untouched — lives
 * in `approval-export-csv-route.test.ts`; real rows through the real route live in
 * `approval-export-csv.db.test.ts`):
 *   - the serializer `buildApprovalExportCsvLines` the route calls: header row + data rows in the
 *     three renderings (code / zh / en), against HAND-TYPED golden lines — never built by calling the
 *     function under test, because a mutation that guts the label table would change the output and a
 *     derived expectation together and stay green;
 *   - the column table itself: the 19 keys, their order and set unchanged, and a zh + en label on
 *     every one (non-empty, unique per language, en free of CJK, none able to be read as a formula or
 *     to need CSV quoting);
 *   - the status words, including the fail-safes (unknown status written as it is, no inherited-key
 *     lookup) and the cancel-round rows that keep the raw status on purpose;
 *   - that the label row goes through the CSV sanitizer (proved with hostile labels injected through
 *     the builder's `columns` parameter — the real labels are all benign, so they cannot show it);
 *   - that the two server-side vocabularies this change copies from the web package are still equal to
 *     their sources. `apps/web` cannot be imported from here (zero cross-package imports), so the web
 *     files are READ as text — the same shape `AuthService.test.ts` and
 *     `after-sales-object-sheet-liveness.test.ts` already use for another package's source.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_EXPORT_CSV_COLUMNS,
  APPROVAL_EXPORT_CSV_DEFAULT_OPTIONS,
  APPROVAL_EXPORT_STATUS_LABELS,
  approvalExportStatusDisplay,
  buildApprovalExportCsvLines,
  resolveApprovalExportCsvOptions,
  type ApprovalExportCsvColumn,
} from '../../src/routes/approvals'
import { neutralizeFormulaInjectionLead } from '../../src/services/csv-cell'
import type { UnifiedApprovalDTO } from '../../src/services/approval-bridge-types'

const CODE_KEYS = [
  'id',
  'sourceSystem',
  'externalApprovalId',
  'workflowKey',
  'businessKey',
  'requestNo',
  'title',
  'status',
  'requesterId',
  'requesterName',
  'subject',
  'currentStep',
  'totalSteps',
  'templateId',
  'templateVersionId',
  'currentNodeKey',
  'formSnapshot',
  'createdAt',
  'updatedAt',
]

const CODE_ROW = CODE_KEYS.join(',')
const ZH_ROW = '审批实例ID,来源系统,外部审批ID,流程标识,业务标识,审批编号,标题,状态,发起人ID,发起人,审批对象,当前步骤,总步骤数,审批表单ID,审批表单版本ID,当前节点标识,表单信息,发起时间（UTC）,更新时间（UTC）'
const EN_ROW = 'Instance ID,Source system,External approval ID,Workflow key,Business key,Request no.,Title,Status,Requester ID,Requester,Subject,Current step,Total steps,Form ID,Form version ID,Current node key,Form details,Submitted (UTC),Updated (UTC)'

function dto(overrides: Partial<UnifiedApprovalDTO> = {}): UnifiedApprovalDTO {
  return {
    id: 'apv_1',
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: 'wf_expense',
    businessKey: 'biz-1',
    title: '差旅报销',
    status: 'approved',
    requester: { id: 'u1', name: '张三' },
    subject: null,
    policy: null,
    currentStep: 2,
    totalSteps: 2,
    templateId: 'tpl_1',
    templateVersionId: 'tplv_1',
    requestNo: 'AP-0001',
    formSnapshot: { f1: 'x' },
    currentNodeKey: 'end',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    ...overrides,
  } as UnifiedApprovalDTO
}

/** The hand-typed data line of `dto()` with a given `status` cell; every other cell is identical in all three renderings. */
function lineWithStatus(status: string): string {
  return `apv_1,platform,,wf_expense,biz-1,AP-0001,差旅报销,${status},u1,张三,,2,2,tpl_1,tplv_1,end,"{""f1"":""x""}",2026-09-01T10:00:00.000Z,2026-09-02T10:00:00.000Z`
}

describe('buildApprovalExportCsvLines — header row and data row, three renderings', () => {
  it('the default options are header=code: the 19 keys, and the raw status (byte-identical to the pre-T1 export)', () => {
    expect(APPROVAL_EXPORT_CSV_DEFAULT_OPTIONS).toEqual({ header: 'code', lang: 'zh' })
    const lines = buildApprovalExportCsvLines([dto()])
    expect(lines[0]).toBe(CODE_ROW)
    expect(lines[1]).toBe(
      'apv_1,platform,,wf_expense,biz-1,AP-0001,差旅报销,approved,u1,张三,,2,2,tpl_1,tplv_1,end,"{""f1"":""x""}",2026-09-01T10:00:00.000Z,2026-09-02T10:00:00.000Z',
    )
    expect(lines).toHaveLength(2)
  })

  it('header=code ignores lang', () => {
    expect(buildApprovalExportCsvLines([dto()], { header: 'code', lang: 'en' })).toEqual(buildApprovalExportCsvLines([dto()]))
  })

  it('header=label&lang=zh: the zh label row, the zh status word, every other cell unchanged', () => {
    const lines = buildApprovalExportCsvLines([dto()], { header: 'label', lang: 'zh' })
    expect(lines[0]).toBe(ZH_ROW)
    expect(lines[1]).toBe(
      'apv_1,platform,,wf_expense,biz-1,AP-0001,差旅报销,已通过,u1,张三,,2,2,tpl_1,tplv_1,end,"{""f1"":""x""}",2026-09-01T10:00:00.000Z,2026-09-02T10:00:00.000Z',
    )
  })

  it('header=label&lang=en: the en label row, the en status word, every other cell unchanged', () => {
    const lines = buildApprovalExportCsvLines([dto()], { header: 'label', lang: 'en' })
    expect(lines[0]).toBe(EN_ROW)
    expect(lines[1]).toBe(
      'apv_1,platform,,wf_expense,biz-1,AP-0001,差旅报销,Approved,u1,张三,,2,2,tpl_1,tplv_1,end,"{""f1"":""x""}",2026-09-01T10:00:00.000Z,2026-09-02T10:00:00.000Z',
    )
  })

  it('no rows: still the header row alone (the zero-row export stays a legible CSV)', () => {
    expect(buildApprovalExportCsvLines([], { header: 'label', lang: 'zh' })).toEqual([ZH_ROW])
    expect(buildApprovalExportCsvLines([], { header: 'code', lang: 'zh' })).toEqual([CODE_ROW])
  })

  it('every row of a multi-row export is rendered in the chosen mode, in the given order', () => {
    const lines = buildApprovalExportCsvLines(
      [dto({ id: 'a', status: 'pending' }), dto({ id: 'b', status: 'rejected' }), dto({ id: 'c', status: 'revoked' })],
      { header: 'label', lang: 'zh' },
    )
    expect(lines.map((line) => line.split(',')[0])).toEqual([ZH_ROW.split(',')[0], 'a', 'b', 'c'])
    expect(lines.slice(1).map((line) => line.split(',')[7])).toEqual(['待处理', '已驳回', '已撤回'])
  })
})

describe('APPROVAL_EXPORT_CSV_COLUMNS — the column set did not change, and every column has a label', () => {
  it('the 19 keys, in this order (hand-typed; the set and the order are unchanged by T1)', () => {
    expect(APPROVAL_EXPORT_CSV_COLUMNS.map((column) => column.header)).toEqual(CODE_KEYS)
  })

  it('the label rows the table yields are exactly the golden zh / en rows', () => {
    expect(APPROVAL_EXPORT_CSV_COLUMNS.map((column) => column.label.zh).join(',')).toBe(ZH_ROW)
    expect(APPROVAL_EXPORT_CSV_COLUMNS.map((column) => column.label.en).join(',')).toBe(EN_ROW)
  })

  it.each(['zh', 'en'] as const)('%s: every label is non-empty and no two columns share one', (lang) => {
    const labels = APPROVAL_EXPORT_CSV_COLUMNS.map((column) => column.label[lang])
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('en labels contain no CJK characters', () => {
    for (const column of APPROVAL_EXPORT_CSV_COLUMNS) {
      // CJK ideographs + extension A, kana, Hangul syllables, full-width forms.
      expect(column.label.en, column.header).not.toMatch(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/)
    }
  })

  it.each(['zh', 'en'] as const)('%s: no label can be read as a formula or needs CSV quoting, so the sanitizer leaves it byte-for-byte', (lang) => {
    for (const column of APPROVAL_EXPORT_CSV_COLUMNS) {
      const label = column.label[lang]
      expect(neutralizeFormulaInjectionLead(label), `${column.header}/${lang}`).toBe(label)
      expect(label, `${column.header}/${lang}`).not.toMatch(/[",\r\n]/)
    }
  })

  it('only the status column overrides its cell in label mode', () => {
    expect(APPROVAL_EXPORT_CSV_COLUMNS.filter((column) => column.display).map((column) => column.header)).toEqual(['status'])
  })
})

describe('status words in label mode', () => {
  it.each([
    ['pending', '待处理', 'Pending'],
    ['approved', '已通过', 'Approved'],
    ['rejected', '已驳回', 'Rejected'],
    ['revoked', '已撤回', 'Revoked'],
    ['cancelled', '已取消', 'Cancelled'],
  ])('%s → %s / %s', (status, zh, en) => {
    expect(approvalExportStatusDisplay({ status, workflowKey: 'wf_expense' }, 'zh')).toBe(zh)
    expect(approvalExportStatusDisplay({ status, workflowKey: 'wf_expense' }, 'en')).toBe(en)
    expect(buildApprovalExportCsvLines([dto({ status })], { header: 'label', lang: 'zh' })[1]).toBe(lineWithStatus(zh))
    expect(buildApprovalExportCsvLines([dto({ status })], { header: 'label', lang: 'en' })[1]).toBe(lineWithStatus(en))
    // The same status in code mode is the raw engine value.
    expect(buildApprovalExportCsvLines([dto({ status })], { header: 'code', lang: 'zh' })[1]).toBe(lineWithStatus(status))
  })

  it('the table holds exactly these five statuses', () => {
    expect(Object.keys(APPROVAL_EXPORT_STATUS_LABELS)).toEqual(['pending', 'approved', 'rejected', 'revoked', 'cancelled'])
  })

  it('a status with no word is written as it is, never blanked (draft, and anything unknown)', () => {
    for (const status of ['draft', 'returned', 'some-future-status']) {
      expect(approvalExportStatusDisplay({ status, workflowKey: null }, 'zh')).toBe(status)
      expect(approvalExportStatusDisplay({ status, workflowKey: null }, 'en')).toBe(status)
    }
  })

  it('inherited object keys are not statuses: `constructor` / `__proto__` / `toString` come out as written', () => {
    for (const status of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(approvalExportStatusDisplay({ status, workflowKey: null }, 'zh')).toBe(status)
    }
  })

  it('a missing status stays an empty cell rather than the text "undefined" or "null"', () => {
    const lines = buildApprovalExportCsvLines([dto({ status: undefined as unknown as string })], { header: 'label', lang: 'zh' })
    expect(lines[1].split(',')[7]).toBe('')
  })

  it('a status that looks like a formula is still neutralised in label mode (the sanitizer is not bypassed for display values)', () => {
    const lines = buildApprovalExportCsvLines([dto({ status: '=1+1' })], { header: 'label', lang: 'zh' })
    expect(lines[1].split(',')[7]).toBe("'=1+1")
  })
})

describe('cancel-round rows keep the raw status in label mode (ratified change-request lock §15.2 / P-2)', () => {
  // The generic words would print 「已驳回」 for a system-closed round, byte-identical to an approver's
  // rejection — the exact look that lock forbids — and the criterion that tells them apart is not on
  // the list DTO. Giving these rows the cancel-round words is an owner choice (see the T1 area notes);
  // until then no word is invented for them.
  it.each(['pending', 'approved', 'rejected', 'revoked'])('%s stays raw for approval.cancel-round, in both languages', (status) => {
    for (const lang of ['zh', 'en'] as const) {
      expect(approvalExportStatusDisplay({ status, workflowKey: 'approval.cancel-round' }, lang)).toBe(status)
      const line = buildApprovalExportCsvLines([dto({ status, workflowKey: 'approval.cancel-round' })], { header: 'label', lang })[1]
      expect(line.split(',')[7]).toBe(status)
    }
  })

  it('POSITIVE CONTROL: the very same status on an ordinary workflow gets its word, so the rows above are the workflow key, not the table', () => {
    expect(approvalExportStatusDisplay({ status: 'rejected', workflowKey: 'wf_expense' }, 'zh')).toBe('已驳回')
    expect(approvalExportStatusDisplay({ status: 'rejected', workflowKey: null }, 'zh')).toBe('已驳回')
  })

  it('a workflow key that merely resembles the cancel round is an ordinary workflow', () => {
    expect(approvalExportStatusDisplay({ status: 'rejected', workflowKey: 'approval.cancel-round-x' }, 'zh')).toBe('已驳回')
    expect(approvalExportStatusDisplay({ status: 'rejected', workflowKey: 'Approval.Cancel-Round' }, 'zh')).toBe('已驳回')
  })
})

describe('the label row is a CSV row like any other: it goes through the sanitizer', () => {
  const hostile: ApprovalExportCsvColumn[] = [
    { header: 'a', label: { zh: "=cmd|' /C calc'!A0", en: '@SUM(1)' }, value: () => 'v1' },
    { header: 'b', label: { zh: 'a,"b"', en: '+1' }, value: () => 'v2' },
    { header: 'c', label: { zh: '-2', en: 'plain' }, value: () => 'v3' },
  ]

  it('zh: leading = is neutralised, a comma-and-quote label is RFC-4180 quoted', () => {
    // Hand-derived: `=cmd|' /C calc'!A0` -> prefix `'`; `a,"b"` -> wrapped, inner quotes doubled; `-2` -> prefix `'`.
    expect(buildApprovalExportCsvLines([], { header: 'label', lang: 'zh' }, hostile)[0]).toBe(
      `'=cmd|' /C calc'!A0,"a,""b""",'-2`,
    )
  })

  it('en: leading @ and + are neutralised', () => {
    expect(buildApprovalExportCsvLines([], { header: 'label', lang: 'en' }, hostile)[0]).toBe("'@SUM(1),'+1,plain")
  })

  it('code mode sanitizes its header cells too (unchanged contract §3.3)', () => {
    const columns: ApprovalExportCsvColumn[] = [{ header: '=evil', label: { zh: 'x', en: 'x' }, value: () => 'v' }]
    expect(buildApprovalExportCsvLines([], { header: 'code', lang: 'zh' }, columns)[0]).toBe("'=evil")
  })
})

describe('resolveApprovalExportCsvOptions', () => {
  it('absent parameters take the defaults: header=code, lang=zh', () => {
    expect(resolveApprovalExportCsvOptions({})).toEqual({ ok: true, options: { header: 'code', lang: 'zh' } })
    expect(resolveApprovalExportCsvOptions({ header: undefined, lang: undefined })).toEqual({
      ok: true,
      options: { header: 'code', lang: 'zh' },
    })
  })

  it.each([
    [{ header: 'label' }, { header: 'label', lang: 'zh' }],
    [{ header: 'label', lang: 'en' }, { header: 'label', lang: 'en' }],
    [{ header: 'code', lang: 'en' }, { header: 'code', lang: 'en' }],
    [{ lang: 'en' }, { header: 'code', lang: 'en' }],
  ])('%j → %j', (query, options) => {
    expect(resolveApprovalExportCsvOptions(query)).toEqual({ ok: true, options })
  })

  it.each([
    ['Label'],
    ['LABEL'],
    [' label'],
    ['label '],
    [''],
    ['bogus'],
    [['label']],
    [['label', 'code']],
    [{ nested: 'label' }],
    [null],
    [1],
    [true],
  ])('header %j is refused', (header) => {
    const result = resolveApprovalExportCsvOptions({ header })
    expect(result).toMatchObject({ ok: false, code: 'APPROVAL_EXPORT_HEADER_INVALID' })
  })

  it.each([['ZH'], ['zh-CN'], ['fr'], [''], [' zh'], [['zh']], [null], [0]])('lang %j is refused', (lang) => {
    const result = resolveApprovalExportCsvOptions({ lang })
    expect(result).toMatchObject({ ok: false, code: 'APPROVAL_EXPORT_LANG_INVALID' })
  })

  it('both bad: the header is reported first; a bad value is never echoed back', () => {
    const result = resolveApprovalExportCsvOptions({ header: 'SECRET-123', lang: 'SECRET-456' })
    expect(result).toMatchObject({ ok: false, code: 'APPROVAL_EXPORT_HEADER_INVALID' })
    expect(JSON.stringify(result)).not.toMatch(/SECRET/)
  })
})

describe('the server-side copies still equal their web sources (read as text: apps/web cannot be imported)', () => {
  const WEB = resolve(__dirname, '../../../../apps/web/src')

  function readWeb(rel: string): string {
    return readFileSync(resolve(WEB, rel), 'utf8')
  }

  /** The text between `marker` and the first line that is exactly `}` after it. */
  function objectBody(source: string, marker: string): string {
    const start = source.indexOf(marker)
    expect(start, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0)
    const bodyStart = source.indexOf('{', start + marker.length - 1)
    const end = source.indexOf('\n}', bodyStart)
    expect(end).toBeGreaterThan(bodyStart)
    return source.slice(bodyStart, end)
  }

  it('status words: the five approvalInstance pairs in statusDomains.ts, both directions', () => {
    const body = objectBody(readWeb('utils/statusDomains.ts'), 'const APPROVAL_INSTANCE_STATUS_DOMAIN: Record<string, StatusDisplayEntry> = {')
    const web: Record<string, { zh: string; en: string }> = {}
    for (const match of body.matchAll(/(\w+):\s*\{\s*tone:\s*'\w+',\s*zh:\s*'([^']*)',\s*en:\s*'([^']*)'\s*\}/g)) {
      web[match[1]] = { zh: match[2], en: match[3] }
    }
    // Positive control: the parse really found the table (a vacuous empty match must not pass).
    expect(Object.keys(web)).toHaveLength(5)
    expect(web.approved).toEqual({ zh: '已通过', en: 'Approved' })
    // Both directions: neither side may carry a status or a word the other lacks.
    expect(APPROVAL_EXPORT_STATUS_LABELS).toEqual(web)
  })

  it('column words that the list already shows: requestNo / title / requesterName / status, plus createdAt with its UTC note', () => {
    const source = readWeb('views/approval/approvalCenterLabels.ts')
    const parse = (marker: string): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const match of objectBody(source, marker).matchAll(/(\w+):\s*'([^']*)'/g)) out[match[1]] = match[2]
      return out
    }
    const zh = parse('export const CENTER_TABLE_ZH = {')
    const en = parse('export const CENTER_TABLE_EN: Record<keyof typeof CENTER_TABLE_ZH, string> = {')
    expect(zh.colRequestNo).toBe('审批编号')
    expect(en.colRequestNo).toBe('Request no.')

    const label = (header: string) => APPROVAL_EXPORT_CSV_COLUMNS.find((column) => column.header === header)!.label
    expect(label('requestNo')).toEqual({ zh: zh.colRequestNo, en: en.colRequestNo })
    expect(label('title')).toEqual({ zh: zh.colTitle, en: en.colTitle })
    expect(label('requesterName')).toEqual({ zh: zh.colRequester, en: en.colRequester })
    expect(label('status')).toEqual({ zh: zh.colStatus, en: en.colStatus })
    // The list shows these in the browser's local time; the export writes UTC, and its label says so.
    expect(label('createdAt')).toEqual({ zh: `${zh.colCreatedAt}（UTC）`, en: `${en.colCreatedAt} (UTC)` })
  })
})
