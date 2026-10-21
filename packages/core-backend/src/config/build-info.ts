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

/** lstat a candidate; a symlink, directory or missing path yields null (never followed). */
function statRegularFile(candidate: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(candidate)
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null
  } catch {
    return null
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

/**
 * When METASHEET_BUILD_PROVENANCE_PATH is set and non-empty it is the ONLY
 * candidate (no walk-up). Otherwise walk up from cwd and the module dir.
 */
function provenanceCandidates(env: NodeJS.ProcessEnv): string[] {
  const pinned = env.METASHEET_BUILD_PROVENANCE_PATH
  if (typeof pinned === 'string' && pinned.trim()) {
    return [path.resolve(pinned.trim())]
  }
  const candidates: string[] = []
  walkUp(process.cwd(), candidates)
  walkUp(__dirname, candidates)
  return candidates
}

function emptyBuildInfo(): BuildInfo {
  return { commit: null, imageTag: null, imageDigest: null, source: null, created: null }
}

function parseProvenance(candidate: string, size: number): BuildInfo {
  try {
    // Size is checked on the lstat result BEFORE any read.
    if (size > PROVENANCE_MAX_BYTES) return emptyBuildInfo()
    const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'))
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
  } catch {
    // Unreadable / unparsable provenance must never break /health.
    return emptyBuildInfo()
  }
}

interface ProvenanceMemo {
  file: { path: string; size: number; mtimeMs: number } | null
  info: BuildInfo
}

let provenanceMemo: ProvenanceMemo | null = null
let provenanceLogged = false

/** Test hook: forget the memo and the one-shot log flag. */
export function resetBuildInfoProvenanceCache(): void {
  provenanceMemo = null
  provenanceLogged = false
}

function resolveProvenance(env: NodeJS.ProcessEnv): BuildInfo {
  let chosen: { path: string; stat: fs.Stats } | null = null
  for (const candidate of provenanceCandidates(env)) {
    const stat = statRegularFile(candidate)
    if (stat) {
      chosen = { path: candidate, stat }
      break
    }
  }
  const file = chosen ? { path: chosen.path, size: chosen.stat.size, mtimeMs: chosen.stat.mtimeMs } : null
  const memo = provenanceMemo
  if (
    memo &&
    ((memo.file === null && file === null) ||
      (memo.file !== null &&
        file !== null &&
        memo.file.path === file.path &&
        memo.file.size === file.size &&
        memo.file.mtimeMs === file.mtimeMs))
  ) {
    return memo.info
  }
  // First call, or the chosen file appeared / changed / disappeared: re-read.
  const info = chosen ? parseProvenance(chosen.path, chosen.stat.size) : emptyBuildInfo()
  provenanceMemo = { file, info }
  if (!provenanceLogged) {
    provenanceLogged = true
    createLogger('BuildInfo').info(
      `build info source: ${info.source === 'provenance-file' ? 'provenance-file' : 'none'}`,
    )
  }
  return info
}

/**
 * Build metadata for /health.
 * Env (METASHEET_BUILD_*) wins: when any env field is present the provenance
 * file is not read. Only when all env fields are null do we fall back to
 * BUILD_PROVENANCE.json: METASHEET_BUILD_PROVENANCE_PATH if set (only that
 * path), else walk up from cwd and the module dir (max 6 levels). The parsed
 * result is memoised against the file's {path,size,mtimeMs} (re-checked with
 * lstat on every call, no read unless it changed), so replacing the file during
 * an in-place upgrade is reflected without a restart.
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
  return { ...resolveProvenance(env) }
}
