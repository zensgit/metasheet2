/**
 * 真实的认证服务实现
 * 替换之前的mock实现
 */

import * as jwt from 'jsonwebtoken'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'node:crypto'
import { poolManager } from '../integration/db/connection-pool'
import { Logger } from '../core/logger'
import { secretManager } from '../security/SecretManager'
import { getBcryptSaltRounds, getProductionAuthSecurityIssues, resolveRuntimeJwtSecret } from '../security/auth-runtime-config'
import { invalidateUserPerms, isAdmin as isRbacAdmin, listUserPermissions } from '../rbac/service'
import { supportsAttendanceSelfService } from '../config/product-mode'
import { isUserSessionRevoked } from './session-revocation'
import { createUserSession, isUserSessionActive } from './session-registry'
import {
  assertAliasCutoverAllowed,
  claimNonEmptyLoginAliasesOrThrow,
  findUserIdByLoginAlias,
  isAuthLoginAliasCutoverEnabled,
} from './login-alias-service'
import type { AliasQueryClient } from './login-alias-service'
import { evaluateUserAuthenticationGate } from './user-activation'
import { isRecoveryAuthorityBusyError } from '../multitable/recovery-authorization-stability'

export interface User {
  id: string
  email: string | null
  username?: string | null
  name: string
  mobile?: string | null
  role: string
  permissions: string[]
  tenantId?: string
  is_active?: boolean
  must_change_password?: boolean
  activation_status?: string
  local_password_set?: boolean
  created_at: Date
  updated_at: Date
  // Index signature for compatibility with Express.Request.user
  [key: string]: unknown
}

// Database user row type (includes password_hash)
interface UserRow extends User {
  password_hash: string
}

const USER_AUTH_SELECT =
  'id, email, username, mobile, name, role, permissions, password_hash, is_active, must_change_password, activation_status, local_password_set, created_at, updated_at'

export interface TokenPayload {
  userId: string
  email: string
  role: string
  tenantId?: string
  sid?: string
  iat: number
  exp: number
}

export interface AuthConfig {
  jwtSecret: string
  jwtExpiry: string
  saltRounds: number
}

const ATTENDANCE_SELF_SERVICE_ROLE_ID = 'attendance_employee'
const ATTENDANCE_SELF_SERVICE_PERMISSIONS = ['attendance:read', 'attendance:write'] as const

