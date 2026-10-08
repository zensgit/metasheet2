/**
 * Server-side ffprobe for elearning M1. Duration is never read from the client.
 * Invocation is execFile (no shell), with bounded timeout/output and unique temp files
 * that are always removed.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const ELEARNING_MEDIA_FFPROBE_TIMEOUT_MS = 15_000
export const ELEARNING_MEDIA_FFPROBE_MAX_OUTPUT_BYTES = 256 * 1024

export const ELEARNING_MEDIA_VIDEO_CODEC = 'h264'
export const ELEARNING_MEDIA_AUDIO_CODEC = 'aac'

export type ElearningMediaProbeOutcome =
  | { ok: true; durationMs: number }
  | { ok: false; reason: 'probe_failed' | 'unsupported_codec' | 'invalid_duration' }

export type ElearningMediaFfprobeRunner = (
  filePath: string,
) => Promise<{ stdout: string; stderr?: string }>

const defaultRunner: ElearningMediaFfprobeRunner = async (filePath) => {
  const { stdout, stderr } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    {
      timeout: ELEARNING_MEDIA_FFPROBE_TIMEOUT_MS,
      maxBuffer: ELEARNING_MEDIA_FFPROBE_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseDurationMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const seconds = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const durationMs = Math.round(seconds * 1000)
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return null
  return durationMs
}

/** Pure evaluation of an ffprobe JSON document. Never reads client-supplied duration. */
export function evaluateElearningMediaProbeJson(parsed: unknown): ElearningMediaProbeOutcome {
  const root = asRecord(parsed)
  if (!root) return { ok: false, reason: 'probe_failed' }
  const streams = Array.isArray(root.streams) ? root.streams : []
  let videoCount = 0
  for (const stream of streams) {
    const row = asRecord(stream)
    if (!row) return { ok: false, reason: 'probe_failed' }
    const type = String(row.codec_type ?? '').toLowerCase()
    const codec = String(row.codec_name ?? '').toLowerCase()
    if (type === 'video') {
      videoCount += 1
      if (codec !== ELEARNING_MEDIA_VIDEO_CODEC) return { ok: false, reason: 'unsupported_codec' }
    } else if (type === 'audio') {
      if (codec !== ELEARNING_MEDIA_AUDIO_CODEC) return { ok: false, reason: 'unsupported_codec' }
    } else if (type) {
      return { ok: false, reason: 'unsupported_codec' }
    }
  }
  if (videoCount < 1) return { ok: false, reason: 'unsupported_codec' }

  const format = asRecord(root.format)
  const durationMs = parseDurationMs(format?.duration)
  if (durationMs === null) return { ok: false, reason: 'invalid_duration' }
  return { ok: true, durationMs }
}

export interface ProbeElearningMediaBufferDeps {
  runner?: ElearningMediaFfprobeRunner
  createTempDir?: (prefix: string) => Promise<string>
  writeFile?: typeof writeFile
  removePath?: (target: string) => Promise<void>
}

/**
 * Write bytes to a unique temp file (never the client filename), run ffprobe, always unlink.
 * Runner failures and unsupported codecs are rejected/not-ready — never ready.
 */
export async function probeElearningMediaBuffer(
  content: Buffer,
  deps: ProbeElearningMediaBufferDeps = {},
): Promise<ElearningMediaProbeOutcome> {
  const createTempDir = deps.createTempDir
    ?? ((prefix) => mkdtemp(path.join(tmpdir(), prefix)))
  const write = deps.writeFile ?? writeFile
  const removePath = deps.removePath ?? ((target) => rm(target, { recursive: true, force: true }))
  const runner = deps.runner ?? defaultRunner

  const dir = await createTempDir('elearning-media-')
  const filePath = path.join(dir, 'upload.mp4')
  try {
    await write(filePath, content, { flag: 'wx' })
    let stdout: string
    try {
      const result = await runner(filePath)
      stdout = result.stdout
    } catch {
      return { ok: false, reason: 'probe_failed' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return { ok: false, reason: 'probe_failed' }
    }
    return evaluateElearningMediaProbeJson(parsed)
  } finally {
    await removePath(dir)
  }
}
