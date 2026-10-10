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
 *   boundGrantLockWaits           → services/stock-preparation-project-sheet-grants.ts
 *                                   runWithStockPreparationProjectSheetGrantLockTimeout: the G1 call
 *                                   sets a transaction-local lock_timeout as its first statement
 *
 * THE TRANSACTION'S OWN CONNECTION. Inside a write's transaction the port passes its transaction
 * query to isPlatformAdmin / listEffectivePermissions / hasEffectiveNamespaceAdmission /
 * resolveWritableSheetIds; each then runs EVERY statement on that connection (rbac/service.ts
 * `isAdmin` and `listUserPermissions`, namespace-admission.ts `userHasEffectiveNamespaceAccess`, the
 * grid's capability resolver), so the in-lock decision reads what the locks protect and the write
 * never holds one pool connection while asking for another. `listUserPermissions` on a transaction
 * query bypasses the permission memo both ways (nothing cached is used; nothing it reads is cached).
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
import { runWithStockPreparationProjectSheetGrantLockTimeout } from './stock-preparation-project-sheet-grants'
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

/** `isAdmin`'s executor shape, over the port's transaction query (one connection, the same statement). */
function adminExecutorOn(txQuery: StockPrepMembersQueryFn): typeof poolQuery {
  return (async (sql: string, params?: unknown[]) => txQuery(sql, params)) as unknown as typeof poolQuery
}

/**
 * The actor's access snapshot for a sheet decision, read FRESH: the permission memo is dropped first,
 * so a code revoked a moment ago is not still honoured from the 60 s cache. On a transaction query
 * both reads run, one after the other, on that connection (and the memo is not consulted at all).
 */
async function freshSheetAccess(userId: string, txQuery?: StockPrepMembersQueryFn): Promise<ResolvedRequestAccess> {
  if (txQuery) {
    const permissions = await listUserPermissions(userId, txQuery)
    const isAdminRole = await isAdmin(userId, adminExecutorOn(txQuery))
    return { userId, permissions, isAdminRole }
  }
  invalidateUserPerms(userId)
  const [permissions, isAdminRole] = await Promise.all([listUserPermissions(userId), isAdmin(userId)])
  return { userId, permissions, isAdminRole }
}

export function createStockPrepMembersHostDeps(): StockPrepMembersDeps {
  const query: StockPrepMembersQueryFn = async (sql, params) => shapeResult(await poolQuery(sql, params))
  return {
    query,
    transaction: (fn) => poolTransaction(async (client) => fn(async (sql, params) => shapeResult(await client.query(sql, params)))),
    isPlatformAdmin: (userId, txQuery) => (txQuery ? isAdmin(userId, adminExecutorOn(txQuery)) : isAdmin(userId)),
    listEffectivePermissions: async (userId, txQuery) => {
      if (txQuery) return listUserPermissions(userId, txQuery)
      invalidateUserPerms(userId)
      return listUserPermissions(userId)
    },
    hasEffectiveNamespaceAdmission: (userId, namespace, txQuery) => (txQuery
      ? userHasEffectiveNamespaceAccess(userId, namespace, txQuery)
      : userHasEffectiveNamespaceAccess(userId, namespace)),
    resolveReadableSheetIds: async (userId, sheetIds) => {
      const access = await freshSheetAccess(userId)
      return resolveReadableSheetIds(undefined, query, sheetIds, access)
    },
    resolveWritableSheetIds: async (userId, sheetIds, txQuery) => {
      const access = await freshSheetAccess(userId, txQuery)
      const run = txQuery ?? query
      const writable = new Set<string>()
      for (const sheetId of Array.from(new Set(sheetIds))) {
        const resolved = await resolveSheetCapabilitiesForAccess(run, sheetId, access)
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
    boundGrantLockWaits: (lockTimeoutMs, fn) => runWithStockPreparationProjectSheetGrantLockTimeout(lockTimeoutMs, fn),
    auditLog,
    invalidateUserPerms,
  }
}

export function createStockPrepMembersHostPort(): StockPrepMembersPort {
  return createStockPrepMembersPort(createStockPrepMembersHostDeps())
}
