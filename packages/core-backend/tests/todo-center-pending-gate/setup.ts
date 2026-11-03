/**
 * Dedicated setup for the todo-center §3.0 shared "pending" query production-path gate.
 *
 * todo-center-design-lock v2.14 §3.0's "测试约束" section: the DEFAULT integration harness
 * (`tests/setup.integration.ts`) sets `RBAC_BYPASS=true` and `RBAC_TOKEN_TRUST=true`, under which
 * `/dev-token`'s `roles=`/`perms=` query params become the actor's identity directly (no `users` /
 * `user_roles` / `user_permissions` row is ever read) — so the production-only divergence axes §1.5
 * documents (role source (a) vs (b), the dev-mock fallback, the RBAC-cache/backfill interactions)
 * are NEVER exercised there. This file, mirroring `tests/elearning-pilot-auth/setup.ts`, flips both
 * flags OFF and pins `PRODUCT_MODE=plm-workbench` BEFORE this suite's own file imports
 * auth/RBAC/`src/index` — module-level constants in `rbac.ts` (`trustTokenClaims`) and
 * `rbac/service.ts` (`TTL_MS`) read `process.env` exactly once, at import time, so setting these
 * anywhere later (including inside a `beforeAll`) would be too late.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.RBAC_BYPASS = 'false'
process.env.RBAC_TOKEN_TRUST = 'false'
// Design-lock §3.0: the gate's own import-time assertion (below, and again at the top of the gate
// file) is what makes this authoritative rather than advisory — `elearning-pilot-auth-gate.ts`'s
// three-guard precedent covers RBAC_BYPASS/RBAC_TOKEN_TRUST/PRODUCT_MODE only; NODE_ENV is NOT one
// of those three upstream, so this lane adds its own explicit assertion (the lock's "本 lane 的 gate
// 把 NODE_ENV 一并断言" instruction) rather than silently inheriting whatever the shell happened to
// export.
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'
// Not 'platform'/'attendance': AuthService.resolveRbacProfile backfills the attendance
// self-service role/permissions on first read under those two modes
// (config/product-mode.ts:supportsAttendanceSelfService), which would seed a `user_roles` row this
// suite's own class ⑤/⑥ fixtures need to control precisely. Same reasoning as the elearning
// precedent this file mirrors.
process.env.PRODUCT_MODE = 'plm-workbench'
// design-lock §3.0: the 60s process-level `listUserPermissions` cache (`rbac/service.ts`) must be
// disabled — `RBAC_CACHE_TTL_MS=0` makes the `>` comparison at its read site never hit, so a viewer
// authenticated AFTER this suite seeds their `user_permissions`/`user_roles` rows never reads a
// stale empty snapshot from an earlier (or absent) grant.
process.env.RBAC_CACHE_TTL_MS = '0'

function applyDotEnv(filePath: string): void {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (key === '' || process.env[key] !== undefined) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

applyDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'))

// design-lock §3.0 反 skip-green 三件之一: DATABASE_URL must already be set (the workflow's own
// `: "${DATABASE_URL:?...}"` step is the OTHER point of this same guard) — refusing to fabricate a
// default here is what keeps a broken/missing DB a RED run instead of a silently skipped one.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'todo-center pending-query gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'todo-center-pending-gate-jwt-secret-min-32b'
}

process.env.TODO_CENTER_PENDING_GATE_SETUP = '1'

if (process.env.RBAC_BYPASS !== 'false') {
  throw new Error('todo-center pending-query gate setup must set RBAC_BYPASS=false before auth/RBAC import')
}
if (process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('todo-center pending-query gate setup must set RBAC_TOKEN_TRUST=false before auth/RBAC import')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('todo-center pending-query gate setup must pin PRODUCT_MODE=plm-workbench to keep attendance self-service backfill off')
}
if (process.env.NODE_ENV !== 'test') {
  throw new Error('todo-center pending-query gate setup requires NODE_ENV=test (the /dev-token route 404s in production, and the dev-mock fallback probe needs it)')
}
if (process.env.RBAC_CACHE_TTL_MS !== '0') {
  throw new Error('todo-center pending-query gate setup must pin RBAC_CACHE_TTL_MS=0 before rbac/service.ts import')
}
