/**
 * 备料「成员与权限」(S5b, register R-39) — the host WIRING of the narrow members port.
 *
 * `services/stock-preparation-members.ts` takes every dependency as a parameter so its guards can be
 * driven with counting fakes; this file binds those parameters to the real host primitives, and
 * index.ts hands the result to `plugin-integration-core` ONLY (the field-permissions / G1 posture).
 *
 *   query / transaction           → db/pg (the pool; one transaction per write)
 *   isPlatformAdmin               → rbac/service.ts isAdmin (the DB `admin` role)
 *   listEffectivePermissions      → rbac/service.ts listUserPermissions, after dropping the actor's
 *                                   memo so the grantor bound reads CURRENT codes (invariant 1)
 *   hasEffectiveNamespaceAdmission→ rbac/namespace-admission.ts userHasEffectiveNamespaceAccess
 *   resolveReadableSheetIds       → multitable/permission-service.ts resolveReadableSheetIds, with an
 *                                   access snapshot built from the same two rbac reads
 *   auditLog                      → audit/audit.ts auditLog (the admin-users.ts writer)
 */

import { auditLog } from '../audit/audit'
import { query as poolQuery, transaction as poolTransaction } from '../db/pg'
import { resolveReadableSheetIds } from '../multitable/permission-service'
import { userHasEffectiveNamespaceAccess } from '../rbac/namespace-admission'
import { invalidateUserPerms, isAdmin, listUserPermissions } from '../rbac/service'
import {
  createStockPrepMembersPort,
  type StockPrepMembersPort,
  type StockPrepMembersQueryFn,
} from './stock-preparation-members'

function shapeResult(result: unknown): { rows: unknown[]; rowCount: number | null } {
  const rows = Array.isArray((result as { rows?: unknown[] } | null)?.rows) ? (result as { rows: unknown[] }).rows : []
  const rowCount = (result as { rowCount?: number | null } | null)?.rowCount ?? null
  return { rows, rowCount }
}

export function createStockPrepMembersHostPort(): StockPrepMembersPort {
  const query: StockPrepMembersQueryFn = async (sql, params) => shapeResult(await poolQuery(sql, params))
  return createStockPrepMembersPort({
    query,
    transaction: (fn) => poolTransaction(async (client) => fn(async (sql, params) => shapeResult(await client.query(sql, params)))),
    isPlatformAdmin: (userId) => isAdmin(userId),
    listEffectivePermissions: async (userId) => {
      invalidateUserPerms(userId)
      return listUserPermissions(userId)
    },
    hasEffectiveNamespaceAdmission: (userId, namespace) => userHasEffectiveNamespaceAccess(userId, namespace),
    resolveReadableSheetIds: async (userId, sheetIds) => {
      const [permissions, isAdminRole] = await Promise.all([listUserPermissions(userId), isAdmin(userId)])
      return resolveReadableSheetIds(undefined, query, sheetIds, { userId, permissions, isAdminRole })
    },
    auditLog,
    invalidateUserPerms,
  })
}
