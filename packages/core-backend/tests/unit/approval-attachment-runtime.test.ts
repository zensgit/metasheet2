/**
 * Approval attachment runtime boot — flag gate, O3 storage disposition, fail-closed probe, worker
 * timer wiring (#4195 §7/§9). The production predicates behind the DI seams (participant visibility,
 * hidden gate, template access, bind) are exercised by the real-DB pipeline suite; this lane pins the
 * BOOT semantics: flag OFF = null, prod = s3-required fail-close, bad local root = throw (abort
 * startup), workers tick the real sweep/drain SQL and stop cleanly.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  bootApprovalAttachmentRuntime,
  resolveApprovalAttachmentStorage,
} from '../../src/services/approval-attachment-runtime'
import type { S3CommandSender } from '../../src/services/approval-attachment-s3'
import { APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE } from '../../src/services/approval-attachment-scan'
import { deriveStorageKey } from '../../src/services/approval-attachment-storage'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

afterEach(() => {
  vi.useRealTimers()
})

function fakeDb() {
  const queries: string[] = []
  return {
    queries,
    db: {
      query: async (sql: string) => {
        queries.push(sql)
        return { rows: [], rowCount: 0 }
      },
    },
  }
}

describe('approval attachment runtime boot', () => {
  test('flag OFF → null (nothing mounts, nothing ticks)', async () => {
    const { db, queries } = fakeDb()
    expect(await bootApprovalAttachmentRuntime({ db, logger, env: {} as NodeJS.ProcessEnv })).toBeNull()
    expect(queries).toEqual([]) // not even a probe query
  })

  test('O3 storage disposition: production resolves s3-required (fail-close), dev resolves local-fs', () => {
    expect(resolveApprovalAttachmentStorage({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).kind).toBe('s3-required')
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const local = resolveApprovalAttachmentStorage({ APPROVAL_ATTACHMENT_STORAGE_DIR: dir } as NodeJS.ProcessEnv)
    expect(local.kind).toBe('local-fs')
    expect(local.kind === 'local-fs' && local.rootDir).toBe(dir)
  })

  test('flag ON + unusable local root → boot THROWS (fail-closed startup abort)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const fileNotDir = path.join(dir, 'a-regular-file')
    writeFileSync(fileNotDir, 'not a directory')
    const { db } = fakeDb()
    await expect(
      bootApprovalAttachmentRuntime({
        db,
        logger,
        // the probe must mkdir/write UNDER a regular file → fails → the boot rejects
        env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', APPROVAL_ATTACHMENT_STORAGE_DIR: path.join(fileNotDir, 'nested') } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow()
  })

  test('scan flag ON without injected scanner → boot THROWS values-free (fail-closed; never degrades to clean)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const { db } = fakeDb()
    await expect(
      bootApprovalAttachmentRuntime({
        db,
        logger,
        env: {
          APPROVAL_ATTACHMENTS_ENABLED: 'true',
          APPROVAL_ATTACHMENT_SCAN_ENABLED: 'true',
          APPROVAL_ATTACHMENT_STORAGE_DIR: dir,
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE)
    // Values-free: fixed message only — no paths, storage roots, or secrets.
    await expect(
      bootApprovalAttachmentRuntime({
        db,
        logger,
        env: {
          APPROVAL_ATTACHMENTS_ENABLED: 'true',
          APPROVAL_ATTACHMENT_SCAN_ENABLED: 'true',
          APPROVAL_ATTACHMENT_STORAGE_DIR: dir,
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.not.toThrow(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  test('scan flag ON + injected scanner (positive control) → boot succeeds; scan OFF stays dormant without scanner', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const { db } = fakeDb()
    // Scan OFF: no scanner required (byte-compatible dormant posture).
    const dormant = await bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', APPROVAL_ATTACHMENT_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
    })
    expect(dormant).not.toBeNull()
    expect(dormant!.router).toBeTruthy()
    // Scan ON + real hook: boots (positive control for the DI seam).
    let hookCalls = 0
    const withScanner = await bootApprovalAttachmentRuntime({
      db,
      logger,
      env: {
        APPROVAL_ATTACHMENTS_ENABLED: 'true',
        APPROVAL_ATTACHMENT_SCAN_ENABLED: 'true',
        APPROVAL_ATTACHMENT_STORAGE_DIR: dir,
      } as NodeJS.ProcessEnv,
      scanHook: async () => {
        hookCalls += 1
        return 'clean'
      },
    })
    expect(withScanner).not.toBeNull()
    expect(withScanner!.router).toBeTruthy()
    // Boot itself does not scan bytes — the hook is only invoked on upload.
    expect(hookCalls).toBe(0)
  })

  test('flag ON production: mounts with the O3 fail-close posture; workers deliberately NOT started', async () => {
    const { db, queries } = fakeDb()
    const runtime = await bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    })
    expect(runtime).not.toBeNull()
    expect(runtime!.storage.kind).toBe('s3-required')
    const stop = runtime!.startWorkers()
    await new Promise((r) => setTimeout(r, 30))
    expect(queries).toEqual([]) // no store ⇒ no sweep/drain/reconcile ticks against the DB
    await stop()
  })

  test('flag ON local: workers tick the REAL sweep + drain SQL; stop() awaits active ticks then ends timers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const { db, queries } = fakeDb()
    let releaseDrain!: () => void
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    let drainStarted = false
    const runtime = await bootApprovalAttachmentRuntime({
      db: {
        query: async (sql: string) => {
          queries.push(sql)
          // Hold the purge-drain tick open so stop() must await the in-flight work.
          if (sql.includes('FOR UPDATE SKIP LOCKED')) {
            drainStarted = true
            await drainGate
          }
          return { rows: [], rowCount: 0 }
        },
      },
      logger,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', APPROVAL_ATTACHMENT_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      intervals: { gcSweepMs: 3_600_000, purgeDrainMs: 3_600_000, reconcileMs: 3_600_000 },
    })
    expect(runtime).not.toBeNull()
    expect(runtime!.router).toBeTruthy()
    const stop = runtime!.startWorkers()
    // Wait until the drain tick is in-flight, then stop WITHOUT releasing first — stop must wait.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (drainStarted) {
          clearInterval(t)
          resolve()
        }
      }, 5)
    })
    const stopPromise = stop()
    let stopDone = false
    void stopPromise.then(() => {
      stopDone = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(stopDone).toBe(false) // still awaiting the active drain tick
    releaseDrain()
    await stopPromise
    expect(stopDone).toBe(true)
    expect(queries.some((q) => q.includes("status = 'unbound'"))).toBe(true) // GC TTL sweep ran
    expect(queries.some((q) => q.includes('FOR UPDATE SKIP LOCKED'))).toBe(true) // purge-drain claim ran
    const before = queries.length
    await new Promise((r) => setTimeout(r, 30))
    expect(queries.length).toBe(before) // stopped: no further ticks
  })

  test('reconcile continuation delay accepts only safe integers in [1, 60000]', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const base = {
      db: fakeDb().db,
      logger,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', APPROVAL_ATTACHMENT_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
    }
    for (const value of [0, 60_001, 1.5, Number.NaN]) {
      await expect(bootApprovalAttachmentRuntime({
        ...base,
        intervals: { reconcileContinuationMs: value },
      })).rejects.toThrow(/reconcileContinuationMs/)
    }
    await expect(bootApprovalAttachmentRuntime({
      ...base,
      intervals: { reconcileContinuationMs: 1 },
    })).resolves.not.toBeNull()
    await expect(bootApprovalAttachmentRuntime({
      ...base,
      intervals: { reconcileContinuationMs: 60_000 },
    })).resolves.not.toBeNull()
  })

  test('S3 probe failure is values-free: raw storage error text never escapes the probe throw', async () => {
    const PROD = {
      NODE_ENV: 'production',
      APPROVAL_ATTACHMENT_S3_BUCKET: 'approval-only',
      APPROVAL_ATTACHMENT_S3_REGION: 'us-east-1',
      APPROVAL_ATTACHMENTS_ENABLED: 'true',
    } as NodeJS.ProcessEnv
    const { db } = fakeDb()
    await expect(
      bootApprovalAttachmentRuntime({
        db,
        logger,
        env: PROD,
        s3Sender: {
          send: async () => {
            throw new Error('AccessDenied bucket=secret-bucket creds=AKIASECRET')
          },
        },
      }),
    ).rejects.toThrow('Approval attachment storage probe failed')
    await expect(
      bootApprovalAttachmentRuntime({
        db,
        logger,
        env: PROD,
        s3Sender: {
          send: async () => {
            throw new Error('AccessDenied bucket=secret-bucket creds=AKIASECRET')
          },
        },
      }),
    ).rejects.not.toThrow(/secret-bucket|AKIASECRET/)
  })

  test('worker failures log the worker name without leaking raw driver or storage error values', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const warnings: string[] = []
    const runtime = await bootApprovalAttachmentRuntime({
      db: {
        query: async () => {
          throw new Error('postgresql://db-user:db-secret@internal.example:5432/private')
        },
      },
      logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', APPROVAL_ATTACHMENT_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      intervals: { gcSweepMs: 3_600_000, purgeDrainMs: 3_600_000, reconcileMs: 3_600_000 },
    })
    const stop = runtime!.startWorkers()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await stop()
    expect(warnings).toContain('Approval attachment GC sweep tick failed')
    expect(warnings).toContain('Approval attachment purge drain tick failed')
    expect(warnings.join('\n')).not.toContain('db-secret')
    expect(warnings.join('\n')).not.toContain('internal.example')
  })
})

describe('O3 built-in production S3 storage', () => {
  const PROD = {
    NODE_ENV: 'production',
    APPROVAL_ATTACHMENT_S3_BUCKET: 'approval-only',
    APPROVAL_ATTACHMENT_S3_REGION: 'us-east-1',
  } as NodeJS.ProcessEnv

  function fakeS3(): { sender: S3CommandSender; blobs: Map<string, Buffer>; commands: unknown[] } {
    const blobs = new Map<string, Buffer>()
    const commands: unknown[] = []
    return {
      blobs,
      commands,
      sender: {
        send: async (command: unknown) => {
          commands.push(command)
          if (command instanceof PutObjectCommand) {
            const key = String(command.input.Key)
            if (blobs.has(key)) throw new Error('PreconditionFailed')
            blobs.set(key, Buffer.from(command.input.Body as Uint8Array))
            return {}
          }
          if (command instanceof GetObjectCommand) {
            const bytes = blobs.get(String(command.input.Key))
            if (!bytes) throw new Error('NoSuchKey')
            return { Body: { transformToByteArray: async () => bytes } }
          }
          if (command instanceof DeleteObjectCommand) {
            blobs.delete(String(command.input.Key))
            return {}
          }
          if (command instanceof HeadObjectCommand) {
            if (!blobs.has(String(command.input.Key))) {
              throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
            }
            return {}
          }
          if (command instanceof ListObjectsV2Command) {
            return {
              IsTruncated: false,
              Contents: [...blobs.keys()].map((Key) => ({ Key, LastModified: new Date() })),
            }
          }
          throw new Error('unexpected command')
        },
      },
    }
  }

  test('NEGATIVE CONTROL: incomplete production config stays s3-required', () => {
    expect(resolveApprovalAttachmentStorage({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).kind).toBe('s3-required')
    expect(resolveApprovalAttachmentStorage({
      NODE_ENV: 'production',
      APPROVAL_ATTACHMENT_S3_BUCKET: 'approval-only',
    } as NodeJS.ProcessEnv).kind).toBe('s3-required')
  })

  test('complete production config selects the built-in S3 store and keeps keys approval-scoped', async () => {
    const { sender, blobs } = fakeS3()
    const storage = resolveApprovalAttachmentStorage(PROD, sender)
    expect(storage.kind).toBe('object-store')
    const key = deriveStorageKey('application/pdf')
    await storage.store!.put(key, Buffer.from('%PDF'))
    expect(blobs.get(key)?.toString()).toBe('%PDF')
    await expect(storage.store!.put('multitable/other.png', Buffer.from('x'))).rejects.toThrow(/outside the approval attachment scope/)
  })

  test('flag ON production probes S3 put→get-exact→list-prefix→delete, then starts workers', async () => {
    const { sender, blobs, commands } = fakeS3()
    const { db, queries } = fakeDb()
    const runtime = await bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { ...PROD, APPROVAL_ATTACHMENTS_ENABLED: 'true' },
      s3Sender: sender,
      intervals: { gcSweepMs: 3_600_000, purgeDrainMs: 3_600_000, reconcileMs: 5 },
    })
    expect(runtime!.storage.kind).toBe('object-store')
    expect(blobs.size).toBe(0) // probe cleaned up
    // Probe sequence: Put, Get (exact bytes), one bounded List, Head, Delete.
    const kinds = commands.map((command) => command.constructor.name)
    expect(kinds.filter((name) => name === 'PutObjectCommand').length).toBeGreaterThanOrEqual(1)
    expect(kinds.filter((name) => name === 'GetObjectCommand').length).toBeGreaterThanOrEqual(1)
    expect(kinds.filter((name) => name === 'ListObjectsV2Command').length).toBeGreaterThanOrEqual(1)
    expect(kinds.filter((name) => name === 'HeadObjectCommand').length).toBeGreaterThanOrEqual(1)
    expect(kinds.filter((name) => name === 'DeleteObjectCommand').length).toBeGreaterThanOrEqual(1)
    const listCmd = commands.find((command) => command instanceof ListObjectsV2Command) as ListObjectsV2Command
    expect(listCmd.input.Prefix).toBe('approval-attachments/')
    expect(listCmd.input.MaxKeys).toBe(1)
    const stop = runtime!.startWorkers()
    await new Promise((r) => setTimeout(r, 60))
    expect(queries.some((q) => q.includes("status = 'unbound'"))).toBe(true)
    expect(queries.some((q) => q.includes('FOR UPDATE SKIP LOCKED'))).toBe(true)
    expect(commands.some((command) => command instanceof ListObjectsV2Command)).toBe(true)
    await stop()
  })

  test('bounded continuation advances 3+ pages quickly, never overlaps, and stop cancels the next page', async () => {
    vi.useFakeTimers()
    const blobs = new Map<string, Buffer>()
    const objectKeys = Array.from(
      { length: 751 },
      (_, index) => `approval-attachments/2026-07/page-${String(index).padStart(4, '0')}.pdf`,
    )
    let reconciliationStarted = false
    let listCalls = 0
    let activeLists = 0
    let maxActiveLists = 0
    const sender: S3CommandSender = {
      send: async (command) => {
        if (command instanceof PutObjectCommand) {
          blobs.set(String(command.input.Key), Buffer.from(command.input.Body as Uint8Array))
          return {}
        }
        if (command instanceof GetObjectCommand) {
          const bytes = blobs.get(String(command.input.Key))
          if (!bytes) throw new Error('NoSuchKey')
          return { Body: { transformToByteArray: async () => bytes } }
        }
        if (command instanceof HeadObjectCommand) return {}
        if (command instanceof DeleteObjectCommand) {
          blobs.delete(String(command.input.Key))
          return {}
        }
        if (command instanceof ListObjectsV2Command) {
          const keys = reconciliationStarted ? objectKeys : [...blobs.keys()]
          const offset = Number(command.input.ContinuationToken ?? 0)
          const limit = Number(command.input.MaxKeys)
          if (reconciliationStarted) {
            listCalls += 1
            activeLists += 1
            maxActiveLists = Math.max(maxActiveLists, activeLists)
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            activeLists -= 1
          }
          const page = keys.slice(offset, offset + limit)
          const next = offset + page.length
          return {
            Contents: page.map((Key) => ({ Key, LastModified: new Date(0) })),
            IsTruncated: next < keys.length,
            ...(next < keys.length ? { NextContinuationToken: String(next) } : {}),
          }
        }
        throw new Error('unexpected command')
      },
    }
    const runtime = await bootApprovalAttachmentRuntime({
      db: {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('WHERE storage_key = ANY')) {
            const keys = params?.[0] as string[]
            return { rows: keys.map((storage_key) => ({ storage_key })), rowCount: keys.length }
          }
          return { rows: [], rowCount: 0 }
        },
      },
      logger,
      env: { ...PROD, APPROVAL_ATTACHMENTS_ENABLED: 'true' },
      s3Sender: sender,
      intervals: {
        gcSweepMs: 60_000,
        purgeDrainMs: 60_000,
        reconcileMs: 1_000,
        reconcileContinuationMs: 10,
      },
    })
    reconciliationStarted = true
    const stop = runtime!.startWorkers()

    await vi.advanceTimersByTimeAsync(999)
    expect(listCalls).toBe(0) // initial delayed-start semantics
    await vi.advanceTimersByTimeAsync(1)
    expect(activeLists).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(listCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(20)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(20)

    expect(listCalls).toBe(3)
    expect(maxActiveLists).toBe(1)
    const stopPromise = stop()
    await stopPromise
    await vi.advanceTimersByTimeAsync(10_000)
    expect(listCalls).toBe(3) // pending fourth-page continuation was cancelled
  })

  test('flag ON production aborts startup when the S3 boot probe fails (values-free)', async () => {
    const { db } = fakeDb()
    // Probe wraps provider errors so boot/index logs never echo raw storage text (bucket/creds).
    await expect(bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { ...PROD, APPROVAL_ATTACHMENTS_ENABLED: 'true' },
      s3Sender: { send: async () => { throw new Error('AccessDenied') } },
    })).rejects.toThrow('Approval attachment storage probe failed')
  })

  test('denied GET, LIST, or HEAD fails the production boot probe closed (values-free)', async () => {
    const { db } = fakeDb()
    // GET denied after put succeeds
    await expect(bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { ...PROD, APPROVAL_ATTACHMENTS_ENABLED: 'true' },
      s3Sender: {
        send: async (command) => {
          if (command instanceof PutObjectCommand) return {}
          if (command instanceof GetObjectCommand) throw new Error('AccessDenied GetObject')
          return {}
        },
      },
    })).rejects.toThrow('Approval attachment storage probe failed')

    // LIST denied after put+get succeed
    await expect(bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { ...PROD, APPROVAL_ATTACHMENTS_ENABLED: 'true' },
      s3Sender: {
        send: async (command) => {
          if (command instanceof PutObjectCommand) return {}
          if (command instanceof GetObjectCommand) {
            return { Body: { transformToByteArray: async () => Buffer.from('approval-attachment boot probe') } }
          }
          if (command instanceof ListObjectsV2Command) throw new Error('AccessDenied ListBucket')
          return {}
        },
      },
    })).rejects.toThrow('Approval attachment storage probe failed')

    // HEAD denied after put+get+bounded-list succeeds
    await expect(bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { ...PROD, APPROVAL_ATTACHMENTS_ENABLED: 'true' },
      s3Sender: {
        send: async (command) => {
          if (command instanceof PutObjectCommand) return {}
          if (command instanceof GetObjectCommand) {
            return { Body: { transformToByteArray: async () => Buffer.from('approval-attachment boot probe') } }
          }
          if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: false }
          if (command instanceof HeadObjectCommand) throw new Error('AccessDenied HeadObject')
          return {}
        },
      },
    })).rejects.toThrow('Approval attachment storage probe failed')
  })
})
