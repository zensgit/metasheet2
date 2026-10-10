/**
 * 备料「成员与权限」(S5b, register R-39) — the host WIRING of the narrow members port.
 *
 * `services/stock-preparation-members.ts` takes every dependency as a parameter so its guards can be
 * driven with counting fakes; this file binds those parameters to the real host primitives, and
 * index.ts hands the result to `plugin-integration-core` ONLY (the field-permissions / G1 posture).
 *
 *   query / transaction           → db/pg (the pool; one transaction per write)
 *   isPlatformAdmin               → rbac/service.ts isAdmin (the DB `admin` role ONLY — not the legacy
 *                                   `users.is_admin` / `users.role` columns, not a token claim)
 *   listEffectivePermissions      → rbac/service.ts listUserPermissions, after dropping the actor's
 *                                   memo so the grantor bound reads CURRENT codes (invariant 1)
 *   hasEffectiveNamespaceAdmission→ rbac/namespace-admission.ts userHasEffectiveNamespaceAccess
 *   resolveReadableSheetIds       → multitable/permission-service.ts resolveReadableSheetIds, with an
 *                                   access snapshot built from the same two rbac reads — after
 *                                   dropping the actor's memo (fix round 1, S3)
 *   resolveWritableSheetIds       → multitable/permission-service.ts resolveSheetCapabilitiesForAccess
 *                                   per sheet (the grid's own capability resolver): a live sheet on
 *                                   which the actor holds everything a `spreadsheet:write` grant
 *                                   confers — create, edit and delete ANY record (not write-own
 *                                   only), manage fields and views, notify — the bound for handing
 *                                   out `spreadsheet:write` (fix round 1, S2); same fresh access
 *                                   snapshot (S3)
 *   auditLog                      → audit/audit.ts auditLog (the admin-users.ts writer)
 */

import { auditLog } from '../audit/audit'
import { query as poolQuery, transaction as poolTransaction } from '../db/pg'
import type { ResolvedRequestAccess } from '../multitable/access'
import {
  requiresOwnWriteRowPolicy,
  resolveReadableSheetIds,
  resolveSheetCapabilitiesForAccess,
} from '../multitable/permission-service'
import { userHasEffectiveNamespaceAccess } from '../rbac/namespace-admission'
import { invalidateUserPerms, isAdmin, listUserPermissions } from '../rbac/service'
import {
  createStockPrepMembersPort,
  type StockPrepMembersDeps,
  type StockPrepMembersPort,
  type StockPrepMembersQueryFn,
} from './stock-preparation-members'

function shapeResult(result: unknown): { rows: unknown[]; rowCount: number | null } {
  const rows = Array.isArray((result as { rows?: unknown[] } | null)?.rows) ? (result as { rows: unknown[] }).rows : []
  const rowCount = (result as { rowCount?: number | null } | null)?.rowCount ?? null
  return { rows, rowCount }
}

/**
 * The actor's access snapshot for a sheet decision, read FRESH: the permission memo is dropped first,
 * so a code revoked a moment ago is not still honoured from the 60 s cache.
 */
async function freshSheetAccess(userId: string): Promise<ResolvedRequestAccess> {
  invalidateUserPerms(userId)
  const [permissions, isAdminRole] = await Promise.all([listUserPermissions(userId), isAdmin(userId)])
  return { userId, permissions, isAdminRole }
}

export function createStockPrepMembersHostDeps(): StockPrepMembersDeps {
  const query: StockPrepMembersQueryFn = async (sql, params) => shapeResult(await poolQuery(sql, params))
  return {
    query,
    transaction: (fn) => poolTransaction(async (client) => fn(async (sql, params) => shapeResult(await client.query(sql, params)))),
    isPlatformAdmin: (userId) => isAdmin(userId),
    listEffectivePermissions: async (userId) => {
      invalidateUserPerms(userId)
      return listUserPermissions(userId)
    },
    hasEffectiveNamespaceAdmission: (userId, namespace) => userHasEffectiveNamespaceAccess(userId, namespace),
    resolveReadableSheetIds: async (userId, sheetIds) => {
      const access = await freshSheetAccess(userId)
      return resolveReadableSheetIds(undefined, query, sheetIds, access)
    },
    resolveWritableSheetIds: async (userId, sheetIds) => {
      const access = await freshSheetAccess(userId)
      const writable = new Set<string>()
      for (const sheetId of Array.from(new Set(sheetIds))) {
        const resolved = await resolveSheetCapabilitiesForAccess(query, sheetId, access)
        const { capabilities } = resolved
        // Everything a `spreadsheet:write` sheet grant confers (permission-service.ts
        // applyContextSheetSchemaWriteGrant): read, create / edit / delete ANY record (not write-own
        // only), manage fields and views, send notifications. The grantor must hold all of it on this
        // sheet — GRANTED ⊆ GRANTOR — so e.g. a global `multitable:write` without
        // `multitable:manage-schema` cannot hand out schema management.
        if (
          resolved.sheetLiveness === 'live'
          && capabilities.canRead
          && capabilities.canCreateRecord
          && capabilities.canEditRecord
          && capabilities.canDeleteRecord
          && capabilities.canManageFields
          && capabilities.canManageViews
          && capabilities.canSendNotification
          && !requiresOwnWriteRowPolicy(resolved.sheetScope, access.isAdminRole)
        ) {
          writable.add(sheetId)
        }
      }
      return writable
    },
    auditLog,
    invalidateUserPerms,
  }
}

export function createStockPrepMembersHostPort(): StockPrepMembersPort {
  return createStockPrepMembersPort(createStockPrepMembersHostDeps())
}
