import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isFeatureOverrideAllowed, mergeFeatureOverrideJson, setLocalFeatureOverride } from '../src/stores/featureFlags'

// Isolated from tests/featureFlags.spec.ts on purpose: that suite has pre-existing, unrelated
// red assertions (quarantined out of the required web-tests lane — see
// apps/web/scripts/run-required-web-tests.sh's "19 pre-existing red files" note) that this PR
// does not touch or attempt to fix. This file only exercises the three exports Navigability audit
// fix 1 (2026-08-22) adds, so it can be safely wired into a required gate on its own.

describe('mergeFeatureOverrideJson', () => {
  it('merges a patch onto an empty/absent override', () => {
    expect(JSON.parse(mergeFeatureOverrideJson(null, { attendanceAdmin: true }))).toEqual({
      attendanceAdmin: true,
    })
  })

  it('preserves existing keys a developer already set (read-merge-write, not overwrite)', () => {
    const existing = JSON.stringify({ attendance: true, workflow: false })
    expect(JSON.parse(mergeFeatureOverrideJson(existing, { attendanceAdmin: true }))).toEqual({
      attendance: true,
      workflow: false,
      attendanceAdmin: true,
    })
  })

  it('lets the patch overwrite a key that already existed', () => {
    const existing = JSON.stringify({ workflow: false })
    expect(JSON.parse(mergeFeatureOverrideJson(existing, { workflow: true }))).toEqual({ workflow: true })
  })

  it('falls back to an empty base for malformed existing JSON', () => {
    expect(JSON.parse(mergeFeatureOverrideJson('{not json', { workflow: true }))).toEqual({ workflow: true })
  })

  it('falls back to an empty base when the existing JSON is a non-object (e.g. an array)', () => {
    expect(JSON.parse(mergeFeatureOverrideJson('[1,2,3]', { workflow: true }))).toEqual({ workflow: true })
  })
})

describe('isFeatureOverrideAllowed / setLocalFeatureOverride', () => {
  const originalDev = import.meta.env.DEV

  beforeEach(() => {
    localStorage.clear()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllEnvs()
    // vitest runs with import.meta.env.DEV === true by default; restore defensively.
    ;(import.meta.env as any).DEV = originalDev
  })

  it('is allowed in DEV mode (the predicate itself is unchanged by this fix)', () => {
    expect(isFeatureOverrideAllowed()).toBe(true)
  })

  it('setLocalFeatureOverride writes metasheet_features under the SAME key parseOverrideFeatures reads', () => {
    setLocalFeatureOverride('attendanceAdmin', true)
    expect(JSON.parse(localStorage.getItem('metasheet_features') || '{}')).toEqual({ attendanceAdmin: true })
  })

  it('setLocalFeatureOverride merges onto an existing override instead of clobbering it', () => {
    localStorage.setItem('metasheet_features', JSON.stringify({ workflow: true }))
    setLocalFeatureOverride('attendanceAdmin', true)
    expect(JSON.parse(localStorage.getItem('metasheet_features') || '{}')).toEqual({
      workflow: true,
      attendanceAdmin: true,
    })
  })

  it('setLocalFeatureOverride can disable a flag it previously enabled', () => {
    setLocalFeatureOverride('attendanceAdmin', true)
    setLocalFeatureOverride('attendanceAdmin', false)
    expect(JSON.parse(localStorage.getItem('metasheet_features') || '{}')).toEqual({ attendanceAdmin: false })
  })

  it('no-ops (does not touch localStorage) when the override gate is closed', () => {
    ;(import.meta.env as any).DEV = false
    setLocalFeatureOverride('attendanceAdmin', true)
    expect(localStorage.getItem('metasheet_features')).toBeNull()
    ;(import.meta.env as any).DEV = originalDev
  })
})
