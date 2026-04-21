import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createCoreBackendMigrationProvider } from '../../src/db/migration-provider'

const tempRoots: string[] = []

async function createTempProjectRoot() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'metasheet2-migration-provider-')
  )
  tempRoots.push(tempRoot)
  return tempRoot
}

async function writeFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents, 'utf8')
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true }))
  )
})

describe('createCoreBackendMigrationProvider', () => {
  it('loads code migrations plus sql migrations from source-style runtime paths', async () => {
    const projectRoot = await createTempProjectRoot()
    const runtimeDir = path.join(projectRoot, 'src/db')
    const sourceMigrationsDir = path.join(runtimeDir, 'migrations')
    const legacySqlDir = path.join(projectRoot, 'migrations')

    await writeFile(
      path.join(sourceMigrationsDir, '20260101000000_code.mjs'),
      'export async function up() {}\n'
    )
    await writeFile(
      path.join(sourceMigrationsDir, '20260101000001_local.sql'),
      'select 1;'
    )
    await writeFile(
      path.join(legacySqlDir, '056_add_users_must_change_password.sql'),
      'alter table users add column must_change_password boolean not null default false;'
    )
    await writeFile(path.join(legacySqlDir, '.ignored.sql'), 'select 2;')

    const provider = createCoreBackendMigrationProvider({ runtimeDir })
    const migrations = await provider.getMigrations()

    expect(Object.keys(migrations).sort()).toEqual([
      '056_add_users_must_change_password',
      '20260101000000_code',
      '20260101000001_local',
    ])
    expect(typeof migrations['056_add_users_must_change_password']?.up).toBe('function')
    expect(typeof migrations['20260101000000_code']?.up).toBe('function')
  })

  it('loads legacy sql migrations from dist-style runtime paths', async () => {
    const projectRoot = await createTempProjectRoot()
    const runtimeDir = path.join(projectRoot, 'dist/src/db')
    const distMigrationsDir = path.join(runtimeDir, 'migrations')
    const sourceSqlDir = path.join(projectRoot, 'src/db/migrations')
    const legacySqlDir = path.join(projectRoot, 'migrations')

    await writeFile(
      path.join(distMigrationsDir, '20260101000002_code.mjs'),
      'export async function up() {}\n'
    )
    await writeFile(
      path.join(sourceSqlDir, '20250925_create_view_tables.sql'),
      'create table if not exists views (id uuid primary key);'
    )
    await writeFile(
      path.join(legacySqlDir, '056_add_users_must_change_password.sql'),
      'alter table users add column must_change_password boolean not null default false;'
    )

    const provider = createCoreBackendMigrationProvider({ runtimeDir })
    const migrations = await provider.getMigrations()

    expect(Object.keys(migrations).sort()).toEqual([
      '056_add_users_must_change_password',
      '20250925_create_view_tables',
      '20260101000002_code',
    ])
  })

  it('honors MIGRATION_EXCLUDE-style names with or without file extensions', async () => {
    const projectRoot = await createTempProjectRoot()
    const runtimeDir = path.join(projectRoot, 'src/db')
    const sourceMigrationsDir = path.join(runtimeDir, 'migrations')
    const legacySqlDir = path.join(projectRoot, 'migrations')

    await writeFile(
      path.join(sourceMigrationsDir, '20260101000000_code.mjs'),
      'export async function up() {}\n'
    )
    await writeFile(
      path.join(legacySqlDir, '056_add_users_must_change_password.sql'),
      'alter table users add column must_change_password boolean not null default false;'
    )

    const provider = createCoreBackendMigrationProvider({
      runtimeDir,
      excludedNames: ['056_add_users_must_change_password.sql', '20260101000000_code.ts'],
    })
    const migrations = await provider.getMigrations()

    expect(Object.keys(migrations)).toEqual([])
  })

  it('fails fast on duplicate migration names across providers', async () => {
    const projectRoot = await createTempProjectRoot()
    const runtimeDir = path.join(projectRoot, 'src/db')
    const sourceMigrationsDir = path.join(runtimeDir, 'migrations')
    const legacySqlDir = path.join(projectRoot, 'migrations')

    await writeFile(
      path.join(sourceMigrationsDir, '056_add_users_must_change_password.sql'),
      'select 1;'
    )
    await writeFile(
      path.join(legacySqlDir, '056_add_users_must_change_password.sql'),
      'select 2;'
    )

    const provider = createCoreBackendMigrationProvider({ runtimeDir })

    await expect(provider.getMigrations()).rejects.toThrow(
      'Duplicate migration name detected: 056_add_users_must_change_password'
    )
  })
})
