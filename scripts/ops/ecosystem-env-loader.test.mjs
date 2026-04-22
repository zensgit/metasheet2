/**
 * Tests for the inline env loader in `ecosystem.config.cjs` (issue #518).
 *
 * The loader reads `docker/app.env` at config-parse time so
 * `pm2 start ecosystem.config.cjs` inherits the runtime env even when the
 * operator did not first `source` the file via the bootstrap scripts.
 *
 * This test spawns a fresh Node child process with a temp cwd so the loader
 * is exercised exactly as PM2 would parse it: a bare `require` of the config
 * must populate `process.env` from the sibling `docker/app.env`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..', '..')
const ecosystemConfigPath = join(repoRoot, 'ecosystem.config.cjs')

function runLoader({ envFile, childEnv = {} }) {
  const sandbox = mkdtempSync(join(tmpdir(), 'ecosystem-env-loader-'))
  try {
    copyFileSync(ecosystemConfigPath, join(sandbox, 'ecosystem.config.cjs'))
    if (envFile !== null) {
      mkdirSync(join(sandbox, 'docker'), { recursive: true })
      writeFileSync(join(sandbox, 'docker', 'app.env'), envFile, 'utf8')
    }
    const result = spawnSync(process.execPath, [
      '-e',
      `require('./ecosystem.config.cjs'); console.log(JSON.stringify({
        DATABASE_URL: process.env.DATABASE_URL ?? null,
        JWT_SECRET: process.env.JWT_SECRET ?? null,
        EMPTY_VAL: process.env.EMPTY_VAL ?? null,
        WITH_EQUALS: process.env.WITH_EQUALS ?? null,
        OVERRIDE_ME: process.env.OVERRIDE_ME ?? null,
        COMMENT_VAR: process.env.COMMENT_VAR ?? null,
      }))`,
    ], {
      cwd: sandbox,
      env: { ...process.env, ...childEnv },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `loader crashed: stderr=${result.stderr}`)
    return JSON.parse(result.stdout.trim().split('\n').pop())
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

describe('ecosystem.config.cjs env loader', () => {
  it('populates process.env from docker/app.env', () => {
    const out = runLoader({
      envFile: 'DATABASE_URL=postgres://a/b?sslmode=disable\nJWT_SECRET=secret-value\n',
    })
    assert.equal(out.DATABASE_URL, 'postgres://a/b?sslmode=disable')
    assert.equal(out.JWT_SECRET, 'secret-value')
  })

  it('skips comments and blank lines without error', () => {
    const out = runLoader({
      envFile: [
        '# Comment line should be ignored',
        '',
        'DATABASE_URL=postgres://x/y',
        '  # Indented comment',
        'COMMENT_VAR=seen',
      ].join('\n'),
    })
    assert.equal(out.DATABASE_URL, 'postgres://x/y')
    assert.equal(out.COMMENT_VAR, 'seen')
  })

  it('strips single and double quotes from values (bash-like)', () => {
    const out = runLoader({
      envFile: 'JWT_SECRET="double-quoted"\nDATABASE_URL=\'single-quoted\'\n',
    })
    assert.equal(out.JWT_SECRET, 'double-quoted')
    assert.equal(out.DATABASE_URL, 'single-quoted')
  })

  it('preserves `=` characters inside values', () => {
    const out = runLoader({
      envFile: 'WITH_EQUALS=a=b=c\n',
    })
    assert.equal(out.WITH_EQUALS, 'a=b=c')
  })

  it('preserves empty values without crashing', () => {
    const out = runLoader({
      envFile: 'EMPTY_VAL=\nDATABASE_URL=postgres://ok\n',
    })
    assert.equal(out.EMPTY_VAL, '')
    assert.equal(out.DATABASE_URL, 'postgres://ok')
  })

  it('does NOT override values already present in the shell env', () => {
    const out = runLoader({
      envFile: 'OVERRIDE_ME=file-value\nDATABASE_URL=postgres://from-file\n',
      childEnv: { OVERRIDE_ME: 'shell-wins' },
    })
    assert.equal(out.OVERRIDE_ME, 'shell-wins')
    assert.equal(out.DATABASE_URL, 'postgres://from-file')
  })

  it('is a silent no-op when docker/app.env is missing', () => {
    // The bootstrap scripts may have already exported env vars; missing file
    // is the expected path in dev / CI, and the loader must not throw.
    const out = runLoader({ envFile: null })
    assert.equal(out.DATABASE_URL, null)
    assert.equal(out.JWT_SECRET, null)
  })
})
