/**
 * Plugin Manifest Validator and Standard
 * Implements comprehensive manifest validation and versioning
 */

import * as semver from 'semver'
import type { PluginManifest as _PluginManifest } from '../types/plugin'

// Plugin manifest schema version
export const MANIFEST_VERSION = '2.0.0'

// JSON Schema property definition
export interface JsonSchemaProperty {
  type?: string | string[]
  description?: string
  default?: unknown
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  [key: string]: unknown
}

// Configuration schema type
export interface ConfigSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
}

// Workflow node configuration type
export interface WorkflowNodeConfig {
  inputs?: Record<string, JsonSchemaProperty>
  outputs?: Record<string, JsonSchemaProperty>
  settings?: Record<string, unknown>
  [key: string]: unknown
}

// Plugin manifest standard interface
export interface PluginManifestV2 {
  // Basic metadata
  manifestVersion: string
  name: string
  version: string
  displayName: string
  description: string
  author: {
    name: string
    email?: string
    url?: string
  }

  // Technical details
  engine: {
    metasheet: string // MetaSheet version constraint
    node?: string // Node.js version constraint
    npm?: string // npm version constraint
  }

  // Entry points
  main: string // Main entry point
  types?: string // TypeScript definitions
  bin?: Record<string, string> // CLI commands

  // Resources
  assets?: {
    icons?: Record<string, string>
    styles?: string[]
    scripts?: string[]
  }

  // Dependencies
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>

  // Capabilities declaration
  capabilities: {
    views?: string[] // Supported view types
    workflows?: string[] // Workflow node types
    dataSources?: string[] // Data source types
    functions?: string[] // Custom formula functions
    triggers?: string[] // Event triggers
    actions?: string[] // Available actions
  }

  // Permissions required
  permissions: {
    database?: {
      read?: string[] // Table patterns
      write?: string[] // Table patterns
      execute?: boolean // Execute queries
    }
    http?: {
      internal?: boolean
      external?: boolean
      allowedDomains?: string[]
      blockedDomains?: string[]
    }
    filesystem?: {
      read?: string[] // Path patterns
      write?: string[] // Path patterns
      temp?: boolean
    }
    system?: {
      env?: string[] // Environment variables
      exec?: string[] // Allowed commands
      network?: boolean
    }
    plugins?: {
      communicate?: string[] // Plugin names
      control?: boolean // Start/stop plugins
    }
  }

  // Lifecycle hooks
  hooks?: {
    install?: string
    uninstall?: string
    activate?: string
    deactivate?: string
    upgrade?: string
    configure?: string
  }

  // API definitions
  routes?: Array<{
    method: string
    path: string
    handler: string
    middleware?: string[]
    permissions?: string[]
  }>

  // View definitions
  views?: Array<{
    id: string
    type: string
    name: string
    component: string
    icon?: string
    permissions?: string[]
  }>

  // Workflow nodes
  workflowNodes?: Array<{
    id: string
    type: string
    name: string
    category: string
    executor: string
    config?: WorkflowNodeConfig
  }>

  // Database migrations
  migrations?: Array<{
    version: string
    up: string
    down: string
  }>

  // Configuration schema
  configSchema?: ConfigSchema

  // Default configuration
  defaultConfig?: Record<string, unknown>

  // Publishing info
  repository?: {
    type: string
    url: string
  }
  homepage?: string
  bugs?: {
    url?: string
    email?: string
  }
  license?: string
  keywords?: string[]

  // Platform support
  platforms?: string[]
  cpu?: string[]
  os?: string[]
}

// Type guard for unknown input
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Type guard for string array
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

// Type guard for ConfigSchema
function isConfigSchema(value: unknown): value is ConfigSchema {
  if (!isRecord(value)) return false
  if (value.type !== 'object') return false
  if (!isRecord(value.properties)) return false
  return true
}

/**
 * Manifest validator
 */
export class ManifestValidator {
  private errors: string[] = []
  private warnings: string[] = []

