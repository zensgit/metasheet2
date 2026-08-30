import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ELEARNING_FLAG_NAMES,
  ELEARNING_PRODUCT_FEATURE,
  isElearningAnalyticsSurfaceEnabled,
  isElearningAssessmentSurfaceEnabled,
  isElearningEnabled,
  isElearningExamSurfaceEnabled,
  isElearningFlagEnabled,
  resolveElearningCatalogFeature,
  type ElearningFlagName,
} from '../../src/elearning/feature-flags'

const LOOKALIKES: Array<string | undefined> = [
  undefined,
  '',
  'false',
  'FALSE',
  '0',
  '1',
  'yes',
  'on',
  'TRUE',
  'True',
  ' true',
  'true ',
  ' true ',
]

describe('elearning V0.1 flags', () => {
  afterEach(() => {
    for (const name of ELEARNING_FLAG_NAMES) {
      delete process.env[name]
    }
    vi.resetModules()
  })

  it('canonical list is exactly the seven contract names and has no TASKS/STATS aliases', () => {
    expect([...ELEARNING_FLAG_NAMES]).toEqual([
      'ELEARNING_ENABLED',
      'ELEARNING_CONTENT_ENABLED',
      'ELEARNING_ASSIGNMENT_ENABLED',
      'ELEARNING_ASSESSMENT_ENABLED',
      'ELEARNING_INCENTIVE_ENABLED',
      'ELEARNING_ANALYTICS_ENABLED',
      'ELEARNING_MEDIA_ENABLED',
    ])
    const joined = ELEARNING_FLAG_NAMES.join(' ')
    expect(joined).not.toMatch(/TASKS|STATS/)
  })

  it.each(ELEARNING_FLAG_NAMES)('%s defaults OFF and accepts only exact literal true', (name) => {
    expect(isElearningFlagEnabled(name, {})).toBe(false)
    for (const value of LOOKALIKES) {
      expect(isElearningFlagEnabled(name, { [name]: value } as NodeJS.ProcessEnv)).toBe(false)
    }
    expect(isElearningFlagEnabled(name, { [name]: 'true' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('master reader is the ELEARNING_ENABLED exact-literal check', () => {
    expect(isElearningEnabled({})).toBe(false)
    expect(isElearningEnabled({ ELEARNING_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isElearningEnabled({ ELEARNING_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    expect(
      isElearningEnabled({
        ELEARNING_CONTENT_ENABLED: 'true',
        ELEARNING_ASSIGNMENT_ENABLED: 'true',
        ELEARNING_ASSESSMENT_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(false)
  })

  it('keeps assessment authoring independent from media while learner exams require it', () => {
    const assessmentOnly = {
      ELEARNING_ENABLED: 'true',
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSESSMENT_ENABLED: 'true',
    } as NodeJS.ProcessEnv
    expect(isElearningAssessmentSurfaceEnabled(assessmentOnly)).toBe(true)
    expect(isElearningExamSurfaceEnabled(assessmentOnly)).toBe(false)
    expect(
      isElearningExamSurfaceEnabled({
        ...assessmentOnly,
        ELEARNING_MEDIA_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
  })

  it('gates analytics independently with master plus exact analytics true', () => {
    expect(isElearningAnalyticsSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isElearningAnalyticsSurfaceEnabled({
      ELEARNING_ENABLED: 'true',
      ELEARNING_ANALYTICS_ENABLED: 'true',
    } as NodeJS.ProcessEnv)).toBe(true)
    expect(isElearningAnalyticsSurfaceEnabled({
      ELEARNING_ENABLED: 'true',
      ELEARNING_ANALYTICS_ENABLED: 'TRUE',
    } as NodeJS.ProcessEnv)).toBe(false)
    expect(isElearningAnalyticsSurfaceEnabled({
      ELEARNING_ANALYTICS_ENABLED: 'true',
    } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('FEATURE_FLAGS registers the seven names, default OFF, exact true only', async () => {
    for (const name of ELEARNING_FLAG_NAMES) {
      delete process.env[name]
    }
    vi.resetModules()
    const off = await import('../../src/config/flags')
    for (const name of ELEARNING_FLAG_NAMES) {
      expect(off.FEATURE_FLAGS[name]).toBe(false)
    }

    process.env.ELEARNING_ENABLED = 'true'
    process.env.ELEARNING_CONTENT_ENABLED = 'TRUE'
    process.env.ELEARNING_ASSIGNMENT_ENABLED = 'true'
    vi.resetModules()
    const on = await import('../../src/config/flags')
    expect(on.FEATURE_FLAGS.ELEARNING_ENABLED).toBe(true)
    expect(on.FEATURE_FLAGS.ELEARNING_CONTENT_ENABLED).toBe(false)
    expect(on.FEATURE_FLAGS.ELEARNING_ASSIGNMENT_ENABLED).toBe(true)
  })

  it('does not treat a boolean true env value as enabled', () => {
    const name: ElearningFlagName = 'ELEARNING_ENABLED'
    expect(isElearningFlagEnabled(name, { [name]: true as unknown as string } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('catalog predicate only opines on the elearning product feature', () => {
    expect(ELEARNING_PRODUCT_FEATURE).toBe('elearning')
    expect(resolveElearningCatalogFeature('afterSales')).toBeUndefined()
    expect(resolveElearningCatalogFeature('attendance')).toBeUndefined()
    expect(resolveElearningCatalogFeature('attendanceAdmin')).toBeUndefined()
    expect(resolveElearningCatalogFeature('not-a-real-feature')).toBeUndefined()
    expect(resolveElearningCatalogFeature('plugin-elearning')).toBeUndefined()
    expect(resolveElearningCatalogFeature('elearning', {})).toBe(false)
    expect(resolveElearningCatalogFeature('elearning', { ELEARNING_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false)
    expect(resolveElearningCatalogFeature('elearning', { ELEARNING_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false)
    expect(resolveElearningCatalogFeature('elearning', { ELEARNING_ENABLED: 'true ' } as NodeJS.ProcessEnv)).toBe(false)
    expect(resolveElearningCatalogFeature('elearning', { ELEARNING_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    expect(
      resolveElearningCatalogFeature('afterSales', { ELEARNING_ENABLED: 'true' } as NodeJS.ProcessEnv),
    ).toBeUndefined()
  })
})
