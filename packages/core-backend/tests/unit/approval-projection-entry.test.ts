import { describe, expect, it } from 'vitest'
import {
  resolveApprovalProjectionEntryForViewer,
  deriveProjectionSheetId,
} from '../../src/multitable/approval-record-projection-service'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'
import type { QueryFn } from '../../src/multitable/permission-service'

/**
 * `resolveApprovalProjectionEntryForViewer` — the P3-2(a) navigation-handle resolver the approval
 * detail response attaches (design-lock 2026-09-12).
 *
 * This calls the REAL, imported `loadApprovalProjectionParticipantSheetIds` (the canonical
 * predicate) with a fake `query` that answers its EXACT SQL shape — so a participant/non-
 * participant split here is a real property of that predicate's logic acting on rows this file
 * controls, not an assertion this file invents. `tests/integration/approval-projection-entry.
 * db.test.ts` re-proves the same split over a real Postgres JOIN and a real HTTP round trip.
 *
 * Mutation probes (§3 criterion A), run manually (cp backup -> mutate ->
 * run -> restore -> cmp, per the repo's own doctrine — never `git checkout --`):
 *   - `loadApprovalProjectionParticipantSheetIds` mutated to always return an EMPTY set reds
 *     "B: a PARTICIPANT ... gets the handle" (direction 1: participant -> null).
 *   - the same function mutated to always return the FULL requested set reds
 *     "B positive control: ... a DIFFERENT (non-participant) viewer gets null" (direction 2:
 *     non-participant -> handle). Both tests must go red, on DIFFERENT mutations, or the coverage
 *     is one-sided.
 */

const TEMPLATE_ID = 'tpl_proj_entry_1'
const SHEET_ID = deriveProjectionSheetId(TEMPLATE_ID)
const VIEWER = 'user_viewer_1'
const OTHER = 'user_other_1'
const VIEW_ID = 'view_proj_1'

type FakeQueryOptions = {
  participantId: string | null
  hasView?: boolean
  throwOn?: 'participant' | 'view'
}

/**
 * Answers the exact SQL shape of the CANONICAL predicate
 * (`loadApprovalProjectionParticipantSheetIds`, `permission-service.ts` — named here rather than
 * transcribed, so a future mechanical census for that SQL shape does not false-hit this doc
 * comment as if it were a rogue second copy) and this resolver's own default-view lookup
 * (`meta_views ... ORDER BY created_at ASC LIMIT 1`). `participantId` is the ONLY userId the fake
 * "database" treats as a participant of `SHEET_ID`.
 */
function fakeQuery(opts: FakeQueryOptions): QueryFn {
  const hasView = opts.hasView ?? true
  return async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('SELECT DISTINCT s.id')) {
      if (opts.throwOn === 'participant') throw new Error('participant lookup unavailable')
      const [sheetIds, baseId, userId] = params as [string[], string, string]
      const hit = Boolean(
        opts.participantId
        && userId === opts.participantId
        && sheetIds.includes(SHEET_ID)
        && baseId === APPROVAL_PROJECTION_BASE_ID,
      )
      return { rows: hit ? [{ id: SHEET_ID }] : [], rowCount: hit ? 1 : 0 }
    }
    if (normalized.startsWith('SELECT id FROM meta_views')) {
      if (opts.throwOn === 'view') throw new Error('view lookup unavailable')
      return { rows: hasView ? [{ id: VIEW_ID }] : [], rowCount: hasView ? 1 : 0 }
    }
    throw new Error(`Unhandled SQL in approval-projection-entry unit test: ${normalized}`)
  }
}

/**
 * Wraps `fakeQuery` to also record which lookup KIND each call was — 'view' or 'participant' —
 * in call order. This is what makes the NIT-5 perf reorder (view lookup first, participant
 * predicate second) an ASSERTED property rather than a doc-comment claim: reverting the order
 * would make the "no view yet" case below issue the participant query too, and this fails.
 */
function trackedFakeQuery(opts: FakeQueryOptions): { query: QueryFn; calls: Array<'view' | 'participant'> } {
  const calls: Array<'view' | 'participant'> = []
  const inner = fakeQuery(opts)
  const query: QueryFn = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    calls.push(normalized.startsWith('SELECT DISTINCT s.id') ? 'participant' : 'view')
    return inner(sql, params)
  }
  return { query, calls }
}

