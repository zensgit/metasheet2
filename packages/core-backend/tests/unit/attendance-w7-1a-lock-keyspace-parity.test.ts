/**
 * W7-1a (#4556) — the composite lock helper's keys are the PRODUCTION lock
 * families, not merely self-consistent ones.
 *
 * WHY THIS EXISTS. Ruling 8 fixes the order for the first code path that ever
 * combines the membership-timeline and schedule-facts lock families, and the
 * helper's header asserts the interop consequence as fact: "shared advisory
 * locks still conflict with the exclusive locks the existing writers take, so
 * a concurrent membership transition or schedule-assignment write is genuinely
 * serialized against this helper".
 *
 * The real-DB contention suite could NOT support that claim. Both competing
 * connections build their keys from W7's OWN builders, so the two sides move
 * together: an independent gate renamed the timeline family prefix to
 * `MUTATED-not-the-w1-family` and all 30 real-DB tests stayed green. Those
 * legs prove ORDER and SELF-CONSISTENCY — genuinely, and they still do — but
 * not MEMBERSHIP in either existing keyspace, which is the entire subject of
 * ruling 8. A guard that can be neutered with the tests green is an untested
 * guard.
 *
 * WHAT IS PINNED HERE, and why it is two-sided. An advisory lock's identity is
 * (key string, hash function arity) — PostgreSQL treats the one-argument and
 * two-argument forms as DISJOINT lock spaces, so matching the string while
 * using the wrong arity buys no mutual exclusion at all. Each family is
 * therefore pinned on BOTH sides:
 *
 *   (a) the W7 builder's OUTPUT equals the string the production writer
 *       produces — so renaming W7's prefix reds; and
 *   (b) the PRODUCTION source still spells its key and its lock call that way
 *       — so if the W1 writer or the plugin renames its family, this reds
 *       instead of W7 silently drifting out of the keyspace it claims to join.
 *
 * Direction matters: without (b) this would be a copy of a copy, and both
 * could drift together exactly as the contention test did.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildAttendanceW7MembershipTimelineLockKeyV1,
  buildAttendanceW7ScheduleFactsLockKeyV1,
} from '../../src/attendance/w7-resolver/w7-composite-lock-order'

const REPO_ROOT = path.resolve(__dirname, '../../../../')

const W1_WRITER = 'packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts'
const PLUGIN_ENTRY = 'plugins/plugin-attendance/index.cjs'
const W7_HELPER = 'packages/core-backend/src/attendance/w7-resolver/w7-composite-lock-order.ts'

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
}

/** ASCII Unit Separator, built from an escape — never typed as a raw byte
 *  (a literal control byte makes the whole file binary to git and grep; see
 *  `source-files-no-raw-control-bytes.test.ts`). */
const US = '\u001f'

describe('W7-1a: the membership-timeline lock key IS the W1 writer’s key', () => {
  it('the W7 builder reproduces the W1 writer’s key string exactly', () => {
    // Spelled here as the production writer spells it:
    //   `attendance-calc-timeline\u001f${input.orgId}\u001f${input.userId}`
    expect(buildAttendanceW7MembershipTimelineLockKeyV1('org-a', 'user-b')).toBe(
      `attendance-calc-timeline${US}org-a${US}user-b`,
    )
  })

  it('the W1 writer still spells that key, and still takes it in the ONE-argument keyspace', () => {
    const source = read(W1_WRITER)
    // The key template, verbatim from the writer.
    // ⚠️ RE-FORMED BY W7-1b (g1). The writer used to spell the RAW org id here.
    // W7-1a's builder keys off the CANONICAL org key, so a mixed-case spelling
    // derived two different advisory keys and the two families never excluded
    // each other — recorded by W7-1a as a W7-1b alignment obligation and fixed
    // at the WRITER, which is where the divergence was.
    //
    // The assertion is therefore STRONGER than before, not merely different: it
    // now pins that the writer canonicalises, which is the property that makes
    // the two keyspaces actually equal. Reverting the writer to `${input.orgId}`
    // reds this leg.
    expect(source).toContain('`attendance-calc-timeline\\u001f${canonicalLockOrgKeyV1(input.orgId)}`')
    expect(source).toContain('function canonicalLockOrgKeyV1(')
    // The arity is half the lock identity: one-arg `hashtextextended` is a
    // DIFFERENT lock space from the two-arg `hashtext` form.
    expect(source).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))')
  })

  it('the W7 helper takes it in that same one-argument keyspace (shared, because W7 reads)', () => {
    expect(read(W7_HELPER)).toContain(
      "await trx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))'",
    )
  })
})

describe('W7-1a: the schedule-facts lock key IS the plugin’s key', () => {
  it('the W7 builder reproduces the plugin’s key string exactly', () => {
    // Production: `attendance-schedule:${String(orgId ?? '')}` with the user id
    // as the SECOND advisory argument.
    expect(buildAttendanceW7ScheduleFactsLockKeyV1('org-a')).toBe('attendance-schedule:org-a')
  })

  it('the plugin still spells that key, and still takes it in the TWO-argument keyspace', () => {
    const source = read(PLUGIN_ENTRY)
    expect(source).toContain('`attendance-schedule:${String(orgId ?? \'\')}`')
    expect(source).toContain(
      "'SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))'",
    )
    // The exclusive writer form must also still exist — it is what the shared
    // W7 read is supposed to conflict with.
    expect(source).toContain("'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))'")
  })

  it('the W7 helper takes it in that same two-argument keyspace, org first then user', () => {
    const helper = read(W7_HELPER)
    expect(helper).toContain(
      "await trx.query('SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))'",
    )
    // Argument ORDER is part of the key: swapping org and user yields a
    // different lock in the same space.
    expect(helper).toContain('buildAttendanceW7ScheduleFactsLockKeyV1(input.orgKey),\n    input.userId,')
  })
})

describe('W7-1a: the keyspace pins are non-vacuous', () => {
  it('the two families are genuinely different key shapes (the pin is not matching everything)', () => {
    const timeline = buildAttendanceW7MembershipTimelineLockKeyV1('org-a', 'user-b')
    const schedule = buildAttendanceW7ScheduleFactsLockKeyV1('org-a')
    expect(timeline).not.toBe(schedule)
    expect(timeline).toContain(US)
    expect(schedule).not.toContain(US)
  })

  it('every pinned production file was really read (non-empty, and is the file it claims to be)', () => {
    // An unreadable or renamed path would make the `toContain` assertions above
    // throw rather than silently pass, but a TRUNCATED read would not — assert
    // size and a stable anchor so the pins cannot pass over a stub.
    for (const [rel, anchor] of [
      [W1_WRITER, 'transitionAttendanceCalculationGroupMembership'],
      [PLUGIN_ENTRY, 'acquireAttendanceScheduleAssignmentReadLock'],
      [W7_HELPER, 'acquireAttendanceW7CompositeFactsLocksV1'],
    ] as const) {
      const source = read(rel)
      expect(source.length, `${rel} is suspiciously small`).toBeGreaterThan(1000)
      expect(source, `${rel} is not the file this pin targets`).toContain(anchor)
    }
  })
})