// P23: user_roles (and users) are among exact-anchor recovery's eight recovery-authority
// tables. A write that lands while recovery holds the per-subject lease fails fast with
// Postgres SQLSTATE 40001 (see recovery-authorization-stability.ts's
// isRecoveryAuthorityBusyError / RECOVERY_AUTHORITY_BUSY_MARKER — reused here, not
// re-derived). That is transient and retryable, so both retry sites below reuse these
// constants: assignUserRoles retries its standalone INSERT a bounded number of times
// in-process (read-path backfill in resolveRbacProfile), and register() retries its WHOLE
// user-creation transaction the same bounded number of times (O2-S1 — a 40001 aborts the
// open transaction, so per-statement retry inside it is impossible; the retry unit is the
// transaction). USER_ROLE_ASSIGNMENT_RETRY_LIMIT is the total number of attempts (not
// "retries after the first"); the backoff is small because a busy lease must not add much
// latency to every authenticated request for a user missing attendance permissions.
export const USER_ROLE_ASSIGNMENT_RETRY_LIMIT = 3
const USER_ROLE_ASSIGNMENT_RETRY_BASE_DELAY_MS = 20

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * O2-A3 (gate NIT-2): the register-path discrimination between "identity already taken"
 * (swallow to `null` → the route's 409 "already exists") and every other failure
 * (rethrow → the route's real 500). Register claims only the email alias, so an
 * ALIAS_CONFLICT LoginAliasClaimError here IS an email-identity conflict (a WRITE_FAILED
 * one is a real write failure and must rethrow); Postgres 23505 on this path is the
 * users email unique index (user_permissions/user_roles both insert with
 * ON CONFLICT DO NOTHING, and the id is a fresh randomUUID). NOT a general-purpose
 * duplicate detector — scoped to register()'s write set only.
 *
 * Duck-typed on `.code` rather than a bare `instanceof LoginAliasClaimError` (gate #5018
 * NIT-3, lesson 判据本身也要被攻击): under a duplicated module instance `instanceof`
 * silently fails and a genuine ALIAS_CONFLICT would rethrow → generic 500 instead of the
 * truthful 409. `'ALIAS_CONFLICT'` is produced only by LoginAliasClaimError on this
 * write set (Postgres errors carry SQLSTATE codes), so the duck-type does not widen the
 * criterion; `'ALIAS_WRITE_FAILED'` still falls through to rethrow.
 */
function isDuplicateIdentityConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'ALIAS_CONFLICT' || code === '23505'
}

/**
 * Thrown by assignUserRoles when every retry against a recovery-authority-busy (40001) write
 * is exhausted. Named and exported so callers (and tests) can distinguish "role assignment is
 * retryable-failed" from every other error assignUserRoles used to swallow unconditionally.
 */
export class UserRoleAssignmentRecoveryBusyError extends Error {
  readonly code = 'USER_ROLE_ASSIGNMENT_RECOVERY_BUSY'
  readonly retryable = true

  constructor(readonly userId: string, readonly roleIds: readonly string[], cause: unknown) {
    super('User role assignment did not persist: recovery authority lease is busy')
    this.name = 'UserRoleAssignmentRecoveryBusyError'
    if (cause !== undefined) {
      ;(this as { cause?: unknown }).cause = cause
    }
  }
}

export class AuthService {
  private config: AuthConfig
  private logger: Logger

  constructor() {
    this.logger = new Logger('AuthService')
    const secret = secretManager.get('JWT_SECRET', { required: false })
    this.config = {
      jwtSecret: resolveRuntimeJwtSecret(secret),
      jwtExpiry: process.env.JWT_EXPIRY || '24h',
      saltRounds: getBcryptSaltRounds()
    }

    // Production security validation
    this.validateProductionSecurity(secret)
  }

  private validateProductionSecurity(secretValue?: string): void {
    if (process.env.NODE_ENV === 'production') {
      const issues = getProductionAuthSecurityIssues(process.env, secretValue)

      // Check JWT expiry
      if (this.config.jwtExpiry === '24h') {
        this.logger.warn('Using default JWT expiry (24h). Consider shorter expiry for production.')
      }

      if (issues.length > 0) {
        this.logger.error('PRODUCTION SECURITY ISSUES:')
        issues.forEach(issue => this.logger.error(`  - ${issue}`))
        this.logger.error('Please fix these issues before deploying to production!')
      }
    }
  }

  private trustTokenClaimsEnabled(): boolean {
    if (!(process.env.RBAC_TOKEN_TRUST === 'true' || process.env.RBAC_TOKEN_TRUST === '1')) {
      return false
    }

    return process.env.NODE_ENV !== 'production'
  }

  private createSessionId(): string {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return crypto.randomBytes(16).toString('hex')
  }

  private normalizeClaimStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
  }

  private normalizeClaimString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  /**
   * Dev-only exception (NODE_ENV !== production && RBAC_TOKEN_TRUST): trusts JWT claims
   * without DB activation gate. Production never enables this path. Not a substitute for
   * T1 fail-closed verifyToken DB path.
   */
  private buildTrustedTokenUser(
    payload: TokenPayload & { id?: string; sub?: string; roles?: unknown; perms?: unknown; name?: unknown; email?: unknown; role?: unknown },
  ): User | null {
    if (!this.trustTokenClaimsEnabled()) return null

    const userId = this.resolveTokenUserId(payload)
    if (!userId) return null

    const roles = this.normalizeClaimStringArray(payload.roles)
    const permissions = this.normalizeClaimStringArray(payload.perms)
    if (roles.length === 0 && permissions.length === 0) return null

    const role =
      roles.includes('admin')
        ? 'admin'
        : (typeof payload.role === 'string' && payload.role.trim() ? payload.role.trim() : roles[0] || 'user')
    const email =
      typeof payload.email === 'string' && payload.email.trim().length > 0
        ? payload.email.trim()
        : `${userId}@trusted-token.local`
    const name =
      typeof payload.name === 'string' && payload.name.trim().length > 0
        ? payload.name.trim()
        : 'Trusted Token User'
    const tenantId = this.normalizeClaimString(payload.tenantId)

    return {
      id: userId,
      email,
      name,
      role,
      permissions,
      ...(tenantId ? { tenantId } : {}),
      is_active: true,
      activation_status: 'activated',
      local_password_set: true,
      created_at: new Date(0),
      updated_at: new Date(0),
      roles,
      perms: permissions,
    }
  }

  /**
   * 验证JWT token
   */
  async verifyToken(token: string): Promise<User | null> {
    try {
      // 验证token格式和签名
      const payload = jwt.verify(token, this.config.jwtSecret) as TokenPayload & { id?: string; sub?: string }
      const userId = this.resolveTokenUserId(payload)
      if (!userId) {
        this.logger.warn('Token verification failed: missing user identity claim')
        return null
      }

      const trustedUser = this.buildTrustedTokenUser(
        payload as TokenPayload & { id?: string; sub?: string; roles?: unknown; perms?: unknown; name?: unknown; email?: unknown; role?: unknown },
      )
      if (trustedUser) {
        return trustedUser
      }

      // 从数据库获取最新用户信息
      const user = await this.getUserById(userId)
      if (!user) {
        return null
      }

      // T1: fail-closed on pending / invalid activation / inactive (shared gate).
      if (evaluateUserAuthenticationGate(user)) {
        return null
      }

      if (await isUserSessionRevoked(user.id, payload.iat)) {
        this.logger.warn(`Token verification failed: session revoked for user ${user.id}`)
        return null
      }

      if (typeof payload.sid === 'string' && payload.sid.trim().length > 0) {
        const active = await isUserSessionActive(user.id, payload.sid.trim())
        if (!active) {
          this.logger.warn(`Token verification failed: session ${payload.sid} inactive for user ${user.id}`)
          return null
        }
      }

      const tenantClaim = this.normalizeClaimString(payload.tenantId)
      const tenantId = tenantClaim
        ? await this.resolveSessionTenantId(user.id, tenantClaim)
        : undefined
      return this.sanitizeUser(tenantId ? { ...user, tenantId } : user)
    } catch (error) {
      this.logger.warn('Token verification failed', error instanceof Error ? error : undefined)
      return null
    }
  }

  /**
   * 创建JWT token
   */
  createToken(user: User, options: { sid?: string } = {}): string {
    const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email ?? '',
      role: user.role,
      ...(typeof user.tenantId === 'string' && user.tenantId.trim().length > 0 ? { tenantId: user.tenantId.trim() } : {}),
      ...(typeof options.sid === 'string' && options.sid.trim().length > 0 ? { sid: options.sid.trim() } : {}),
    }

    return jwt.sign(payload, this.config.jwtSecret, {
      expiresIn: this.config.jwtExpiry
    } as jwt.SignOptions)
  }

  /**
   * 检查用户权限
   */
  checkPermission(user: User, resource: string, action: string): boolean {
    // 超级管理员拥有所有权限
    if (user.role === 'admin') {
      return true
    }

    // 检查特定权限
    const requiredPermission = `${resource}:${action}`
    return user.permissions.includes(requiredPermission) || user.permissions.includes(`${resource}:*`)
  }

  /**
   * 用户登录
   */
  async login(
    identifier: string,
    password: string,
    options: { ipAddress?: string | null; userAgent?: string | null; tenantId?: string | null } = {},
  ): Promise<{ user: User; token: string } | null> {
    try {
      const user = await this.getUserByIdentifier(identifier)
      if (!user) {
        return null
      }

      // Password usability gate before bcrypt (pending / SSO-only accounts).
      const gate = evaluateUserAuthenticationGate(user, { requireLocalPassword: true })
      if (gate) {
        return null
      }

      // 验证密码
      const isValid = await bcrypt.compare(password, user.password_hash)
      if (!isValid) {
        return null
      }

      const sessionId = crypto.randomUUID()
      const tenantId = await this.resolveSessionTenantId(user.id, options.tenantId)
      const token = this.createToken(tenantId ? { ...user, tenantId } : user, { sid: sessionId })
      const payload = this.readTokenPayload(token)
      if (payload?.exp) {
        await createUserSession(user.id, {
          sessionId,
          expiresAt: new Date(payload.exp * 1000).toISOString(),
          ipAddress: options.ipAddress ?? null,
          userAgent: options.userAgent ?? null,
        })
      }

      // 更新最后登录时间
      await this.updateLastLogin(user.id)

      // 返回用户信息（不包含密码hash）
      const safeUser = this.sanitizeUser(tenantId ? { ...user, tenantId } : user)
      return { user: safeUser, token }
    } catch (error) {
      // Surface alias cutover misconfiguration to operators (do not swallow as null login).
      if ((error as { code?: string } | null)?.code === 'ALIAS_CUTOVER_BLOCKED') {
        throw error
      }
      this.logger.error('Login error', error instanceof Error ? error : undefined)
      return null
    }
  }

  async resolveSessionTenantId(userId: string, requestedTenantId?: string): Promise<string | undefined> {
    const requested = typeof requestedTenantId === 'string' && requestedTenantId.trim().length > 0
      ? requestedTenantId.trim()
      : undefined
    try {
      const pool = poolManager.get()
      if (requested) {
        const result = await pool.query(
          `SELECT uo.org_id
           FROM user_orgs uo
           JOIN users u ON u.id = uo.user_id
           WHERE uo.user_id = $1
             AND uo.org_id = $2
             AND uo.is_active = true
             AND u.is_active = true
           LIMIT 1`,
          [userId, requested],
        )
        return result.rows[0]?.org_id === requested ? requested : undefined
      }

      const result = await pool.query(
        `SELECT uo.org_id
         FROM user_orgs uo
         JOIN users u ON u.id = uo.user_id
         WHERE uo.user_id = $1
           AND uo.is_active = true
           AND u.is_active = true
         ORDER BY uo.org_id ASC
         LIMIT 2`,
        [userId],
      )
      return result.rows.length === 1 && typeof result.rows[0]?.org_id === 'string'
        ? result.rows[0].org_id
        : undefined
    } catch (error) {
      this.logger.warn('Session tenant resolution failed', error instanceof Error ? error : undefined)
      return undefined
    }
  }

  /**
   * 用户注册
   */
  // W4-PRE-1 policy (§3.3 item 2 of the Wave-4 onboarding design lock, docs/development/
  // attendance-vnext-wave4-onboarding-design-lock-20260721.md): this signature carries no org
  // parameter and this deployment-level self-service registration path has no source of an
  // authoritative org anywhere in its call chain — it is the design lock's own example of an
  // "org 不可知的路径(如部署级注册)". Per the explicit ticket instruction, an org-unknowable
  // path MUST record its policy and MUST NOT silently guess an org (e.g. defaulting to
  // 'default' — that string is the one-time zzzz20260114110000 backfill's semantics, not a
  // live admission default). Deliberately: this method does NOT write user_orgs. A user
  // created here has no org membership until an org-aware admission path (POST
  // /api/admin/users with attendanceOrgId, or directory sync admission) later adds one, or an
  // operator backfills it explicitly. Verified by
  // tests/integration/attendance-w4pre1-user-orgs-policy.db.test.ts (zero user_orgs rows for a
  // user created via this path).
  async register(email: string, password: string, name: string): Promise<User | null> {
    try {
      // 检查邮箱是否已存在
      const existingUser = await this.getUserByEmail(email)
      if (existingUser) {
        return null
      }

      // 加密密码 — self-service register is always activated + local password set
      const passwordHash = await bcrypt.hash(password, this.config.saltRounds)
      const enableAttendanceSelfService = supportsAttendanceSelfService(process.env.PRODUCT_MODE)
      const registrationPermissions = [
        'spreadsheet:read',
        'spreadsheet:write',
        'spreadsheets:read',
        'spreadsheets:write',
        ...(enableAttendanceSelfService
          ? ATTENDANCE_SELF_SERVICE_PERMISSIONS
          : []),
      ]

      // 创建用户
      const userId = crypto.randomUUID()
      const selfServiceRoleIds = enableAttendanceSelfService
        ? [ATTENDANCE_SELF_SERVICE_ROLE_ID]
        : []

      // P23 / O2-S1: user creation and self-service role assignment are ONE transaction —
      // the users, user_login_aliases, user_permissions and user_roles rows all commit or
      // none do. user_roles (and users) are recovery-authority tables, so any of these
      // writes can fail fast with 40001 while recovery holds the per-subject lease; a 40001
      // aborts the whole open transaction (later statements would fail with 25P02), so the
      // bounded retry re-runs the WHOLE transaction, reusing the same retry-limit/backoff
      // constants assignUserRoles has always used. Exhaustion throws the same named
      // UserRoleAssignmentRecoveryBusyError — but now with zero residue, unlike the
      // pre-slice shape where the user row stayed committed while the role was missing.
      const pool = poolManager.get()
      for (let attempt = 1; ; attempt++) {
        let newUser: User | null
        try {
          newUser = await pool.transaction(async (client) => {
            const created = await this.createUserInTransaction(client, {
              id: userId,
              email,
              name,
              password_hash: passwordHash,
              role: 'user',
              permissions: registrationPermissions,
            })
            if (created && selfServiceRoleIds.length > 0) {
              await this.insertUserRolesOnce(client, userId, selfServiceRoleIds)
            }
            return created
          })
        } catch (txnError) {
          if (isRecoveryAuthorityBusyError(txnError)) {
            if (attempt >= USER_ROLE_ASSIGNMENT_RETRY_LIMIT) {
              throw new UserRoleAssignmentRecoveryBusyError(userId, selfServiceRoleIds, txnError)
            }
            await delay(USER_ROLE_ASSIGNMENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
            continue
          }
          // O2-A3 (gate NIT-2): `null` must mean "identity already taken" and NOTHING
          // else — the registration route maps null to 409 "User with this email
          // already exists" (routes/auth.ts). A duplicate-identity conflict (the alias
          // claim losing a concurrent-register race, or the users email unique index
          // firing — the race twin of the getUserByEmail pre-check) keeps the
          // historical swallow-to-null; the whole transaction has rolled back,
          // fail-closed. Every OTHER transaction failure now rethrows, so the route's
          // catch answers its real 500 instead of fabricating an "exists" 409.
          if (isDuplicateIdentityConflict(txnError)) {
            this.logger.warn('Registration identity conflict', txnError instanceof Error ? txnError : undefined)
            return null
          }
          this.logger.warn('Database insert failed', txnError instanceof Error ? txnError : undefined)
          throw txnError
        }
        if (newUser && selfServiceRoleIds.length > 0) {
          // Only after the transaction actually committed — invalidating before commit
          // could refill the cache from a state the commit then supersedes.
          invalidateUserPerms(userId)
        }
        return newUser
      }
    } catch (error) {
      this.logger.error('Registration error', error instanceof Error ? error : undefined)
      // P23: bounded whole-transaction retries exhausted against a busy recovery lease.
      // Everything rolled back (no user/alias/permission/role residue — O2-S1), but
      // re-throw so the caller (the registration route in routes/auth.ts, which wraps this
      // call in its own try/catch) sees a retryable failure instead of a fabricated
      // success — never swallow this one to `null` alongside the ordinary "email already
      // exists" case.
      if (error instanceof UserRoleAssignmentRecoveryBusyError) throw error
      // O2-A3 (gate NIT-2): the same discrimination as the transaction catch — `null`
      // is reserved for "identity already taken". Anything else (bcrypt failure,
      // getUserByEmail infrastructure error, rethrown transaction failures passing
      // through) propagates to the route's own catch → its real 500, never a
      // fabricated "email already exists" 409.
      if (isDuplicateIdentityConflict(error)) return null
      throw error
    }
  }

  /**
   * 通过ID获取用户
   */
  private async getUserById(userId: string): Promise<(User & { password_hash: string }) | null> {
    try {
      // 首先尝试从数据库获取
      try {
        const pool = poolManager.get()
        const result = await pool.query(
          `SELECT ${USER_AUTH_SELECT} FROM users WHERE id = $1`,
          [userId]
        )

        if (result.rows.length > 0) {
          const row = result.rows[0] as UserRow
          const resolved = await this.resolveRbacProfile(row.id, row.role, Array.isArray(row.permissions) ? row.permissions : [])
          return {
            id: row.id,
            email: row.email,
            username: row.username ?? null,
            mobile: row.mobile ?? null,
            name: row.name,
            role: resolved.role,
            permissions: resolved.permissions,
            is_active: row.is_active,
            must_change_password: row.must_change_password,
            activation_status: row.activation_status,
            local_password_set: row.local_password_set,
            password_hash: row.password_hash,
            created_at: row.created_at,
            updated_at: row.updated_at
          }
        }
      } catch (dbError) {
        this.logger.warn('Database query failed', dbError instanceof Error ? dbError : undefined)
      }

      // 降级：返回mock用户（非生产环境）
      if (process.env.NODE_ENV !== 'production') {
        return {
          id: userId,
          email: 'dev@metasheet.com',
          username: 'dev-user',
          name: 'Development User',
          mobile: null,
          role: 'admin',
          permissions: ['*:*'],
          is_active: true,
          must_change_password: false,
          activation_status: 'activated',
          local_password_set: true,
          password_hash: await bcrypt.hash('dev123', this.config.saltRounds),
          created_at: new Date(),
          updated_at: new Date()
        }
      }

      return null
    } catch (error) {
      this.logger.error('Get user by ID error', error instanceof Error ? error : undefined)
      return null
    }
  }

  private async getUserByEmail(email: string): Promise<(User & { password_hash: string }) | null> {
    return this.getUserByIdentifier(email)
  }

  /**
   * 通过邮箱、用户名或手机号获取用户
   */
  private async getUserByIdentifier(identifier: string): Promise<(User & { password_hash: string }) | null> {
    try {
      const trimmedIdentifier = identifier.trim()
      if (!trimmedIdentifier) return null

      try {
        const pool = poolManager.get()

        // T2b: alias-only login (no OR fallback to users.email/username/mobile).
        // Enforce admin-alias readiness gate on every auth path that would use aliases —
        // enabling AUTH_LOGIN_USE_ALIASES without a password-capable admin must not lock
        // operators out while reporting ready:true elsewhere.
        if (isAuthLoginAliasCutoverEnabled()) {
          await assertAliasCutoverAllowed()
          const userId = await findUserIdByLoginAlias(trimmedIdentifier)
          if (!userId) return null
          const byId = await pool.query(
            `SELECT ${USER_AUTH_SELECT} FROM users WHERE id = $1 LIMIT 1`,
            [userId],
          )
          if (!byId.rows[0]) return null
          return this.mapAuthUserRow(byId.rows[0] as UserRow)
        }

        // T2a (default): legacy OR-column path remains until cutover.
        const normalizedEmail = trimmedIdentifier.toLowerCase()
        const normalizedUsername = trimmedIdentifier.toLowerCase()
        const normalizedMobile = trimmedIdentifier.replace(/\s+/g, '')
        const result = await pool.query(
          `SELECT ${USER_AUTH_SELECT}
           FROM users
           WHERE lower(email) = $1
              OR lower(username) = $2
              OR regexp_replace(mobile, '\\s+', '', 'g') = $3
           ORDER BY
             CASE
               WHEN lower(email) = $1 THEN 0
               WHEN lower(username) = $2 THEN 1
               WHEN regexp_replace(mobile, '\\s+', '', 'g') = $3 THEN 2
               ELSE 3
             END ASC,
             created_at ASC
           LIMIT 2`,
          [normalizedEmail, normalizedUsername, normalizedMobile]
        )

        const distinctUserIds = new Set(result.rows.map((row) => row.id))
        if (distinctUserIds.size > 1) {
          return null
        }

        if (result.rows.length > 0) {
          return this.mapAuthUserRow(result.rows[0] as UserRow)
        }
      } catch (dbError) {
        if ((dbError as { code?: string } | null)?.code === 'ALIAS_CUTOVER_BLOCKED') {
          throw dbError
        }
        this.logger.warn('Database query failed', dbError instanceof Error ? dbError : undefined)
      }
      return null
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ALIAS_CUTOVER_BLOCKED') {
        throw error
      }
      this.logger.error('Get user by identifier error', error instanceof Error ? error : undefined)
      return null
    }
  }

  private async mapAuthUserRow(row: UserRow): Promise<(User & { password_hash: string })> {
    const resolved = await this.resolveRbacProfile(
      row.id,
      row.role,
      Array.isArray(row.permissions) ? row.permissions : [],
    )
    return {
      id: row.id,
      email: row.email,
      username: row.username ?? null,
      mobile: row.mobile ?? null,
      name: row.name,
      role: resolved.role,
      permissions: resolved.permissions,
      is_active: row.is_active,
      must_change_password: row.must_change_password,
      activation_status: row.activation_status,
      local_password_set: row.local_password_set,
      password_hash: row.password_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private sanitizeUser(user: User & { password_hash?: string }): User {
    const { password_hash: _password_hash, ...safeUser } = user
    return safeUser as User
  }

  private async resolveRbacProfile(
    userId: string,
    fallbackRole: string,
    fallbackPermissions: string[]
  ): Promise<{ role: string; permissions: string[] }> {
    let role = fallbackRole
    let permissions = fallbackPermissions

    try {
      const admin = await isRbacAdmin(userId)
      if (admin) role = 'admin'
    } catch (error) {
      this.logger.warn('RBAC role lookup failed', error instanceof Error ? error : undefined)
    }

    try {
      permissions = await listUserPermissions(userId)
    } catch (error) {
      this.logger.warn('RBAC permission lookup failed', error instanceof Error ? error : undefined)
    }

    if (this.shouldBackfillAttendanceSelfService(role, permissions)) {
      // P23: this call is NOT inside a try today, and assignUserRoles can now throw
      // (UserRoleAssignmentRecoveryBusyError) instead of always swallowing. resolveRbacProfile
      // is reached from every getUserById/getUserByIdentifier read (login, verifyToken, ...),
      // so an uncaught throw here would turn a transient recovery-busy lease into "user not
      // found" for an otherwise-valid session on every authenticated request. Contain the
      // failure locally: only merge the backfilled attendance permissions into the in-memory
      // result once assignUserRoles has confirmed they persisted. If it did not persist, the
      // permissions must not appear in the returned value even though this is a best-effort
      // backfill — do not fabricate unpersisted permissions.
      try {
        await this.assignUserRoles(userId, [ATTENDANCE_SELF_SERVICE_ROLE_ID])
        permissions = Array.from(new Set([...permissions, ...ATTENDANCE_SELF_SERVICE_PERMISSIONS]))
      } catch (error) {
        this.logger.warn(
          'Attendance self-service role backfill did not persist; omitting unpersisted permissions',
          error instanceof Error ? error : undefined,
        )
      }
    }

    return { role, permissions }
  }

  private shouldBackfillAttendanceSelfService(role: string, permissions: string[]): boolean {
    if (!supportsAttendanceSelfService(process.env.PRODUCT_MODE)) return false
    if (role === 'admin') return false
    return !permissions.some((permission) => permission.startsWith('attendance:'))
  }

  /**
   * 创建新用户 — runs inside the CALLER's open transaction (O2-S1).
   *
   * The only caller is register(), which owns the pool.transaction wrapper so that the
   * self-service user_roles insert commits or rolls back atomically with the users row.
   * Errors propagate to the transaction owner — retry/swallow semantics live there, because
   * after a 40001 the transaction is aborted and nothing here could be retried in place.
   *
   * Load-bearing alias writer hook: activated self-registration must claim the email
   * login alias in the same transaction as the users row. Removing
   * claimNonEmptyLoginAliasesOrThrow here must fail tests/unit/login-alias-writers.test.ts
   * and tests/integration/login-alias-writers.db.test.ts (auth_register class).
   * An alias conflict throws and rolls back the users insert (fail-closed).
   */
  private async createUserInTransaction(
    client: AliasQueryClient,
    userData: {
      id: string
      email: string
      name: string
      password_hash: string
      role: string
      permissions: string[]
    },
  ): Promise<User | null> {
    const permissionsJson = JSON.stringify(userData.permissions)
    const result = await client.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         activation_status, local_password_set, is_active,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'activated', TRUE, TRUE, NOW(), NOW())
       RETURNING id, email, name, role, permissions, must_change_password,
                 activation_status, local_password_set, is_active, created_at, updated_at`,
      [userData.id, userData.email, userData.name, userData.password_hash, userData.role, permissionsJson],
    )

    if (result.rows.length === 0) return null

    // Alias full-writer: claim non-empty identifiers (email for self-registration).
    await claimNonEmptyLoginAliasesOrThrow({
      userId: userData.id,
      email: userData.email,
      source: 'auth_register',
      client,
    })

    if (userData.permissions.length > 0) {
      const values = userData.permissions.map((_, index) => `($1, $${index + 2})`).join(', ')
      await client.query(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [userData.id, ...userData.permissions],
      )
    }

    const row = result.rows[0] as User
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
      must_change_password: row.must_change_password,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  /**
   * Single-shot user_roles insert against the given query surface (pool for the standalone
   * retry loop in assignUserRoles, transaction client for register). Deliberately does NOT
   * retry or invalidate caches — the caller owns both.
   */
  private async insertUserRolesOnce(
    client: AliasQueryClient,
    userId: string,
    roleIds: readonly string[],
  ): Promise<void> {
    for (const roleId of roleIds) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, roleId]
      )
    }
  }

  private async assignUserRoles(userId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return
    const pool = poolManager.get()
    for (let attempt = 1; ; attempt++) {
      try {
        await this.insertUserRolesOnce(pool, userId, roleIds)
        invalidateUserPerms(userId)
        return
      } catch (error) {
        if (isRecoveryAuthorityBusyError(error)) {
          if (attempt >= USER_ROLE_ASSIGNMENT_RETRY_LIMIT) {
            // Bounded retries exhausted — do NOT silently warn-and-swallow like every other
            // error here: the caller must learn roles were not persisted (P23 requirement).
            throw new UserRoleAssignmentRecoveryBusyError(userId, roleIds, error)
          }
          await delay(USER_ROLE_ASSIGNMENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
          continue
        }
        // Unrelated errors keep the pre-existing behavior: warn and swallow.
        this.logger.warn('User role assignment failed during registration', error instanceof Error ? error : undefined)
        return
      }
    }
  }

  /**
   * 更新最后登录时间
   */
  private async updateLastLogin(userId: string): Promise<void> {
    try {
      try {
        const pool = poolManager.get()
        await pool.query(
          'UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1',
          [userId]
        )
      } catch (dbError) {
        this.logger.warn('Database update failed', dbError instanceof Error ? dbError : undefined)
      }
    } catch (error) {
      this.logger.error('Update last login error', error instanceof Error ? error : undefined)
    }
  }

  /**
   * 刷新token
   */
  async refreshToken(oldToken: string): Promise<string | null> {
    try {
      // 验证旧token（忽略过期）
      const payload = jwt.verify(oldToken, this.config.jwtSecret, { ignoreExpiration: true }) as TokenPayload & { id?: string; sub?: string }
      const userId = this.resolveTokenUserId(payload)
      if (!userId) {
        this.logger.warn('Token refresh failed: missing user identity claim')
        return null
      }

      // 获取用户最新信息
      const user = await this.getUserById(userId)
      if (!user) {
        return null
      }
      if (evaluateUserAuthenticationGate(user)) {
        return null
      }

      if (await isUserSessionRevoked(user.id, payload.iat)) {
        this.logger.warn(`Token refresh failed: session revoked for user ${user.id}`)
        return null
      }

      const sessionId = typeof payload.sid === 'string' && payload.sid.trim().length > 0
        ? payload.sid.trim()
        : this.createSessionId()
      if (typeof payload.sid === 'string' && payload.sid.trim().length > 0) {
        const active = await isUserSessionActive(user.id, sessionId)
        if (!active) {
          this.logger.warn(`Token refresh failed: session ${sessionId} inactive for user ${user.id}`)
          return null
        }
      }

      const tenantId = await this.resolveSessionTenantId(user.id, this.normalizeClaimString(payload.tenantId))
      const refreshedUser = tenantId
        ? { ...user, tenantId }
        : user
      const refreshedToken = this.createToken(refreshedUser, { sid: sessionId })
      const refreshedPayload = this.readTokenPayload(refreshedToken)
      if (refreshedPayload?.exp) {
        await createUserSession(user.id, {
          sessionId,
          expiresAt: new Date(refreshedPayload.exp * 1000).toISOString(),
        })
      }

      return refreshedToken
    } catch (error) {
      this.logger.warn('Token refresh failed', error instanceof Error ? error : undefined)
      return null
    }
  }

  readTokenPayload(token: string, options: { ignoreExpiration?: boolean } = {}): (TokenPayload & { id?: string; sub?: string }) | null {
    try {
      return jwt.verify(token, this.config.jwtSecret, {
        ignoreExpiration: options.ignoreExpiration === true,
      }) as TokenPayload & { id?: string; sub?: string }
    } catch (error) {
      this.logger.warn('Token payload read failed', error instanceof Error ? error : undefined)
      return null
    }
  }

  private resolveTokenUserId(payload: TokenPayload & { id?: string; sub?: string }): string | null {
    const value = payload.userId || payload.id || payload.sub
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
}

// 导出单例实例
export const authService = new AuthService()
