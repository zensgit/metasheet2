import { describe, expect, it, vi } from 'vitest'

import {
  createRecoveryArchiveObservability,
  RECOVERY_ARCHIVE_WORKER_RUN_KINDS,
} from '../../src/multitable/recovery-archive-observability'

describe('recovery archive operational observability', () => {
  it('records only closed worker outcomes and aggregate counts', () => {
    const sink = fakeSink()
    const observer = createRecoveryArchiveObservability(sink)

    observer.recordRun({ kind: 'completed', swept: 2, chunks: 3 })

    expect(sink.incrementRun).toHaveBeenCalledWith('completed')
    expect(sink.incrementSwept).toHaveBeenCalledWith(2)
    expect(sink.incrementChunks).toHaveBeenCalledWith(3)
    expect(RECOVERY_ARCHIVE_WORKER_RUN_KINDS).toContain('completed')
  })

  it.each([
    [{ kind: 'unknown', swept: 0, chunks: 0 }, 'unknown outcome'],
    [{ kind: 'completed', swept: -1, chunks: 0 }, 'negative sweep count'],
    [{ kind: 'completed', swept: 0, chunks: 1.5 }, 'fractional chunk count'],
    [{ kind: 'completed', swept: 0, chunks: 0, sheetId: 'sensitive' }, 'extra key'],
  ])('rejects %s (%s) without recording a success', (input) => {
    const sink = fakeSink()
    const observer = createRecoveryArchiveObservability(sink)

    expect(() => observer.recordRun(input as never)).toThrow(
      'RECOVERY_ARCHIVE_OBSERVABILITY_INVALID_RUN_RESULT',
    )

    expect(sink.incrementRun).not.toHaveBeenCalled()
    expect(sink.incrementSwept).not.toHaveBeenCalled()
    expect(sink.incrementChunks).not.toHaveBeenCalled()
  })

  it('tracks start, successful drain, and failed drain without dynamic labels', () => {
    const sink = fakeSink()
    const observer = createRecoveryArchiveObservability(sink)

    observer.recordLifecycle('started')
    observer.recordLifecycle('drained')
    observer.recordLifecycle('started')
    observer.recordLifecycle('drain_failed')

    expect(sink.setRunning.mock.calls).toEqual([[1], [0], [1]])
    expect(sink.incrementDrain.mock.calls).toEqual([['success'], ['failure']])
  })

  it('fails closed on an unknown lifecycle event', () => {
    const sink = fakeSink()
    const observer = createRecoveryArchiveObservability(sink)

    expect(() => observer.recordLifecycle('sheet-sensitive' as never)).toThrow(
      'RECOVERY_ARCHIVE_OBSERVABILITY_INVALID_LIFECYCLE',
    )
    expect(sink.setRunning).not.toHaveBeenCalled()
    expect(sink.incrementDrain).not.toHaveBeenCalled()
  })
})

function fakeSink() {
  return {
    incrementRun: vi.fn(),
    incrementSwept: vi.fn(),
    incrementChunks: vi.fn(),
    setRunning: vi.fn(),
    incrementDrain: vi.fn(),
  }
}
