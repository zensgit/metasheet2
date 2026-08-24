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

export function isElearningFlagEnabled(
  name: ElearningFlagName,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[name] === 'true'
}

export function isElearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isElearningFlagEnabled(ELEARNING_ENABLED, env)
}
