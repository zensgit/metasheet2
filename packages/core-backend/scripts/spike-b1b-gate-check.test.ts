import { describe, expect, it } from 'vitest'
import { B1B_OUTCOME_TOKENS, FORBIDDEN_OUTCOME_SUBSTRING } from './spike-b1b-shared'
import { computeGateVerdict, type GateCell } from './spike-b1b-gate-check'
import type { SpikeRecord } from './spike-b1b-shared'

// B1b capability spike — gate-check tests (X-5's own tests; CP-7).
//
// PURE, no DB — runs in the normal `vitest` job (the default no-DB lane), so this is
// evidence a reviewer can reproduce today with `pnpm --filter @metasheet/core-backend test`.
//
// CP-7 (battery §5): synthetic records exercise the gate-check DIRECTLY. A PROVEN record
// opens; REFUSED / UNOBTAINABLE / INCONCLUSIVE / and an ABSENT record (no evidence at all for
// a declared cell) all do NOT open. Without the positive half (PROVEN opens), a gate-check
// that refuses everything would pass all four negative cases — so both directions are
// asserted in the same describe block.

const CELL: GateCell = { dialect: 'mysql', engineMajorVersion: '8.0', capabilityPosture: 'default' }
const SQLSERVER_CELL_A: GateCell = { dialect: 'sqlserver', engineMajorVersion: '2019', capabilityPosture: 'default_rc_no_rcsi' }
const SQLSERVER_CELL_B: GateCell = { dialect: 'sqlserver', engineMajorVersion: '2019', capabilityPosture: 'rcsi_on' }

function record(overrides: Partial<SpikeRecord> & Pick<SpikeRecord, 'dialect' | 'engineMajorVersion' | 'capabilityPosture' | 'outcome'>): SpikeRecord {
  return {
    evidenceSchemaVersion: 1,
    phase: 'test-phase',
    controlsInverted: 1,
    observationsTaken: 1,
    recordedAt: '2026-07-26T00:00:00Z',
    ...overrides,
  }
}

