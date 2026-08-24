export const ELEARNING_ENABLED = 'ELEARNING_ENABLED' as const
export const ELEARNING_CONTENT_ENABLED = 'ELEARNING_CONTENT_ENABLED' as const
export const ELEARNING_ASSIGNMENT_ENABLED = 'ELEARNING_ASSIGNMENT_ENABLED' as const
export const ELEARNING_ASSESSMENT_ENABLED = 'ELEARNING_ASSESSMENT_ENABLED' as const
export const ELEARNING_INCENTIVE_ENABLED = 'ELEARNING_INCENTIVE_ENABLED' as const
export const ELEARNING_ANALYTICS_ENABLED = 'ELEARNING_ANALYTICS_ENABLED' as const
export const ELEARNING_MEDIA_ENABLED = 'ELEARNING_MEDIA_ENABLED' as const

export const ELEARNING_FLAG_NAMES = [
  ELEARNING_ENABLED,
  ELEARNING_CONTENT_ENABLED,
  ELEARNING_ASSIGNMENT_ENABLED,
  ELEARNING_ASSESSMENT_ENABLED,
  ELEARNING_INCENTIVE_ENABLED,
  ELEARNING_ANALYTICS_ENABLED,
  ELEARNING_MEDIA_ENABLED,
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

/**
 * Watch surface is live only when master AND CONTENT AND ASSIGNMENT AND MEDIA
 * are exact literal 'true'. Assessment is not part of this gate.
 */
export function isElearningWatchSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isElearningEnabled(env) &&
    isElearningFlagEnabled(ELEARNING_CONTENT_ENABLED, env) &&
    isElearningFlagEnabled(ELEARNING_ASSIGNMENT_ENABLED, env) &&
    isElearningFlagEnabled(ELEARNING_MEDIA_ENABLED, env)
  )
}
