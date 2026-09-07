import { createHash } from 'node:crypto'
import { isAttendanceProjectionOwnerWithCalculationPointerV1 } from './w7-provenance-domain'
import { getObjectFieldId } from '../multitable/provisioning'
import { acquireCanonicalSheetFence } from '../multitable/canonical-sheet-fence'
import { hasPermission, type ResolvedRequestAccess } from '../multitable/access'
import { loadDatabaseFreshRecoveryAccess } from '../multitable/recovery-authorization-stability'
import {
  ensureRecordWriteAllowed, isRecordReadDeniedForUserStrict, loadFieldPermissionScopeMap,
  loadRecordPermissionScopeMap, resolveSheetCapabilitiesForAccess,
} from '../multitable/permission-service'
import { deriveFieldPermissions, isFieldWriteForbidden, type FieldLike } from '../multitable/permission-derivation'
import { deriveGrantNamespaces } from '../rbac/namespace-admission'

type QueryResult = { rows: unknown[]; rowCount?: number }
export type AttendanceCleaningAuthorityQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>

export type AttendanceCleaningActorInput = {
  orgId: string
  actorId: string
  tokenSubjectUserId: string
}

/** Called in the owning W4 transaction; JWT claims identify, never grant. */
export async function assertAttendanceCleaningActor(
  query: AttendanceCleaningAuthorityQuery,
  input: AttendanceCleaningActorInput,
): Promise<ResolvedRequestAccess> {
  const denied = () => new Error('ATTENDANCE_CLEANING_FORBIDDEN')
  try {
    if (!input.actorId || input.actorId !== input.tokenSubjectUserId || !input.orgId) throw denied()
    const actor = await query(
      `SELECT id FROM users WHERE id = $1 AND is_active = true
        AND COALESCE(activation_status, 'activated') = 'activated' FOR SHARE`, [input.actorId],
    )
    const membership = await query(
      'SELECT user_id FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true FOR SHARE',
      [input.actorId, input.orgId],
    )
    if (actor.rows.length !== 1 || membership.rows.length !== 1) throw denied()
    // The ACP transaction wrapper fences authority tables before its snapshot;
    // these rows additionally make the exact current authority reads explicit.
    await query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id FOR SHARE', [input.actorId])
    await query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code FOR SHARE', [input.actorId])
    await query(`SELECT rp.permission_code FROM role_permissions rp JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = $1 ORDER BY rp.role_id, rp.permission_code FOR SHARE OF rp`, [input.actorId])
    const access = await loadDatabaseFreshRecoveryAccess(query, input.actorId)
    if (!hasPermission(access.permissions, 'attendance:admin')) throw denied()
    const roles = await query(`SELECT ur.role_id, rp.permission_code FROM user_roles ur
      LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1`, [input.actorId])
    const roleRows = roles.rows as Array<{ role_id: string; permission_code: string | null }>
    if (!access.permissions.includes('*:*') && !roleRows.some(row => row.role_id === 'admin')) {
      const controlled = roleRows.some(row => deriveGrantNamespaces({ roleId: row.role_id,
        permissionCodes: row.permission_code === null ? [] : [row.permission_code] }).includes('attendance'))
      const admissions = await query(`SELECT namespace FROM user_namespace_admissions
        WHERE user_id = $1 AND namespace = 'attendance' AND enabled = true FOR SHARE`, [input.actorId])
      if (!controlled || admissions.rows.length !== 1) throw denied()
    }
    return { ...access, authenticatedTenantId: input.orgId }
  } catch {
    throw denied()
  }
}

