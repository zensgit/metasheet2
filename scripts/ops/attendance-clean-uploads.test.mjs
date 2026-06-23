import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const repoRoot = process.cwd()
const cleanupScript = path.join(repoRoot, 'scripts/ops/attendance-clean-uploads.sh')

function runBash(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      resolve({ status: code, stdout, stderr })
    })
  })
}

test('attendance-clean-uploads deletes stale bind-mount files without expanding awk fields under nounset', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-clean-uploads-'))
  const uploadDir = path.join(dir, 'uploads')
  const binDir = path.join(dir, 'bin')
  const composeFile = path.join(dir, 'docker-compose.app.yml')
  const envFile = path.join(dir, 'app.env')
  const oldFile = path.join(uploadDir, 'old.csv')
  const freshFile = path.join(uploadDir, 'fresh.csv')
  const dockerStub = path.join(binDir, 'docker')

  try {
    mkdirSync(uploadDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(oldFile, 'old import payload\n', 'utf8')
    writeFileSync(freshFile, 'fresh import payload\n', 'utf8')
    writeFileSync(dockerStub, '#!/usr/bin/env bash\nexit 1\n', 'utf8')
    chmodSync(dockerStub, 0o755)

    const oldDate = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000)
    utimesSync(oldFile, oldDate, oldDate)

    writeFileSync(
      composeFile,
      [
        'services:',
        '  backend:',
        '    volumes:',
        `      - ${uploadDir}:/app/uploads/attendance-import`,
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(envFile, 'ATTENDANCE_IMPORT_UPLOAD_DIR=/app/uploads/attendance-import\n', 'utf8')
    chmodSync(cleanupScript, 0o755)

    const result = await runBash(cleanupScript, {
      COMPOSE_FILE: composeFile,
      ENV_FILE: envFile,
      MAX_FILE_AGE_DAYS: '14',
      DELETE: 'true',
      CONFIRM_DELETE: 'true',
      MAX_DELETE_FILES: '10',
      MAX_DELETE_GB: '1',
      PATH: `${binDir}:${process.env.PATH || ''}`,
    })

    assert.equal(result.status, 0, `stderr:\n${result.stderr}`)
    assert.match(result.stderr, /stale_count=1/)
    assert.match(result.stderr, /stale_kb_total=/)
    assert.match(result.stderr, /Delete completed/)
    assert.equal(existsSync(oldFile), false)
    assert.equal(existsSync(freshFile), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
