import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuildInfo, resetBuildInfoProvenanceCache } from '../../src/config/build-info'

describe('getBuildInfo provenance-file fallback', () => {
  const dirs: string[] = []
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'))
    dirs.push(d)
    return d
  }
  const prov = { gitCommit: 'abc123', gitRef: 'multitable-onprem-r67', builtAt: '2026-10-20T01:02:03Z', ciRunId: '99' }
  const nulls = { commit: null, imageTag: null, imageDigest: null, source: null, created: null }

  beforeEach(() => resetBuildInfoProvenanceCache())
  afterEach(() => {
    vi.restoreAllMocks()
    resetBuildInfoProvenanceCache()
    while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  it('env wins and the file is not read', () => {
    const file = path.join(mk(), 'BUILD_PROVENANCE.json')
    fs.writeFileSync(file, JSON.stringify(prov))
    const spy = vi.spyOn(fs, 'readFileSync')
    const info = getBuildInfo({ METASHEET_BUILD_COMMIT: 'envsha', METASHEET_BUILD_PROVENANCE_PATH: file } as NodeJS.ProcessEnv)
    expect(info.commit).toBe('envsha')
    expect(info.source).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('maps the provenance file found via METASHEET_BUILD_PROVENANCE_PATH', () => {
    const file = path.join(mk(), 'custom.json')
    fs.writeFileSync(file, JSON.stringify(prov))
    expect(getBuildInfo({ METASHEET_BUILD_PROVENANCE_PATH: file } as NodeJS.ProcessEnv)).toEqual({
      commit: 'abc123',
      imageTag: 'multitable-onprem-r67',
      imageDigest: null,
      source: 'provenance-file',
      created: '2026-10-20T01:02:03Z',
    })
  })

  it('discovers BUILD_PROVENANCE.json by walking up from cwd', () => {
    const root = mk()
    fs.writeFileSync(path.join(root, 'BUILD_PROVENANCE.json'), JSON.stringify(prov))
    const deep = path.join(root, 'packages', 'core-backend')
    fs.mkdirSync(deep, { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(deep)
    expect(getBuildInfo({} as NodeJS.ProcessEnv).commit).toBe('abc123')
  })

  it('keeps nulls without throwing for missing, unparsable or oversized files', () => {
    const dir = mk()
    const missing = path.join(dir, 'nope.json')
    expect(getBuildInfo({ METASHEET_BUILD_PROVENANCE_PATH: missing } as NodeJS.ProcessEnv)).toEqual(nulls)
    resetBuildInfoProvenanceCache()
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, '{not json')
    expect(getBuildInfo({ METASHEET_BUILD_PROVENANCE_PATH: bad } as NodeJS.ProcessEnv)).toEqual(nulls)
    resetBuildInfoProvenanceCache()
    const big = path.join(dir, 'big.json')
    fs.writeFileSync(big, JSON.stringify({ gitCommit: 'x', pad: 'a'.repeat(1024 * 1024 + 10) }))
    expect(getBuildInfo({ METASHEET_BUILD_PROVENANCE_PATH: big } as NodeJS.ProcessEnv)).toEqual(nulls)
  })

  it('memoises: a second call does not re-read the file', () => {
    const file = path.join(mk(), 'p.json')
    fs.writeFileSync(file, JSON.stringify(prov))
    const spy = vi.spyOn(fs, 'readFileSync')
    const env = { METASHEET_BUILD_PROVENANCE_PATH: file } as NodeJS.ProcessEnv
    getBuildInfo(env)
    getBuildInfo(env)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the file is replaced in place (no reset hook), and drops to nulls if it disappears', () => {
    const file = path.join(mk(), 'p.json')
    const env = { METASHEET_BUILD_PROVENANCE_PATH: file } as NodeJS.ProcessEnv
    fs.writeFileSync(file, JSON.stringify({ gitCommit: 'prev', gitRef: 'r66' }))
    expect(getBuildInfo(env).commit).toBe('prev')
    fs.writeFileSync(file, JSON.stringify({ gitCommit: 'next-commit-longer', gitRef: 'r67' }))
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(file, future, future)
    expect(getBuildInfo(env)).toMatchObject({ commit: 'next-commit-longer', imageTag: 'r67' })
    fs.rmSync(file)
    expect(getBuildInfo(env)).toEqual(nulls)
  })

  it('skips an oversized file by lstat size without reading it', () => {
    const file = path.join(mk(), 'huge.json')
    fs.writeFileSync(file, JSON.stringify({ gitCommit: 'x', pad: 'a'.repeat(2 * 1024 * 1024) }))
    const spy = vi.spyOn(fs, 'readFileSync')
    expect(getBuildInfo({ METASHEET_BUILD_PROVENANCE_PATH: file } as NodeJS.ProcessEnv)).toEqual(nulls)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a non-empty METASHEET_BUILD_PROVENANCE_PATH is the only candidate (no walk-up)', () => {
    const root = mk()
    fs.writeFileSync(path.join(root, 'BUILD_PROVENANCE.json'), JSON.stringify(prov))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    // pinned but missing: the cwd file must NOT be used
    const missing = path.join(mk(), 'nope.json')
    expect(getBuildInfo({ METASHEET_BUILD_PROVENANCE_PATH: missing } as NodeJS.ProcessEnv)).toEqual(nulls)
    // unset / blank pin: walk-up still works
    resetBuildInfoProvenanceCache()
    expect(getBuildInfo({ METASHEET_BUILD_PROVENANCE_PATH: '  ' } as NodeJS.ProcessEnv).commit).toBe('abc123')
  })
})

describe('getBuildInfo', () => {
  it('normalizes deploy build metadata from environment variables', () => {
    const info = getBuildInfo({
      METASHEET_BUILD_COMMIT: ' 0123456789abcdef0123456789abcdef01234567 ',
      METASHEET_BUILD_IMAGE_TAG: '0123456789abcdef0123456789abcdef01234567',
      METASHEET_BUILD_IMAGE_DIGEST: 'ghcr.io/zensgit/metasheet2-backend@sha256:abc123',
      METASHEET_BUILD_SOURCE: 'https://github.com/zensgit/metasheet2',
      METASHEET_BUILD_CREATED: '2026-05-27T15:00:00Z',
    } as NodeJS.ProcessEnv)

    expect(info).toEqual({
      commit: '0123456789abcdef0123456789abcdef01234567',
      imageTag: '0123456789abcdef0123456789abcdef01234567',
      imageDigest: 'ghcr.io/zensgit/metasheet2-backend@sha256:abc123',
      source: 'https://github.com/zensgit/metasheet2',
      created: '2026-05-27T15:00:00Z',
    })
  })

  it('hides unset or placeholder metadata instead of exposing noisy values', () => {
    expect(getBuildInfo({
      METASHEET_BUILD_COMMIT: 'unknown',
      METASHEET_BUILD_IMAGE_TAG: '',
      METASHEET_BUILD_IMAGE_DIGEST: '   ',
    } as NodeJS.ProcessEnv)).toEqual({
      commit: null,
      imageTag: null,
      imageDigest: null,
      source: null,
      created: null,
    })
  })
})
