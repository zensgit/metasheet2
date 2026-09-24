import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

/**
 * Merge-train dry run v3b §5.2.1, action 3 — a STATIC guard on the `expectedVersion` rider.
 *
 * `ApprovalActionRequest.expectedVersion` is the optional optimistic-lock precondition
 * `ApprovalProductService.dispatchAction` re-checks under its own row lock. Today it is SET by
 * exactly two call sites — the legacy `POST /api/approvals/:id/approve` and `/:id/reject` doors —
 * and both doors refuse a cancel-round instance (`rejectIfCancelRound`) BEFORE they dispatch, so
 * the version precondition and the cancel-round action gate inside `dispatchAction` can never both
 * fire on one call. The relative order of those two checks (owner-named: version gate first) is
 * therefore observationally inert today, and this file is what keeps that a TESTED property rather
 * than a coincidence: it goes red the moment either of the two revival paths opens —
 *
 *   1. a THIRD `expectedVersion` write point appears (in particular inside the `/actions` handler,
 *      which carries no `rejectIfCancelRound`), or
 *   2. `rejectIfCancelRound` is removed from, or moved behind the dispatch in, either legacy door.
 *
 * It also pins the two owner-named orders statically, as a complement to the real-DB legs:
 * F4 (i) — in each legacy door the seat gate precedes the cancel-round outlet guard; F4 (ii) — in
 * `dispatchAction` the version precondition precedes the cancel-round action gate, and both follow
 * the attendance fail-closed guard.
 *
 * Source census, not behaviour: comment lines are stripped before counting, so a docblock that
 * mentions the rider does not count as a write point and a code line cannot hide inside a comment.
 */
const backendRoot = path.resolve(__dirname, '..', '..')
const routesPath = path.join(backendRoot, 'src', 'routes', 'approvals.ts')
const servicePath = path.join(backendRoot, 'src', 'services', 'ApprovalProductService.ts')

type Span = { name: string; start: number; end: number }

function stripCommentLines(source: string): string {
  // Replace every comment-only line by an empty line so character offsets stay aligned with the
  // original file (spans computed on one text are valid on the other).
  return source
    .split('\n')
    .map((line) => {
      const t = line.trimStart()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line
    })
    .join('\n')
}

/** Handler spans: from each top-level `  r.<verb>(` registration to the next one (or EOF). */
function routeHandlerSpans(code: string): Span[] {
  const re = /\n {2}r\.(post|get|put|patch|delete)\(\s*'([^']+)'/g
  const starts: Array<{ name: string; index: number }> = []
  for (let m = re.exec(code); m; m = re.exec(code)) starts.push({ name: `${m[1].toUpperCase()} ${m[2]}`, index: m.index })
  return starts.map((s, i) => ({ name: s.name, start: s.index, end: i + 1 < starts.length ? starts[i + 1].index : code.length }))
}

function occurrences(code: string, needle: string, from = 0, to = code.length): number[] {
  const out: number[] = []
  let i = code.indexOf(needle, from)
  while (i !== -1 && i < to) {
    out.push(i)
    i = code.indexOf(needle, i + needle.length)
  }
  return out
}

