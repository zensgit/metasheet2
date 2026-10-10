import { Kysely, PostgresDialect } from 'kysely'
import type { Pool } from 'pg'
import { beforeEach, expect, test, vi } from 'vitest'

const control = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    guard: 'cleanup-anchor',
    refuseCleanupDown: false,
  }
  const layer = (name: string) => ({
    down: vi.fn(async () => {
      state.calls.push(`${name}:down`)
      if (name === 'cleanup-anchor') {
        if (state.refuseCleanupDown) throw new Error('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_IN_USE')
        state.guard = 'claim-anchor'
      }
    }),
    up: vi.fn(async () => {
      state.calls.push(`${name}:up`)
      if (name === 'cleanup-anchor') state.guard = 'cleanup-anchor'
    }),
  })
  return { state, layer }
})

vi.mock('../../src/db/migrations/zzzz20260918120000_add_recovery_archive_section_checkpoints', () => control.layer('checkpoints'))
vi.mock('../../src/db/migrations/zzzz20260918130000_create_recovery_archive_prepared_captures', () => control.layer('prepared'))
vi.mock('../../src/db/migrations/zzzz20260918140000_create_recovery_archive_manual_requests', () => control.layer('manual-requests'))
vi.mock('../../src/db/migrations/zzzz20260919160000_create_archive_attachment_restore_stages', () => control.layer('attachment-stages'))
vi.mock('../../src/db/migrations/zzzz20261001120000_add_archive_abandoned_object_bindings', () => control.layer('abandoned-bindings'))
vi.mock('../../src/db/migrations/zzzz20261007120000_amend_recovery_archive_cleanup_anchor', () => control.layer('cleanup-anchor'))

import { restorePreparedMigrationLayer, suspendPreparedMigrationLayer } from '../utils/recovery-prepared-migration-layer'

function port(present = true) {
  const queries: string[] = []
  const client = {
    query: async (sql: string) => {
      queries.push(sql)
      return { command: 'SELECT', rowCount: 1, rows: [{ present }] }
    },
    release: () => {},
  }
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: {
    connect: async () => client, end: async () => {},
  } as unknown as Pool }) })
  return { db, queries }
}

beforeEach(() => {
  control.state.calls.length = 0
  control.state.guard = 'cleanup-anchor'
  control.state.refuseCleanupDown = false
})

test('restores the current anchor guard after a historical claim-anchor migration rebuilds it', async () => {
  const { db } = port()
  try {
    await suspendPreparedMigrationLayer(db)
    // The older catalog/claim-anchor suite recreates the predecessor function.
    control.state.guard = 'claim-anchor'
    await restorePreparedMigrationLayer(db)
    expect(control.state.guard).toBe('cleanup-anchor')
    const calls = control.state.calls
    expect(calls.filter(call => call === 'cleanup-anchor:down')).toHaveLength(1)
    expect(calls.indexOf('cleanup-anchor:down')).toBeLessThan(calls.indexOf('abandoned-bindings:down'))
    expect(calls.filter(call => call === 'cleanup-anchor:up')).toHaveLength(1)
    expect(calls.indexOf('cleanup-anchor:up')).toBeGreaterThan(calls.lastIndexOf('abandoned-bindings:up'))
    const before = [...calls]
    await restorePreparedMigrationLayer(db)
    expect(calls).toEqual(before)
  } finally {
    await db.destroy()
  }
})

test('leaves an absent prepared layer untouched', async () => {
  const { db } = port(false)
  try {
    await suspendPreparedMigrationLayer(db)
    await restorePreparedMigrationLayer(db)
    expect(control.state.calls).toEqual([])
  } finally {
    await db.destroy()
  }
})

test('preserves a cleanup-anchor rollback refusal before dismantling older layers', async () => {
  const { db, queries } = port()
  control.state.refuseCleanupDown = true
  try {
    await expect(suspendPreparedMigrationLayer(db)).rejects.toThrow('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_IN_USE')
    expect(control.state.calls).toEqual(['cleanup-anchor:down'])
    expect(queries).toContain('rollback')
    await restorePreparedMigrationLayer(db)
    expect(control.state.calls).toEqual(['cleanup-anchor:down'])
    expect(control.state.guard).toBe('cleanup-anchor')
  } finally {
    await db.destroy()
  }
})
