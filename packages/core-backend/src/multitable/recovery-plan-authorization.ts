import { resolveForeignSheetIdFromProperty, type ExactAnchorPlanAuthContext } from './exact-anchor-recovery-execute'
import { isPersonSingleRecord, validatePersonValue } from './field-codecs'
import { loadFieldsForSheet } from './loaders'
import { deriveFieldPermissions, isFieldAlwaysReadOnly, isFieldWriteForbidden, type RecordPermissionScope } from './permission-derivation'
import {
  ensureRecordWriteAllowed,
  loadDeniedRecordIds,
  loadFieldPermissionScopeMap,
  loadRecordPermissionScopeMap,
  loadRowLevelReadDenyEnabled,
  type QueryFn,
} from './permission-service'
import { createPersonMemberResolver, personRestrictGroupIds } from './person-field-restriction'
import { acquireRecoveryAuthorityLease, type RecoverySheetAuthority } from './recovery-authorization-stability'

export const createRecoveryAuthorizationStabilizer = () =>
  async (
    query: QueryFn,
    ctx: ExactAnchorPlanAuthContext,
  ): Promise<'ready' | 'busy' | 'unavailable'> => {
    const fields = await loadFieldsForSheet(query, ctx.sheetId)
    const fieldById = new Map(fields.map((field) => [field.id, field]))
    const authorityUserIds = new Set<string>([ctx.actorId])
    for (const write of ctx.revertWrites) {
      for (const fieldId of write.changedFieldIds) {
        if (fieldById.get(fieldId)?.type !== 'person') continue
        const value = write.patch[fieldId]
        if (!Array.isArray(value)) continue
        for (const candidate of value) {
          if (typeof candidate !== 'string' && typeof candidate !== 'number') continue
          const userId = String(candidate).trim()
          if (userId) authorityUserIds.add(userId)
        }
      }
    }
    return acquireRecoveryAuthorityLease(query, authorityUserIds)
  }

/**
 * REQUIRED in-fence WRITE authorization over the TRUE restorable delta (kernel `EvaluatePlanAuthorization`).
 * Runs INSIDE the destructive transaction, after the L7 plan + restorable projection and BEFORE any
 * value/existence validator, so a denied actor receives one uniform `forbidden` (no value/target oracle).
 * WHOLE-refuses unless ALL hold, re-resolved FRESH from the in-fence query (never pre-fence closures):
 *   1. canManageSheetAccess + conservative full-table read (same floor as preview);
 *   2. per-source-row edit (reverts) / delete (reset deletes) authority against CURRENT created_by,
 *      sheet own-write scope, and record permission scopes;
 *   3. layer-3 writable field permission for every true changedFieldId (visible ∧ not readOnly ∧ not
 *      always-read-only);
 *   4. native person membership / restrict-group validity for every changed person value;
 *   5. for every changed forward link: an unambiguous foreign sheet the actor can CURRENTLY read + edit,
 *      and every target record readable (row-deny) + editable (created_by / record scopes).
 */