describe('v3b action 3 — `expectedVersion` is written by exactly the two legacy decision doors, and each door refuses a cancel-round instance before it dispatches', () => {
  const routesSource = readFileSync(routesPath, 'utf8')
  const routes = stripCommentLines(routesSource)
  const spans = routeHandlerSpans(routes)
  const approve = spans.find((s) => s.name === 'POST /api/approvals/:id/approve')
  const reject = spans.find((s) => s.name === 'POST /api/approvals/:id/reject')
  const actions = spans.find((s) => s.name === 'POST /api/approvals/:id/actions')

  it('the three legacy-decision handlers are located (self-check: a renamed route must not silently vacate this guard)', () => {
    expect(approve, 'legacy /approve handler').toBeTruthy()
    expect(reject, 'legacy /reject handler').toBeTruthy()
    expect(actions, '/actions handler').toBeTruthy()
    expect(spans.length).toBeGreaterThan(10)
  })

  it('WRITE POINTS: exactly two, one inside each legacy door — a third one anywhere (the /actions handler included) is red', () => {
    // The rider is SET where the route binds its own validated `version` to it.
    const writePoint = 'expectedVersion: requestedVersion'
    const all = occurrences(routes, writePoint)
    expect(all, 'write points across the whole routes file').toHaveLength(2)
    expect(occurrences(routes, writePoint, approve!.start, approve!.end)).toHaveLength(1)
    expect(occurrences(routes, writePoint, reject!.start, reject!.end)).toHaveLength(1)
    expect(occurrences(routes, writePoint, actions!.start, actions!.end)).toHaveLength(0)
    // Any other spelling of a write (`expectedVersion:` followed by something else) is either the
    // ONE forwarding site inside the shared settlement helper (outside every handler) or new — and
    // new is red.
    const anySet = occurrences(routes, 'expectedVersion:')
    const insideHandlers = anySet.filter((i) => spans.some((s) => i >= s.start && i < s.end))
    const outsideHandlers = anySet.filter((i) => !spans.some((s) => i >= s.start && i < s.end))
    expect(insideHandlers, 'sets inside route handlers').toHaveLength(2)
    // Outside every handler the token may appear only inside the shared settlement helper: its
    // parameter type (`precondition: { expectedVersion: number; ... }`) and its ONE forwarding
    // site (`expectedVersion: precondition.expectedVersion`). Anything else is a new writer.
    const helperStart = routes.indexOf('async function settleLegacyDecisionThroughSharedPath(')
    const helperEnd = routes.indexOf('\nfunction ', helperStart)
    expect(helperStart).toBeGreaterThan(-1)
    expect(outsideHandlers.length).toBeGreaterThanOrEqual(1)
    for (const i of outsideHandlers) {
      expect(i, 'a set outside every handler must live inside the shared settlement helper').toBeGreaterThan(helperStart)
      expect(i).toBeLessThan(helperEnd)
    }
    expect(occurrences(routes, 'expectedVersion: precondition.expectedVersion', helperStart, helperEnd)).toHaveLength(1)
    const otherOutside = outsideHandlers.filter((i) => !routes.startsWith('expectedVersion: precondition.expectedVersion', i) && !routes.startsWith('expectedVersion: number', i))
    expect(otherOutside, 'unexpected `expectedVersion:` writer outside the handlers').toHaveLength(0)
  })

  it('EACH legacy door: seat gate, THEN cancel-round outlet guard, THEN the write point (F4 (i) order pinned statically; removing or moving the guard is red)', () => {
    for (const [door, tag] of [
      [approve!, 'legacy POST /:id/approve'],
      [reject!, 'legacy POST /:id/reject'],
    ] as const) {
      const gate = occurrences(routes, 'await resolveLegacyDecisionSeat(', door.start, door.end)
      const guard = occurrences(routes, `rejectIfCancelRound(instance, '${tag}')`, door.start, door.end)
      const write = occurrences(routes, 'expectedVersion: requestedVersion', door.start, door.end)
      expect(gate, `${door.name}: seat gate`).toHaveLength(1)
      expect(guard, `${door.name}: cancel-round outlet guard`).toHaveLength(1)
      expect(write, `${door.name}: write point`).toHaveLength(1)
      expect(gate[0]).toBeLessThan(guard[0])
      expect(guard[0]).toBeLessThan(write[0])
    }
    // The /actions door carries no outlet guard of its own (its cancel-round judgment lives in
    // `dispatchAction`) — which is exactly why a write point there would revive the latent order.
    expect(occurrences(routes, 'rejectIfCancelRound(', actions!.start, actions!.end)).toHaveLength(0)
  })

  it('dispatchAction: attendance fail-closed guard, THEN the version precondition, THEN the cancel-round action gate (F4 (ii) order pinned statically); the rider is read at exactly one site', () => {
    const service = stripCommentLines(readFileSync(servicePath, 'utf8'))
    const reads = occurrences(service, 'request.expectedVersion')
    // `request.expectedVersion !== undefined && instance.version !== request.expectedVersion` is one
    // statement with two mentions; both must sit on the same line.
    expect(reads.length).toBeGreaterThanOrEqual(1)
    const readLine = service.slice(0, reads[0]).split('\n').length
    for (const r of reads) expect(service.slice(0, r).split('\n').length).toBe(readLine)
    const methodStart = service.indexOf('async dispatchAction(')
    expect(methodStart).toBeGreaterThan(-1)
    const nextMethod = service.indexOf('\n  async ', methodStart + 1)
    const nextPrivate = service.indexOf('\n  private ', methodStart + 1)
    const methodEnd = Math.min(...[nextMethod, nextPrivate].filter((i) => i > -1))
    expect(reads[0]).toBeGreaterThan(methodStart)
    expect(reads[0]).toBeLessThan(methodEnd)
    const attendance = occurrences(service, 'await guardAttendanceCentralMutationOrThrow(client, instance)', methodStart, methodEnd)
    const actionGate = occurrences(service, 'assertCancelRoundActionAllowed(instance, request.action)', methodStart, methodEnd)
    expect(attendance.length).toBeGreaterThanOrEqual(1)
    expect(actionGate).toHaveLength(1)
    expect(attendance[0]).toBeLessThan(reads[0])
    expect(reads[0]).toBeLessThan(actionGate[0])
  })
})
