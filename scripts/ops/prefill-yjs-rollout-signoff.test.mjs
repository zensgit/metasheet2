import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(__dirname, 'prefill-yjs-rollout-signoff.mjs')

function createFixtureDir() {
  return mkdtempSync(path.join(tmpdir(), 'yjs-signoff-prefill-'))
}

test('prefill-yjs-rollout-signoff writes a partially completed signoff draft', () => {
  const fixtureDir = createFixtureDir()

  try {
    const statusPath = path.join(fixtureDir, 'status.json')
    const retentionPath = path.join(fixtureDir, 'retention.json')
    const reportPath = path.join(fixtureDir, 'reports/report.json')
    const packetDir = path.join(fixtureDir, 'packet')
    const outputPath = path.join(fixtureDir, 'signoff.md')

    mkdirSync(path.dirname(reportPath), { recursive: true })
    mkdirSync(packetDir, { recursive: true })

    writeFileSync(
      statusPath,
      JSON.stringify({
        metrics: {
          enabled: true,
          initialized: true,
          activeDocCount: 3,
          pendingWriteCount: 1,
          flushFailureCount: 0,
          activeSocketCount: 4,
        },
      }),
      'utf8',
    )
    writeFileSync(
      retentionPath,
      JSON.stringify({
        stats: {
          statesCount: 8,
          updatesCount: 16,
          orphanStatesCount: 0,
          orphanUpdatesCount: 0,
        },
        hottestRecords: [{ docId: 'sheet-a:record-7', updateCount: 9 }],
      }),
      'utf8',
    )
    writeFileSync(reportPath, JSON.stringify({ ok: true }), 'utf8')

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--status-json',
        statusPath,
        '--retention-json',
        retentionPath,
        '--report-json',
        reportPath,
        '--packet-dir',
        packetDir,
        '--output-path',
        outputPath,
        '--environment',
        'internal',
        '--owner',
        'ops-user',
        '--approver',
        'review-user',
        '--window',
        '2026-04-19T10:00:00Z/2026-04-19T11:00:00Z',
        '--pilot-sheets',
        'sheet-a,sheet-b',
        '--pilot-users',
        'alice,bob',
        '--expected-users',
        '2',
        '--excluded-sheets',
        'exec-board',
      ],
      {
        cwd: fixtureDir,
        encoding: 'utf8',
      },
    )

    assert.equal(result.status, 0, result.stderr)
    const output = readFileSync(outputPath, 'utf8')
    assert.match(output, /Environment: internal/)
    assert.match(output, /Rollout owner: ops-user/)
    assert.match(output, /Review approver: review-user/)
    assert.match(output, /Pilot sheets: sheet-a,sheet-b/)
    assert.match(output, /`activeDocCount`: 3/)
    assert.match(output, /`statesCount`: 8/)
    assert.match(output, /Hottest record observed: sheet-a:record-7 \(9 updates\)/)
    assert.match(output, /Runtime status report path: status\.json/)
    assert.match(output, /Combined rollout report path: reports\/report\.json/)
    assert.match(output, /Packet export path: packet/)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})
