import { describe, expect, it } from 'vitest'

import {
  recoveryArchiveObservability,
  registry,
} from '../../src/metrics/metrics'
import { RECOVERY_ARCHIVE_WORKER_RUN_KINDS } from '../../src/multitable/recovery-archive-observability'

describe('recovery archive Prometheus metrics', () => {
  it('exports fixed-cardinality worker and drain evidence', async () => {
    const initialExposition = await registry.metrics()
    const initialRunLines = initialExposition.split('\n').filter((line) => (
      line.startsWith('metasheet_recovery_archive_worker_runs_total{')
    ))
    expect(initialRunLines).toHaveLength(RECOVERY_ARCHIVE_WORKER_RUN_KINDS.length)
    for (const outcome of RECOVERY_ARCHIVE_WORKER_RUN_KINDS) {
      expect(initialRunLines).toContain(
        `metasheet_recovery_archive_worker_runs_total{outcome="${outcome}"} 0`,
      )
    }
    const initialDrainLines = initialExposition.split('\n').filter((line) => (
      line.startsWith('metasheet_recovery_archive_worker_drain_total{')
    ))
    expect(initialDrainLines).toEqual([
      'metasheet_recovery_archive_worker_drain_total{outcome="success"} 0',
      'metasheet_recovery_archive_worker_drain_total{outcome="failure"} 0',
    ])
    expect(initialExposition).toMatch(/^metasheet_recovery_archive_worker_running 0$/m)

    recoveryArchiveObservability.recordRun({ kind: 'completed', swept: 2, chunks: 3 })
    recoveryArchiveObservability.recordLifecycle('started')
    recoveryArchiveObservability.recordLifecycle('drained')

    const exposition = await registry.metrics()
    const runLines = exposition.split('\n').filter((line) => (
      line.startsWith('metasheet_recovery_archive_worker_runs_total{')
    ))
    expect(runLines).toHaveLength(RECOVERY_ARCHIVE_WORKER_RUN_KINDS.length)
    for (const outcome of RECOVERY_ARCHIVE_WORKER_RUN_KINDS) {
      expect(runLines).toContain(
        `metasheet_recovery_archive_worker_runs_total{outcome="${outcome}"} ${outcome === 'completed' ? 1 : 0}`,
      )
    }
    expect(exposition).toContain('metasheet_recovery_archive_worker_swept_total 2')
    expect(exposition).toContain('metasheet_recovery_archive_worker_chunks_total 3')
    expect(exposition).toContain('metasheet_recovery_archive_worker_running 0')
    expect(exposition).toContain(
      'metasheet_recovery_archive_worker_drain_total{outcome="success"} 1',
    )
    expect(exposition).toContain(
      'metasheet_recovery_archive_worker_drain_total{outcome="failure"} 0',
    )
    expect(exposition).not.toMatch(/sheetId|generationId|keyId|providerUri/)
  })
})