/** After W4 class-11; reuses effective multitable grants without granting any. */
export async function lockAttendanceCleaningProjectionAccess(
  query: AttendanceCleaningAuthorityQuery,
  input: AttendanceCleaningActorInput & { projectionRecordId: string },
) {
  const access = await assertAttendanceCleaningActor(query, input)
  try {
    const ownership = await query(`SELECT sheet.id AS sheet_id, registry.project_id
      FROM meta_records projection
      JOIN meta_sheets sheet ON sheet.id = projection.sheet_id AND sheet.deleted_at IS NULL
      JOIN plugin_multitable_object_registry registry ON registry.sheet_id = sheet.id
      WHERE projection.id = $1 AND registry.plugin_name = 'plugin-attendance'
        AND registry.object_id = 'attendance_report_records' AND registry.project_id = $2
      FOR SHARE OF sheet, registry`, [input.projectionRecordId, `${input.orgId}:attendance`])
    if (ownership.rows.length !== 1) unavailable()
    const owner = ownership.rows[0] as { sheet_id: string; project_id: string }
    // The owning ACP wrapper's prefence also covers absent-to-deny insertions.
    await query('SELECT group_id FROM platform_member_group_members WHERE user_id = $1 ORDER BY group_id FOR SHARE', [input.actorId])
    await query('SELECT subject_type, subject_id, perm_code FROM spreadsheet_permissions WHERE sheet_id = $1 ORDER BY subject_type, subject_id, perm_code FOR SHARE', [owner.sheet_id])
    await query('SELECT id FROM field_permissions WHERE sheet_id = $1 ORDER BY id FOR SHARE', [owner.sheet_id])
    await query('SELECT id FROM record_permissions WHERE sheet_id = $1 AND record_id = $2 ORDER BY id FOR SHARE', [owner.sheet_id, input.projectionRecordId])
    if ((await lockDailyProjectionGroup(query, input.projectionRecordId)).length !== 1) unavailable()
    const rows = await query('SELECT id, sheet_id, data, version, created_by, locked FROM meta_records WHERE id = $1 FOR UPDATE', [input.projectionRecordId])
    const projection = rows.rows[0] as { id: string; sheet_id: string; data: Record<string, unknown>; version: number; created_by: string | null; locked: boolean } | undefined
    if (rows.rows.length !== 1 || !projection || projection.sheet_id !== owner.sheet_id || projection.locked) unavailable()
    const resolved = await resolveSheetCapabilitiesForAccess(query, owner.sheet_id, access)
    const recordScopes = await loadRecordPermissionScopeMap(query, owner.sheet_id, [projection.id], access.userId)
    if (resolved.sheetLiveness !== 'live' || !resolved.capabilities.canRead
      || await isRecordReadDeniedForUserStrict(query, owner.sheet_id, projection.id, access.userId)
      || !ensureRecordWriteAllowed(resolved.capabilities, resolved.sheetScope, access, projection.created_by, 'edit', recordScopes, projection.id)) unavailable()
    const fieldIds = {
      requested: getObjectFieldId(owner.project_id, 'attendance_report_records', 'cleaning_requested'),
      reason: getObjectFieldId(owner.project_id, 'attendance_report_records', 'cleaning_reason'),
    }
    const fields = await query('SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR SHARE', [owner.sheet_id, Object.values(fieldIds)])
    if (fields.rows.length !== 2) unavailable()
    const fieldScopes = await loadFieldPermissionScopeMap(query, owner.sheet_id, access.userId)
    const permissions = deriveFieldPermissions(fields.rows as FieldLike[], resolved.capabilities, { fieldScopeMap: fieldScopes })
    if (Object.values(fieldIds).some(id => isFieldWriteForbidden(permissions[id]))) unavailable()
    return { projection, fieldIds, access, projectId: owner.project_id }
  } catch {
    throw new Error('ATTENDANCE_CLEANING_FORBIDDEN')
  }
}

export class AttendanceMultitableCleaningAuthorityError extends Error {
  constructor() {
    super('ATTENDANCE_CLEANING_ANCHOR_UNAVAILABLE')
    this.name = 'AttendanceMultitableCleaningAuthorityError'
  }
}

