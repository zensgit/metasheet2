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
  created_at: Date
  updated_at: Date
  // Index signature for compatibility with Express.Request.user
  [key: string]: unknown
}

// Database user row type (includes password_hash)
interface UserRow extends User {
  password_hash: string
}

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

      // 验证用户是否仍然活跃
      if (user.role === 'disabled' || user.is_active === false) {
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

      return this.sanitizeUser(user)
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

      // 验证密码
      const isValid = await bcrypt.compare(password, user.password_hash)
      if (!isValid) {
        return null
      }

      // 检查用户状态
      if (user.role === 'disabled' || user.is_active === false) {
        return null
      }

      const sessionId = crypto.randomUUID()
      const tenantId = typeof options.tenantId === 'string' && options.tenantId.trim().length > 0
        ? options.tenantId.trim()
        : undefined
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
      this.logger.error('Login error', error instanceof Error ? error : undefined)
      return null
    }
  }

  /**
   * 用户注册
   */
  async register(email: string, password: string, name: string): Promise<User | null> {
    try {
      // 检查邮箱是否已存在
      const existingUser = await this.getUserByEmail(email)
      if (existingUser) {
        return null
      }

      // 加密密码
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
      const newUser = await this.createUser({
        id: userId,
        email,
        name,
        password_hash: passwordHash,
        role: 'user',
        permissions: registrationPermissions
      })

      if (newUser && enableAttendanceSelfService) {
        await this.assignUserRoles(userId, [ATTENDANCE_SELF_SERVICE_ROLE_ID])
      }

      return newUser
    } catch (error) {
      this.logger.error('Registration error', error instanceof Error ? error : undefined)
      return null
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
          'SELECT id, email, username, mobile, name, role, permissions, password_hash, is_active, must_change_password, created_at, updated_at FROM users WHERE id = $1',
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

      const normalizedEmail = trimmedIdentifier.toLowerCase()
      const normalizedUsername = trimmedIdentifier.toLowerCase()
      const normalizedMobile = trimmedIdentifier.replace(/\s+/g, '')

      try {
        const pool = poolManager.get()
        const result = await pool.query(
          `SELECT id, email, username, mobile, name, role, permissions, password_hash, is_active, must_change_password, created_at, updated_at
           FROM users
           WHERE lower(COALESCE(email, '')) = $1
              OR lower(COALESCE(username, '')) = $2
              OR regexp_replace(COALESCE(mobile, ''), '\\s+', '', 'g') = $3
           ORDER BY
             CASE
               WHEN lower(COALESCE(email, '')) = $1 THEN 0
               WHEN lower(COALESCE(username, '')) = $2 THEN 1
               WHEN regexp_replace(COALESCE(mobile, ''), '\\s+', '', 'g') = $3 THEN 2
               ELSE 3
             END ASC,
             created_at ASC
           LIMIT 2`,
          [normalizedEmail, normalizedUsername, normalizedMobile]
        )

        const emailMatches = result.rows.filter((row) => typeof row.email === 'string' && row.email.toLowerCase() === normalizedEmail)
        const usernameMatches = result.rows.filter((row) => typeof row.username === 'string' && row.username.toLowerCase() === normalizedUsername)
        if (emailMatches.length > 1 || usernameMatches.length > 1) {
          return null
        }
        if (result.rows.length > 1 && emailMatches.length === 0 && usernameMatches.length === 0) {
          return null
        }

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
            password_hash: row.password_hash,
            created_at: row.created_at,
            updated_at: row.updated_at
          }
        }
      } catch (dbError) {
        this.logger.warn('Database query failed', dbError instanceof Error ? dbError : undefined)
      }
      return null
    } catch (error) {
      this.logger.error('Get user by identifier error', error instanceof Error ? error : undefined)
      return null
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
      await this.assignUserRoles(userId, [ATTENDANCE_SELF_SERVICE_ROLE_ID])
      permissions = Array.from(new Set([...permissions, ...ATTENDANCE_SELF_SERVICE_PERMISSIONS]))
    }

    return { role, permissions }
  }

  private shouldBackfillAttendanceSelfService(role: string, permissions: string[]): boolean {
    if (!supportsAttendanceSelfService(process.env.PRODUCT_MODE)) return false
    if (role === 'admin') return false
    return !permissions.some((permission) => permission.startsWith('attendance:'))
  }

  /**
   * 创建新用户
   */
  private async createUser(userData: {
    id: string
    email: string
    name: string
    password_hash: string
    role: string
    permissions: string[]
  }): Promise<User | null> {
    try {
      try {
        const pool = poolManager.get()
        const permissionsJson = JSON.stringify(userData.permissions)
        const result = await pool.query(
          `INSERT INTO users (id, email, name, password_hash, role, permissions, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
           RETURNING id, email, name, role, permissions, must_change_password, created_at, updated_at`,
          [userData.id, userData.email, userData.name, userData.password_hash, userData.role, permissionsJson]
        )

        if (result.rows.length > 0) {
          const row = result.rows[0] as User
          if (userData.permissions.length > 0) {
            const values = userData.permissions.map((_, index) => `($1, $${index + 2})`).join(', ')
            await pool.query(
              `INSERT INTO user_permissions (user_id, permission_code)
               VALUES ${values}
               ON CONFLICT DO NOTHING`,
              [userData.id, ...userData.permissions]
            )
          }
          return {
            id: row.id,
            email: row.email,
            name: row.name,
            role: row.role,
            permissions: Array.isArray(row.permissions) ? row.permissions : [],
            must_change_password: row.must_change_password,
            created_at: row.created_at,
            updated_at: row.updated_at
          }
        }
      } catch (dbError) {
        this.logger.warn('Database insert failed', dbError instanceof Error ? dbError : undefined)
      }
      return null
    } catch (error) {
      this.logger.error('Create user error', error instanceof Error ? error : undefined)
      return null
    }
  }

  private async assignUserRoles(userId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return
    try {
      const pool = poolManager.get()
      for (const roleId of roleIds) {
        await pool.query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userId, roleId]
        )
      }
      invalidateUserPerms(userId)
    } catch (error) {
      this.logger.warn('User role assignment failed during registration', error instanceof Error ? error : undefined)
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
      if (!user || user.role === 'disabled' || user.is_active === false) {
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

      const refreshedUser = this.normalizeClaimString(payload.tenantId)
        ? { ...user, tenantId: this.normalizeClaimString(payload.tenantId) }
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
