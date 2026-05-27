export interface BuildInfo {
  commit: string | null
  imageTag: string | null
  imageDigest: string | null
  source: string | null
  created: string | null
}

function readEnvString(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'unknown') return null
  return trimmed
}

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    commit: readEnvString(env, 'METASHEET_BUILD_COMMIT'),
    imageTag: readEnvString(env, 'METASHEET_BUILD_IMAGE_TAG'),
    imageDigest: readEnvString(env, 'METASHEET_BUILD_IMAGE_DIGEST'),
    source: readEnvString(env, 'METASHEET_BUILD_SOURCE'),
    created: readEnvString(env, 'METASHEET_BUILD_CREATED'),
  }
}