export type RefreshAttendanceReportProjectionAnchorInput = {
  projectionRecordId: string
  canonicalRecordId: string
  sourceFingerprint: string
}

type CanonicalRow = {
  projection_record_id: string
  canonical_record_id: string
  org_id: string
  user_id: string
  work_date: string
  timezone: string
  first_in_at: Date | string | null
  last_out_at: Date | string | null
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
  status: string
  is_workday: boolean
  projection_owner: string
  current_calculation_id: string | null
  visibility_state: string
  visibility_reason: string
}

type CalculationRow = { id: string; version: number; mode: string; outcome: string }

function unavailable(): never {
  throw new AttendanceMultitableCleaningAuthorityError()
}

function nonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) unavailable()
  return value
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) unavailable()
  return value
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) unavailable()
  return date.toISOString()
}

export function buildAttendanceCanonicalSourceDigest(input: CanonicalRow): string {
  const tuple = [
    'attendance-canonical-source-v1',
    nonEmpty(input.org_id),
    nonEmpty(input.canonical_record_id),
    nonEmpty(input.user_id),
    nonEmpty(input.work_date),
    nonEmpty(input.timezone),
    timestamp(input.first_in_at),
    timestamp(input.last_out_at),
    positiveInteger(input.work_minutes + 1) - 1,
    positiveInteger(input.late_minutes + 1) - 1,
    positiveInteger(input.early_leave_minutes + 1) - 1,
    nonEmpty(input.status),
    input.is_workday === true,
    nonEmpty(input.projection_owner),
    input.current_calculation_id === null ? null : nonEmpty(input.current_calculation_id),
    nonEmpty(input.visibility_state),
    nonEmpty(input.visibility_reason),
  ]
  return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')
}

function assertRefreshInput(input: RefreshAttendanceReportProjectionAnchorInput): void {
  if (
    !input
    || !/^rec_[A-Za-z0-9_-]+$/.test(input.projectionRecordId)
    || !/^[0-9a-f]{40}$/.test(input.sourceFingerprint)
    || typeof input.canonicalRecordId !== 'string'
    || input.canonicalRecordId.length === 0
  ) unavailable()
}

async function loadCanonicalRow(
  query: AttendanceCleaningAuthorityQuery,
  input: RefreshAttendanceReportProjectionAnchorInput,
): Promise<CanonicalRow> {
  const result = await query(
    `SELECT projection.id AS projection_record_id,
            attendance_record.id AS canonical_record_id, attendance_record.org_id, attendance_record.user_id,
            attendance_record.work_date::text AS work_date,
            attendance_record.timezone, attendance_record.first_in_at, attendance_record.last_out_at, attendance_record.work_minutes,
            attendance_record.late_minutes, attendance_record.early_leave_minutes, attendance_record.status, attendance_record.is_workday,
            attendance_record.projection_owner, attendance_record.current_calculation_id, attendance_record.visibility_state,
            attendance_record.visibility_reason
       FROM meta_records projection
       JOIN meta_sheets sheet ON sheet.id = projection.sheet_id AND sheet.deleted_at IS NULL
       JOIN plugin_multitable_object_registry registry
         ON registry.sheet_id = projection.sheet_id
        AND registry.plugin_name = 'plugin-attendance'
        AND registry.object_id = 'attendance_report_records'
       JOIN attendance_records attendance_record ON attendance_record.id = $2
        AND registry.project_id = attendance_record.org_id || ':attendance'
      WHERE projection.id = $1
      FOR UPDATE OF projection, attendance_record`,
    [input.projectionRecordId, input.canonicalRecordId],
  )
  const row = result.rows[0] as CanonicalRow | undefined
  if (!row || result.rows.length !== 1) unavailable()
  return row
}

