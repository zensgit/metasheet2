import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1'])
const DISALLOWED_PORTS = new Set(['5432', '5433', '5435'])

export function assertOwnedDatabaseIdentity(
  expected: { readonly oid: string; readonly owner: string } | undefined,
  current: { readonly oid?: unknown; readonly owner?: unknown } | undefined,
): void {
  if (!expected || !current || !/^[1-9][0-9]*$/.test(expected.oid)
    || expected.owner !== 'tm_backup_owner'
    || current.oid !== expected.oid || current.owner !== expected.owner) {
    throw new Error('RECOVERY_LOCAL_BACKUP_DATABASE_IDENTITY_REFUSED')
  }
}

export interface RecoveryLocalBackupCliOptions {
  readonly adminUrl: URL
  readonly pgdata: string
  readonly workRoot: string
}

export function parseRecoveryLocalBackupCli(argv: readonly string[]): RecoveryLocalBackupCliOptions {
  const values = new Map<string, string>()
  const allowed = new Set(['--admin-url', '--pgdata', '--work-root'])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag || !allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) {
      throw new Error('RECOVERY_LOCAL_BACKUP_CLI_REFUSED')
    }
    values.set(flag, value)
  }
  if (argv.length !== allowed.size * 2 || values.size !== allowed.size) {
    throw new Error('RECOVERY_LOCAL_BACKUP_CLI_REFUSED')
  }

  const adminUrl = admitRecoveryLocalBackupAdminUrl(values.get('--admin-url')!)
  const pgdata = admitRecoveryLocalBackupPgdata(values.get('--pgdata')!)
  const workRoot = admitRecoveryLocalBackupWorkRoot(values.get('--work-root')!)
  if (pgdata === workRoot || pathContains(pgdata, workRoot) || pathContains(workRoot, pgdata)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
  }
  return Object.freeze({ adminUrl, pgdata, workRoot })
}

export function admitRecoveryLocalBackupAdminUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('RECOVERY_LOCAL_BACKUP_ADMIN_REFUSED')
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !url.port ||
    DISALLOWED_PORTS.has(url.port) ||
    url.pathname !== '/postgres' ||
    decodeURIComponent(url.username) !== 'tm_backup_owner' ||
    url.hash ||
    [...url.searchParams].length !== 0
  ) {
    throw new Error('RECOVERY_LOCAL_BACKUP_ADMIN_REFUSED')
  }
  return new URL(url.href)
}

export function admitRecoveryLocalBackupPgdata(value: string): string {
  const admitted = admitAbsolutePath(value)
  const parent = resolve(admitted, '..')
  const name = admitted.slice(parent.length + 1)
  if (parent !== '/private/tmp' || !/^tm-local-backup-pg-[A-Za-z0-9-]+$/.test(name)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
  }
  return admitted
}

export function admitRecoveryLocalBackupWorkRoot(value: string): string {
  const admitted = admitAbsolutePath(value)
  const parent = resolve(admitted, '..')
  const name = admitted.slice(parent.length + 1)
  if (parent !== '/private/tmp' || !/^tm-local-backup-run-[a-z0-9-]+$/.test(name)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
  }
  return admitted
}

export function recoveryLocalBackupDatabaseNames(runToken: string): {
  readonly source: string
  readonly target: string
} {
  if (!/^[a-f0-9]{16}$/.test(runToken)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_RUN_TOKEN_REFUSED')
  }
  return Object.freeze({
    source: `tm_local_backup_${runToken}_source`,
    target: `tm_local_backup_${runToken}_target`,
  })
}

export function recoveryLocalBackupDatabaseUrl(adminUrl: URL, databaseName: string): URL {
  if (!DATABASE_NAME.test(databaseName)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_DATABASE_NAME_REFUSED')
  }
  const result = new URL(adminUrl.href)
  result.pathname = `/${databaseName}`
  return result
}

export function recoveryLocalBackupPgEnv(url: URL): NodeJS.ProcessEnv {
  const databaseName = decodeURIComponent(url.pathname.slice(1))
  if (!DATABASE_NAME.test(databaseName)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_DATABASE_NAME_REFUSED')
  }
  return {
    PGDATABASE: databaseName,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
  }
}

export async function assertOwnedPrivateDirectory(path: string): Promise<{
  readonly realPath: string
  readonly dev: bigint
  readonly ino: bigint
}> {
  if (!process.getuid) throw new Error('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
  const metadata = await lstat(path, { bigint: true })
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid()) ||
    (metadata.mode & 0o077n) !== 0n
  ) {
    throw new Error('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
  }
  const configuredPath = resolve(path)
  const realPath = await realpath(path)
  if (realPath !== configuredPath) throw new Error('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
  return Object.freeze({ realPath, dev: metadata.dev, ino: metadata.ino })
}

export function assertDistinctDirectoryIdentities(
  left: { readonly realPath: string; readonly dev: bigint; readonly ino: bigint },
  right: { readonly realPath: string; readonly dev: bigint; readonly ino: bigint },
): void {
  if (left.realPath === right.realPath || (left.dev === right.dev && left.ino === right.ino)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_PATH_IDENTITY_REFUSED')
  }
}

function admitAbsolutePath(value: string): string {
  if (!value || !isAbsolute(value) || value.includes('\0')) {
    throw new Error('RECOVERY_LOCAL_BACKUP_PATH_REFUSED')
  }
  return resolve(value)
}

function pathContains(parent: string, candidate: string): boolean {
  const nested = relative(parent, candidate)
  return nested !== '' && !nested.startsWith('..') && !isAbsolute(nested)
}
