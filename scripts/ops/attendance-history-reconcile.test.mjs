import test from 'node:test'
import assert from 'node:assert/strict'
import { historyScope, summarizeHistory, reconcileHistory } from './attendance-history-reconcile.mjs'

const scopeEnv = { ORG_ID: 'synthetic-org', USER_ID: 'synthetic-user', FROM_DATE: '2026-09-10', TO_DATE: '2026-09-11' }

test('history reads require an explicit bounded scope and real calendar dates', () => {
  assert.deepEqual(historyScope(scopeEnv), { orgId: 'synthetic-org', userId: 'synthetic-user', from: '2026-09-10', to: '2026-09-11' })
  for (const change of [{ USER_ID: '' }, { ORG_ID: '' }, { FROM_DATE: '2026-02-30' }, { TO_DATE: '2027-09-11' }, { TO_DATE: '2026-09-09' }]) {
    assert.throws(() => historyScope({ ...scopeEnv, ...change }), /ATTENDANCE_HISTORY_SCOPE_INVALID/)
  }
})

test('historical observations preserve persisted day/timezone and never emit row values', () => {
  const record = { work_date: '2026-09-10', timezone: 'Asia/Shanghai', first_in_at: '2026-09-10T01:00:00Z', last_out_at: '2026-09-10T10:00:00Z', work_minutes: 0, user_id: 'DO_NOT_EMIT', meta: { secret: 'DO_NOT_EMIT' } }
  const events = [
    { work_date: '2026-09-10', timezone: 'America/Los_Angeles', occurred_at: record.first_in_at, event_type: 'check_in' },
    { work_date: '2026-09-10', timezone: 'Asia/Shanghai', occurred_at: record.last_out_at, event_type: 'check_out' },
  ]
  assert.deepEqual(summarizeHistory([record], events), {
    code: 'ATTENDANCE_HISTORY_OBSERVATIONS', readOnly: true,
    counts: { records: 1, rawEvents: 2, recordsWithoutRawEvents: 0, recordsMissingIn: 0, recordsMissingOut: 0,
      completedPairsWithZeroMinutes: 1, reversedCompletedPairs: 0, recordBoundariesWithoutMatchingEvents: 0, recordsWithEventTimezoneDifference: 1,
      invalidRecordTimezones: 0, invalidEventTimezones: 0, invalidRecordInstants: 0,
      invalidEventInstants: 0, eventsWithLocalDateDifferentFromWorkDate: 1 },
  })
  assert.doesNotMatch(JSON.stringify(summarizeHistory([record], events)), /DO_NOT_EMIT|2026|Shanghai|Los_Angeles/)
  const missing = summarizeHistory([{ ...record, timezone: 'bad', last_out_at: null }], [])
  assert.equal(missing.counts.recordsWithoutRawEvents, 1)
  assert.equal(missing.counts.recordsMissingOut, 1)
  assert.equal(missing.counts.completedPairsWithZeroMinutes, 0)
  assert.equal(missing.counts.invalidRecordTimezones, 1)
  assert.equal(summarizeHistory([{ ...record, last_out_at: '2026-09-09T10:00:00Z', reversed_completed_pair: true }], []).counts.reversedCompletedPairs, 1)
})

test('naive or invalid event instants are not timezone failures; overnight pairs stay ordered', () => {
  const events = [
    { work_date: '2026-09-10', occurred_at: '2026-09-10T10:00:00', timezone: 'Asia/Shanghai' },
    { work_date: '2026-09-10', occurred_at: null, timezone: 'Asia/Shanghai' },
    { work_date: '2026-09-10', occurred_at: '2026-02-30T00:00:00Z', timezone: 'Asia/Shanghai' },
  ]
  const invalid = summarizeHistory([], events).counts
  assert.equal(invalid.invalidEventInstants, 3)
  assert.equal(invalid.invalidEventTimezones, 0)
  assert.equal(invalid.eventsWithLocalDateDifferentFromWorkDate, 0)
  const record = { work_date: '2026-09-10', first_in_at: new Date('2026-09-10T15:00:00.001Z'), last_out_at: new Date('2026-09-10T23:00:00.002Z'), timezone: 'Asia/Shanghai', work_minutes: 480 }
  const night = summarizeHistory([record], [
    { work_date: record.work_date, occurred_at: record.first_in_at, timezone: record.timezone, event_type: 'check_in' },
    { work_date: record.work_date, occurred_at: record.last_out_at, timezone: record.timezone, event_type: 'check_out' },
  ]).counts
  assert.equal(night.reversedCompletedPairs, 0)
  assert.equal(night.eventsWithLocalDateDifferentFromWorkDate, 1)
  assert.equal(night.recordBoundariesWithoutMatchingEvents, 0)
})

test('read transaction pins organization, user, range and rolls back after success or failure', async () => {
  for (const fail of [false, true]) {
    const calls = []
    const client = { async query(sql, params) {
      calls.push({ sql, params })
      if (fail && sql.includes('FROM attendance_events')) throw new Error('private database detail')
      return { rows: [] }
    } }
    const run = reconcileHistory(client, historyScope(scopeEnv))
    if (fail) await assert.rejects(run)
    else assert.equal((await run).counts.records, 0)
    assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(calls.at(-1).sql, 'ROLLBACK')
    for (const call of calls.filter(call => call.params)) {
      assert.match(call.sql, /org_id = \$1 AND user_id = \$2/)
      assert.deepEqual(call.params, ['synthetic-org', 'synthetic-user', '2026-09-10', '2026-09-11'])
    }
  }
})