async function lockDailyProjectionGroup(
  query: AttendanceCleaningAuthorityQuery,
  projectionRecordId: string,
): Promise<string[]> {
  const scope = await query(
    `SELECT registry.sheet_id, registry.project_id
       FROM plugin_multitable_object_registry registry
       JOIN meta_records source ON source.sheet_id = registry.sheet_id
       JOIN meta_sheets sheet ON sheet.id = source.sheet_id AND sheet.deleted_at IS NULL
      WHERE source.id = $1 AND registry.plugin_name = 'plugin-attendance'
        AND registry.object_id = 'attendance_report_records'`, [projectionRecordId],
  )
  if (scope.rows.length !== 1) unavailable()
  const owner = scope.rows[0] as { sheet_id: string; project_id: string }
  const sheetId = nonEmpty(owner.sheet_id)
  const rowKeyField = getObjectFieldId(nonEmpty(owner.project_id), 'attendance_report_records', 'row_key')
  // Existing create/form writers use this same fence even when the global flag is off.
  await acquireCanonicalSheetFence(query, sheetId)
  // Lock every existing row in a deterministic order: a row-key PATCH can otherwise
  // move a previously unrelated row into the duplicate group after a filtered read.
  const rows = await query('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY id FOR UPDATE', [sheetId])
  const fields = await query('SELECT id FROM meta_fields WHERE id = $1 AND sheet_id = $2 FOR SHARE', [rowKeyField, sheetId])
  if (fields.rows.length !== 1) unavailable()
  const records = rows.rows as Array<{ id: string; data: Record<string, unknown> }>
  const source = records.find(row => row.id === projectionRecordId)
  const rowKey = source?.data?.[rowKeyField]
  if (typeof rowKey !== 'string' || rowKey.length === 0) unavailable()
  return records.filter(row => row.data?.[rowKeyField] === rowKey).map(row => row.id)
}

async function loadSelectedCalculation(
  query: AttendanceCleaningAuthorityQuery,
  record: CanonicalRow,
): Promise<{ selector: 'current_calculation' | 'latest_completed_calculation'; calculation: CalculationRow } | null> {
  if (isAttendanceProjectionOwnerWithCalculationPointerV1(record.projection_owner)) {
    if (!record.current_calculation_id) unavailable()
    const current = await query(
      `SELECT id, version, mode, outcome
         FROM attendance_record_calculations
        WHERE id = $1 AND attendance_record_id = $2 AND org_id = $3
        FOR KEY SHARE`,
      [record.current_calculation_id, record.canonical_record_id, record.org_id],
    )
    const calculation = current.rows[0] as CalculationRow | undefined
    if (current.rows.length === 1 && calculation?.mode === 'authoritative' && calculation.outcome === 'completed') {
      return { selector: 'current_calculation', calculation }
    }
    unavailable()
  }
  const latest = await query(
    `SELECT id, version, mode, outcome
       FROM attendance_record_calculations
      WHERE attendance_record_id = $1 AND org_id = $2 AND outcome = 'completed'
      ORDER BY version DESC
      LIMIT 1
      FOR KEY SHARE`,
    [record.canonical_record_id, record.org_id],
  )
  const calculation = latest.rows[0] as CalculationRow | undefined
  if (latest.rows.length === 0) return null
  if (latest.rows.length !== 1 || !calculation || !nonEmpty(calculation.id) || positiveInteger(calculation.version) < 1) unavailable()
  return { selector: 'latest_completed_calculation', calculation }
}