export const createRecoveryPlanAuthorization = (
  sheetId: string,
  resolveAuthority: (query: QueryFn, sheetId: string) => Promise<RecoverySheetAuthority>,
  hasFullRead: (query: QueryFn, sheetId: string, authority: RecoverySheetAuthority) => Promise<boolean>,
) =>
  async (query: QueryFn, ctx: ExactAnchorPlanAuthContext): Promise<boolean> => {
    const fields = await loadFieldsForSheet(query, sheetId)
    const fieldByIdFull = new Map(fields.map((f) => [f.id, f]))

    const authority = await resolveAuthority(query, sheetId)
    const { access, capabilities, sheetScope } = authority
    if (access.userId !== ctx.actorId) return false
    if (!access.userId || !capabilities.canManageSheetAccess) return false
    if (!(await hasFullRead(query, sheetId, authority))) return false

    // 2. Source-row authority: CURRENT created_by + record permission scopes, whole-refuse.
    const sourceIds = [...new Set([...ctx.revertWrites.map((rw) => rw.recordId), ...ctx.deleteRecordIds])]
    const createdByById = new Map<string, string | null>()
    if (sourceIds.length > 0) {
      const rows = (await query(
        'SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
        [sheetId, sourceIds],
      )).rows as Array<{ id: unknown; created_by: unknown }>
      for (const r of rows) createdByById.set(String(r.id), typeof r.created_by === 'string' ? r.created_by : null)
    }
    const recordScopeMap = sourceIds.length > 0
      ? await loadRecordPermissionScopeMap(query, sheetId, sourceIds, access.userId)
      : new Map<string, RecordPermissionScope>()
    for (const rw of ctx.revertWrites) {
      if (!createdByById.has(rw.recordId)) return false
      if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, createdByById.get(rw.recordId) ?? null, 'edit', recordScopeMap, rw.recordId)) return false
    }
    for (const recordId of ctx.deleteRecordIds) {
      if (!capabilities.canDeleteRecord) return false
      if (!createdByById.has(recordId)) return false
      if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, createdByById.get(recordId) ?? null, 'delete', recordScopeMap, recordId)) return false
    }

    // 3. Layer-3 field-write gate over the TRUE changed set.
    const changedFieldIds = new Set(ctx.revertWrites.flatMap((rw) => rw.changedFieldIds))
    if (changedFieldIds.size > 0) {
      const scopeMap = await loadFieldPermissionScopeMap(query, sheetId, access.userId)
      const fieldPermissions = deriveFieldPermissions(fields, capabilities, { fieldScopeMap: scopeMap })
      for (const fid of changedFieldIds) {
        const field = fieldByIdFull.get(fid)
        if (!field) return false
        if (isFieldAlwaysReadOnly(field)) return false
        if (isFieldWriteForbidden(fieldPermissions[fid])) return false
      }
    }

    // 4. Person membership / restrict-group validity for every changed person value.
    const resolvePersonMemberUserIds = createPersonMemberResolver(query, sheetId)
    for (const rw of ctx.revertWrites) {
      for (const fid of rw.changedFieldIds) {
        const field = fieldByIdFull.get(fid)
        if (!field || field.type !== 'person') continue
        const value = rw.patch[fid]
        if (value === null || value === undefined) continue
        try {
          const allowed = await resolvePersonMemberUserIds(personRestrictGroupIds(field))
          validatePersonValue(value, fid, allowed, isPersonSingleRecord(field.property))
        } catch {
          return false
        }
      }
    }

    // 5. Forward-link foreign authority (read + edit on the CURRENT foreign sheet + target records).
    const linkTargetsByField = new Map<string, string[]>()
    for (const rw of ctx.revertWrites) {
      for (const lu of rw.linkUpdates) {
        if (lu.targetIds.length === 0) continue
        linkTargetsByField.set(lu.fieldId, [...(linkTargetsByField.get(lu.fieldId) ?? []), ...lu.targetIds])
      }
    }
    if (linkTargetsByField.size > 0) {
      // RAW property blobs — alias ambiguity must fail closed (serializeFieldRow collapses aliases).
      const rawPropRes = await query(
        'SELECT id, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
        [sheetId, [...linkTargetsByField.keys()]],
      )
      const rawPropById = new Map<string, Record<string, unknown>>()
      for (const r of rawPropRes.rows as Array<{ id: unknown; property: unknown }>) {
        let prop: Record<string, unknown> = {}
        if (r.property && typeof r.property === 'object' && !Array.isArray(r.property)) {
          prop = r.property as Record<string, unknown>
        } else if (typeof r.property === 'string' && r.property.trim()) {
          try {
            const parsed = JSON.parse(r.property) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prop = parsed as Record<string, unknown>
          } catch { /* malformed property JSON → empty bag → fail closed below */ }
        }
        rawPropById.set(String(r.id), prop)
      }
      const targetsByForeignSheet = new Map<string, Set<string>>()
      for (const [fieldId, rawTargets] of linkTargetsByField) {
        const foreignSheetId = resolveForeignSheetIdFromProperty(rawPropById.get(fieldId))
        if (!foreignSheetId) return false
        const targets = targetsByForeignSheet.get(foreignSheetId) ?? new Set<string>()
        for (const id of rawTargets) targets.add(id)
        targetsByForeignSheet.set(foreignSheetId, targets)
      }

      for (const foreignSheetId of [...targetsByForeignSheet.keys()].sort()) {
        const targetIds = [...(targetsByForeignSheet.get(foreignSheetId) ?? [])].sort()
        // Establish foreign-sheet authority before any target-row lookup, preserving the no-oracle
        // order for an actor who can manage the source sheet but cannot inspect the foreign sheet.
        const resolved = await resolveAuthority(query, foreignSheetId)
        if (!resolved.access.userId || !resolved.capabilities.canRead || !resolved.capabilities.canEditRecord) {
          return false
        }
        // Lock target rows BEFORE reading data-dependent row denial or created_by authority. FOR UPDATE
        // (not KEY SHARE) blocks both delete and ordinary data updates through COMMIT; all targets for a
        // sheet are acquired in one deterministic statement to avoid per-field lock-order drift.
        const targetRows = (await query(
          `SELECT id, created_by FROM meta_records
            WHERE sheet_id = $1 AND id = ANY($2::text[])
            ORDER BY id
            FOR UPDATE`,
          [foreignSheetId, targetIds],
        )).rows as Array<{ id: unknown; created_by: unknown }>
        const foreignCreatedBy = new Map(targetRows.map((r) => [String(r.id), typeof r.created_by === 'string' ? r.created_by : null]))
        // A missing target cannot be authority-proven — uniform forbidden HERE keeps the later
        // link-integrity validator from becoming an existence oracle for unauthorized actors.
        if (foreignCreatedBy.size !== targetIds.length) return false
        if (!resolved.access.isAdminRole && (await loadRowLevelReadDenyEnabled(query, foreignSheetId))) {
          const denied = await loadDeniedRecordIds(query, foreignSheetId, resolved.access.userId)
          if (targetIds.some((id) => denied.has(id))) return false
        }
        const foreignScopeMap = await loadRecordPermissionScopeMap(query, foreignSheetId, targetIds, resolved.access.userId)
        for (const id of targetIds) {
          if (!ensureRecordWriteAllowed(resolved.capabilities, resolved.sheetScope, resolved.access, foreignCreatedBy.get(id) ?? null, 'edit', foreignScopeMap, id)) return false
        }
      }
    }
    return true
  }
