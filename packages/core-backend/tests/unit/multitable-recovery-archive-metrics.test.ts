import { describe, expect, it } from 'vitest'

import {
  recoveryArchiveObservability,
  registry,
} from '../../src/metrics/metrics'

describe('recovery archive Prometheus metrics', () => {
  it('exports fixed-cardinality worker and drain evidence', async () => {
    recoveryArchiveObservability.recordRun({ kind: 'completed', swept: 2, chunks: 3 })
    recoveryArchiveObservability.recordLifecycle('started')
    recoveryArchiveObservability.recordLifecycle('drained')

    const exposition = await registry.metrics()
    expect(exposition).toContain(
      'metasheet_recovery_archive_worker_runs_total{outcome="completed"} 1',
    )
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
