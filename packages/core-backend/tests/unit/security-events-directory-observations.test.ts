import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventConnections, W1Capacity, type EventClient, type EventSql } from '../../src/security-events/runtime'
import { SecurityEventRepository, type DirectoryRunObservation } from '../../src/security-events/repository'

const state = vi.hoisted(() => ({
  connect: undefined as undefined | (() => Promise<void>),
  secret: 'postgres://127.0.0.1:1/none',
  trace: [] as { text: string; values?: unknown[] }[],
  configs: [] as Record<string, unknown>[],
  resolve: undefined as undefined | ((text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>),
}))
vi.mock('../../src/security/SecretManager', () => ({ secretManager: { get: () => state.secret } }))
vi.mock('pg', () => ({ Client: class {
  constructor(config: Record<string, unknown>) { state.configs.push(config) }
  async connect() { await state.connect?.() }
  async end() {}
  on() {}
  async query(text: string, values?: unknown[]) {
    state.trace.push({ text, values })
    return state.resolve ? state.resolve(text, values) : { rows: [] }
  }
} }))

const integrationId = randomUUID(), runId = randomUUID()
const tick = () => new Promise(resolve => setImmediate(resolve))
async function settle() { for (let i = 0; i < 12; i++) await tick() }
function resolver(org = 'org-A') {
  return async (text: string, values?: unknown[]) => ({ rows: text.includes('FROM public.directory_integrations')
    ? [{ id: values![0], org_id: org, run_id: values![1] }]
    : text.startsWith('INSERT INTO public.security_events') ? [{ id: randomUUID() }] : [] })
}
const inserts = () => state.trace.filter(item => item.text.startsWith('INSERT INTO public.security_events'))
function inserted(index = 0) {
  const { text, values } = inserts()[index]
  return Object.fromEntries(text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(', ').map((key, i) => [key, values![i]]))
}
async function facade() { return import('../../src/security-events/directory-observations') }

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubEnv('DATABASE_URL', 'postgres://127.0.0.1:1/none')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  state.trace = []; state.configs = []; state.resolve = resolver(); state.connect = undefined; state.secret = 'postgres://127.0.0.1:1/none'
})
afterEach(() => {
  expect(expect.getState().assertionCalls).toBeGreaterThan(0)
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
})

