/**
 * 请假撤销入口(阶段 B2)—— 前端 ↔ 服务端合同同步(读源码,不挂组件)。
 *
 * Standalone and readFileSync-only ON PURPOSE, like attendance-rules-me-contract-sync.spec.ts: it lives
 * in the always-on required web lane, so a change that edits ONLY the server side of a cancel-round
 * response still runs it. Every anchor fails loudly when it is not found; members are parsed by symbol
 * name, never by line number. What it pins (owner 2026-09-29 14:3x 「Minimal action response」 and
 * 「Summary exposes entryEnabled」; P-4 summary fields; P-5 「Full status, no raw ids/errors」; P-8 codes;
 * P-11 (a)(b) on the todo-center `PendingItem`):
 *  - the approve / reject / withdraw success body is exactly { requestId, roundId, outcome, status } and
 *    the client reads `roundId` from `data`;
 *  - the summary route adds `entryEnabled`;
 *  - the summary round's field set, and the delivery field set / status and channel unions, equal what
 *    the client copies and labels;
 *  - every `CANCEL_ROUND_*` code the server can produce has client copy;
 *  - the todo item carries `workflowKey`, the cancel-round key is the same string on both sides, and the
 *    todo `href` is the attendance deep link the attendance page resolves (`section` + `requestId`).
 *  - the attendance-side pending list (owner 16:5x 「Attendance-side list」): the route string and its
 *    `withPermission('attendance:approve')`, the nine keys of each `listed.push({ … })` item equal the
 *    client's `PendingCancelRoundItem` fields, and the success envelope `data: { items, total }` — the
 *    three anchors design MD §11.10 names for the stacked tree (B2 gate P3-2);
 *  - the decision / withdraw bodies accept `expectedRoundId` and the client's decision and withdraw send it
 *    (phase D D2; the withdraw half since the 2026-10-08 reviewer finding F1). The wire-body assertions in
 *    the Core / AttendancePanel / CenterRoute / DetailView specs are the authority; these text pins only
 *    keep the two client functions' shapes from drifting apart.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CANCEL_ROUND_PENDING_LIST_PATH,
  CANCEL_ROUND_DELIVERY_CHANNEL_COPY,
  CANCEL_ROUND_DELIVERY_STATUSES,
  CANCEL_ROUND_ERROR_COPY,
  CANCEL_ROUND_STATUS_KEYS,
  CANCEL_ROUND_WORKFLOW_KEY,
  cancelRoundStatusKeyFromSummary,
  normalizeCancelRoundDeliveries,
  normalizeCancelRoundSummary,
  normalizePendingCancelRoundList,
} from '../src/approvals/cancelRound'
import { ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID } from '../src/views/attendance/attendanceOverviewRequestReveal'

const REPO = join(__dirname, '../../..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')
const PLUGIN = read('plugins/plugin-attendance/index.cjs')
const PORT = read('packages/core-backend/src/approvals/approval-cancel-round-entry-port.ts')

function stripLineComments(text: string): string {
  return text.replace(/\/\/[^\n]*/g, '')
}