describe('resolveApprovalProjectionEntryForViewer — P3-2(a) navigation handle', () => {
  it('sheetId comes from the EXISTING exported deriveProjectionSheetId, never re-built', () => {
    expect(SHEET_ID).toBe(`sht_apr_proj_${TEMPLATE_ID}`)
  })

  it('B: a PARTICIPANT (canonical predicate hit) gets the handle with the server-resolved viewId', async () => {
    const result = await resolveApprovalProjectionEntryForViewer(fakeQuery({ participantId: VIEWER }), TEMPLATE_ID, VIEWER)
    expect(result).toEqual({ sheetId: SHEET_ID, viewId: VIEW_ID })
  })

  it('B positive control: the SAME data, a DIFFERENT (non-participant) viewer gets null', async () => {
    const result = await resolveApprovalProjectionEntryForViewer(fakeQuery({ participantId: VIEWER }), TEMPLATE_ID, OTHER)
    expect(result).toBeNull()
  })

  it('no templateId -> null WITHOUT querying (nothing to resolve)', async () => {
    let called = false
    const q: QueryFn = async () => {
      called = true
      return { rows: [] }
    }
    expect(await resolveApprovalProjectionEntryForViewer(q, null, VIEWER)).toBeNull()
    expect(await resolveApprovalProjectionEntryForViewer(q, undefined, VIEWER)).toBeNull()
    expect(await resolveApprovalProjectionEntryForViewer(q, '', VIEWER)).toBeNull()
    expect(called).toBe(false)
  })

  it('no viewerId -> null WITHOUT querying (nothing to resolve)', async () => {
    let called = false
    const q: QueryFn = async () => {
      called = true
      return { rows: [] }
    }
    expect(await resolveApprovalProjectionEntryForViewer(q, TEMPLATE_ID, null)).toBeNull()
    expect(await resolveApprovalProjectionEntryForViewer(q, TEMPLATE_ID, undefined)).toBeNull()
    expect(await resolveApprovalProjectionEntryForViewer(q, TEMPLATE_ID, '')).toBeNull()
    expect(called).toBe(false)
  })

  it('participant but the sheet has no view row yet -> null (fail-closed; never guesses a viewId)', async () => {
    const result = await resolveApprovalProjectionEntryForViewer(
      fakeQuery({ participantId: VIEWER, hasView: false }),
      TEMPLATE_ID,
      VIEWER,
    )
    expect(result).toBeNull()
  })

  it('NIT-5 perf: the view lookup runs FIRST — when no view exists, the participant predicate (the EXPENSIVE meta_sheets JOIN meta_records query) is never issued at all', async () => {
    // Pins the query-order reorder as a real property, not a doc-comment claim: this viewer IS
    // a participant (`participantId: VIEWER`), so under the OLD (participant-first) order the
    // participant query would have run, hit, and only THEN found no view. Under the new order
    // the view lookup runs first, finds nothing, and returns null WITHOUT ever calling the
    // participant predicate — `calls` proves it, not just the returned value.
    const { query, calls } = trackedFakeQuery({ participantId: VIEWER, hasView: false })
    const result = await resolveApprovalProjectionEntryForViewer(query, TEMPLATE_ID, VIEWER)
    expect(result).toBeNull()
    expect(calls).toEqual(['view'])
  })

  it('NIT-5 perf, positive control: when a view DOES exist, both lookups run, view first then participant', async () => {
    const { query, calls } = trackedFakeQuery({ participantId: VIEWER, hasView: true })
    const result = await resolveApprovalProjectionEntryForViewer(query, TEMPLATE_ID, VIEWER)
    expect(result).toEqual({ sheetId: SHEET_ID, viewId: VIEW_ID })
    expect(calls).toEqual(['view', 'participant'])
  })

  // NOT an "F" case (renamed — the original name claimed this resolver's own fail-closed catch,
  // but that catch never fires here): `loadApprovalProjectionParticipantSheetIds` has its OWN
  // try/catch (permission-service.ts:957-959) that swallows the thrown error and returns an
  // EMPTY set, so the query error never reaches THIS function at all — it just sees "not a
  // participant" and returns `null` via the ordinary B-direction-1 path. The "F:" test below
  // (the default-view lookup throwing) is the one that actually exercises this resolver's own
  // `catch` — that lookup has no nested try/catch of its own.
  it('participant query throwing is absorbed by the PREDICATE\'s OWN fail-closed catch (permission-service.ts), not this resolver\'s — still resolves to null, never rejects', async () => {
    await expect(
      resolveApprovalProjectionEntryForViewer(fakeQuery({ participantId: VIEWER, throwOn: 'participant' }), TEMPLATE_ID, VIEWER),
    ).resolves.toBeNull()
  })

  it('F: the default-view lookup throwing resolves to null, never rejects (no 500 upstream) — THIS resolver\'s own catch, not the predicate\'s', async () => {
    await expect(
      resolveApprovalProjectionEntryForViewer(fakeQuery({ participantId: VIEWER, throwOn: 'view' }), TEMPLATE_ID, VIEWER),
    ).resolves.toBeNull()
  })
})