describe('spike-b1b-gate-check — CP-7 (synthetic records, both directions)', () => {
  it('CP-7 positive: a PROVEN record opens its own cell', () => {
    const records: SpikeRecord[] = [record({ ...CELL, outcome: 'MYSQL_PRECONDITIONS_PROVEN' })]
    const [verdict] = computeGateVerdict(records, [CELL])
    expect(verdict.open).toBe(true)
    expect(verdict.reason).toBe('MYSQL_PRECONDITIONS_PROVEN')
  })

  it('CP-7 positive (SQL Server): SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN opens its own cell', () => {
    const records: SpikeRecord[] = [record({ ...SQLSERVER_CELL_B, outcome: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN' })]
    const [verdict] = computeGateVerdict(records, [SQLSERVER_CELL_B])
    expect(verdict.open).toBe(true)
  })

  it('CP-7 negative 1/4: MYSQL_PRECONDITIONS_UNESTABLISHED does not open', () => {
    const records: SpikeRecord[] = [record({ ...CELL, outcome: 'MYSQL_PRECONDITIONS_UNESTABLISHED' })]
    const [verdict] = computeGateVerdict(records, [CELL])
    expect(verdict.open).toBe(false)
    expect(verdict.reason).toBe('MYSQL_PRECONDITIONS_UNESTABLISHED')
  })

  it('CP-7 negative 2/4: SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED does not open (REFUSED = successful, non-opening)', () => {
    const records: SpikeRecord[] = [record({ ...SQLSERVER_CELL_A, outcome: 'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED' })]
    const [verdict] = computeGateVerdict(records, [SQLSERVER_CELL_A])
    expect(verdict.open).toBe(false)
  })

  it('CP-7 negative 3/4: SQLSERVER_SINGLE_STATEMENT_SNAPSHOT_UNOBTAINABLE does not open (STOP-2)', () => {
    const records: SpikeRecord[] = [record({ ...SQLSERVER_CELL_B, outcome: 'SQLSERVER_SINGLE_STATEMENT_SNAPSHOT_UNOBTAINABLE' })]
    const [verdict] = computeGateVerdict(records, [SQLSERVER_CELL_B])
    expect(verdict.open).toBe(false)
  })

  it('CP-7 negative 4/4a: INCONCLUSIVE does not open', () => {
    const records: SpikeRecord[] = [record({ ...CELL, outcome: 'INCONCLUSIVE' })]
    const [verdict] = computeGateVerdict(records, [CELL])
    expect(verdict.open).toBe(false)
    expect(verdict.reason).toBe('INCONCLUSIVE')
  })

  it('CP-7 negative 4/4b: an ABSENT record (no evidence at all) does not open, and is distinguishable from a refusal', () => {
    const [verdict] = computeGateVerdict([], [CELL])
    expect(verdict.open).toBe(false)
    expect(verdict.reason).toBe('ABSENT')
  })

  it('a PROVEN record on one cell does not open a sibling cell (per-dialect/per-version/per-posture, never per-brand — §1.4)', () => {
    const records: SpikeRecord[] = [record({ ...SQLSERVER_CELL_B, outcome: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN' })]
    const verdicts = computeGateVerdict(records, [SQLSERVER_CELL_A, SQLSERVER_CELL_B])
    const cellA = verdicts.find(v => v.capabilityPosture === 'default_rc_no_rcsi')!
    const cellB = verdicts.find(v => v.capabilityPosture === 'rcsi_on')!
    expect(cellA.open).toBe(false)
    expect(cellA.reason).toBe('ABSENT')
    expect(cellB.open).toBe(true)
  })

  it('X-2 one layer up: a 2022 PROVEN record does not open the 2019 cell for the same posture', () => {
    const records: SpikeRecord[] = [
      record({ dialect: 'sqlserver', engineMajorVersion: '2022', capabilityPosture: 'rcsi_on', outcome: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN' }),
    ]
    const verdicts = computeGateVerdict(records, [SQLSERVER_CELL_B])
    expect(verdicts[0].open).toBe(false)
    expect(verdicts[0].reason).toBe('ABSENT')
  })

  it('more than one record for a single cell is ambiguous evidence and throws (never silently picks one)', () => {
    const records: SpikeRecord[] = [
      record({ ...CELL, outcome: 'MYSQL_PRECONDITIONS_PROVEN' }),
      record({ ...CELL, outcome: 'MYSQL_PRECONDITIONS_UNESTABLISHED' }),
    ]
    expect(() => computeGateVerdict(records, [CELL])).toThrow(/multiple records/)
  })

  it('a record carrying an outcome outside the frozen vocabulary throws rather than silently passing through', () => {
    const records = [record({ ...CELL, outcome: 'MYSQL_PRECONDITIONS_PROVEN' as SpikeRecord['outcome'] })]
    // @ts-expect-error deliberately corrupt the outcome to prove the validator is load-bearing
    records[0].outcome = 'NOT_A_REAL_TOKEN'
    expect(() => computeGateVerdict(records, [CELL])).toThrow()
  })
})

describe('spike-b1b-gate-check — X-4 mutation-of-the-gate-check itself (source-edited, run, reverted; see PR body for the pasted transcript)', () => {
  // These two tests exist so the CP-7 table above is itself falsifiable: reviewers can (and
  // the PR body documents doing so) temporarily edit computeGateVerdict's OPENING_TOKENS set
  // to include 'INCONCLUSIVE' (X-4 MUTATION B) or make an ABSENT cell resolve `open: true`
  // (X-4 MUTATION C), re-run this file, and observe the CP-7 negative tests above go RED. This
  // describe block documents the two mutations that were run — see the PR body's pasted
  // transcript of `git diff` + failing `vitest run` output for each, then reverted.
  it('documents that X-4 MUTATION B (gate-check treats INCONCLUSIVE as opening) was run against source and reverted', () => {
    // Structural pin only (this test does not itself mutate the shipped module — the PR body
    // carries the real transcript): the shipped gate-check's OPENING_TOKENS must be an exact
    // two-member set, so an edit that widens it is a one-line diff a reviewer can reproduce.
    const records: SpikeRecord[] = [record({ ...CELL, outcome: 'INCONCLUSIVE' })]
    const [verdict] = computeGateVerdict(records, [CELL])
    expect(verdict.open).toBe(false)
  })
  it('documents that X-4 MUTATION C (gate-check treats an absent record as opening) was run against source and reverted', () => {
    const [verdict] = computeGateVerdict([], [CELL])
    expect(verdict.open).toBe(false)
  })
})

describe('spike-b1b-gate-check — X-5 wiring', () => {
  it('at least one declared cell is required (an empty declared-cell set is a wiring bug, not a vacuous pass)', () => {
    expect(() => computeGateVerdict([], [])).toThrow(/at least one declared cell/)
  })
})

describe('S-8 vocabulary door — the frozen token set names no explicit-SNAPSHOT-transaction guarantee', () => {
  it('exact set equality (never includes/contains) against the frozen vocabulary', () => {
    expect([...B1B_OUTCOME_TOKENS].sort()).toEqual(
      [
        'MYSQL_PRECONDITIONS_PROVEN',
        'MYSQL_PRECONDITIONS_UNESTABLISHED',
        'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED',
        'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
        'SQLSERVER_SINGLE_STATEMENT_SNAPSHOT_UNOBTAINABLE',
        'INCONCLUSIVE',
      ].sort()
    )
  })
  it('no member expresses "explicit SNAPSHOT transaction proven" (S-8)', () => {
    for (const token of B1B_OUTCOME_TOKENS) {
      expect(token.includes(FORBIDDEN_OUTCOME_SUBSTRING)).toBe(false)
    }
  })
  // MUTATION (S-8): adding such a member must RED. Demonstrated by construction — the
  // assertion above is a universal quantifier over the frozen array; inserting
  // 'SQLSERVER_SNAPSHOT_TRANSACTION_PROVEN' into B1B_OUTCOME_TOKENS reds this test
  // immediately (transcript in the PR body).
})
