import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSignalChannels } from './attendance-daily-gate-signal-channels.mjs'

test('buildSignalChannels tracks latest scheduled and manual completions separately', () => {
  const channels = buildSignalChannels({
    list: [
      {
        id: 301,
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch',
        updated_at: '2026-03-28T01:16:39Z',
        html_url: 'https://example.test/runs/301',
      },
      {
        id: 300,
        status: 'completed',
        conclusion: 'failure',
        event: 'schedule',
        updated_at: '2026-03-28T00:16:39Z',
        html_url: 'https://example.test/runs/300',
      },
    ],
    excludeConclusions: ['cancelled', 'neutral', 'skipped'],
  })

  assert.deepEqual(channels.latestScheduledCompleted, {
    id: 300,
    status: 'completed',
    conclusion: 'failure',
    event: 'schedule',
    createdAt: null,
    updatedAt: '2026-03-28T00:16:39Z',
    url: 'https://example.test/runs/300',
  })
  assert.deepEqual(channels.latestManualCompleted, {
    id: 301,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    createdAt: null,
    updatedAt: '2026-03-28T01:16:39Z',
    url: 'https://example.test/runs/301',
  })
  assert.equal(channels.manualRecovery, true)
})

test('buildSignalChannels ignores excluded scheduled conclusions and does not mark stale manual replay as recovery', () => {
  const channels = buildSignalChannels({
    list: [
      {
        id: 402,
        status: 'completed',
        conclusion: 'success',
        event: 'schedule',
        updated_at: '2026-03-28T03:16:39Z',
        html_url: 'https://example.test/runs/402',
      },
      {
        id: 401,
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch',
        updated_at: '2026-03-28T01:16:39Z',
        html_url: 'https://example.test/runs/401',
      },
      {
        id: 400,
        status: 'completed',
        conclusion: 'skipped',
        event: 'schedule',
        updated_at: '2026-03-28T02:16:39Z',
        html_url: 'https://example.test/runs/400',
      },
    ],
    excludeConclusions: ['cancelled', 'neutral', 'skipped'],
  })

  assert.equal(channels.latestScheduledCompleted?.id, 402)
  assert.equal(channels.latestManualCompleted?.id, 401)
  assert.equal(channels.manualRecovery, false)
})
