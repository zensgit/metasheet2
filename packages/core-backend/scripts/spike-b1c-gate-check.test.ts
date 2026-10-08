import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  B1C_CAPABILITY_POSTURE,
  B1C_CONSISTENCY_PROOF,
  B1C_CONTINUATION_LIFETIME,
  type B1cSqlServerEvidenceRecord,
} from './spike-b1c-shared'
import {
  assertEveryDeclaredCellHasEvidence,
  assertEveryDeclaredCellProven,
  computeB1cGateVerdicts,
  type B1cGateCell,
} from './spike-b1c-gate-check'

const CELL_2019: B1cGateCell = {
  dialect: 'sqlserver',
  engineMajorVersion: '2019',
  capabilityPosture: B1C_CAPABILITY_POSTURE,
}
const CELL_2022: B1cGateCell = {
  ...CELL_2019,
  engineMajorVersion: '2022',
}

function record(
  overrides: Partial<B1cSqlServerEvidenceRecord> = {},
): B1cSqlServerEvidenceRecord {
  return {
    evidenceSchemaVersion: 1,
    dialect: 'sqlserver',
    engineMajorVersion: '2019',
    capabilityPosture: B1C_CAPABILITY_POSTURE,
    outcome: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
    consistencyProof: B1C_CONSISTENCY_PROOF,
    continuationLifetime: B1C_CONTINUATION_LIFETIME,
    snapshotEnabledReadback: true,
    snapshotIsolationObserved: true,
    activeSnapshotObserved: true,
    sameSessionAcrossPages: true,
    terminalShortPageObserved: true,
    snapshotMatchesOriginal: true,
    freshStateMatchesMutated: true,
    snapshotDisabledRejected: true,
    killedSessionAbsent: true,
    connectionLossRejected: true,
    commitAfterLossRejected: true,
    cleanupComplete: true,
    lossControlTransactionFactoryCalls: 1,
    writerMutationsCommitted: 3,
    pageSize: 3,
    originalRowCount: 8,
    snapshotRowCount: 8,
    snapshotDuplicateCount: 0,
    snapshotMissingCount: 0,
    snapshotUnexpectedCount: 0,
    freshRowCount: 8,
    freshDuplicateCount: 0,
    freshMissingCount: 0,
    freshUnexpectedCount: 0,
    pageCount: 3,
    pageSessionObservationCount: 3,
    controlsTotal: 5,
    controlsPassed: 5,
    observationsTaken: 12,
    recordedAt: '2026-07-28T00:00:00Z',
    ...overrides,
  }
}

describe('B1c gate verdicts', () => {
  it('proves only a complete opening record and keeps sibling versions separate', () => {
    const verdicts = computeB1cGateVerdicts([record()], [CELL_2019, CELL_2022])
    expect(verdicts).toEqual([
      {
        ...CELL_2019,
        evidencePresent: true,
        proven: true,
        reason: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
      },
      {
        ...CELL_2022,
        evidencePresent: false,
        proven: false,
        reason: 'ABSENT',
      },
    ])
    expect(() => assertEveryDeclaredCellHasEvidence(verdicts)).toThrow(
      /1 declared cell/,
    )
    expect(() => assertEveryDeclaredCellProven(verdicts)).toThrow(
      /1 declared cell/,
    )
  })

  it.each([
    'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_UNOBTAINABLE',
    'INCONCLUSIVE',
  ] as const)('does not prove the non-opening outcome %s', (outcome) => {
    const [verdict] = computeB1cGateVerdicts(
      [record({ outcome, snapshotMatchesOriginal: false })],
      [CELL_2019],
    )
    expect(verdict.evidencePresent).toBe(true)
    expect(verdict.proven).toBe(false)
    expect(verdict.reason).toBe(outcome)
    expect(() => assertEveryDeclaredCellHasEvidence([verdict])).not.toThrow()
    expect(() => assertEveryDeclaredCellProven([verdict])).toThrow(
      /did not prove/,
    )
  })

  it('opens only when every declared cell has opening evidence', () => {
    const verdicts = computeB1cGateVerdicts(
      [record(), record({ engineMajorVersion: '2022' })],
      [CELL_2019, CELL_2022],
    )
    expect(() => assertEveryDeclaredCellProven(verdicts)).not.toThrow()
  })

  it('wires the CLI to the opening gate, with a positive control', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b1c-gate-'))
    const evidencePath = path.join(
      directory,
      'b1c-sqlserver-2019-snapshot-page-sequence.json',
    )
    const run = () =>
      spawnSync(
        path.join(process.cwd(), 'node_modules/.bin/tsx'),
        [
          path.join(process.cwd(), 'scripts/spike-b1c-gate-check.ts'),
          '--evidence-dir',
          directory,
          '--declared-cells',
          JSON.stringify([CELL_2019]),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
        },
      )
    try {
      fs.writeFileSync(evidencePath, JSON.stringify(record()))
      const opening = run()
      expect(opening.status, opening.stderr).toBe(0)

      fs.writeFileSync(
        evidencePath,
        JSON.stringify(
          record({
            outcome: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_UNOBTAINABLE',
            snapshotMatchesOriginal: false,
          }),
        ),
      )
      const nonOpening = run()
      expect(nonOpening.status).toBe(1)
      expect(nonOpening.stderr).toContain('did not prove')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects undeclared evidence, duplicate evidence, and duplicate declared cells', () => {
    expect(() =>
      computeB1cGateVerdicts(
        [record({ engineMajorVersion: '2022' })],
        [CELL_2019],
      ),
    ).toThrow(/undeclared cell/)
    expect(() =>
      computeB1cGateVerdicts([record(), record()], [CELL_2019]),
    ).toThrow(/multiple evidence/)
    expect(() =>
      computeB1cGateVerdicts([], [CELL_2019, { ...CELL_2019 }]),
    ).toThrow(/appears more than once/)
  })

  it('rejects forged opening evidence instead of trusting the outcome token', () => {
    expect(() =>
      computeB1cGateVerdicts(
        [record({ sameSessionAcrossPages: false })],
        [CELL_2019],
      ),
    ).toThrow(/complete page-sequence proof/)
    expect(() =>
      computeB1cGateVerdicts([record({ controlsPassed: 4 })], [CELL_2019]),
    ).toThrow(/every declared control/)
  })

  it('rejects empty or widened declared-cell schemas', () => {
    expect(() => computeB1cGateVerdicts([], [])).toThrow(/at least one/)
    expect(() =>
      computeB1cGateVerdicts(
        [],
        [
          {
            ...CELL_2019,
            customerScope: 'forbidden',
          } as unknown as B1cGateCell,
        ],
      ),
    ).toThrow(/closed schema/)
    expect(() =>
      computeB1cGateVerdicts([], [new Proxy(CELL_2019, {})]),
    ).toThrow(/must not be a Proxy/)
  })
})
