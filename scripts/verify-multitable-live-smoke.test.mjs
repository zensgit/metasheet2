import assert from 'node:assert/strict'
import test from 'node:test'

import { renderSmokeMarkdown } from './verify-multitable-live-smoke.mjs'

test('renderSmokeMarkdown renders run mode, report paths, metadata, and failing checks', () => {
  const markdown = renderSmokeMarkdown({
    ok: false,
    runMode: 'staging',
    apiBase: 'http://127.0.0.1:7778',
    webBase: 'http://127.0.0.1:8899',
    headless: true,
    startedAt: '2026-03-26T12:00:00.000Z',
    finishedAt: '2026-03-26T12:05:00.000Z',
    reportPath: '/tmp/smoke/report.json',
    reportMdPath: '/tmp/smoke/report.md',
    error: 'boom',
    metadata: {
      baseId: 'base-1',
      sheetId: 'sheet-1',
    },
    checks: [
      { name: 'ui.embed-host.ready', ok: true },
      { name: 'ui.embed-host.navigate.blocked', ok: false },
    ],
  })

  assert.match(markdown, /# Multitable Live Smoke/)
  assert.match(markdown, /Run mode: `staging`/)
  assert.match(markdown, /JSON report: `\/tmp\/smoke\/report\.json`/)
  assert.match(markdown, /Markdown report: `\/tmp\/smoke\/report\.md`/)
  assert.match(markdown, /Failing checks: `ui\.embed-host\.navigate\.blocked`/)
  assert.match(markdown, /Error: `boom`/)
  assert.match(markdown, /baseId: `base-1`/)
  assert.match(markdown, /sheetId: `sheet-1`/)
})
