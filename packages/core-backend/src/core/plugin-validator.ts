// plugin-validator.ts
// Lightweight manifest + capability validation (extensible)

import semver from 'semver'
import type { PluginManifest } from '../types/plugin'

export interface ValidationIssue { level: 'error' | 'warning'; message: string }
export interface ValidationResult { ok: boolean; issues: ValidationIssue[] }

const REQUIRED_FIELDS = ['name', 'version', 'main']

export interface CapabilityRegistry {
  has(key: string): boolean
}

export function validateManifest(manifest: PluginManifest, caps?: CapabilityRegistry): ValidationResult {
  const issues: ValidationIssue[] = []
  for (const f of REQUIRED_FIELDS) {
    if (!(f in manifest)) issues.push({ level: 'error', message: `Missing required field: ${f}` })
  }
  if (manifest.version && !semver.valid(manifest.version)) {
    issues.push({ level: 'error', message: `Invalid version: ${manifest.version}` })
  }
  // Check capabilities if present (optional extension field not in base manifest type)
  const manifestWithCaps = manifest as PluginManifest & { capabilities?: string[] }
  if (caps && manifestWithCaps.capabilities) {
    for (const c of manifestWithCaps.capabilities) {
      if (!caps.has(c)) issues.push({ level: 'warning', message: `Capability not in matrix: ${c}` })
    }
  }
  return { ok: issues.filter(i => i.level === 'error').length === 0, issues }
}

