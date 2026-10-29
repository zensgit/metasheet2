import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const { buildAttendanceApprovalInstancePayload } = requireCjs('../../../../plugins/plugin-attendance/index.cjs')
  .__attendanceApprovalCenterForTests

const userId = 'synthetic-requester-display'

describe('attendance approval requester display snapshot', () => {
  it.each([
    { case: 'omitted', requesterName: undefined, expected: 'Unknown user' },
    { case: 'null', requesterName: null, expected: 'Unknown user' },
    { case: 'empty', requesterName: '', expected: 'Unknown user' },
    { case: 'whitespace', requesterName: ' \t ', expected: 'Unknown user' },
    { case: 'genuine name', requesterName: 'Synthetic requester', expected: 'Synthetic requester' },
    { case: 'genuine email', requesterName: 'requester@example.invalid', expected: 'requester@example.invalid' },
    { case: 'genuine name equals ID', requesterName: userId, expected: userId },
    { case: 'genuine name bytes', requesterName: ' Synthetic requester ', expected: ' Synthetic requester ' },
  ])('stores $case without inventing a technical display fallback', ({ requesterName, expected }) => {
    const payload = buildAttendanceApprovalInstancePayload({
      approvalId: 'synthetic-approval-label',
      requestId: 'synthetic-request-label',
      orgId: 'synthetic-requester-org',
      userId,
      requesterName,
      draft: {
        workDate: '2026-10-26',
        requestType: 'time_correction',
        requestedInAt: null,
        requestedOutAt: null,
        reason: null,
        metadata: {},
      },
    })
    expect(payload.requesterSnapshot).toEqual({ id: userId, name: expected })
    expect(payload.formSnapshot.userId).toBe(userId)
    expect(payload.subjectSnapshot.userId).toBe(userId)
    expect(payload.metadata.userId).toBe(userId)
    expect(payload.workflowKey).toBe('attendance.request')
    expect(payload.businessKey).toBe('attendance-request:synthetic-request-label')
  })
})

const requesterDisplay = requireCjs('../../../../plugins/plugin-attendance/lib/attendance-requester-display.cjs')
const subjectId = 'synthetic-subject'
const operatorId = 'synthetic-operator'
const orgId = 'synthetic-org'

describe('requester display reads preserve identity, history and error boundaries', () => {
  it('does not consult a directory when the authenticated label belongs to self', async () => {
    const client = { query: () => { throw new Error('UNEXPECTED_DIRECTORY_READ') } }
    expect(await requesterDisplay.forCreate(client, {
      userId: subjectId, actorId: subjectId, orgId, actorName: subjectId,
    })).toBe(subjectId)
  })

  it.each([
    [{ name: ' Genuine subject ', email: 'subject@example.invalid' }, ' Genuine subject '],
    [{ name: subjectId, email: 'subject@example.invalid' }, subjectId],
    [{ name: ' ', email: 'subject@example.invalid' }, 'subject@example.invalid'],
    [{ name: null, email: subjectId }, 'Unknown user'],
    [undefined, 'Unknown user'],
  ])('reads only the authorized target profile, never the operator label: %j', async (profile, expected) => {
    const queries: Array<{ sql: string; parameters: unknown[] }> = []
    const client = { query: async (sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters })
      return profile ? [profile] : []
    } }
    expect(await requesterDisplay.forCreate(client, {
      userId: subjectId, actorId: operatorId, orgId, actorName: 'Operator only',
    })).toBe(expected)
    expect(queries).toHaveLength(1)
    expect(queries[0].parameters).toEqual([subjectId, orgId])
    expect(queries[0].sql).toContain('o.org_id = $2 AND o.is_active = true')
    expect(queries[0].sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i)
  })

  it.each([
    [{ id: subjectId, name: 'Historical name' }, orgId, 'Historical name'],
    [{ id: subjectId, name: subjectId }, orgId, subjectId],
    [{ name: 'Legacy name' }, null, 'Legacy name'],
    [{ id: 'foreign-subject', name: 'Foreign display' }, orgId, 'Unknown user'],
    [{ id: subjectId, orgId: 'foreign-org', name: 'Foreign display' }, orgId, 'Unknown user'],
    [{ id: subjectId, name: 'Foreign display' }, 'foreign-org', 'Unknown user'],
    [{ id: subjectId, name: ' \t ' }, orgId, 'Unknown user'],
    [{ id: subjectId, name: 42 }, orgId, 'Unknown user'],
    [null, orgId, 'Unknown user'],
    [[], orgId, 'Unknown user'],
  ])('an existing snapshot is frozen or neutral, never refreshed: %j', async (snapshot, storedOrg, expected) => {
    const calls: unknown[][] = []
    const client = { query: async (_sql: string, parameters: unknown[]) => {
      calls.push(parameters)
      return [{ requester_snapshot: snapshot, org_id: storedOrg }]
    } }
    expect(await requesterDisplay.forPendingEdit(client, {
      approvalId: 'synthetic-approval', userId: subjectId, orgId,
      actorId: operatorId, actorName: 'New operator display',
    })).toBe(expected)
    expect(calls).toEqual([['synthetic-approval']])
  })

  it.each([null, 'absent-row'])('an absent prior approval follows new-snapshot selection: %s', async approvalId => {
    const client = { query: async () => [] }
    expect(await requesterDisplay.forPendingEdit(client, {
      approvalId, userId: subjectId, orgId, actorId: subjectId, actorName: 'Current self label',
    })).toBe('Current self label')
  })

  it.each(['40001', '40P01', '23514'])('SQL failure %s cannot become a successful neutral-label write', async code => {
    const client = { query: async () => {
      throw Object.assign(new Error('Private driver message'), { code, detail: 'Private detail' })
    } }
    for (const read of [
      () => requesterDisplay.forCreate(client, { userId: subjectId, orgId, actorId: operatorId, actorName: 'Operator' }),
      () => requesterDisplay.forPendingEdit(client, { approvalId: 'old', userId: subjectId, orgId, actorId: operatorId }),
    ]) {
      const error = await read().then(() => null, (failure: Error & { code?: string }) => failure)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('ATTENDANCE_REQUESTER_DISPLAY_READ_FAILED')
      expect(error.code).toBe(code === '23514' ? undefined : code)
      expect(Object.keys(error).sort()).toEqual(code === '23514' ? [] : ['code'])
    }
  })
})

it.each([null, { name: ' ' , email: subjectId }])('missing profile remains a schema-safe neutral string: %j', profile => {
  expect(requesterDisplay.profileName(profile, subjectId)).toBe('Unknown user')
})