/** Body of `<head> … {` up to its matching `}` (brace depth), or fail. */
function blockAfter(source: string, head: string | RegExp): string {
  const start = typeof head === 'string' ? source.indexOf(head) : source.search(head)
  expect(start, `anchor ${String(head)} must be found`).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced block after ${String(head)}`)
}

function interfaceFields(source: string, name: string): string[] {
  const body = stripLineComments(blockAfter(source, `export interface ${name} {`)).replace(/\/\*[\s\S]*?\*\//g, '')
  const fields = [...body.matchAll(/^\s*(?:readonly\s+)?(\w+)\??:/gm)].map((m) => m[1])
  expect(fields.length, `${name} must declare fields`).toBeGreaterThan(0)
  return fields.sort()
}

/** String-literal members of `export type <name> = 'a' | 'b' …` (structural: every member must be a literal). */
function unionMembers(source: string, name: string): string[] {
  const match = new RegExp(`export type ${name} =([\\s\\S]*?)\\n(?:\\n|export|/\\*\\*)`).exec(source)
  expect(match, `union ${name} must be found`).toBeTruthy()
  const body = stripLineComments((match as RegExpExecArray)[1])
  const parts = body.split('|').map((p) => p.trim()).filter((p) => p.length > 0)
  const members = parts.map((p) => /^'([^']+)'$/.exec(p)?.[1])
  expect(members.every((m) => typeof m === 'string'), `${name}: every member must be a string literal`).toBe(true)
  return (members as string[]).sort()
}

describe('write-route success body (owner 14:3x 「Minimal action response」)', () => {
  it('approve / reject / withdraw answer exactly { requestId, roundId, outcome, status } under data', () => {
    const responder = blockAfter(PLUGIN, 'const respondCancelRoundActionOutcome = (res, requestId, round) =>')
    const data = blockAfter(responder, 'data:')
    const keys = data.split(',').map((entry) => entry.trim().split(':')[0].trim()).filter(Boolean).sort()
    expect(keys).toEqual(['outcome', 'requestId', 'roundId', 'status'])
    // both write routes answer through it
    const actions = blockAfter(PLUGIN, "'/api/attendance/requests/:id/cancel-round/actions',")
    const withdraw = blockAfter(PLUGIN, "'/api/attendance/requests/:id/cancel-round/withdraw',")
    expect(actions).toContain('respondCancelRoundActionOutcome(res, request.requestId, result.round)')
    expect(withdraw).toContain('respondCancelRoundActionOutcome(res, request.requestId, result.round)')
  })

  it('the client reads the decided and the withdrawn round from data.roundId (the key the server sends)', async () => {
    const source = read('apps/web/src/approvals/cancelRound.ts')
    for (const head of ['export async function decideCancelRound(', 'export async function withdrawCancelRound(']) {
      const body = blockAfter(source, head)
      expect(body, head).toContain('data?.roundId')
      expect(body, head).not.toMatch(/payload\??\.roundId/)
    }
  })
})

describe('summary read (P-4 + owner 14:3x 「Summary exposes entryEnabled」)', () => {
  it('the summary route adds entryEnabled next to the port summary', () => {
    const route = blockAfter(PLUGIN, /'GET',\s*'\/api\/attendance\/requests\/:id\/cancel-round',/)
    expect(route).toMatch(/data:\s*\{\s*requestId: request\.requestId,\s*\.\.\.summary,\s*entryEnabled: isAttendanceCancelRoundEntryEnabled\(\)\s*\}/)
  })

  it('the round fields the server declares are exactly the fields the client copies', () => {
    const serverFields = interfaceFields(PORT, 'CancelRoundSummaryRoundV1')
    const wire = Object.fromEntries(serverFields.map((f) => [f, f === 'deliveries' ? [] : f === 'closedBySystem' || f === 'canWithdraw' ? true : `v-${f}`]))
    const round = normalizeCancelRoundSummary({ ok: true, data: { requestId: 'r', documentInstanceId: 'd', entryEnabled: true, round: wire } }, 'r').round
    expect(round, 'a round carrying every server field must normalize').not.toBeNull()
    expect(Object.keys(round!).sort()).toEqual(serverFields)
    expect(interfaceFields(PORT, 'CancelRoundSummaryV1')).toEqual(['documentInstanceId', 'round'])
  })

  it('status and outcome vocabularies match', () => {
    expect(unionMembers(PORT, 'CancelRoundSummaryStatusV1')).toEqual([...CANCEL_ROUND_STATUS_KEYS].sort())
    // every outcome the server can report maps to a V-word on the client, even without a status token
    for (const outcome of unionMembers(PORT, 'CancelRoundOutcomeV1')) {
      expect(cancelRoundStatusKeyFromSummary({ outcome, status: '' }), outcome).not.toBe('status_unavailable')
    }
    const withdrawReasons = unionMembers(PORT, 'CancelRoundWithdrawBlockedReasonV1')
    for (const reason of withdrawReasons) expect(CANCEL_ROUND_ERROR_COPY[reason]?.cls, reason).toBe('withdraw')
  })
})

describe('P-5 deliveries (「Full status, no raw ids/errors」)', () => {
  it('the delivery field set, status union and channel union equal the client\'s copy and labels', () => {
    const serverFields = interfaceFields(PORT, 'CancelRoundDeliveryV1')
    expect(serverFields).toEqual(['attempts', 'channelType', 'createdAt', 'lastAttemptAt', 'status', 'updatedAt'])
    const copied = normalizeCancelRoundDeliveries([Object.fromEntries(serverFields.map((f) => [f, f === 'attempts' ? 1 : f === 'status' ? 'delivered' : `v-${f}`]))])
    expect(Object.keys(copied![0]).sort()).toEqual(serverFields)
    expect(unionMembers(PORT, 'CancelRoundDeliveryStatusV1')).toEqual([...CANCEL_ROUND_DELIVERY_STATUSES].sort())
    expect(unionMembers(PORT, 'CancelRoundDeliveryChannelTypeV1')).toEqual(Object.keys(CANCEL_ROUND_DELIVERY_CHANNEL_COPY).sort())
  })
})

describe('error codes (P-8)', () => {
  it('every CANCEL_ROUND_* code the server source can produce has client copy', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|cjs|js)$/.test(name)) files.push(path)
      }
    }
    walk(join(REPO, 'packages/core-backend/src'))
    files.push(join(REPO, 'plugins/plugin-attendance/index.cjs'))
    const codes = new Set<string>()
    for (const file of files) {
      // quoted string literals only — backticked names in comments are identifiers, not codes
      for (const m of readFileSync(file, 'utf8').matchAll(/(['"])(CANCEL_ROUND_[A-Z_]+)\1/g)) codes.add(m[2])
    }
    expect(codes.size, 'the server source must produce cancel-round codes').toBeGreaterThan(10)
    const missing = [...codes].filter((code) => !(code in CANCEL_ROUND_ERROR_COPY)).sort()
    expect(missing).toEqual([])
  })
})

describe('todo center item (P-11 (a)(b), todo-center lock §3 PendingItem)', () => {
  it('the item carries workflowKey, and the cancel-round key is the same string on both sides', () => {
    const registry = read('packages/core-backend/src/services/pending-source-registry.ts')
    expect(interfaceFields(registry, 'PendingItem')).toContain('workflowKey')
    const source = read('packages/core-backend/src/services/approval-pending-source.ts')
    expect(source).toContain('workflowKey: row.workflowKey,')
    const hooks = read('packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts')
    expect(/export const APPROVAL_CANCEL_ROUND_WORKFLOW_KEY = '([^']+)'/.exec(hooks)?.[1]).toBe(CANCEL_ROUND_WORKFLOW_KEY)
    expect(/const APPROVAL_CANCEL_ROUND_WORKFLOW_KEY = '([^']+)'/.exec(PLUGIN)?.[1]).toBe(CANCEL_ROUND_WORKFLOW_KEY)
  })

  it('the cancel-round href is the attendance deep link the attendance page resolves', () => {
    const source = read('packages/core-backend/src/services/approval-pending-source.ts')
    expect(/const ATTENDANCE_REQUESTS_SECTION = '([^']+)'/.exec(source)?.[1]).toBe(ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID)
    const href = blockAfter(source, 'function attendanceRequestHref(requestId: string): string')
    expect(href).toContain('`/attendance?section=${ATTENDANCE_REQUESTS_SECTION}&requestId=${encodeURIComponent(requestId)}`')
    const experience = read('apps/web/src/views/attendance/AttendanceExperienceView.vue')
    expect(experience).toContain('route.query.requestId')
    expect(experience).toContain(`'${ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID}'`)
  })
})

describe('attendance-side pending list (owner 16:5x 「Attendance-side list」; design MD §11.10 anchors)', () => {
  const ROUTE = /'GET',\s*'\/api\/attendance\/cancel-rounds\/pending',/
  const handler = () => blockAfter(PLUGIN, ROUTE)

  it('the route string is the client\'s path, behind withPermission(\'attendance:approve\')', () => {
    const start = PLUGIN.search(ROUTE)
    expect(start, 'the pending-list route must be registered in the plugin').toBeGreaterThan(-1)
    expect(PLUGIN.slice(start).match(/'(\/api\/attendance\/cancel-rounds\/pending)'/)?.[1]).toBe(CANCEL_ROUND_PENDING_LIST_PATH)
    const head = PLUGIN.slice(start, PLUGIN.indexOf('{', start))
    expect(head).toContain("withPermission('attendance:approve', async (req, res) =>")
  })

  it('each listed item carries exactly the nine keys the client reads', () => {
    const pushed = stripLineComments(blockAfter(handler(), 'listed.push('))
    // `key: value,` or the shorthand `key,` — one property per line
    const serverKeys = [...pushed.matchAll(/^\s*(\w+)\s*(?::|,|$)/gm)].map((m) => m[1]).sort()
    expect(serverKeys).toHaveLength(9)
    const client = read('apps/web/src/approvals/cancelRound.ts')
    expect(interfaceFields(client, 'PendingCancelRoundItem')).toEqual(serverKeys)
    const wire = Object.fromEntries(serverKeys.map((k) => [k, `v-${k}`]))
    const list = normalizePendingCancelRoundList({ ok: true, data: { items: [wire], total: 1 } })
    expect(Object.keys(list.items[0]).sort()).toEqual(serverKeys)
  })

  it('the success envelope is data: { items, total }', () => {
    expect(handler()).toMatch(/res\.json\(\{\s*ok: true,\s*data: \{\s*items: listed\.slice\([^)]*\),\s*total: listed\.length\s*\}\s*\}\)/)
  })
})

describe('the listed round travels with the decision (phase D D2)', () => {
  it('the decision and withdraw bodies accept expectedRoundId and hand it to the port; the client decision and withdraw send it', () => {
    const decisionSchema = blockAfter(PLUGIN, 'const cancelRoundDecisionBodySchema = z.object(')
    const withdrawSchema = blockAfter(PLUGIN, 'const cancelRoundWithdrawBodySchema = z.object(')
    expect(decisionSchema).toContain('expectedRoundId: z.string()')
    expect(withdrawSchema).toContain('expectedRoundId: z.string()')
    const actions = blockAfter(PLUGIN, "'/api/attendance/requests/:id/cancel-round/actions',")
    const withdraw = blockAfter(PLUGIN, "'/api/attendance/requests/:id/cancel-round/withdraw',")
    expect(actions).toContain('expectedRoundId: normalizeCancelRoundExpectedRoundId(parsed.data.expectedRoundId)')
    expect(withdraw).toContain('expectedRoundId: normalizeCancelRoundExpectedRoundId(parsed.data.expectedRoundId)')
    const client = read('apps/web/src/approvals/cancelRound.ts')
    expect(blockAfter(client, 'export async function decideCancelRound(')).toContain("withOptionalText('expectedRoundId', expectedRoundId)")
    expect(blockAfter(client, 'export async function withdrawCancelRound(')).toContain("withOptionalText('expectedRoundId', expectedRoundId)")
    // the stale refusal the client maps is the one the port answers
    expect(PORT).toMatch(/code: APPROVAL_ERROR_CODES\.INVALID_STATUS_TRANSITION/)
    expect(blockAfter(client, 'export async function decideListedCancelRound(')).toContain("=== 'INVALID_STATUS_TRANSITION'")
  })
})

