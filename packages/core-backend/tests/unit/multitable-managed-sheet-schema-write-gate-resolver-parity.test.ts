/**
 * TWO RESOLVERS, ONE VERDICT — the managed-sheet schema-write fence must answer identically on both
 * capability resolvers this codebase ships.
 *
 *   1. `resolveSheetCapabilitiesForAccess` (multitable/permission-service.ts) — the request-bound
 *      resolver every REST route reaches through `resolveSheetCapabilities`.
 *   2. `resolveSheetCapabilitiesForUser`  (multitable/sheet-capabilities.ts)  — the userId-keyed
 *      resolver that fronts the collab sheet/comment rooms + Yjs record auth (index.ts), the
 *      automation FWB save-time gates (automation-service.ts) and the OAPI token capability read
 *      (routes/api-tokens.ts).
 *
 * Resolver 2 already clones the approval-projection fence and the e-learning projection fence; it did
 * NOT clone the managed-sheet fence when that gate shipped, on the argument that no caller of
 * resolver 2 reads `canManageFields` today. That argument is true (verified caller by caller: they
 * read canRead / canCreateRecord / canEditRecord / canManageSheetAccess / canManageAutomation only,
 * and `deriveFieldPermissions` / `canWriteRecord` / `ensureRecordWriteAllowed` narrow their parameter
 * to canEditRecord+canCreateRecord) — so the missing fence was LATENT, not a live hole. It is wired
 * anyway, and pinned HERE: a divergence between the two resolvers is a defect on its own, because the
 * next caller to read `capabilities.canManageFields` through resolver 2 would silently inherit an open
 * schema plane.
 *
 * Every cell feeds BOTH resolvers the SAME (user, sheet, grant, admin-flag) input and compares their
 * `canManageFields` verdicts to EACH OTHER, not just to a constant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  userHasPermission: vi.fn(),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

import {
  resolveSheetCapabilitiesForAccess,
  type QueryFn,
} from '../../src/multitable/permission-service'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import { isAdmin, listUserPermissions } from '../../src/rbac/service'

const SHEET_ID = 'sheet_parity_subject'
const ACTOR = 'u_parity_writer'
/**
 * No global codes at all: `canManageFields` can only come from the SHEET-level full-write grant that
 * `applyContextSheetSchemaWriteGrant` promotes — the exact tier the fence exists to narrow, and the
 * one composition step both resolvers share verbatim.
 */
const PERMISSIONS: string[] = []

const REGISTRY_SQL = 'FROM plugin_multitable_object_registry'

type Opts = { managed: boolean; throwOnRegistry?: boolean }

/** One fake DB, handed to both resolvers, so the ONLY difference between them is their own code. */
function makeQuery(opts: Opts): { query: QueryFn; sqlLog: string[] } {
  const sqlLog: string[] = []
  const query = (async (sql: string, params?: unknown[]) => {
    sqlLog.push(sql)
    if (sql.includes(REGISTRY_SQL)) {
      if (opts.throwOnRegistry) {
        throw Object.assign(
          new Error('relation "plugin_multitable_object_registry" does not exist'),
          { code: '42P01' },
        )
      }
      return { rows: opts.managed ? [{ '?column?': 1 }] : [] }
    }
    if (sql.includes('FROM spreadsheet_permissions')) {
      const requested = Array.isArray(params?.[1]) ? (params?.[1] as unknown[]).map(String) : []
      return {
        rows: requested.map((sheetId) => ({
          sheet_id: sheetId,
          perm_code: 'spreadsheet:write',
          subject_type: 'user',
        })),
      }
    }
    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ deleted_at: null }] }
    }
    // Everything else (approval-projection probe, e-learning projection map, ...) answers "no rows".
    return { rows: [] }
  }) as QueryFn
  return { query, sqlLog }
}

type Verdicts = {
  viaRequest: boolean
  viaUser: boolean
  requestEdit: boolean
  userEdit: boolean
  requestLog: string[]
  userLog: string[]
}

