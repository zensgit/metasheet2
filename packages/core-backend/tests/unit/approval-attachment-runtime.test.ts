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
import { describe, expect, test } from 'vitest'

import {
  bootApprovalAttachmentRuntime,
  resolveApprovalAttachmentStorage,
} from '../../src/services/approval-attachment-runtime'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

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
    stop()
  })

  test('flag ON local: workers tick the REAL sweep + drain SQL; stop() ends the timers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aatt-'))
    const { db, queries } = fakeDb()
    const runtime = await bootApprovalAttachmentRuntime({
      db,
      logger,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', APPROVAL_ATTACHMENT_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      intervals: { gcSweepMs: 3_600_000, purgeDrainMs: 3_600_000, reconcileMs: 3_600_000 },
    })
    expect(runtime).not.toBeNull()
    expect(runtime!.router).toBeTruthy()
    const stop = runtime!.startWorkers()
    await new Promise((r) => setTimeout(r, 50)) // initial ticks are immediate (interval-independent)
    expect(queries.some((q) => q.includes("status = 'unbound'"))).toBe(true) // GC TTL sweep ran
    expect(queries.some((q) => q.includes('FOR UPDATE SKIP LOCKED'))).toBe(true) // purge-drain claim ran
    const before = queries.length
    stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(queries.length).toBe(before) // stopped: no further ticks
  })
})
