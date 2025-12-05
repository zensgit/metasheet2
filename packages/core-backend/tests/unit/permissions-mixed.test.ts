import { describe, it, expect } from 'vitest'
import { ManifestValidator } from '../../src/core/PluginManifestValidator'

describe('Manifest permissions validation', () => {
  it('validates database permissions format', () => {
    const validator = new ManifestValidator()

    // Invalid: database.read is not an array
    const manifestWithInvalidDbPerms = {
      manifestVersion: '2.0.0',
      name: 'test-plugin',
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: { name: 'Test Author' },
      engine: { metasheet: '>=1.0.0' },
      main: 'index.js',
      capabilities: {},
      permissions: {
        database: {
          read: 'invalid-not-array' // Should be array
        }
      }
    }

    const result = validator.validate(manifestWithInvalidDbPerms)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('database.read must be an array')
  })

  it('warns about wildcard database permissions', () => {
    const validator = new ManifestValidator()

    const manifestWithWildcard = {
      manifestVersion: '2.0.0',
      name: 'test-plugin',
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: { name: 'Test Author' },
      engine: { metasheet: '>=1.0.0' },
      main: 'index.js',
      capabilities: {},
      permissions: {
        database: {
          read: ['*'] // Wildcard - should warn
        }
      }
    }

    const result = validator.validate(manifestWithWildcard)
    expect(result.warnings).toContain('Using wildcard (*) database permissions is not recommended')
  })

  it('rejects root filesystem write access', () => {
    const validator = new ManifestValidator()

    const manifestWithRootAccess = {
      manifestVersion: '2.0.0',
      name: 'test-plugin',
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: { name: 'Test Author' },
      engine: { metasheet: '>=1.0.0' },
      main: 'index.js',
      capabilities: {},
      permissions: {
        filesystem: {
          write: ['/'] // Root access - not allowed
        }
      }
    }

    const result = validator.validate(manifestWithRootAccess)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Root filesystem write access is not allowed')
  })

  it('rejects wildcard command execution', () => {
    const validator = new ManifestValidator()

    const manifestWithWildcardExec = {
      manifestVersion: '2.0.0',
      name: 'test-plugin',
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: { name: 'Test Author' },
      engine: { metasheet: '>=1.0.0' },
      main: 'index.js',
      capabilities: {},
      permissions: {
        system: {
          exec: ['*'] // Wildcard exec - not allowed
        }
      }
    }

    const result = validator.validate(manifestWithWildcardExec)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Wildcard command execution is not allowed')
  })

  it('detects HTTP domain conflicts', () => {
    const validator = new ManifestValidator()

    const manifestWithConflict = {
      manifestVersion: '2.0.0',
      name: 'test-plugin',
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: { name: 'Test Author' },
      engine: { metasheet: '>=1.0.0' },
      main: 'index.js',
      capabilities: {},
      permissions: {
        http: {
          allowedDomains: ['example.com', 'api.test.com'],
          blockedDomains: ['example.com'] // Conflict!
        }
      }
    }

    const result = validator.validate(manifestWithConflict)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('Domain conflicts'))).toBe(true)
  })
})