export async function refreshAttendanceReportProjectionAnchor(
  query: AttendanceCleaningAuthorityQuery,
  input: RefreshAttendanceReportProjectionAnchorInput,
): Promise<void> {
  try {
    assertRefreshInput(input)
    const group = await lockDailyProjectionGroup(query, input.projectionRecordId)
    if (group.length > 1) {
      await withholdAttendanceReportProjectionAnchors(query, group)
      return
    }
    const record = await loadCanonicalRow(query, input)
    const selected = await loadSelectedCalculation(query, record)
    if (!selected) {
      await withholdAttendanceReportProjectionAnchors(query, [record.projection_record_id])
      return
    }
    const { selector, calculation } = selected
    const digest = buildAttendanceCanonicalSourceDigest(record)
    const existing = await query(
      `SELECT canonical_record_id
         FROM attendance_report_projection_anchors
        WHERE projection_record_id = $1
        FOR UPDATE`,
      [input.projectionRecordId],
    )
    const bound = existing.rows[0] as { canonical_record_id?: unknown } | undefined
    if (existing.rows.length > 1 || (bound && bound.canonical_record_id !== record.canonical_record_id)) unavailable()
    const written = await query(
      `INSERT INTO attendance_report_projection_anchors (
         projection_record_id, org_id, canonical_record_id, source_selector,
         source_calculation_id, source_calculation_version, canonical_source_digest, source_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (projection_record_id) DO UPDATE
          SET source_selector = EXCLUDED.source_selector,
              source_calculation_id = EXCLUDED.source_calculation_id,
              source_calculation_version = EXCLUDED.source_calculation_version,
              canonical_source_digest = EXCLUDED.canonical_source_digest,
              source_fingerprint = EXCLUDED.source_fingerprint,
              updated_at = now()
        WHERE attendance_report_projection_anchors.org_id = EXCLUDED.org_id
          AND attendance_report_projection_anchors.canonical_record_id = EXCLUDED.canonical_record_id
       RETURNING projection_record_id`,
      [
        record.projection_record_id,
        record.org_id,
        record.canonical_record_id,
        selector,
        nonEmpty(calculation.id),
        positiveInteger(calculation.version),
        digest,
        input.sourceFingerprint,
      ],
    )
    if (written.rows.length !== 1) unavailable()
  } catch (error) {
    if (error instanceof AttendanceMultitableCleaningAuthorityError) throw error
    unavailable()
  }
}

export async function withholdAttendanceReportProjectionAnchors(
  query: AttendanceCleaningAuthorityQuery,
  projectionRecordIds: readonly string[],
): Promise<void> {
  try {
    if (!Array.isArray(projectionRecordIds) || projectionRecordIds.length === 0 || projectionRecordIds.some(id => !/^rec_[A-Za-z0-9_-]+$/.test(id))) {
      unavailable()
    }
    const sources = await query(
      `SELECT projection.id AS projection_record_id, registry.project_id
        FROM meta_records projection JOIN plugin_multitable_object_registry registry
          ON registry.sheet_id = projection.sheet_id
       WHERE projection.id = ANY($1::text[])
         AND registry.plugin_name = 'plugin-attendance'
         AND registry.object_id = 'attendance_report_records'
       ORDER BY projection.id FOR UPDATE OF projection`,
      [projectionRecordIds],
    )
    const mappings = sources.rows.map(raw => {
      const source = raw as { projection_record_id: string; project_id: string }
      return {
        projection_record_id: nonEmpty(source.projection_record_id),
        field_id: getObjectFieldId(nonEmpty(source.project_id), 'attendance_report_records', 'row_key'),
      }
    })
    await query(
      `DELETE FROM attendance_report_projection_anchors anchor USING (
         SELECT DISTINCT peer.id
           FROM jsonb_to_recordset($1::jsonb) mapping(projection_record_id text, field_id text)
           JOIN meta_records source ON source.id = mapping.projection_record_id
           LEFT JOIN meta_fields field ON field.id = mapping.field_id AND field.sheet_id = source.sheet_id
           JOIN meta_records peer ON peer.sheet_id = source.sheet_id
            AND (peer.id = source.id OR (
              field.id IS NOT NULL AND jsonb_typeof(source.data -> field.id) = 'string'
              AND peer.data -> field.id = source.data -> field.id))
       ) duplicate_group WHERE anchor.projection_record_id = duplicate_group.id`,
      [JSON.stringify(mappings)],
    )
  } catch (error) {
    if (error instanceof AttendanceMultitableCleaningAuthorityError) throw error
    unavailable()
  }
}