async function bothResolvers(opts: Opts, isAdminRole: boolean): Promise<Verdicts> {
  vi.mocked(isAdmin).mockResolvedValue(isAdminRole)
  vi.mocked(listUserPermissions).mockResolvedValue(PERMISSIONS)

  const req = makeQuery(opts)
  const resolvedViaRequest = await resolveSheetCapabilitiesForAccess(req.query, SHEET_ID, {
    userId: ACTOR,
    permissions: PERMISSIONS,
    isAdminRole,
  })

  const usr = makeQuery(opts)
  const resolvedViaUser = await resolveSheetCapabilitiesForUser(usr.query, SHEET_ID, ACTOR)

  return {
    viaRequest: resolvedViaRequest.capabilities.canManageFields,
    viaUser: resolvedViaUser.capabilities.canManageFields,
    requestEdit: resolvedViaRequest.capabilities.canEditRecord,
    userEdit: resolvedViaUser.capabilities.canEditRecord,
    requestLog: req.sqlLog,
    userLog: usr.sqlLog,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('managed-sheet schema-write fence — the two capability resolvers agree', () => {
  it('MANAGED sheet x non-admin x sheet-level full write: BOTH resolvers answer canManageFields=false', async () => {
    const v = await bothResolvers({ managed: true }, false)
    expect(v.viaUser).toBe(v.viaRequest)
    expect({ viaRequest: v.viaRequest, viaUser: v.viaUser }).toEqual({ viaRequest: false, viaUser: false })
  })

  it('ORDINARY sheet, same actor and same grant: BOTH resolvers answer canManageFields=true', async () => {
    const v = await bothResolvers({ managed: false }, false)
    expect(v.viaUser).toBe(v.viaRequest)
    expect({ viaRequest: v.viaRequest, viaUser: v.viaUser }).toEqual({ viaRequest: true, viaUser: true })
  })

  it('registry lookup THROWS: BOTH resolvers fail closed to canManageFields=false', async () => {
    const v = await bothResolvers({ managed: false, throwOnRegistry: true }, false)
    expect(v.viaUser).toBe(v.viaRequest)
    expect({ viaRequest: v.viaRequest, viaUser: v.viaUser }).toEqual({ viaRequest: false, viaUser: false })
    // Narrowing only, on BOTH: an unreadable registry must not take the data plane down with it.
    expect({ requestEdit: v.requestEdit, userEdit: v.userEdit }).toEqual({ requestEdit: true, userEdit: true })
  })

  it('MANAGED sheet x ADMIN: BOTH resolvers keep canManageFields=true (identical admin exemption)', async () => {
    const v = await bothResolvers({ managed: true }, true)
    expect(v.viaUser).toBe(v.viaRequest)
    expect({ viaRequest: v.viaRequest, viaUser: v.viaUser }).toEqual({ viaRequest: true, viaUser: true })
  })

  it('MANAGED sheet x non-admin: the DATA plane is untouched on BOTH resolvers', async () => {
    const v = await bothResolvers({ managed: true }, false)
    expect({ requestEdit: v.requestEdit, userEdit: v.userEdit }).toEqual({ requestEdit: true, userEdit: true })
  })

  it('BOTH resolvers read the registry exactly when there is something to narrow', async () => {
    const narrowing = await bothResolvers({ managed: true }, false)
    expect(narrowing.requestLog.some((sql) => sql.includes(REGISTRY_SQL))).toBe(true)
    expect(narrowing.userLog.some((sql) => sql.includes(REGISTRY_SQL))).toBe(true)

    // Admin: nothing to narrow, so neither resolver pays the query.
    const admin = await bothResolvers({ managed: true }, true)
    expect(admin.requestLog.some((sql) => sql.includes(REGISTRY_SQL))).toBe(false)
    expect(admin.userLog.some((sql) => sql.includes(REGISTRY_SQL))).toBe(false)
  })
})