  /**
   * Validate a plugin manifest
   */
  validate(manifest: unknown): {
    valid: boolean
    errors: string[]
    warnings: string[]
    normalized?: PluginManifestV2
  } {
    this.errors = []
    this.warnings = []

    if (!isRecord(manifest)) {
      this.errors.push('Manifest must be an object')
      return {
        valid: false,
        errors: this.errors,
        warnings: this.warnings
      }
    }

    // Check required fields
    this.validateRequiredFields(manifest)

    // Validate version formats
    this.validateVersions(manifest)

    // Validate capabilities
    this.validateCapabilities(manifest)

    // Validate permissions
    this.validatePermissions(manifest)

    // Validate dependencies
    this.validateDependencies(manifest)

    // Validate routes
    this.validateRoutes(manifest)

    // Validate migrations
    this.validateMigrations(manifest)

    // Normalize manifest
    const normalized = this.errors.length === 0
      ? this.normalizeManifest(manifest)
      : undefined

    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      normalized
    }
  }

  private validateRequiredFields(manifest: Record<string, unknown>) {
    const required = [
      'manifestVersion',
      'name',
      'version',
      'displayName',
      'description',
      'author',
      'engine',
      'main',
      'capabilities',
      'permissions'
    ]

    for (const field of required) {
      if (!manifest[field]) {
        this.errors.push(`Missing required field: ${field}`)
      }
    }

    // Validate name format
    if (manifest.name && typeof manifest.name === 'string' && !/^[a-z0-9-]+$/.test(manifest.name)) {
      this.errors.push('Plugin name must be lowercase letters, numbers, and hyphens only')
    }

    // Validate manifest version
    if (manifest.manifestVersion && typeof manifest.manifestVersion === 'string' && !semver.valid(manifest.manifestVersion)) {
      this.errors.push('Invalid manifestVersion format')
    }

    // Check manifest version compatibility
    if (manifest.manifestVersion && typeof manifest.manifestVersion === 'string' && !semver.satisfies(MANIFEST_VERSION, manifest.manifestVersion)) {
      this.warnings.push(`Manifest version ${manifest.manifestVersion} may not be fully compatible with current version ${MANIFEST_VERSION}`)
    }
  }

  private validateVersions(manifest: Record<string, unknown>) {
    // Validate plugin version
    if (manifest.version && typeof manifest.version === 'string' && !semver.valid(manifest.version)) {
      this.errors.push('Invalid plugin version format')
    }

    // Validate engine constraints
    if (manifest.engine && isRecord(manifest.engine)) {
      if (manifest.engine.metasheet && typeof manifest.engine.metasheet === 'string' && !semver.validRange(manifest.engine.metasheet)) {
        this.errors.push('Invalid MetaSheet version constraint')
      }

      if (manifest.engine.node && typeof manifest.engine.node === 'string' && !semver.validRange(manifest.engine.node)) {
        this.errors.push('Invalid Node.js version constraint')
      }
    }
  }

  private validateCapabilities(manifest: Record<string, unknown>) {
    if (!manifest.capabilities || !isRecord(manifest.capabilities)) return

    const validViewTypes = ['grid', 'kanban', 'calendar', 'gallery', 'form', 'gantt', 'timeline']
    const validWorkflowTypes = ['action', 'trigger', 'condition', 'transform']

    if (manifest.capabilities.views && isStringArray(manifest.capabilities.views)) {
      for (const view of manifest.capabilities.views) {
        if (!validViewTypes.includes(view)) {
          this.warnings.push(`Unknown view type: ${view}`)
        }
      }
    }

    if (manifest.capabilities.workflows && isStringArray(manifest.capabilities.workflows)) {
      for (const workflow of manifest.capabilities.workflows) {
        if (!validWorkflowTypes.includes(workflow)) {
          this.warnings.push(`Unknown workflow type: ${workflow}`)
        }
      }
    }
  }

  private validatePermissions(manifest: Record<string, unknown>) {
    if (!manifest.permissions || !isRecord(manifest.permissions)) return

    // Validate database permissions
    if (manifest.permissions.database && isRecord(manifest.permissions.database)) {
      const db = manifest.permissions.database

      if (db.read && !Array.isArray(db.read)) {
        this.errors.push('database.read must be an array')
      }

      if (db.write && !Array.isArray(db.write)) {
        this.errors.push('database.write must be an array')
      }

      // Check for overly broad permissions
      if (isStringArray(db.read) && db.read.includes('*') || isStringArray(db.write) && db.write.includes('*')) {
        this.warnings.push('Using wildcard (*) database permissions is not recommended')
      }
    }

    // Validate HTTP permissions
    if (manifest.permissions.http && isRecord(manifest.permissions.http)) {
      const http = manifest.permissions.http

      if (http.external && !http.allowedDomains) {
        this.warnings.push('External HTTP access without domain restrictions is risky')
      }

      if (http.allowedDomains && isStringArray(http.allowedDomains) &&
          http.blockedDomains && isStringArray(http.blockedDomains)) {
        // Check for conflicts
        const allowed = new Set(http.allowedDomains)
        const blocked = new Set(http.blockedDomains)
        const conflicts = Array.from(allowed).filter(d => blocked.has(d))

        if (conflicts.length > 0) {
          this.errors.push(`Domain conflicts in HTTP permissions: ${conflicts.join(', ')}`)
        }
      }
    }

    // Validate filesystem permissions
    if (manifest.permissions.filesystem && isRecord(manifest.permissions.filesystem)) {
      const fs = manifest.permissions.filesystem

      if (isStringArray(fs.write) && fs.write.includes('/')) {
        this.errors.push('Root filesystem write access is not allowed')
      }

      if (isStringArray(fs.read) && (fs.read.includes('~/.ssh') || fs.read.includes('~/.aws'))) {
        this.warnings.push('Reading sensitive directories is discouraged')
      }
    }

    // Validate system permissions
    if (manifest.permissions.system && isRecord(manifest.permissions.system)) {
      const sys = manifest.permissions.system

      if (isStringArray(sys.exec) && sys.exec.includes('*')) {
        this.errors.push('Wildcard command execution is not allowed')
      }

      if (isStringArray(sys.env) && sys.env.includes('*')) {
        this.warnings.push('Reading all environment variables is discouraged')
      }
    }
  }

  private validateDependencies(manifest: Record<string, unknown>) {
    // Check for version conflicts
    const allDeps = {
      ...(isRecord(manifest.dependencies) ? manifest.dependencies : {}),
      ...(isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {}),
      ...(isRecord(manifest.optionalDependencies) ? manifest.optionalDependencies : {})
    }

    for (const [pkg, version] of Object.entries(allDeps)) {
      if (typeof version !== 'string') continue

      if (!semver.validRange(version)) {
        this.errors.push(`Invalid version range for ${pkg}: ${version}`)
      }

      // Check for security issues with known problematic packages
      const problematic = ['eval', 'node-eval', 'vm2']
      if (problematic.includes(pkg)) {
        this.warnings.push(`Package ${pkg} has known security issues`)
      }
    }

    // Check for circular dependencies
    if (isRecord(manifest.dependencies) &&
        typeof manifest.name === 'string' &&
        manifest.dependencies[manifest.name]) {
      this.errors.push('Plugin cannot depend on itself')
    }
  }

  private validateRoutes(manifest: Record<string, unknown>) {
    if (!manifest.routes || !Array.isArray(manifest.routes)) return

    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']

    for (const route of manifest.routes) {
      if (!isRecord(route)) continue

      if (!route.method || typeof route.method !== 'string' || !validMethods.includes(route.method.toUpperCase())) {
        this.errors.push(`Invalid HTTP method: ${route.method}`)
      }

      if (!route.path || typeof route.path !== 'string' || !route.path.startsWith('/')) {
        this.errors.push(`Invalid route path: ${route.path}`)
      }

      if (!route.handler) {
        this.errors.push(`Missing handler for route: ${route.path}`)
      }

      // Check for path conflicts
      if (typeof route.path === 'string' && route.path.match(/^\/api\/(core|system|admin)/)) {
        this.errors.push(`Route ${route.path} conflicts with system routes`)
      }
    }
  }

  private validateMigrations(manifest: Record<string, unknown>) {
    if (!manifest.migrations || !Array.isArray(manifest.migrations)) return

    const versions = new Set<string>()

    for (const migration of manifest.migrations) {
      if (!isRecord(migration)) continue

      if (!migration.version || typeof migration.version !== 'string') {
        this.errors.push('Migration missing version')
      }

      if (!migration.up) {
        this.errors.push(`Migration ${migration.version} missing up script`)
      }

      if (!migration.down) {
        this.warnings.push(`Migration ${migration.version} missing down script (rollback not possible)`)
      }

      if (typeof migration.version === 'string' && versions.has(migration.version)) {
        this.errors.push(`Duplicate migration version: ${migration.version}`)
      }

      if (typeof migration.version === 'string') {
        versions.add(migration.version)
      }
    }

    // Check version order
    const sorted = Array.from(versions).sort(semver.compare)
    const original = Array.from(versions)

    if (JSON.stringify(sorted) !== JSON.stringify(original)) {
      this.warnings.push('Migrations are not in version order')
    }
  }

  private normalizeManifest(manifest: Record<string, unknown>): PluginManifestV2 {
    return {
      manifestVersion: typeof manifest.manifestVersion === 'string' ? manifest.manifestVersion : MANIFEST_VERSION,
      name: String(manifest.name),
      version: String(manifest.version),
      displayName: String(manifest.displayName),
      description: String(manifest.description),
      author: typeof manifest.author === 'string'
        ? { name: manifest.author }
        : isRecord(manifest.author) && typeof manifest.author.name === 'string'
          ? {
              name: manifest.author.name,
              email: typeof manifest.author.email === 'string' ? manifest.author.email : undefined,
              url: typeof manifest.author.url === 'string' ? manifest.author.url : undefined
            }
          : { name: 'Unknown' },
      engine: {
        metasheet: isRecord(manifest.engine) && typeof manifest.engine.metasheet === 'string'
          ? manifest.engine.metasheet
          : '*',
        node: isRecord(manifest.engine) && typeof manifest.engine.node === 'string'
          ? manifest.engine.node
          : undefined,
        npm: isRecord(manifest.engine) && typeof manifest.engine.npm === 'string'
          ? manifest.engine.npm
          : undefined
      },
      main: String(manifest.main),
      types: typeof manifest.types === 'string' ? manifest.types : undefined,
      bin: isRecord(manifest.bin) ? manifest.bin as Record<string, string> : undefined,
      assets: isRecord(manifest.assets) ? manifest.assets as PluginManifestV2['assets'] : undefined,
      dependencies: isRecord(manifest.dependencies) ? manifest.dependencies as Record<string, string> : {},
      peerDependencies: isRecord(manifest.peerDependencies) ? manifest.peerDependencies as Record<string, string> : {},
      optionalDependencies: isRecord(manifest.optionalDependencies) ? manifest.optionalDependencies as Record<string, string> : {},
      capabilities: isRecord(manifest.capabilities) ? manifest.capabilities as PluginManifestV2['capabilities'] : {},
      permissions: isRecord(manifest.permissions) ? manifest.permissions as PluginManifestV2['permissions'] : {},
      hooks: isRecord(manifest.hooks) ? manifest.hooks as PluginManifestV2['hooks'] : undefined,
      routes: Array.isArray(manifest.routes) ? manifest.routes as PluginManifestV2['routes'] : [],
      views: Array.isArray(manifest.views) ? manifest.views as PluginManifestV2['views'] : [],
      workflowNodes: Array.isArray(manifest.workflowNodes) ? manifest.workflowNodes as PluginManifestV2['workflowNodes'] : [],
      migrations: Array.isArray(manifest.migrations) ? manifest.migrations as PluginManifestV2['migrations'] : [],
      configSchema: isConfigSchema(manifest.configSchema) ? manifest.configSchema : undefined,
      defaultConfig: isRecord(manifest.defaultConfig) ? manifest.defaultConfig : {},
      repository: isRecord(manifest.repository) ? manifest.repository as PluginManifestV2['repository'] : undefined,
      homepage: typeof manifest.homepage === 'string' ? manifest.homepage : undefined,
      bugs: isRecord(manifest.bugs) ? manifest.bugs as PluginManifestV2['bugs'] : undefined,
      license: typeof manifest.license === 'string' ? manifest.license : undefined,
      keywords: isStringArray(manifest.keywords) ? manifest.keywords : [],
      platforms: isStringArray(manifest.platforms) ? manifest.platforms : undefined,
      cpu: isStringArray(manifest.cpu) ? manifest.cpu : undefined,
      os: isStringArray(manifest.os) ? manifest.os : undefined
    }
  }

  /**
   * Check if two plugins are compatible
   */
  static checkCompatibility(
    plugin1: PluginManifestV2,
    plugin2: PluginManifestV2
  ): {
    compatible: boolean
    conflicts: string[]
  } {
    const conflicts: string[] = []

    // Check version compatibility
    if (plugin1.dependencies?.[plugin2.name]) {
      const required = plugin1.dependencies[plugin2.name]
      if (!semver.satisfies(plugin2.version, required)) {
        conflicts.push(`Version mismatch: ${plugin1.name} requires ${plugin2.name}@${required}, but ${plugin2.name}@${plugin2.version} is installed`)
      }
    }

    // Check for route conflicts
    const routes1 = new Set(plugin1.routes?.map(r => `${r.method}:${r.path}`))
    const routes2 = new Set(plugin2.routes?.map(r => `${r.method}:${r.path}`))
    const routeConflicts = Array.from(routes1).filter(r => routes2.has(r))

    if (routeConflicts.length > 0) {
      conflicts.push(`Route conflicts: ${routeConflicts.join(', ')}`)
    }

    // Check for permission conflicts
    if (plugin1.permissions.plugins?.control && plugin2.permissions.plugins?.control) {
      conflicts.push('Both plugins require plugin control permission')
    }

    return {
      compatible: conflicts.length === 0,
      conflicts
    }
  }
}

// Export validator instance
export const manifestValidator = new ManifestValidator()
