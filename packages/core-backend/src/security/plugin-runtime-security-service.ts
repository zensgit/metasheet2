import crypto from 'node:crypto'
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
  isEncryptedSecretValue,
} from './encrypted-secrets'
import { PERMISSION_WHITELIST } from '../types/plugin'
import type {
  AuditLogOptions,
  PluginPermission,
  PluginSandbox,
  RateLimitResult,
  ResourceLimits,
  ResourceUsage,
  SecurityAuditEvent,
  SecurityService,
  ThreatScanResult,
} from '../types/plugin'

type RuntimeSandbox = PluginSandbox & {
  destroy(): void
}

type RuntimeRateLimit = {
  count: number
  resetAt: number
}

const DEFAULT_SANDBOX_APIS = ['console', 'JSON', 'Math', 'Date']
const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  memory: 100,
  cpu: 30,
  disk: 50,
  network: 60,
  database: 300,
}

const THREAT_PATTERNS: Array<{
  pattern: RegExp
  type: string
  severity: ThreatScanResult['threats'][number]['severity']
  description: string
}> = [
  {
    pattern: /require\s*\(/g,
    type: 'module_access',
    severity: 'critical',
    description: 'Unauthorized require() usage',
  },
  {
    pattern: /process\./g,
    type: 'system_access',
    severity: 'critical',
    description: 'Unauthorized process access',
  },
  {
    pattern: /\bfs\./g,
    type: 'file_system',
    severity: 'high',
    description: 'Unauthorized file system access',
  },
  {
    pattern: /child_process/g,
    type: 'process_spawn',
    severity: 'critical',
    description: 'Unauthorized child process spawning',
  },
  {
    pattern: /\beval\s*\(/g,
    type: 'code_execution',
    severity: 'high',
    description: 'Dynamic code evaluation detected',
  },
  {
    pattern: /\bFunction\s*\(/g,
    type: 'code_generation',
    severity: 'medium',
    description: 'Dynamic function creation detected',
  },
  {
    pattern: /__proto__|prototype\s*=/g,
    type: 'prototype_pollution',
    severity: 'high',
    description: 'Potential prototype pollution',
  },
  {
    pattern: /\bfetch\s*\(|XMLHttpRequest/g,
    type: 'network_access',
    severity: 'medium',
    description: 'Network access detected',
  },
]

function positionFor(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1]?.length ?? 0,
  }
}

function assertPlatformKeyOnly(key?: string): void {
  if (key) {
    throw new Error('Plugin runtime security service does not support per-call encryption keys')
  }
}

function makeAuditId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
}

/**
 * Host-backed security service for the active CJS plugin runtime.
 *
 * It intentionally reuses the platform `enc:` secret format instead of creating
 * another per-plugin encryption scheme. Sandbox code execution remains
 * unavailable in this runtime path; callers get an explicit error instead of a
 * false sense of isolation.
 */
export class PluginRuntimeSecurityService implements SecurityService {
  private readonly sandboxes = new Map<string, RuntimeSandbox>()
  private readonly auditEvents: SecurityAuditEvent[] = []
  private readonly rateLimits = new Map<string, RuntimeRateLimit>()
  private readonly resourceUsage = new Map<string, ResourceUsage[]>()

  createSandbox(
    pluginName: string,
    allowedAPIs: string[] = DEFAULT_SANDBOX_APIS,
    limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
  ): PluginSandbox {
    const sandbox: RuntimeSandbox = {
      pluginName,
      allowedAPIs,
      resourceLimits: limits,
      environment: { pluginName },
      execute: async () => {
        throw new Error('Plugin sandbox execution is not available in the CJS plugin runtime')
      },
      getResourceUsage: () => ({
        timestamp: new Date(),
      }),
      destroy: () => {
        this.sandboxes.delete(pluginName)
      },
    }
    this.sandboxes.set(pluginName, sandbox)
    return sandbox
  }

  getSandbox(pluginName: string): PluginSandbox | null {
    return this.sandboxes.get(pluginName) ?? null
  }

  async checkPermission(pluginName: string, permission: string): Promise<boolean> {
    const allowed = PERMISSION_WHITELIST.includes(permission as PluginPermission)
    await this.audit({
      id: makeAuditId('perm'),
      pluginName,
      event: 'permission_check',
      resource: permission,
      action: 'check',
      timestamp: new Date(),
      severity: allowed ? 'info' : 'warning',
      metadata: { allowed },
    })
    return allowed
  }

  async checkPermissions(pluginName: string, permissions: string[]): Promise<boolean[]> {
    return Promise.all(permissions.map(permission => this.checkPermission(pluginName, permission)))
  }

  async validateAPIAccess(pluginName: string, apiPath: string, method: string): Promise<boolean> {
    const sandbox = this.getSandbox(pluginName)
    const allowed = Boolean(sandbox?.allowedAPIs.some(api => apiPath.startsWith(api)))
    await this.audit({
      id: makeAuditId('api'),
      pluginName,
      event: 'api_access',
      resource: apiPath,
      action: method,
      timestamp: new Date(),
      severity: allowed ? 'info' : 'warning',
      metadata: { allowed },
    })
    return allowed
  }

  async encrypt(data: string, key?: string): Promise<string> {
    assertPlatformKeyOnly(key)
    return encryptStoredSecretValue(data)
  }

  async decrypt(data: string, key?: string): Promise<string> {
    assertPlatformKeyOnly(key)
    return decryptStoredSecretValue(data)
  }

  hash(data: string, algorithm = 'sha256'): string {
    return crypto.createHash(algorithm).update(data).digest('hex')
  }

  async verify(data: string, hash: string, algorithm = 'sha256'): Promise<boolean> {
    return this.verifyHash(data, hash, algorithm)
  }

  verifyHash(data: string, hash: string, algorithm = 'sha256'): boolean {
    return this.hash(data, algorithm) === hash
  }

  generateToken(length = 32): string {
    const safeLength = Math.max(1, Math.floor(length))
    return crypto.randomBytes(Math.ceil(safeLength / 2)).toString('hex').slice(0, safeLength)
  }

  async scanForThreats(pluginName: string, code: string): Promise<ThreatScanResult> {
    const threats: ThreatScanResult['threats'] = []
    for (const { pattern, type, severity, description } of THREAT_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(code)) !== null) {
        const location = positionFor(code, match.index)
        threats.push({
          type,
          severity,
          description,
          location,
          line: location.line,
          column: location.column,
        })
      }
    }

    const result: ThreatScanResult = {
      safe: threats.every(threat => threat.severity !== 'critical'),
      threats,
    }

    await this.audit({
      id: makeAuditId('scan'),
      pluginName,
      event: 'threat_scan',
      timestamp: new Date(),
      severity: result.safe ? 'info' : 'warning',
      metadata: {
        safe: result.safe,
        threatCount: threats.length,
        criticalThreats: threats.filter(threat => threat.severity === 'critical').length,
      },
    })

    return result
  }

  async rateLimit(key: string, limit: number, window: number): Promise<RateLimitResult> {
    const now = Date.now()
    const existing = this.rateLimits.get(key)
    const current = existing && now < existing.resetAt
      ? existing
      : { count: 0, resetAt: now + window }

    current.count += 1
    this.rateLimits.set(key, current)

    const allowed = current.count <= limit
    const resetAt = new Date(current.resetAt)
    return {
      allowed,
      remaining: Math.max(0, limit - current.count),
      resetAt,
      resetTime: resetAt,
      retryAfter: allowed ? 0 : Math.ceil((current.resetAt - now) / 1000),
    }
  }

  async checkRateLimit(pluginName: string, resource: string): Promise<RateLimitResult> {
    return this.rateLimit(`${pluginName}:${resource}`, 100, 60_000)
  }

  async monitorResource(pluginName: string, _resource: string, usage: ResourceUsage): Promise<void> {
    const entries = this.resourceUsage.get(pluginName) ?? []
    entries.push({
      ...usage,
      timestamp: usage.timestamp ?? new Date(),
    })
    this.resourceUsage.set(pluginName, entries.slice(-1000))
  }

  async getResourceUsage(pluginName: string): Promise<ResourceUsage[]> {
    return [...(this.resourceUsage.get(pluginName) ?? [])]
  }

  async audit(event: SecurityAuditEvent): Promise<void> {
    this.auditEvents.unshift({
      ...event,
      id: event.id ?? makeAuditId('audit'),
      event: event.event ?? event.type,
      type: event.type ?? event.event,
      timestamp: event.timestamp ?? new Date(),
      severity: event.severity ?? 'info',
    })
    if (this.auditEvents.length > 50_000) {
      this.auditEvents.length = 50_000
    }
  }

  async getAuditLog(options: AuditLogOptions = {}): Promise<SecurityAuditEvent[]> {
    const eventFilter = options.event ?? options.type
    const actorFilter = options.userId ?? options.actor
    const from = options.dateFrom ?? options.from
    const to = options.dateTo ?? options.to
    const offset = options.offset ?? 0
    const limit = options.limit ?? 1000

    return this.auditEvents
      .filter(event => !options.pluginName || event.pluginName === options.pluginName)
      .filter(event => !eventFilter || event.event === eventFilter || event.type === eventFilter)
      .filter(event => !actorFilter || event.userId === actorFilter || event.actor === actorFilter)
      .filter(event => !options.severity || event.severity === options.severity)
      .filter(event => !from || !event.timestamp || event.timestamp >= from)
      .filter(event => !to || !event.timestamp || event.timestamp <= to)
      .slice(offset, offset + limit)
  }

  async getAuditLogs(options: AuditLogOptions = {}): Promise<SecurityAuditEvent[]> {
    return this.getAuditLog(options)
  }

  isEncrypted(value: unknown): boolean {
    return isEncryptedSecretValue(value)
  }
}
