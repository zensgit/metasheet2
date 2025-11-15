/**
 * Plugin Manifest Validator and Standard
 * Implements comprehensive manifest validation and versioning
 */

import * as semver from 'semver'
import type { PluginManifest } from '../types/plugin'

// Plugin manifest schema version
export const MANIFEST_VERSION = '2.0.0'

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
    config?: any
  }>

  // Database migrations
  migrations?: Array<{
    version: string
    up: string
    down: string
  }>

  // Configuration schema
  configSchema?: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }

  // Default configuration
  defaultConfig?: Record<string, any>

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

/**
 * Manifest validator
 */
export class ManifestValidator {
  private errors: string[] = []
  private warnings: string[] = []

  /**
   * Validate a plugin manifest
   */
  validate(manifest: any): {
    valid: boolean
    errors: string[]
    warnings: string[]
    normalized?: PluginManifestV2
  } {
    this.errors = []
    this.warnings = []

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

  private validateRequiredFields(manifest: any) {
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
    if (manifest.name && !/^[a-z0-9-]+$/.test(manifest.name)) {
      this.errors.push('Plugin name must be lowercase letters, numbers, and hyphens only')
    }

    // Validate manifest version
    if (manifest.manifestVersion && !semver.valid(manifest.manifestVersion)) {
      this.errors.push('Invalid manifestVersion format')
    }

    // Check manifest version compatibility
    if (manifest.manifestVersion && !semver.satisfies(MANIFEST_VERSION, manifest.manifestVersion)) {
      this.warnings.push(`Manifest version ${manifest.manifestVersion} may not be fully compatible with current version ${MANIFEST_VERSION}`)
    }
  }

  private validateVersions(manifest: any) {
    // Validate plugin version
    if (manifest.version && !semver.valid(manifest.version)) {
      this.errors.push('Invalid plugin version format')
    }

    // Validate engine constraints
    if (manifest.engine) {
      if (manifest.engine.metasheet && !semver.validRange(manifest.engine.metasheet)) {
        this.errors.push('Invalid MetaSheet version constraint')
      }

      if (manifest.engine.node && !semver.validRange(manifest.engine.node)) {
        this.errors.push('Invalid Node.js version constraint')
      }
    }
  }

  private validateCapabilities(manifest: any) {
    if (!manifest.capabilities) return

    const validViewTypes = ['grid', 'kanban', 'calendar', 'gallery', 'form', 'gantt', 'timeline']
    const validWorkflowTypes = ['action', 'trigger', 'condition', 'transform']

    if (manifest.capabilities.views) {
      for (const view of manifest.capabilities.views) {
        if (!validViewTypes.includes(view)) {
          this.warnings.push(`Unknown view type: ${view}`)
        }
      }
    }

    if (manifest.capabilities.workflows) {
      for (const workflow of manifest.capabilities.workflows) {
        if (!validWorkflowTypes.includes(workflow)) {
          this.warnings.push(`Unknown workflow type: ${workflow}`)
        }
      }
    }
  }

  private validatePermissions(manifest: any) {
    if (!manifest.permissions) return

    // Validate database permissions
    if (manifest.permissions.database) {
      const db = manifest.permissions.database

      if (db.read && !Array.isArray(db.read)) {
        this.errors.push('database.read must be an array')
      }

      if (db.write && !Array.isArray(db.write)) {
        this.errors.push('database.write must be an array')
      }

      // Check for overly broad permissions
      if (db.read?.includes('*') || db.write?.includes('*')) {
        this.warnings.push('Using wildcard (*) database permissions is not recommended')
      }
    }

    // Validate HTTP permissions
    if (manifest.permissions.http) {
      const http = manifest.permissions.http

      if (http.external && !http.allowedDomains) {
        this.warnings.push('External HTTP access without domain restrictions is risky')
      }

      if (http.allowedDomains && http.blockedDomains) {
        // Check for conflicts
        const allowed = new Set(http.allowedDomains)
        const blocked = new Set(http.blockedDomains)
        const conflicts = [...allowed].filter(d => blocked.has(d))

        if (conflicts.length > 0) {
          this.errors.push(`Domain conflicts in HTTP permissions: ${conflicts.join(', ')}`)
        }
      }
    }

    // Validate filesystem permissions
    if (manifest.permissions.filesystem) {
      const fs = manifest.permissions.filesystem

      if (fs.write?.includes('/')) {
        this.errors.push('Root filesystem write access is not allowed')
      }

      if (fs.read?.includes('~/.ssh') || fs.read?.includes('~/.aws')) {
        this.warnings.push('Reading sensitive directories is discouraged')
      }
    }

    // Validate system permissions
    if (manifest.permissions.system) {
      const sys = manifest.permissions.system

      if (sys.exec?.includes('*')) {
        this.errors.push('Wildcard command execution is not allowed')
      }

      if (sys.env?.includes('*')) {
        this.warnings.push('Reading all environment variables is discouraged')
      }
    }
  }

  private validateDependencies(manifest: any) {
    // Check for version conflicts
    const allDeps = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies
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
    if (manifest.dependencies?.[manifest.name]) {
      this.errors.push('Plugin cannot depend on itself')
    }
  }

  private validateRoutes(manifest: any) {
    if (!manifest.routes) return

    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']

    for (const route of manifest.routes) {
      if (!route.method || !validMethods.includes(route.method.toUpperCase())) {
        this.errors.push(`Invalid HTTP method: ${route.method}`)
      }

      if (!route.path || !route.path.startsWith('/')) {
        this.errors.push(`Invalid route path: ${route.path}`)
      }

      if (!route.handler) {
        this.errors.push(`Missing handler for route: ${route.path}`)
      }

      // Check for path conflicts
      if (route.path?.match(/^\/api\/(core|system|admin)/)) {
        this.errors.push(`Route ${route.path} conflicts with system routes`)
      }
    }
  }

  private validateMigrations(manifest: any) {
    if (!manifest.migrations) return

    const versions = new Set<string>()

    for (const migration of manifest.migrations) {
      if (!migration.version) {
        this.errors.push('Migration missing version')
      }

      if (!migration.up) {
        this.errors.push(`Migration ${migration.version} missing up script`)
      }

      if (!migration.down) {
        this.warnings.push(`Migration ${migration.version} missing down script (rollback not possible)`)
      }

      if (versions.has(migration.version)) {
        this.errors.push(`Duplicate migration version: ${migration.version}`)
      }

      versions.add(migration.version)
    }

    // Check version order
    const sorted = [...versions].sort(semver.compare)
    const original = [...versions]

    if (JSON.stringify(sorted) !== JSON.stringify(original)) {
      this.warnings.push('Migrations are not in version order')
    }
  }

  private normalizeManifest(manifest: any): PluginManifestV2 {
    return {
      manifestVersion: manifest.manifestVersion || MANIFEST_VERSION,
      name: manifest.name,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      author: typeof manifest.author === 'string'
        ? { name: manifest.author }
        : manifest.author,
      engine: {
        metasheet: manifest.engine?.metasheet || '*',
        node: manifest.engine?.node,
        npm: manifest.engine?.npm
      },
      main: manifest.main,
      types: manifest.types,
      bin: manifest.bin,
      assets: manifest.assets,
      dependencies: manifest.dependencies || {},
      peerDependencies: manifest.peerDependencies || {},
      optionalDependencies: manifest.optionalDependencies || {},
      capabilities: manifest.capabilities || {},
      permissions: manifest.permissions || {},
      hooks: manifest.hooks,
      routes: manifest.routes || [],
      views: manifest.views || [],
      workflowNodes: manifest.workflowNodes || [],
      migrations: manifest.migrations || [],
      configSchema: manifest.configSchema,
      defaultConfig: manifest.defaultConfig || {},
      repository: manifest.repository,
      homepage: manifest.homepage,
      bugs: manifest.bugs,
      license: manifest.license,
      keywords: manifest.keywords || [],
      platforms: manifest.platforms,
      cpu: manifest.cpu,
      os: manifest.os
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
    const routeConflicts = [...routes1].filter(r => routes2.has(r))

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