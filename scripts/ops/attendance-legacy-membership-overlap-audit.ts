#!/usr/bin/env -S pnpm exec tsx
import { pathToFileURL } from 'node:url'

const connectionPoolNamespace = await import(
  '../../packages/core-backend/src/integration/db/connection-pool'
)
const auditNamespace = await import(
  '../../packages/core-backend/src/services/AttendanceLegacyMembershipOverlapAudit.ts'
)
const connectionPoolModule = (
  'poolManager' in connectionPoolNamespace
    ? connectionPoolNamespace
    : (connectionPoolNamespace as unknown as { default: typeof connectionPoolNamespace }).default
)
const auditModule = (
  'AttendanceLegacyMembershipAuditError' in auditNamespace
    ? auditNamespace
    : (auditNamespace as unknown as { default: typeof auditNamespace }).default
)
const { poolManager } = connectionPoolModule
const {
  ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY,
  AttendanceLegacyMembershipAuditError,
  auditAttendanceLegacyMembershipOverlaps,
} = auditModule

function readOrgId(args: string[]): string {
  const index = args.indexOf('--org')
  if (index < 0 || !args[index + 1]?.trim()) {
    throw new AttendanceLegacyMembershipAuditError(
      'ORG_ID_REQUIRED',
      400,
      'Usage: pnpm exec tsx scripts/ops/attendance-legacy-membership-overlap-audit.ts --org <orgId>',
    )
  }
  return args[index + 1].trim()
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const manifest = await auditAttendanceLegacyMembershipOverlaps(readOrgId(args))
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
    return manifest.zeroConflicts ? 0 : 4
  } catch (error) {
    if (error instanceof AttendanceLegacyMembershipAuditError) {
      process.stderr.write(`${error.code}: ${error.message}\n`)
      if (error.code === 'ORG_ID_REQUIRED') return 2
      if (error.code === ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY) return 3
      return 3
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  const exitCode = await main()
  await poolManager.close()
  process.exitCode = exitCode
}
