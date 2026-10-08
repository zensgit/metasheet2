/**
 * Contract tests for tests/utils/pinned-server.ts (#4154 slice).
 *
 * Proves the three load-bearing properties the migration relies on:
 *   1. one listener per suite — the base URL (port) is stable across tests;
 *   2. per-test app semantics survive — setApp swaps which app serves without re-listening;
 *   3. missing setApp fails loudly (500), it does not hang.
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()

function appReplying(marker: string) {
  const app = express()
  app.get('/marker', (_req, res) => {
    res.json({ marker })
  })
  return app
}

let urlSeenByFirstTest = ''

describe('usePinnedServer', () => {
  it('serves the currently installed app', async () => {
    pinned.setApp(appReplying('alpha'))
    urlSeenByFirstTest = pinned.url()
    const res = await request(pinned.url()).get('/marker').expect(200)
    expect(res.body.marker).toBe('alpha')
  })

  it('swapping apps re-routes without re-listening (same base URL across tests)', async () => {
    expect(pinned.url()).toBe(urlSeenByFirstTest)
    pinned.setApp(appReplying('beta'))
    const res = await request(pinned.url()).get('/marker').expect(200)
    expect(res.body.marker).toBe('beta')

    // Swap again within the same test — still the same listener.
    pinned.setApp(appReplying('gamma'))
    const res2 = await request(pinned.url()).get('/marker').expect(200)
    expect(res2.body.marker).toBe('gamma')
    expect(pinned.url()).toBe(urlSeenByFirstTest)
  })

  it('responds 500 (not a hang) when no app is installed', async () => {
    pinned.setApp(null as never)
    const res = await request(pinned.url()).get('/marker')
    expect(res.status).toBe(500)
    expect(res.text).toContain('no app installed')
  })
})
