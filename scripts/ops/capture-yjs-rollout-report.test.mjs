import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const captureScript = path.join(__dirname, 'capture-yjs-rollout-report.mjs')

function createFixtureDir() {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'yjs-rollout-report-'))
  mkdirSync(path.join(fixtureDir, 'scripts/ops'), { recursive: true })
  return fixtureDir
}

function writeScript(fixtureDir, name, payload, exitCode = 0) {
  const scriptPath = path.join(fixtureDir, 'scripts/ops', name)
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
console.log(JSON.stringify(${JSON.stringify(payload, null, 2)}))
process.exit(${exitCode})
`,
    'utf8',
  )
}

function runCapture(fixtureDir) {
  return spawnSync(
    process.execPath,
    [captureScript, '--token', 'test-token', '--database-url', 'postgres://example/test', '--output-dir', 'artifacts-out'],
    {
      cwd: fixtureDir,
      encoding: 'utf8',
    },
  )
}

test('capture-yjs-rollout-report writes report files when runtime and retention payloads are complete', () => {
  const fixtureDir = createFixtureDir()

  try {
    writeScript(fixtureDir, 'check-yjs-rollout-status.mjs', {
      baseUrl: 'http://127.0.0.1:8900',
      metrics: {
        enabled: true,
        initialized: true,
        activeDocCount: 0,
        pendingWriteCount: 0,
        flushSuccessCount: 0,
        flushFailureCount: 0,
        activeSocketCount: 0,
        activeRecordCount: 0,
      },
      failures: [],
      payload: { success: true, yjs: {} },
    })
    writeScript(fixtureDir, 'check-yjs-retention-health.mjs', {
      databaseUrlPresent: true,
      thresholds: {
        maxUpdates: 100000,
        maxOrphanStates: 0,
        maxOrphanUpdates: 0,
        topLimit: 10,
      },
      failures: [],
      stats: {
        statesCount: 0,
        updatesCount: 0,
        orphanStatesCount: 0,
        orphanUpdatesCount: 0,
      },
      hottestRecords: [],
    })

    const result = runCapture(fixtureDir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Wrote .*yjs-rollout-report-.*\.json/)

    const outputDir = path.join(fixtureDir, 'artifacts-out')
    const files = readdirSync(outputDir)
    const jsonFile = files.find((file) => file.endsWith('.json'))
    const mdFile = files.find((file) => file.endsWith('.md'))
    assert.ok(jsonFile)
    assert.ok(mdFile)

    const report = JSON.parse(readFileSync(path.join(outputDir, jsonFile), 'utf8'))
    assert.equal(report.runtime.payload.metrics.enabled, true)
    assert.equal(report.retention.payload.stats.statesCount, 0)
    assert.equal(report.retention.payload.stats.orphanUpdatesCount, 0)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})

test('capture-yjs-rollout-report fails closed when retention stats are missing', () => {
  const fixtureDir = createFixtureDir()

  try {
    writeScript(fixtureDir, 'check-yjs-rollout-status.mjs', {
      baseUrl: 'http://127.0.0.1:8900',
      metrics: {
        enabled: true,
        initialized: true,
        activeDocCount: 0,
        pendingWriteCount: 0,
        flushSuccessCount: 0,
        flushFailureCount: 0,
        activeSocketCount: 0,
        activeRecordCount: 0,
      },
      failures: [],
      payload: { success: true, yjs: {} },
    })
    writeScript(fixtureDir, 'check-yjs-retention-health.mjs', {
      databaseUrlPresent: true,
      thresholds: {
        maxUpdates: 100000,
        maxOrphanStates: 0,
        maxOrphanUpdates: 0,
        topLimit: 10,
      },
      failures: [],
      stats: {},
      hottestRecords: [],
    })

    const result = runCapture(fixtureDir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Incomplete retention payload/)

    const outputDir = path.join(fixtureDir, 'artifacts-out')
    assert.equal(existsSync(outputDir), false)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})
