import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bootRecoveryArchiveRestoreWorker,
  createRecoveryArchiveRestoreWorkerFromOperations,
  isRecoveryArchiveRestoreWorkerEnabled,
  type RecoveryArchiveRestoreWorkerOperations,
} from '../../src/multitable/recovery-archive-restore-worker'
import {
  RecoveryArchiveRestoreJobError,
  type RecoveryArchiveRestoreJobCandidate,
  type RecoveryArchiveRestoreJobWorkerClaim,
} from '../../src/multitable/recovery-archive-restore-jobs'

const NOW = new Date('2026-08-29T06:00:00.000Z')
const RESUME_DEADLINE = '2026-08-29T06:10:00.000Z'

const candidate = {
  jobId: '11111111-1111-4111-8111-111111111111',
  sheetId: 'sheet-worker',
  keyId: 'key-worker',
  archiveGenerationId: '22222222-2222-4222-8222-222222222222',
  blockFence: '7',
  resumeDeadline: RESUME_DEADLINE,
} as unknown as RecoveryArchiveRestoreJobCandidate

const claim = {
  ...candidate,
  workerOwnerId: 'worker-owner',
  workerFence: '3',
  leaseUntil: '2026-08-29T06:01:00.000Z',
} as unknown as RecoveryArchiveRestoreJobWorkerClaim

function operations(
  overrides: Partial<RecoveryArchiveRestoreWorkerOperations> = {},
): RecoveryArchiveRestoreWorkerOperations {
  return {
    sweepExpired: vi.fn(async () => 0),
    select: vi.fn(async () => candidate),
    claim: vi.fn(async () => claim),
    renew: vi.fn(async (_claim, leaseUntil) => ({
      ...claim,
      leaseUntil,
    }) as RecoveryArchiveRestoreJobWorkerClaim),
    executeChunk: vi.fn(async () => ({ kind: 'no_pending_chunk' })),
    finalize: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
    ...overrides,
  }
}

function worker(ops: RecoveryArchiveRestoreWorkerOperations, maxChunksPerRun = 1000) {
  return createRecoveryArchiveRestoreWorkerFromOperations(ops, {
    leaseMs: 60_000,
    maxChunksPerRun,
    now: () => NOW,
  })
}

describe('recovery archive restore worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sweeps first and stays idle when no durable job is claimable', async () => {
    const calls: string[] = []
    const ops = operations({
      sweepExpired: vi.fn(async () => {
        calls.push('sweep')
        return 2
      }),
      select: vi.fn(async () => {
        calls.push('select')
        return null
      }),
    })

    await expect(worker(ops).runOnce()).resolves.toEqual({
      kind: 'idle',
      swept: 2,
      chunks: 0,
    })
    expect(calls).toEqual(['sweep', 'select'])
    expect(ops.claim).not.toHaveBeenCalled()
  })

  it('claims, executes chunks, renews between chunks, and finalizes only after no pending chunk', async () => {
    const calls: string[] = []
    const ops = operations({
      sweepExpired: vi.fn(async () => {
        calls.push('sweep')
        return 1
      }),
      select: vi.fn(async () => {
        calls.push('select')
        return candidate
      }),
      claim: vi.fn(async (_candidate, leaseUntil) => {
        calls.push(`claim:${leaseUntil}`)
        return claim
      }),
      executeChunk: vi.fn()
        .mockImplementationOnce(async () => {
          calls.push('chunk:0')
          return { kind: 'committed', chunkIndex: 0, completedCount: '5000' }
        })
        .mockImplementationOnce(async () => {
          calls.push('chunk:none')
          return { kind: 'no_pending_chunk' }
        }),
      renew: vi.fn(async (_claim, leaseUntil) => {
        calls.push(`renew:${leaseUntil}`)
        return { ...claim, leaseUntil } as RecoveryArchiveRestoreJobWorkerClaim
      }),
      finalize: vi.fn(async () => {
        calls.push('finalize')
      }),
    })

    await expect(worker(ops).runOnce()).resolves.toEqual({
      kind: 'completed',
      swept: 1,
      chunks: 1,
    })
    expect(calls).toEqual([
      'sweep',
      'select',
      'claim:2026-08-29T06:01:00.000Z',
      'chunk:0',
      'renew:2026-08-29T06:01:00.000Z',
      'chunk:none',
      'finalize',
    ])
    expect(ops.pause).not.toHaveBeenCalled()
    expect(ops.abandon).not.toHaveBeenCalled()
  })

  it('pauses an unknown infrastructure failure and exposes no thrown value', async () => {
    const ops = operations({
      executeChunk: vi.fn(async () => {
        throw new Error('customer-value-must-not-escape')
      }),
    })

    await expect(worker(ops).runOnce()).resolves.toEqual({
      kind: 'paused_retryable',
      swept: 0,
      chunks: 0,
    })
    expect(ops.pause).toHaveBeenCalledWith(claim)
    expect(ops.abandon).not.toHaveBeenCalled()
  })

  it.each([
    new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED'),
    new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT'),
    Object.assign(new Error('deadlock'), { code: '40P01' }),
    Object.assign(new Error('serialization'), { code: '40001' }),
    Object.assign(new Error('lock'), { code: '55P03' }),
  ])('abandons authority, archive-drift, and D1 lock-conflict failures', async (failure) => {
    const ops = operations({
      executeChunk: vi.fn(async () => {
        throw failure
      }),
    })

    await expect(worker(ops).runOnce()).resolves.toEqual({
      kind: 'abandoned',
      swept: 0,
      chunks: 0,
    })
    expect(ops.abandon).toHaveBeenCalledWith(claim)
    expect(ops.pause).not.toHaveBeenCalled()
  })

  it('does not terminalize a stale claim owned by another worker', async () => {
    const ops = operations({
      executeChunk: vi.fn(async () => {
        throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
      }),
    })

    await expect(worker(ops).runOnce()).resolves.toEqual({
      kind: 'lease_lost',
      swept: 0,
      chunks: 0,
    })
    expect(ops.pause).not.toHaveBeenCalled()
    expect(ops.abandon).not.toHaveBeenCalled()
  })

  it('stops between committed chunks without starting another destructive transaction', async () => {
    let stop = false
    const ops = operations({
      executeChunk: vi.fn(async () => {
        stop = true
        return { kind: 'committed', chunkIndex: 0, completedCount: '1' }
      }),
    })

    await expect(worker(ops).runOnce(() => stop)).resolves.toEqual({
      kind: 'stopped',
      swept: 0,
      chunks: 1,
    })
    expect(ops.executeChunk).toHaveBeenCalledTimes(1)
    expect(ops.renew).not.toHaveBeenCalled()
    expect(ops.finalize).not.toHaveBeenCalled()
  })

  it('yields after the configured bounded chunk count', async () => {
    const ops = operations({
      executeChunk: vi.fn(async () => ({ kind: 'already_committed', chunkIndex: 0 })),
    })

    await expect(worker(ops, 2).runOnce()).resolves.toEqual({
      kind: 'yielded',
      swept: 0,
      chunks: 2,
    })
    expect(ops.executeChunk).toHaveBeenCalledTimes(2)
    expect(ops.renew).toHaveBeenCalledTimes(2)
  })
})

