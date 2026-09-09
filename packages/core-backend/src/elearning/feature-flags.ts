export const ELEARNING_ENABLED = 'ELEARNING_ENABLED' as const
export const ELEARNING_CONTENT_ENABLED = 'ELEARNING_CONTENT_ENABLED' as const
export const ELEARNING_ASSIGNMENT_ENABLED = 'ELEARNING_ASSIGNMENT_ENABLED' as const
export const ELEARNING_ASSESSMENT_ENABLED = 'ELEARNING_ASSESSMENT_ENABLED' as const
export const ELEARNING_INCENTIVE_ENABLED = 'ELEARNING_INCENTIVE_ENABLED' as const
export const ELEARNING_ANALYTICS_ENABLED = 'ELEARNING_ANALYTICS_ENABLED' as const
export const ELEARNING_MEDIA_ENABLED = 'ELEARNING_MEDIA_ENABLED' as const
export const ELEARNING_WATCH_CHALLENGE_ENABLED = 'ELEARNING_WATCH_CHALLENGE_ENABLED' as const
export const ELEARNING_ENROLLMENT_ENABLED = 'ELEARNING_ENROLLMENT_ENABLED' as const

export const ELEARNING_FLAG_NAMES = [
  ELEARNING_ENABLED,
  ELEARNING_CONTENT_ENABLED,
  ELEARNING_ASSIGNMENT_ENABLED,
  ELEARNING_ASSESSMENT_ENABLED,
  ELEARNING_INCENTIVE_ENABLED,
  ELEARNING_ANALYTICS_ENABLED,
  ELEARNING_MEDIA_ENABLED,
  ELEARNING_WATCH_CHALLENGE_ENABLED,
  ELEARNING_ENROLLMENT_ENABLED,
] as const

export type ElearningFlagName = (typeof ELEARNING_FLAG_NAMES)[number]

/** Frontend product feature / app.manifest.featureFlags entry gated by ELEARNING_ENABLED. */
export const ELEARNING_PRODUCT_FEATURE = 'elearning' as const

export function isElearningFlagEnabled(
  name: ElearningFlagName,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[name] === 'true'
}

export function isElearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isElearningFlagEnabled(ELEARNING_ENABLED, env)
}

/**
 * App-catalog opinion for the elearning product feature only.
 * Returns false when the master flag is not exact 'true', true when it is,
 * and undefined for any other flag so after-sales / attendance / unknown
 * featureFlags keep their existing catalog behavior.
 */
export function resolveElearningCatalogFeature(
  flag: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  if (flag !== ELEARNING_PRODUCT_FEATURE) return undefined
  return isElearningEnabled(env)
}

/** Upload surface is live only when master AND MEDIA are exact literal 'true'. */
export function isElearningMediaSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isElearningEnabled(env) && isElearningFlagEnabled(ELEARNING_MEDIA_ENABLED, env)
}

/** Content/catalog/scope surface requires only the master and CONTENT gates. */
export function isElearningContentSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isElearningEnabled(env) && isElearningFlagEnabled(ELEARNING_CONTENT_ENABLED, env)
}

/** Online self-study enrollment is independently demand-gated and never grants access. */
export function isElearningEnrollmentSurfaceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isElearningContentSurfaceEnabled(env)
    && isElearningFlagEnabled(ELEARNING_ENROLLMENT_ENABLED, env)
  )
}

/** Assignment writes additionally require the independent ASSIGNMENT capability. */
export function isElearningAssignmentSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isElearningContentSurfaceEnabled(env)
    && isElearningFlagEnabled(ELEARNING_ASSIGNMENT_ENABLED, env)
  )
}

/**
 * Watching is available to either an assignment or a visibility rule, so the
 * independent ASSIGNMENT capability must not gate it.
 */
export function isElearningWatchSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isElearningContentSurfaceEnabled(env)
    && isElearningFlagEnabled(ELEARNING_MEDIA_ENABLED, env)
  )
}

/** L6 watch challenge requires the existing watch surface plus its own exact gate. */
export function isElearningWatchChallengeSurfaceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isElearningWatchSurfaceEnabled(env)
    && isElearningFlagEnabled(ELEARNING_WATCH_CHALLENGE_ENABLED, env)
  )
}

/**
 * Assessment authoring is independent from media/watch and requires only the
 * master, CONTENT, and ASSESSMENT capabilities.
 */
export function isElearningAssessmentSurfaceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isElearningContentSurfaceEnabled(env)
    && isElearningFlagEnabled(ELEARNING_ASSESSMENT_ENABLED, env)
  )
}

/** Learner exam runtime additionally needs the media/watch capability. */
export function isElearningExamSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isElearningWatchSurfaceEnabled(env)
    && isElearningAssessmentSurfaceEnabled(env)
  )
}

/** Analytics is independent from content and incentive, but always needs master. */
export function isElearningAnalyticsSurfaceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isElearningEnabled(env)
    && isElearningFlagEnabled(ELEARNING_ANALYTICS_ENABLED, env)
  )
}
