#!/usr/bin/env npx tsx
/**
 * CI/CD Script: Validate all plugin manifests
 *
 * Checks that all plugins have valid plugin.json manifests.
 * Returns exit code 0 if all valid, 1 if any invalid.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface ManifestV2 {
  manifestVersion?: string
  name: string
  version: string
  displayName?: string
  description?: string
  author?: {
    name: string
    email?: string
  }
  engine?: {
    metasheet: string
    node?: string
  }
  main?: string
  capabilities?: {
    views?: any[]
    workflows?: any[]
    functions?: any[]
  }
  permissions?: {
    database?: {
      read?: string[]
      write?: string[]
    }
    http?: {
      internal?: boolean
      external?: string[]
    }
    filesystem?: {
      read?: string[]
      write?: string[]
    }
  }
  license?: string
}

interface ValidationResult {
  pluginName: string
  valid: boolean
  errors: string[]
  warnings: string[]
}

function validateManifest(manifest: any, pluginDir: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const pluginName = manifest.name || path.basename(pluginDir)

  // Required fields
  if (!manifest.manifestVersion) {
    errors.push('Missing required field: manifestVersion')
  } else if (manifest.manifestVersion !== '2.0.0') {
    warnings.push(`Unexpected manifestVersion: ${manifest.manifestVersion} (expected 2.0.0)`)
  }

  if (!manifest.name) {
    errors.push('Missing required field: name')
  } else {
    const namePattern = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/
    if (!namePattern.test(manifest.name)) {
      errors.push(`Invalid name format: ${manifest.name} (must be lowercase with optional scope and hyphens)`)
    }
  }

  if (!manifest.version) {
    errors.push('Missing required field: version')
  } else if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push(`Invalid version format: ${manifest.version} (must be semver)`)
  }

  if (!manifest.displayName) {
    errors.push('Missing required field: displayName')
  }

  if (!manifest.description) {
    errors.push('Missing required field: description')
  }

  // Author validation
  if (!manifest.author) {
    errors.push('Missing required field: author')
  } else if (typeof manifest.author !== 'object') {
    errors.push('author must be an object with name and optional email')
  } else {
    if (!manifest.author.name) {
      errors.push('Missing required field: author.name')
    }
  }

  // Engine validation
  if (!manifest.engine) {
    errors.push('Missing required field: engine')
  } else if (typeof manifest.engine !== 'object') {
    errors.push('engine must be an object with metasheet version requirement')
  } else {
    if (!manifest.engine.metasheet) {
      errors.push('Missing required field: engine.metasheet')
    }
  }

  // Main entry point validation
  if (!manifest.main) {
    errors.push('Missing required field: main')
  } else {
    const mainPath = path.join(pluginDir, manifest.main)
    if (!fs.existsSync(mainPath)) {
      warnings.push(`Main entry point not found: ${manifest.main}`)
    }
  }

  // Capabilities validation
  if (!manifest.capabilities) {
    errors.push('Missing required field: capabilities')
  } else if (typeof manifest.capabilities !== 'object') {
    errors.push('capabilities must be an object')
  } else {
    if (!Array.isArray(manifest.capabilities.views)) {
      errors.push('capabilities.views must be an array')
    }
    if (!Array.isArray(manifest.capabilities.workflows)) {
      errors.push('capabilities.workflows must be an array')
    }
    if (!Array.isArray(manifest.capabilities.functions)) {
      errors.push('capabilities.functions must be an array')
    }
  }

  // Permissions validation (required but can be empty)
  if (!manifest.permissions) {
    errors.push('Missing required field: permissions')
  } else if (typeof manifest.permissions !== 'object') {
    errors.push('permissions must be an object')
  } else {
    // Check for wildcard permissions
    if (manifest.permissions.database) {
      if (manifest.permissions.database.read?.includes('*') ||
          manifest.permissions.database.write?.includes('*')) {
        warnings.push('Using wildcard (*) database permissions is not recommended')
      }
    }
  }

  // License validation
  if (!manifest.license) {
    warnings.push('Missing license field')
  }

  return {
    pluginName,
    valid: errors.length === 0,
    errors,
    warnings
  }
}

async function main() {
  console.log('🔍 Validating plugin manifests...\n')

  const rootDir = path.resolve(__dirname, '..')
  const pluginsDir = path.join(rootDir, 'plugins')

  if (!fs.existsSync(pluginsDir)) {
    console.error('❌ Plugins directory not found:', pluginsDir)
    process.exit(1)
  }

  const pluginDirs = fs.readdirSync(pluginsDir).filter(dir => {
    const fullPath = path.join(pluginsDir, dir)
    return fs.statSync(fullPath).isDirectory()
  })

  console.log(`Found ${pluginDirs.length} plugin directories\n`)

  const results: ValidationResult[] = []
  let totalErrors = 0
  let totalWarnings = 0

  for (const dir of pluginDirs) {
    const pluginPath = path.join(pluginsDir, dir)
    const manifestPath = path.join(pluginPath, 'plugin.json')

    if (!fs.existsSync(manifestPath)) {
      console.log(`⚠️  ${dir}: No plugin.json found (skipped)`)
      continue
    }

    try {
      const content = fs.readFileSync(manifestPath, 'utf-8')
      const manifest = JSON.parse(content)
      const result = validateManifest(manifest, pluginPath)
      results.push(result)

      if (result.valid) {
        if (result.warnings.length > 0) {
          console.log(`✅ ${result.pluginName}: Valid (${result.warnings.length} warnings)`)
          result.warnings.forEach(w => console.log(`   ⚠️  ${w}`))
        } else {
          console.log(`✅ ${result.pluginName}: Valid`)
        }
      } else {
        console.log(`❌ ${result.pluginName}: Invalid`)
        result.errors.forEach(e => console.log(`   ❌ ${e}`))
        result.warnings.forEach(w => console.log(`   ⚠️  ${w}`))
      }

      totalErrors += result.errors.length
      totalWarnings += result.warnings.length
    } catch (error) {
      console.log(`❌ ${dir}: Failed to parse plugin.json`)
      console.log(`   ❌ ${(error as Error).message}`)
      totalErrors++
      results.push({
        pluginName: dir,
        valid: false,
        errors: [`Parse error: ${(error as Error).message}`],
        warnings: []
      })
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('📊 VALIDATION SUMMARY')
  console.log('='.repeat(50))

  const validCount = results.filter(r => r.valid).length
  const invalidCount = results.filter(r => !r.valid).length

  console.log(`Total plugins: ${results.length}`)
  console.log(`Valid: ${validCount} ✅`)
  console.log(`Invalid: ${invalidCount} ❌`)
  console.log(`Total errors: ${totalErrors}`)
  console.log(`Total warnings: ${totalWarnings}`)

  if (invalidCount > 0) {
    console.log('\n❌ Validation FAILED')
    console.log('Please fix the above errors before merging.')
    process.exit(1)
  } else {
    console.log('\n✅ All manifests are valid!')
    if (totalWarnings > 0) {
      console.log(`⚠️  Consider addressing the ${totalWarnings} warning(s) above.`)
    }
    process.exit(0)
  }
}

main().catch(error => {
  console.error('Script error:', error)
  process.exit(1)
})
