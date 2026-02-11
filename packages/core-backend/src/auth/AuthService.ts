/**
 * 真实的认证服务实现
 * 替换之前的mock实现
 */

import * as jwt from 'jsonwebtoken'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { poolManager } from '../integration/db/connection-pool'
import { Logger } from '../core/logger'
import { secretManager } from '../security/SecretManager'
import { isAdmin as isRbacAdmin, listUserPermissions } from '../rbac/service'

export interface User {
  id: string
  email: string
  name: string
  role: string
  permissions: string[]
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
  iat: number
  exp: number
}

export interface AuthConfig {
  jwtSecret: string
  jwtExpiry: string
  saltRounds: number
}

export class AuthService {
  private config: AuthConfig
  private logger: Logger

  constructor() {
    this.logger = new Logger('AuthService')
    const secret = secretManager.get('JWT_SECRET', { required: process.env.NODE_ENV === 'production' })
    this.config = {
      jwtSecret: secret || this.generateSecretWarning(),
      jwtExpiry: process.env.JWT_EXPIRY || '24h',
      saltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '10')
    }

    // Production security validation
    this.validateProductionSecurity()
  }

  private generateSecretWarning(): string {
    this.logger.warn('JWT_SECRET not set! Using fallback (NOT FOR PRODUCTION)')

    // In production, generate a more secure temporary secret but still warn
    if (process.env.NODE_ENV === 'production') {
      this.logger.error('CRITICAL: JWT_SECRET missing in production! Generating temporary secret.')
      // Generate a cryptographically secure random secret for this session
      return crypto.randomBytes(64).toString('hex')
    }

    return 'fallback-development-secret-change-in-production'
  }

  private validateProductionSecurity(): void {
    if (process.env.NODE_ENV === 'production') {
      const issues: string[] = []

      // Check JWT secret strength
      if (!process.env.JWT_SECRET) {
        issues.push('JWT_SECRET environment variable not set')
      } else if (process.env.JWT_SECRET.length < 32) {
        issues.push('JWT_SECRET is too short (minimum 32 characters recommended)')
      }

      // Check bcrypt rounds
      if (this.config.saltRounds < 12) {
        issues.push(`BCRYPT_SALT_ROUNDS too low for production (${this.config.saltRounds}, recommended: ≥12)`)
      }

      // Check JWT expiry
      if (this.config.jwtExpiry === '24h') {
        this.logger.warn('Using default JWT expiry (24h). Consider shorter expiry for production.')
      }

      if (issues.length > 0) {
        this.logger.error('PRODUCTION SECURITY ISSUES:')
        issues.forEach(issue => this.logger.error(`  - ${issue}`))
        this.logger.error('Please fix these issues before deploying to production!')

        // In strict production mode, could throw an error here
        // throw new Error('Critical security configuration issues detected')
      }
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

      // 从数据库获取最新用户信息
      const user = await this.getUserById(userId)
      if (!user) {
        return null
      }

      // 验证用户是否仍然活跃
      if (user.role === 'disabled') {
        return null
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
  createToken(user: User): string {
    const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email,
      role: user.role
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
  async login(email: string, password: string): Promise<{ user: User; token: string } | null> {
    try {
      const user = await this.getUserByEmail(email)
      if (!user) {
        return null
      }

      // 验证密码
      const isValid = await bcrypt.compare(password, user.password_hash)
      if (!isValid) {
        return null
      }

      // 检查用户状态
      if (user.role === 'disabled') {
        return null
      }

      // 生成token
      const token = this.createToken(user)

      // 更新最后登录时间
      await this.updateLastLogin(user.id)

      // 返回用户信息（不包含密码hash）
      const safeUser = this.sanitizeUser(user)
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

      // 创建用户
      const userId = crypto.randomUUID()
      const newUser = await this.createUser({
        id: userId,
        email,
        name,
        password_hash: passwordHash,
        role: 'user',
        permissions: [
          'spreadsheet:read',
          'spreadsheet:write',
          'spreadsheets:read',
          'spreadsheets:write'
        ]
      })

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
          'SELECT id, email, name, role, permissions, password_hash, created_at, updated_at FROM users WHERE id = $1',
          [userId]
        )

        if (result.rows.length > 0) {
          const row = result.rows[0] as UserRow
          const resolved = await this.resolveRbacProfile(row.id, row.role, Array.isArray(row.permissions) ? row.permissions : [])
          return {
            id: row.id,
            email: row.email,
            name: row.name,
            role: resolved.role,
            permissions: resolved.permissions,
            password_hash: row.password_hash,
            created_at: row.created_at,
            updated_at: row.updated_at
          }
        }
      } catch (dbError) {
        this.logger.warn('Database query failed', dbError instanceof Error ? dbError : undefined)
      }

      // 降级：返回mock用户（仅开发环境）
      if (process.env.NODE_ENV === 'development') {
        return {
          id: userId,
          email: 'dev@metasheet.com',
          name: 'Development User',
          role: 'admin',
          permissions: ['*:*'],
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

  /**
   * 通过邮箱获取用户
   */
  private async getUserByEmail(email: string): Promise<(User & { password_hash: string }) | null> {
    try {
      try {
        const pool = poolManager.get()
        const result = await pool.query(
          'SELECT id, email, name, role, permissions, password_hash, created_at, updated_at FROM users WHERE email = $1',
          [email]
        )

        if (result.rows.length > 0) {
          const row = result.rows[0] as UserRow
          const resolved = await this.resolveRbacProfile(row.id, row.role, Array.isArray(row.permissions) ? row.permissions : [])
          return {
            id: row.id,
            email: row.email,
            name: row.name,
            role: resolved.role,
            permissions: resolved.permissions,
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
      this.logger.error('Get user by email error', error instanceof Error ? error : undefined)
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

    return { role, permissions }
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
           RETURNING id, email, name, role, permissions, created_at, updated_at`,
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
      if (!user || user.role === 'disabled') {
        return null
      }

      // 生成新token
      return this.createToken(user)
    } catch (error) {
      this.logger.warn('Token refresh failed', error instanceof Error ? error : undefined)
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
