import { afterEach, describe, expect, it, vi } from 'vitest'

// DT-HARDEN-05 — the two lease knobs are module-load IIFEs, so each case reloads the
// real module with the env staged first. Invalid values must fall back to defaults
// (never NaN/zero intervals into setInterval or SQL), and the staleness threshold must
// clamp to >=5x the heartbeat interval so a mis-tuned pair cannot reclaim a live run.

const HEARTBEAT_ENV = 'DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS'
const STALE_ENV = 'DIRECTORY_SYNC_LEASE_STALE_MINUTES'

const originalHeartbeat = process.env[HEARTBEAT_ENV]
const originalStale = process.env[STALE_ENV]

async function loadKnobs(env: { heartbeat?: string; stale?: string }) {
  vi.resetModules()
  if (env.heartbeat === undefined) delete process.env[HEARTBEAT_ENV]
  else process.env[HEARTBEAT_ENV] = env.heartbeat
  if (env.stale === undefined) delete process.env[STALE_ENV]
  else process.env[STALE_ENV] = env.stale
  const mod = await import('../../src/directory/directory-sync')
  return {
    heartbeatMs: mod.DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS,
    staleMinutes: mod.DIRECTORY_SYNC_LEASE_STALE_MINUTES,
  }
}

afterEach(() => {
  if (originalHeartbeat === undefined) delete process.env[HEARTBEAT_ENV]
  else process.env[HEARTBEAT_ENV] = originalHeartbeat
  if (originalStale === undefined) delete process.env[STALE_ENV]
  else process.env[STALE_ENV] = originalStale
  vi.resetModules()
})

describe('DT-HARDEN-05 lease env knobs', () => {
  it('heartbeat interval falls back to 60s for unset/NaN/zero/negative/sub-5s values', async () => {
    for (const heartbeat of [undefined, 'abc', '0', '-5000', '4999']) {
      const { heartbeatMs } = await loadKnobs({ heartbeat })
      expect(heartbeatMs, `heartbeat=${String(heartbeat)}`).toBe(60_000)
    }
  })

  it('heartbeat interval honors a valid override and truncates fractions', async () => {
    expect((await loadKnobs({ heartbeat: '5000' })).heartbeatMs).toBe(5_000)
    expect((await loadKnobs({ heartbeat: '90000.7' })).heartbeatMs).toBe(90_000)
  })

  it('staleness falls back to 10min for unset/NaN/zero/negative values', async () => {
    for (const stale of [undefined, 'abc', '0', '-3']) {
      const { staleMinutes } = await loadKnobs({ stale })
      expect(staleMinutes, `stale=${String(stale)}`).toBe(10)
    }
  })

  it('staleness clamps to >=5x the heartbeat interval, including across both knobs', async () => {
    // Default 60s beat → 5min floor beats a 2min request.
    expect((await loadKnobs({ stale: '2' })).staleMinutes).toBe(5)
    // 2min beat → 10min floor beats a 5min request.
    expect((await loadKnobs({ heartbeat: '120000', stale: '5' })).staleMinutes).toBe(10)
    // A request above the floor is honored as-is.
    expect((await loadKnobs({ stale: '30' })).staleMinutes).toBe(30)
  })
})
