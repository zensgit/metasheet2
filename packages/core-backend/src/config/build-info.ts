import fs from 'fs'
import path from 'path'

import { createLogger } from '../core/logger'

export interface BuildInfo {
  commit: string | null
  imageTag: string | null
  imageDigest: string | null
  source: string | null
  created: string | null
}

const PROVENANCE_FILE_NAME = 'BUILD_PROVENANCE.json'
const PROVENANCE_MAX_BYTES = 1024 * 1024
const PROVENANCE_MAX_WALK_LEVELS = 6

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'unknown') return null
  return trimmed
}

function readEnvString(env: NodeJS.ProcessEnv, key: string): string | null {
  return cleanString(env[key])
}

function isRegularFile(candidate: string): boolean {
  try {
    // lstat: a symlinked provenance file is never followed.
    const stat = fs.lstatSync(candidate)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function walkUp(start: string, out: string[]): void {
  let dir = path.resolve(start)
  for (let level = 0; level <= PROVENANCE_MAX_WALK_LEVELS; level += 1) {
    out.push(path.join(dir, PROVENANCE_FILE_NAME))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

function provenanceCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = []
  const pinned = env.METASHEET_BUILD_PROVENANCE_PATH
  if (typeof pinned === 'string' && pinned.trim()) {
    candidates.push(path.resolve(pinned.trim()))
  }
  walkUp(process.cwd(), candidates)
  walkUp(__dirname, candidates)
  return candidates
}

function emptyBuildInfo(): BuildInfo {
  return { commit: null, imageTag: null, imageDigest: null, source: null, created: null }
}

function loadProvenance(env: NodeJS.ProcessEnv): BuildInfo {
  try {
    for (const candidate of provenanceCandidates(env)) {
      if (!isRegularFile(candidate)) continue
      const raw = fs.readFileSync(candidate)
      if (raw.length > PROVENANCE_MAX_BYTES) return emptyBuildInfo()
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyBuildInfo()
      const data = parsed as Record<string, unknown>
      const commit = cleanString(data.gitCommit)
      const imageTag = cleanString(data.gitRef)
      if (!commit && !imageTag) return emptyBuildInfo()
      return {
        commit,
        imageTag,
        imageDigest: cleanString(data.imageDigest) ?? cleanString(data.digest),
        source: 'provenance-file',
        created: cleanString(data.builtAt) ?? cleanString(data.createdAt) ?? cleanString(data.buildTime),
      }
    }
  } catch {
    // Missing / unreadable / unparsable provenance must never break /health.
  }
  return emptyBuildInfo()
}

let provenanceMemo: BuildInfo | null = null

/** Test hook: forget the memoised provenance-file read. */
export function resetBuildInfoProvenanceCache(): void {
  provenanceMemo = null
}

/**
 * Build metadata for /health.
 * Env (METASHEET_BUILD_*) wins: when any env field is present the provenance
 * file is not read. Only when all env fields are null do we fall back to
 * BUILD_PROVENANCE.json (METASHEET_BUILD_PROVENANCE_PATH, else walk up from
 * cwd and the module dir, max 6 levels). The file is read once and memoised.
 */
export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const fromEnv: BuildInfo = {
    commit: readEnvString(env, 'METASHEET_BUILD_COMMIT'),
    imageTag: readEnvString(env, 'METASHEET_BUILD_IMAGE_TAG'),
    imageDigest: readEnvString(env, 'METASHEET_BUILD_IMAGE_DIGEST'),
    source: readEnvString(env, 'METASHEET_BUILD_SOURCE'),
    created: readEnvString(env, 'METASHEET_BUILD_CREATED'),
  }
  if (Object.values(fromEnv).some((value) => value !== null)) return fromEnv
  if (provenanceMemo === null) {
    provenanceMemo = loadProvenance(env)
    createLogger('BuildInfo').info(
      `build info source: ${provenanceMemo.source === 'provenance-file' ? 'provenance-file' : 'none'}`,
    )
  }
  return { ...provenanceMemo }
}
