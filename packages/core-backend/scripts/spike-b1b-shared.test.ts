import { describe, expect, it } from 'vitest'
import { DeclaredPhaseTracker, MutationLog, assertRowLabel, evidenceFileName, isOutcomeToken } from './spike-b1b-shared'

// B1b capability spike — pure, DB-free tests for the shared harness mechanics (X-3's own
// mutations, which are engine-agnostic and therefore cheap to prove here rather than only
// against a live MySQL/SQL Server container).

describe('DeclaredPhaseTracker — X-3 (exactly one token per declared phase, frozen vocabulary)', () => {
  it('baseline: every declared phase emits once -> finalize() returns the full map', () => {
    const tracker = new DeclaredPhaseTracker(['phaseA', 'phaseB'])
    tracker.emit('phaseA', 'INCONCLUSIVE')
    tracker.emit('phaseB', 'MYSQL_PRECONDITIONS_PROVEN')
    const result = tracker.finalize()
    expect(result.get('phaseA')).toBe('INCONCLUSIVE')
    expect(result.get('phaseB')).toBe('MYSQL_PRECONDITIONS_PROVEN')
  })

  it('MUTATION A: a token outside the frozen vocabulary throws', () => {
    const tracker = new DeclaredPhaseTracker(['phaseA'])
    expect(() => tracker.emit('phaseA', 'NOT_A_REAL_TOKEN' as never)).toThrow(/frozen vocabulary/)
  })

  it('MUTATION B: a phase emitting a second token throws (exactly one per phase)', () => {
    const tracker = new DeclaredPhaseTracker(['phaseA'])
    tracker.emit('phaseA', 'INCONCLUSIVE')
    expect(() => tracker.emit('phaseA', 'MYSQL_PRECONDITIONS_PROVEN')).toThrow(/already emitted/)
  })

  it('MUTATION C: an emitter that throws before writing its token reds the RUN via finalize() — "missing phase" is distinguishable from a silent pass', () => {
    const tracker = new DeclaredPhaseTracker(['phaseA', 'phaseB'])

    function runPhase(phase: string, body: () => void): void {
      // The shape every real caller (spike-b1b-mysql.ts / spike-b1b-sqlserver.ts) must use:
      // finalize() runs in a `finally` OUTSIDE this per-phase try, at the end of the whole
      // run — this helper only demonstrates that a mid-phase throw does not call emit().
      body()
    }

    expect(() => {
      try {
        runPhase('phaseA', () => tracker.emit('phaseA', 'INCONCLUSIVE'))
        runPhase('phaseB', () => {
          throw new Error('boom — simulated emitter failure before emit() runs')
        })
      } finally {
        tracker.finalize()
      }
    }).toThrow(/missing phase record\(s\): phaseB/)
  })

  it('an undeclared phase cannot emit (declaring the phase set up front is load-bearing)', () => {
    const tracker = new DeclaredPhaseTracker(['phaseA'])
    expect(() => tracker.emit('phaseZ', 'INCONCLUSIVE')).toThrow(/undeclared phase/)
  })

  it('declaring a phase twice is a wiring bug, refused at construction', () => {
    expect(() => new DeclaredPhaseTracker(['phaseA', 'phaseA'])).toThrow(/declared twice/)
  })

  it('an empty declared-phase set is refused (never a vacuously-satisfiable tracker)', () => {
    expect(() => new DeclaredPhaseTracker([])).toThrow(/at least one declared phase/)
  })
})

describe('MutationLog — baseline/mutated pairing (§1.3: a control that fails to invert reds the run)', () => {
  it('a mutation that reds as expected records PASS', () => {
    const log = new MutationLog()
    const ok = log.check('M-3-discriminating', 'READ UNCOMMITTED must red the >= READ COMMITTED assertion', 'RED', false)
    expect(ok).toBe(true)
    expect(log.summary()).toEqual({ total: 1, passed: 1, failed: 0 })
  })

  it('a baseline that stays green as expected records PASS', () => {
    const log = new MutationLog()
    const ok = log.check('M-1-baseline', 'InnoDB table reports InnoDB', 'GREEN', true)
    expect(ok).toBe(true)
  })

  it('a control that fails to invert (still GREEN when RED was expected) records FAIL and assertAllPassed() throws', () => {
    const log = new MutationLog()
    log.check('M-3-discriminating', 'a broken guard that never reds', 'RED', /* holds= */ true)
    expect(log.summary()).toEqual({ total: 1, passed: 0, failed: 1 })
    expect(() => log.assertAllPassed('mysql')).toThrow(/1 mutation\(s\)\/control\(s\) failed to invert/)
  })

  it('assertAllPassed() is silent when every entry passed', () => {
    const log = new MutationLog()
    log.check('a', 'x', 'GREEN', true)
    log.check('b', 'y', 'RED', false)
    expect(() => log.assertAllPassed('mysql')).not.toThrow()
  })
})

describe('values-free row-label discipline (§6.1/§6.2)', () => {
  it('accepts only the three closed labels', () => {
    expect(assertRowLabel('COMMITTED_ROW')).toBe('COMMITTED_ROW')
    expect(assertRowLabel('PRE_IMAGE')).toBe('PRE_IMAGE')
    expect(assertRowLabel('POST_IMAGE')).toBe('POST_IMAGE')
  })
  it('rejects anything outside the closed vocabulary (the type system already prevents most of this; the runtime guard is the belt for a JS caller)', () => {
    expect(() => assertRowLabel('some_actual_value' as never)).toThrow(/closed vocabulary/)
  })
})

describe('isOutcomeToken / evidenceFileName', () => {
  it('rejects non-member strings', () => {
    expect(isOutcomeToken('MYSQL_PRECONDITIONS_PROVEN')).toBe(true)
    expect(isOutcomeToken('mysql_preconditions_proven')).toBe(false)
    expect(isOutcomeToken('')).toBe(false)
  })
  it('sanitizes version/phase labels into a safe filename without colliding dialects or phases', () => {
    expect(evidenceFileName('mysql', '8.0', 'preconditions')).toBe('mysql-8.0-preconditions.json')
    expect(evidenceFileName('sqlserver', '2019', 'phaseA')).toBe('sqlserver-2019-phaseA.json')
    expect(evidenceFileName('sqlserver', '2019', 'phaseB')).toBe('sqlserver-2019-phaseB.json')
  })
})