describe('directory observation entry points', () => {
  it.each(['0', 'not-a-number'])('uses the pool driver fallback maximum for %s', async max => {
    vi.stubEnv('DB_POOL_MAX', max)
    const api = await facade()
    api.recordDirectorySchedulerObservation({ kind: 'bootstrap', integrationId: null })
    await settle()
    expect(inserts()).toHaveLength(1)
    expect(console.warn).not.toHaveBeenCalled()
  })
  it('loads passively and exposes only two synchronous functions', async () => {
    const api = await facade()
    expect(Object.keys(api).sort()).toEqual(['recordDirectoryRunObservation', 'recordDirectorySchedulerObservation'])
    expect(state.configs).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(api.recordDirectorySchedulerObservation({ kind: 'reclaim', integrationId: null })).toBeUndefined()
    await settle()
    expect(inserted()).toMatchObject({ scope_kind: 'system', org_id: null, target_kind: null, source_step: 'reclaim' })
  })
  it.each(['schedule_invalid', 'refresh'] as const)('resolves %s from the persisted integration', async kind => {
    const api = await facade()
    expect(api.recordDirectorySchedulerObservation({ kind, integrationId })).toBeUndefined()
    await settle()
    expect(inserted()).toMatchObject({ org_id: 'org-A', target_id: integrationId, source_step: kind, facts: {} })
    expect(state.configs.every(config => config.application_name === 'e1_write')).toBe(true)
    const business = state.trace.filter(row => !/^(?:SELECT set_config|BEGIN|COMMIT)/.test(row.text))
    expect(business).toHaveLength(2)
    for (const row of business) {
      const index = state.trace.indexOf(row)
      expect(state.trace[index - 1].text).toContain("set_config('lock_timeout'")
      expect(state.trace[index - 1].text).toContain("set_config('statement_timeout'")
    }
    expect(state.trace.filter(row => row.text === 'BEGIN')).toHaveLength(1)
  })
  it.each(['binding_sweep_failed', 'post_commit_failed'] as const)('records %s only for the completed matching run', async kind => {
    const api = await facade()
    api.recordDirectoryRunObservation({ kind, integrationId, runId })
    await settle()
    const query = state.trace.find(row => row.text.includes('JOIN public.directory_sync_runs'))!
    expect(query.text).toContain("r.status='completed'")
    expect(query.text).toContain('r.finished_at IS NOT NULL')
    expect(query.values).toEqual([integrationId, runId])
    expect(inserted()).toMatchObject({ source_id: runId, target_id: runId, org_id: 'org-A', event_type: `directory.${kind}` })
  })
  it.each(['missing', 'mismatch', 'invalid_org'] as const)('does not record or retain an unresolved %s scope', async mode => {
    const api = await facade()
    state.resolve = async text => ({ rows: text.includes('FROM public.directory_integrations') && mode !== 'missing'
      ? [{ id: integrationId, org_id: mode === 'invalid_org' ? 'bad org' : 'org-B', run_id: randomUUID() }] : [] })
    api.recordDirectoryRunObservation({ kind: 'post_commit_failed', integrationId, runId })
    await settle(); await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(inserts()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(console.warn).toHaveBeenCalledWith('source_missing', { count_unknown: true })
  })
  it('rejects extra fields, invalid kinds, invalid IDs and caller scope without starting SQL', async () => {
    const api = await facade()
    const candidates = [null, {}, { kind: 'unknown_kind', integrationId, runId },
      { kind: 'post_commit_failed', integrationId, runId, orgId: 'org-B' },
      { kind: 'post_commit_failed', integrationId, runId: 'bad value' },
      { kind: 'post_commit_failed', integrationId, runId, error: new Error('fixture') }]
    for (const input of candidates) expect(() => api.recordDirectoryRunObservation(input as DirectoryRunObservation)).not.toThrow()
    api.recordDirectorySchedulerObservation({ kind: 'refresh', integrationId: null })
    api.recordDirectorySchedulerObservation({ kind: 'bootstrap', integrationId })
    api.recordDirectorySchedulerObservation({ kind: 'schedule_invalid', integrationId: null })
    expect(state.trace).toHaveLength(0)
    expect(state.configs).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledWith('mapping_rejected', { count_unknown: true })
  })
  it('contains throwing input accessors and diagnostics', async () => {
    const api = await facade()
    vi.mocked(console.warn).mockImplementation(() => { throw new Error('fixture') })
    const input = { get kind(): never { throw new Error('fixture') }, integrationId, runId }
    expect(() => api.recordDirectoryRunObservation(input)).not.toThrow()
    expect(state.configs).toHaveLength(0)
  })
  it('normalizes UUID spelling before persisted source matching', async () => {
    const api = await facade()
    api.recordDirectorySchedulerObservation({ kind: 'refresh', integrationId: integrationId.toUpperCase() }); await settle()
    api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', integrationId: integrationId.toUpperCase(), runId: runId.toUpperCase() }); await settle()
    expect(inserted(0).target_id).toBe(integrationId)
    expect(inserted(1).source_id).toBe(runId)
  })
  it('copies caller input before asynchronous resolution', async () => {
    const api = await facade()
    const input = { kind: 'post_commit_failed' as const, integrationId, runId }
    api.recordDirectoryRunObservation(input)
    input.integrationId = randomUUID(); input.runId = randomUUID()
    await settle()
    expect(inserted()).toMatchObject({ source_id: runId, org_id: 'org-A' })
  })
  it('uses one boot key for schedule observations and a fresh key for each refresh', async () => {
    const api = await facade()
    for (const kind of ['schedule_invalid', 'schedule_invalid', 'refresh', 'refresh'] as const) {
      api.recordDirectorySchedulerObservation({ kind, integrationId }); await settle()
    }
    expect(inserted(0).source_id).toEqual(inserted(1).source_id)
    expect(inserted(2).source_id).not.toEqual(inserted(3).source_id)
    expect(inserted(0).source_id).toContain(integrationId)
  })
  it.each(['42P01', '23514', '57014', 'commit_unknown'])('isolates %s and retries once with the original scope and key', async code => {
    const api = await facade()
    const original = resolver()
    state.resolve = async (text, values) => {
      if (text.startsWith('INSERT INTO') || (code === 'commit_unknown' && text === 'COMMIT')) {
        if (code !== 'commit_unknown' || text === 'COMMIT') throw Object.assign(new Error('fixture'), { code })
      }
      return original(text, values)
    }
    expect(api.recordDirectoryRunObservation({ kind: 'post_commit_failed', integrationId, runId })).toBeUndefined()
    await settle()
    const first = inserted()
    state.resolve = resolver('org-B')
    await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(inserts()).toHaveLength(2)
    expect(inserted(1)).toMatchObject({ id: first.id, source_id: first.source_id, org_id: 'org-A', occurred_at: first.occurred_at })
    expect(state.trace.filter(row => row.text.includes('FROM public.directory_integrations'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(inserts()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('drops a second failed write without scheduling another retry', async () => {
    const api = await facade(), original = resolver()
    state.resolve = async (text, values) => {
      if (text.startsWith('INSERT INTO')) throw new Error('fixture')
      return original(text, values)
    }
    api.recordDirectoryRunObservation({ kind: 'post_commit_failed', integrationId, runId }); await settle()
    await vi.advanceTimersByTimeAsync(30000); await settle()
    await vi.advanceTimersByTimeAsync(5000); await settle()
    expect(inserts()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retries later snapshots at the current batch deadline', async () => {
    const api = await facade(), original = resolver()
    state.resolve = async (text, values) => {
      if (text.startsWith('INSERT INTO')) throw new Error('fixture')
      return original(text, values)
    }
    api.recordDirectorySchedulerObservation({ kind: 'reclaim', integrationId: null }); await settle()
    await vi.advanceTimersByTimeAsync(29900)
    api.recordDirectorySchedulerObservation({ kind: 'bootstrap', integrationId: null }); await settle()
    expect(inserts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100); await settle()
    expect(inserts()).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('includes snapshots retained during the active drain', async () => {
    const api = await facade(), original = resolver()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    state.resolve = async (text, values) => {
      if (text.startsWith('INSERT INTO')) {
        if (inserts().length === 2) await hold
        throw new Error('fixture')
      }
      return original(text, values)
    }
    try {
      api.recordDirectorySchedulerObservation({ kind: 'reclaim', integrationId: null }); await settle()
      await vi.advanceTimersByTimeAsync(30000); await settle()
      api.recordDirectorySchedulerObservation({ kind: 'bootstrap', integrationId: null }); await settle()
      expect(inserts()).toHaveLength(3)
    } finally { release() }
    await settle()
    expect(inserts()).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('delays a startup burst and records every admitted integration without exceeding the write budget', async () => {
    const api = await facade()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const original = resolver()
    state.resolve = async (text, values) => { if (text === 'BEGIN') await hold; return original(text, values) }
    const ids = Array.from({ length: 24 }, () => randomUUID())
    for (const id of ids) expect(api.recordDirectorySchedulerObservation({ kind: 'schedule_invalid', integrationId: id })).toBeUndefined()
    await settle()
    expect(state.configs).toHaveLength(1)
    expect(inserts()).toHaveLength(0)
    release(); await settle()
    expect(inserts()).toHaveLength(ids.length)
    expect(inserts().map((_, index) => inserted(index).target_id)).toEqual(ids)
    expect(state.configs.every(config => config.application_name === 'e1_write')).toBe(true)
    expect(console.warn).not.toHaveBeenCalled()
  })
  it('bounds pending observations and expires them from their invocation time', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const api = await facade(), original = resolver()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    state.resolve = async (text, values) => { if (text === 'BEGIN') await hold; return original(text, values) }
    for (let i = 0; i < 1001; i++) api.recordDirectorySchedulerObservation({ kind: 'schedule_invalid', integrationId: randomUUID() })
    await settle()
    expect(state.configs).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('event_store_unavailable', { count_unknown: true })
    now = 60000
    release(); await settle()
    expect(inserts()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    state.resolve = original
    api.recordDirectorySchedulerObservation({ kind: 'refresh', integrationId }); await settle()
    expect(inserts()).toHaveLength(1)
  })
  it.each(['schedule_invalid', 'refresh', 'binding_sweep_failed', 'post_commit_failed', 'diagnostic_failed'] as const)(
    'does not retry %s when connect consumes the foreground budget before scope lookup', async kind => {
      const api = await facade()
      const { eventRetries } = await import('../../src/security-events/process-store')
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const connect = vi.fn(async () => { now += 100 })
      state.connect = connect
      if (kind === 'schedule_invalid' || kind === 'refresh') api.recordDirectorySchedulerObservation({ kind, integrationId })
      else api.recordDirectoryRunObservation({ kind, integrationId, runId })
      await settle()
      expect(connect).toHaveBeenCalledTimes(1)
      expect(state.trace).toEqual([])
      expect(eventRetries.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(vi.mocked(console.warn).mock.calls).toEqual([['event_store_unavailable', { count_unknown: true }]])
      state.connect = undefined
      now += 30000
      await vi.advanceTimersByTimeAsync(30000)
      await settle()
      expect(state.configs).toHaveLength(1)
      expect(state.trace).toEqual([])
      expect(eventRetries.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(vi.mocked(console.warn).mock.calls).toEqual([['event_store_unavailable', { count_unknown: true }]])
    },
  )
  it.each(['reclaim', 'bootstrap'] as const)('retains %s without reading a source when connection establishment fails', async kind => {
    const api = await facade()
    state.connect = async () => { throw new Error('fixture') }
    expect(api.recordDirectorySchedulerObservation({ kind, integrationId: null })).toBeUndefined()
    await settle()
    expect(state.trace).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(state.configs).toHaveLength(1)
    state.connect = undefined
    await vi.advanceTimersByTimeAsync(20000); await settle()
    expect(inserts()).toHaveLength(1)
    expect(inserted()).toMatchObject({ scope_kind: 'system', org_id: null, source_step: kind })
    expect(state.trace.some(row => row.text.includes('FROM public.directory_integrations'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['reclaim', 'bootstrap'] as const)('retains %s before write capacity admission', async kind => {
    const connections = new EventConnections({ connectionString: 'postgres://127.0.0.1:1/none' })
    const repository = new SecurityEventRepository(connections, new W1Capacity(20))
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const busy = [1, 2, 3].map(() => connections.writeTransaction('background', () => hold))
    try {
      const result = await repository.appendDirectoryObservation({ kind, integrationId: null })
      expect(result).toMatchObject({ recorded: false, diagnostic: 'event_store_unavailable', retry: { authority: { kind: 'integration', orgId: null }, input: { source_step: kind } } })
      expect(connections.active).toEqual({ write: 3, query: 0 })
      expect(state.configs).toHaveLength(3)
    } finally { release(); await Promise.all(busy) }
  })
  it('preserves observation time while the first source read is delayed', async () => {
    const api = await facade(), original = resolver()
    const time = new Date('2026-11-22T00:00:00Z')
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: time })
    state.resolve = async (text, values) => {
      if (text.includes('FROM public.directory_integrations')) vi.setSystemTime(new Date(time.getTime() + 50))
      return original(text, values)
    }
    api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', integrationId, runId }); await settle()
    expect(inserted().occurred_at).toBe(time.toISOString())
  })
  it('uses the shared provider URL and production TLS options with an isolated write identity', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('DB_SSL', 'true')
    vi.stubEnv('DB_SSL_CA', 'fixture-ca')
    vi.stubEnv('DB_SSL_CERT', 'fixture-cert')
    vi.stubEnv('DB_SSL_KEY', 'fixture-key')
    vi.stubEnv('DB_SSL_REJECT_UNAUTHORIZED', 'true')
    const api = await facade()
    api.recordDirectorySchedulerObservation({ kind: 'bootstrap', integrationId: null }); await settle()
    expect(state.configs[0]).toMatchObject({ connectionString: state.secret,
      ssl: { rejectUnauthorized: true, ca: 'fixture-ca', cert: 'fixture-cert', key: 'fixture-key' }, application_name: 'e1_write' })
    expect(inserts()).toHaveLength(1)
  })
  it.each(['schedule_invalid', 'refresh', 'diagnostic_failed', 'binding_sweep_failed', 'post_commit_failed'] as const)('reads %s sources without row or advisory locks', async kind => {
    const api = await facade()
    if (kind === 'schedule_invalid' || kind === 'refresh') api.recordDirectorySchedulerObservation({ kind, integrationId })
    else api.recordDirectoryRunObservation({ kind, integrationId, runId })
    await settle()
    expect(inserts()).toHaveLength(1)
    expect(state.trace.filter(row => row.text.includes('FROM public.directory_integrations'))).toHaveLength(1)
    expect(state.trace.map(row => row.text).join('\n')).not.toMatch(/FOR\s+(?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)|advisory/i)
  })
  it('reports a permanent identity conflict without retaining it', async () => {
    const api = await facade(), original = resolver()
    state.resolve = async (text, values) => text.startsWith('INSERT INTO') || text.includes('FROM public.security_events')
      ? { rows: [] } : original(text, values)
    api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId }); await settle()
    expect(console.warn).toHaveBeenCalledWith('event_identity_conflict', { count_unknown: true })
    expect(vi.getTimerCount()).toBe(0)
    expect(inserts()).toHaveLength(1)
  })
  it('reports an identity conflict on the only retry with its fixed diagnostic', async () => {
    const api = await facade(), original = resolver()
    state.resolve = async (text, values) => {
      if (text.startsWith('INSERT INTO')) throw new Error('fixture')
      return original(text, values)
    }
    api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId }); await settle()
    vi.mocked(console.warn).mockClear()
    state.resolve = async () => ({ rows: [] })
    await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('event_identity_conflict', { count_unknown: true })
    expect(inserts()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('runs no observation work until the caller confirms the outer commit', async () => {
    const api = await facade()
    let confirm!: () => void
    const commit = new Promise<void>(resolve => { confirm = resolve })
    const action = (async () => {
      await commit
      api.recordDirectoryRunObservation({ kind: 'post_commit_failed', integrationId, runId })
    })()
    await settle()
    expect(state.trace).toHaveLength(0)
    confirm(); await action; await settle()
    expect(inserts()).toHaveLength(1)
  })
  it('keeps rollback and unknown outcomes outside the recorder', async () => {
    const api = await facade()
    for (const code of ['rollback', 'unknown']) {
      const original = new Error(code)
      const action = async () => {
        await Promise.reject(original)
        api.recordDirectoryRunObservation({ kind: 'post_commit_failed', integrationId, runId })
      }
      await expect(action()).rejects.toBe(original)
    }
    expect(state.trace).toHaveLength(0)
  })
})

describe('diagnostic observations', () => {
  it('returns synchronously while resolving a running source through the write pool', async () => {
    const api = await facade(), original = resolver()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    state.resolve = async (text, values) => {
      if (text.includes('JOIN public.directory_sync_runs')) {
        await hold
        if (/status|finished_at|committed/i.test(text)) return { rows: [] }
      }
      return original(text, values)
    }
    expect(api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId })).toBeUndefined()
    await settle()
    expect(inserts()).toHaveLength(0)
    release(); await settle()
    expect(inserted()).toMatchObject({ event_type: 'directory.diagnostic_failed', source_kind: 'sync_run',
      source_id: runId, source_step: 'diagnostic', org_id: 'org-A', facts: {}, outcome: 'failed' })
    expect(inserted().facts).toEqual({})
    const source = state.trace.find(row => row.text.includes('JOIN public.directory_sync_runs'))!
    expect(source.values).toEqual([integrationId, runId])
    expect(source.text).not.toMatch(/status|finished_at|committed|FOR\s+(?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)|advisory/i)
    expect(state.configs.every(config => config.application_name === 'e1_write')).toBe(true)
    expect(state.trace.filter(row => row.text === 'COMMIT')).toHaveLength(1)
  })
  it.each(['completed', 'failed', 'aborted'])('preserves the first diagnostic event after the run becomes %s', async status => {
    const api = await facade()
    let currentStatus = 'running'
    const events = new Map<string, Record<string, unknown>>()
    const key = (row: Record<string, unknown>) => JSON.stringify(['producer', 'source_kind', 'source_id', 'source_step', 'event_type'].map(field => row[field]))
    state.resolve = async (text, values) => {
      if (text.includes('JOIN public.directory_sync_runs')) {
        return { rows: text.includes("r.status='completed'") && currentStatus !== 'completed' ? []
          : [{ id: integrationId, org_id: 'org-A', run_id: runId }] }
      }
      if (text.startsWith('INSERT INTO public.security_events')) {
        const candidate = inserted(inserts().length - 1), identity = key(candidate)
        if (events.has(identity)) return { rows: [] }
        events.set(identity, { ...candidate, recorded_at: '2026-11-22T00:00:00Z', expires_at: '2027-11-22T00:00:00Z' })
        return { rows: [{ id: candidate.id }] }
      }
      if (text.includes('FROM public.security_events')) return { rows: [events.get(JSON.stringify(values))!] }
      return { rows: [] }
    }
    api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId }); await settle()
    expect(events.size).toBe(1)
    const first = structuredClone([...events.values()][0])
    currentStatus = status
    for (let i = 0; i < 2; i++) {
      api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId }); await settle()
    }
    expect([...events.values()]).toEqual([first])
    expect(first).toMatchObject({ event_type: 'directory.diagnostic_failed', source_step: 'diagnostic', facts: {} })
    expect(first.facts).toEqual({})
    expect(state.trace.some(row => /^(?:UPDATE|DELETE)/.test(row.text))).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['missing_integration', 'missing_run', 'mismatched_run', 'invalid_org'])('reports a gap for %s without guessing a scope', async mode => {
    const api = await facade()
    state.resolve = async text => ({ rows: text.includes('JOIN public.directory_sync_runs') && !mode.startsWith('missing_')
      ? [{ id: integrationId, org_id: mode === 'invalid_org' ? 'bad org' : 'org-A', run_id: mode === 'mismatched_run' ? randomUUID() : runId }] : [] })
    expect(api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId })).toBeUndefined()
    await settle(); await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(inserts()).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('source_missing', { count_unknown: true })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['42P01', '23514', '57014', 'commit_unknown'])('contains diagnostic write failure %s and retries the same empty fact once', async code => {
    const api = await facade(), original = resolver()
    state.resolve = async (text, values) => {
      if (code === 'commit_unknown' ? text === 'COMMIT' : text.startsWith('INSERT INTO')) throw Object.assign(new Error('fixture'), { code })
      return original(text, values)
    }
    expect(api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId })).toBeUndefined()
    await settle()
    const first = inserted()
    state.resolve = resolver('org-B')
    await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(inserts()).toHaveLength(2)
    expect(inserted(1)).toEqual(first)
    expect(first).toMatchObject({ event_type: 'directory.diagnostic_failed', source_step: 'diagnostic', org_id: 'org-A', facts: {} })
    expect(first.facts).toEqual({})
    expect(state.trace.filter(row => row.text.includes('JOIN public.directory_sync_runs'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000); await settle()
    expect(inserts()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([59999, 60000])('measures diagnostic retry expiry from invocation at elapsed %s milliseconds', async elapsed => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const api = await facade(), original = resolver()
    state.resolve = async (text, values) => {
      if (text.startsWith('INSERT INTO')) { now = 30; throw new Error('fixture') }
      return original(text, values)
    }
    api.recordDirectoryRunObservation({ kind: 'diagnostic_failed', runId, integrationId }); await settle()
    expect(inserts()).toHaveLength(1)
    state.resolve = original
    now = elapsed
    await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(inserts()).toHaveLength(elapsed < 60000 ? 2 : 1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects diagnostic result, error, sample and commit fields without reading them', async () => {
    const api = await facade()
    for (const field of ['status', 'directoryApplyCommitted', 'committed', 'error', 'sample', 'facts', 'orgId']) {
      const input = { kind: 'diagnostic_failed' as const, runId, integrationId,
        get [field](): never { throw new Error('fixture') } }
      expect(api.recordDirectoryRunObservation(input)).toBeUndefined()
    }
    await settle()
    expect(state.trace).toHaveLength(0)
    expect(state.configs).toHaveLength(0)
  })
  it('starts the diagnostic deadline before reading input fields', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const api = await facade(), original = resolver()
    state.resolve = async (text, values) => {
      if (text.startsWith('INSERT INTO')) throw new Error('fixture')
      return original(text, values)
    }
    api.recordDirectoryRunObservation({ get kind() { now = 30; return 'diagnostic_failed' as const }, runId, integrationId })
    await settle()
    expect(inserts()).toHaveLength(1)
    now = 60000
    state.resolve = original
    await vi.advanceTimersByTimeAsync(30000); await settle()
    expect(inserts()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('directory repository commit visibility', () => {
  it('does not retain running or uncommitted source rows', async () => {
    const trace: string[] = []
    const client: EventClient = {
      connect: async () => {}, end: async () => {}, on: () => {},
      query: (async (text: string) => { trace.push(text); return { rows: [] } }) as EventSql['query'],
    }
    const repository = new SecurityEventRepository(new EventConnections({ connectionString: 'postgres://127.0.0.1:1/none' }, () => client), new W1Capacity(20))
    expect(await repository.appendDirectoryObservation({ kind: 'post_commit_failed', integrationId, runId })).toEqual({ recorded: false, diagnostic: 'source_missing' })
    expect(trace.some(text => text.startsWith('INSERT'))).toBe(false)
  })
})
