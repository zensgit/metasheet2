import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  admitRecoveryLocalBackupAdminUrl,
  assertOwnedPrivateDirectory,
  assertOwnedDatabaseIdentity,
  admitRecoveryLocalBackupWorkRoot,
  assertDistinctDirectoryIdentities,
  parseRecoveryLocalBackupCli,
  recoveryLocalBackupDatabaseNames,
  recoveryLocalBackupDatabaseUrl,
  recoveryLocalBackupPgEnv,
} from '../utils/recovery-local-backup-driver-safety'

describe('local backup-set acceptance driver safety', () => {
  test('refuses cleanup of a replaced, unowned or missing database', () => {
    const owned = { oid: '17001', owner: 'tm_backup_owner' }
    expect(() => assertOwnedDatabaseIdentity(owned, { ...owned })).not.toThrow()
    for (const current of [undefined, { ...owned, oid: '17002' }, { ...owned, owner: 'other' }]) {
      expect(() => assertOwnedDatabaseIdentity(owned, current)).toThrow('RECOVERY_LOCAL_BACKUP_DATABASE_IDENTITY_REFUSED')
    }
    expect(() => assertOwnedDatabaseIdentity(undefined, owned)).toThrow('RECOVERY_LOCAL_BACKUP_DATABASE_IDENTITY_REFUSED')
  })
  test('admits only an explicit nonstandard loopback postgres maintenance URL', () => {
    const admitted = admitRecoveryLocalBackupAdminUrl('postgresql://tm_backup_owner:secret@127.0.0.1:55469/postgres')
    expect(admitted.hostname).toBe('127.0.0.1')
    expect(admitted.port).toBe('55469')
    expect(admitted.pathname).toBe('/postgres')

    for (const value of [
      'postgresql://tm_backup_owner@db.internal:55469/postgres',
      'postgresql://tm_backup_owner@127.0.0.1:5432/postgres',
      'postgresql://tm_backup_owner@127.0.0.1:55469/shared',
      'postgresql://tm_backup_owner@127.0.0.1:55469/postgres?sslmode=disable',
      'postgresql://owner@127.0.0.1:55469/postgres',
      'postgresql://127.0.0.1:55469/postgres',
    ]) {
      expect(() => admitRecoveryLocalBackupAdminUrl(value)).toThrow('RECOVERY_LOCAL_BACKUP_ADMIN_REFUSED')
    }
  })

  test('requires all explicit arguments exactly once and refuses DATABASE_URL-shaped positional input', () => {
    const parsed = parseRecoveryLocalBackupCli([
      '--admin-url', 'postgresql://tm_backup_owner@127.0.0.1:55469/postgres',
      '--pgdata', '/private/tmp/tm-local-backup-pg-0gAhRA',
      '--work-root', '/private/tmp/tm-local-backup-run-example',
    ])
    expect(parsed.pgdata).toBe('/private/tmp/tm-local-backup-pg-0gAhRA')
    expect(parsed.workRoot).toBe('/private/tmp/tm-local-backup-run-example')
    expect(() => parseRecoveryLocalBackupCli(['postgresql://tm_backup_owner@127.0.0.1:55469/postgres']))
      .toThrow('RECOVERY_LOCAL_BACKUP_CLI_REFUSED')
    expect(() => parseRecoveryLocalBackupCli([
      '--admin-url', 'postgresql://tm_backup_owner@127.0.0.1:55469/postgres',
      '--admin-url', 'postgresql://tm_backup_owner@127.0.0.1:55469/postgres',
      '--pgdata', '/private/tmp/tm-local-backup-pg-0gAhRA',
    ])).toThrow('RECOVERY_LOCAL_BACKUP_CLI_REFUSED')
  })

  test('bounds the run root without requiring a separate physical device', () => {
    expect(admitRecoveryLocalBackupWorkRoot('/private/tmp/tm-local-backup-run-example'))
      .toBe('/private/tmp/tm-local-backup-run-example')
    expect(() => admitRecoveryLocalBackupWorkRoot('/tmp/tm-local-backup-run-example'))
      .toThrow('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
    expect(() => assertDistinctDirectoryIdentities(
      { realPath: '/private/tmp/source', dev: 1n, ino: 2n },
      { realPath: '/private/tmp/target', dev: 1n, ino: 3n },
    )).not.toThrow()
    expect(() => assertDistinctDirectoryIdentities(
      { realPath: '/private/tmp/source', dev: 1n, ino: 2n },
      { realPath: '/private/tmp/other', dev: 1n, ino: 2n },
    )).toThrow('RECOVERY_LOCAL_BACKUP_PATH_IDENTITY_REFUSED')
  })

  test('rejects final-component and parent-component symlink aliases', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tm-local-backup-safety-')))
    const real = join(root, 'real')
    const finalAlias = join(root, 'final-alias')
    const parentAlias = `${root}-parent-alias`
    try {
      await mkdir(real, { mode: 0o700 })
      await symlink(real, finalAlias)
      await symlink(root, parentAlias)
      await expect(assertOwnedPrivateDirectory(real)).resolves.toMatchObject({ realPath: real })
      await expect(assertOwnedPrivateDirectory(finalAlias)).rejects.toThrow('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
      await expect(assertOwnedPrivateDirectory(join(parentAlias, 'real'))).rejects.toThrow('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
    } finally {
      await rm(parentAlias, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  test('derives bounded database names and subprocess PG environment without a database URL argument', () => {
    const names = recoveryLocalBackupDatabaseNames('0123456789abcdef')
    expect(names).toEqual({
      source: 'tm_local_backup_0123456789abcdef_source',
      target: 'tm_local_backup_0123456789abcdef_target',
    })
    const target = recoveryLocalBackupDatabaseUrl(
      new URL('postgresql://tm_backup_owner:secret@127.0.0.1:55469/postgres'),
      names.target,
    )
    expect(recoveryLocalBackupPgEnv(target)).toEqual({
      PGDATABASE: names.target,
      PGHOST: '127.0.0.1',
      PGPORT: '55469',
      PGUSER: 'tm_backup_owner',
      PGPASSWORD: 'secret',
    })
  })
})