describe('recovery archive restore worker boot', () => {
  it.each([undefined, 'false', 'TRUE', ' true '])(
    'is inert unless both archive and writer-fence flags are exact true (%s)',
    (archive) => {
      const createWorker = vi.fn()
      const schedule = vi.fn()
      expect(bootRecoveryArchiveRestoreWorker({
        env: {
          MULTITABLE_RECOVERY_ARCHIVE_ENABLED: archive,
          MULTITABLE_ENABLE_WRITER_FENCE: 'true',
        },
        intervalMs: 1000,
        createWorker,
        schedule,
      })).toBeNull()
      expect(createWorker).not.toHaveBeenCalled()
      expect(schedule).not.toHaveBeenCalled()
    },
  )

  it('also refuses archive true when the writer fence is not exact true', () => {
    expect(isRecoveryArchiveRestoreWorkerEnabled({
      MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
      MULTITABLE_ENABLE_WRITER_FENCE: 'TRUE',
    })).toBe(false)
  })

  it('starts one non-overlapping loop and stop awaits the in-flight tick', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const runOnce = vi.fn(async () => {
      await pending
      return { kind: 'idle', swept: 0, chunks: 0 } as const
    })
    let scheduled!: () => void
    const cancel = vi.fn()
    const onResult = vi.fn()
    const loop = bootRecoveryArchiveRestoreWorker({
      env: {
        MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
        MULTITABLE_ENABLE_WRITER_FENCE: 'true',
      },
      intervalMs: 1000,
      createWorker: () => ({ runOnce }),
      schedule: (tick) => {
        scheduled = tick
        return 'timer'
      },
      cancel,
      onResult,
    })
    expect(loop).not.toBeNull()
    expect(runOnce).toHaveBeenCalledTimes(1)
    scheduled()
    expect(runOnce).toHaveBeenCalledTimes(1)

    let firstStopped = false
    let secondStopped = false
    const firstStopping = loop!.stop().then(() => {
      firstStopped = true
    })
    const secondStopping = loop!.stop().then(() => {
      secondStopped = true
    })
    await Promise.resolve()
    expect(firstStopped).toBe(false)
    expect(secondStopped).toBe(false)
    expect(cancel).toHaveBeenCalledWith('timer')
    expect(cancel).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([firstStopping, secondStopping])
    expect(onResult).toHaveBeenCalledWith({ kind: 'idle', swept: 0, chunks: 0 })
    await expect(loop!.tick()).resolves.toBeNull()
  })
})
