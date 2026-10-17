/**
 * Real PostgreSQL durability for a personal line intent.
 * Not collected by the default unit run (the name is not *.test.ts).
 * Runs through vitest.plm-personal-bom-write-lock.config.ts with an explicit
 * owned local socket or the opt-in disposable PostgreSQL CI service.
 * A skip is not this proof. The fake-pool SQL order test is not this proof.
 *
 * Phase 1 commits the intent before the provider call. A concurrent source,
 * user, or membership mutation must appear in pg_blocking_pids while that
 * transaction holds its row lock, and the following phase sends nothing.
 * Losing the outcome COMMIT leaves the same frozen row for a new instance.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { up as upBindings } from '../../src/db/migrations/zzzz20261017010000_create_plm_personal_bom_write_bindings'
import { down as downIntents, up as upIntents } from '../../src/db/migrations/zzzz20261017020000_create_plm_personal_bom_write_intents'
import { PlmPersonalBomWriteBindingService } from '../../src/services/PlmPersonalBomWriteBindingService'

function explicitDisposableUrl(): string | null {
  const raw = process.env.PLM_PERSONAL_BOM_WRITE_TEST_PG_URL || process.env.MAIN_OWNED_META_PG_URL
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!['postgresql:', 'postgres:'].includes(url.protocol)) return null
    const ownedSocket = url.searchParams.get('host')?.startsWith('/tmp/plm-bom-main-pg-') === true
    const ciService = process.env.EXPECT_PLM_PERSONAL_BOM_WRITE_DB === '1'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname === '/plm_personal_disposable'
    return ownedSocket || ciService ? raw : null
  } catch {
    return null
  }
}

const rawUrl = explicitDisposableUrl()
if (process.env.PLM_BOM_LOCK_PG_REQUIRED === 'true' && !rawUrl)
  throw new Error('Explicit disposable personal BOM PostgreSQL URL required')

const owner = 'meta-owner'
const actor = { userId: owner, metaTenantId: 'meta-a' }
const sourceId = 'source-1'
const connection = 'conn-1'
const token = (id: string) => `yuw_${id.repeat(32)}_${'c'.repeat(43)}`
const lineInput = {
  operationKind: 'line' as const,
  partId: 'part-1',
  bomLineId: 'line-1',
  clientKey: 'client-key-1',
  patch: { quantity: 1 },
}

function searchPathUrl(url: string, schema: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('options', `-csearch_path=${schema}`)
  return parsed.href
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface PatchCall {
  key: string | undefined
  ifMatch: string | undefined
  body: string | undefined
  url: string
  authorization: string | undefined
}

interface HttpState {
  origins: string[]
  methods: string[]
  patches: PatchCall[]
  ecos: PatchCall[]
  revokes: number
  patchStatus: number | null
  holdLine: boolean
  enteredLine: () => void
  lineHeld: Promise<void>
}

function installFetch(state: HttpState): void {
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const origin = new URL(String(url)).origin
    state.origins.push(origin)
    expect(origin).toBe('https://native.invalid')
    const method = init.method ?? 'GET'
    state.methods.push(method)
    if (method === 'POST' && String(url).includes('/plm-bom-write-grant/verify')) {
      const grantId = init.headers.Authorization.slice('Bearer yuw_'.length, 'Bearer yuw_'.length + 32)
      return new Response(JSON.stringify({
        schema: 'yuantus.plm-bom-write-binding.v1',
        grant_id: grantId,
        connection_id: connection,
        tenant_id: 'yt-b',
        org_id: 'org-1',
        auth_user_id: '42',
        expires_at: '2027-01-01T00:00:00.000000Z',
        purpose: 'bom_write',
      }), { status: 200 })
    }
    if (method === 'PATCH') {
      state.patches.push({
        key: init.headers['Idempotency-Key'],
        ifMatch: init.headers['If-Match'],
        body: init.body,
        url: String(url),
        authorization: init.headers.Authorization,
      })
      if (state.holdLine) {
        state.enteredLine()
        await state.lineHeld
      }
      if (state.patchStatus !== null && state.patchStatus !== 200)
        return new Response('{"detail":"denied"}', { status: state.patchStatus })
      const lined = /\/lines\/([^/?#]+)$/.exec(String(url))
      const bomLineId = lined ? decodeURIComponent(lined[1]) : 'line-1'
      return new Response(JSON.stringify({ ok: true, bom_line_id: bomLineId }), { status: 200 })
    }
    if (method === 'POST' && String(url).includes('/eco-intent')) {
      state.ecos.push({
        key: init.headers['Idempotency-Key'],
        ifMatch: init.headers['If-Match'],
        body: init.body,
        url: String(url),
        authorization: init.headers.Authorization,
      })
      return new Response(JSON.stringify({
        eco_id: 'eco-1',
        state: 'open',
        attached: false,
        source_version_id: null,
        target_version_id: null,
      }), { status: 200 })
    }
    if (method === 'DELETE' && String(url).includes('/plm-bom-write-grant/grant')) {
      state.revokes += 1
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected personal bom write ${method}`)
  })
}

function adapterFor(config: { connection: { url: string; headers: Record<string, string> } }) {
  return new PLMAdapter(
    { get: async () => undefined } as never,
    { info() {}, warn() {}, error() {}, debug() {} } as never,
    { ...config, connection: { ...config.connection, url: 'https://stale-native.invalid' } } as never,
  )
}

describe.skipIf(!rawUrl)('personal BOM write intent postgres durability', () => {
  const leftovers: Array<() => Promise<void>> = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    while (leftovers.length) {
      const close = leftovers.pop()
      if (close) await close()
    }
  })

  it('serializes one logical key and rejects a changed body', async () => {
    const opened = await openSchema()
    const http = httpState()
    installFetch(http)
    const adapter = adapterFor(opened.config)
    const bound = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    await bound.bind(actor, { dataSourceId: sourceId, connectionId: connection, grant: token('a') })
    const other = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    const [first, second] = await Promise.all([
      bound.dispatchOperation(actor, sourceId, lineInput),
      other.dispatchOperation(actor, sourceId, lineInput),
    ])
    expect(first.intentId).toBe(second.intentId)
    expect(first.providerIdempotencyKey).toBe(second.providerIdempotencyKey)
    expect(first.outcome).toBe('accepted')
    expect(http.patches).toHaveLength(2)
    expect(http.patches.every((call) => call.key === first.providerIdempotencyKey)).toBe(true)
    expect(http.patches.every((call) => call.ifMatch === undefined)).toBe(true)
    expect(http.patches.every((call) => call.body === '{"quantity":1}')).toBe(true)
    expect(http.patches.every((call) => call.url.includes('/api/v1/bom/multitable/part-1/lines/line-1'))).toBe(true)
    expect(http.methods.filter((method) => method === 'POST')).toEqual(['POST'])
    let rows = await intentRows(opened.pool)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: first.intentId,
      outcome: 'accepted',
      request_body: '{"quantity":1}',
      if_match: null,
      operation_kind: 'line',
      part_id: 'part-1',
      bom_line_id: 'line-1',
      actor_meta_tenant_id: 'meta-a',
      source_meta_tenant_id: 'meta-a',
      workspace_id: 'workspace-1',
      scope_kind: 'private',
      target_origin: 'https://native.invalid',
      subject_id: '42',
      provider_idempotency_key: first.providerIdempotencyKey,
    })
    await expect(bound.dispatchOperation(actor, sourceId, {
      ...lineInput,
      patch: { quantity: 2 },
    })).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    expect(http.patches).toHaveLength(2)
    rows = await intentRows(opened.pool)
    expect(rows).toHaveLength(1)
    expect(rows[0].request_body).toBe('{"quantity":1}')
    expect(rows[0].provider_idempotency_key).toBe(first.providerIdempotencyKey)
    const third = await bound.dispatchOperation(actor, sourceId, { ...lineInput, clientKey: 'client-key-2' })
    expect(third.intentId).not.toBe(first.intentId)
    expect(third.providerIdempotencyKey).not.toBe(first.providerIdempotencyKey)
    rows = await intentRows(opened.pool)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.binding_id)).size).toBe(1)
    expect(new Set(rows.map((row) => row.client_key_sha256)).size).toBe(2)
    const docs = await opened.pool.query('SELECT to_jsonb(i) AS doc FROM plm_personal_bom_write_intents i')
    const blob = JSON.stringify(docs.rows)
    expect(blob).not.toContain('client-key-')
    expect(blob).not.toContain('yuw_')
    expect(http.origins.every((origin) => origin === 'https://native.invalid')).toBe(true)
    expect(http.origins).not.toContain('https://stale-native.invalid')
  }, 20000)

  it('stores long, empty, and ordinary yuw_ JSON text and a line id containing that text', async () => {
    const longRef = 'X'.repeat(200)
    const quantity = `${'0'.repeat(200)}1`
    const component = 'assembly_yuw_component'
    const lineId = 'line-assembly_yuw_component'
    const grant = token('a')
    const requestBody = `{"find_num":"${component}","quantity":"${quantity}","refdes":"${longRef}","uom":""}`
    const wireBody = `{"quantity":"${quantity}","uom":"","find_num":"${component}","refdes":"${longRef}"}`
    const opened = await openSchema()
    const http = httpState()
    installFetch(http)
    const adapter = adapterFor(opened.config)
    const bound = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    await bound.bind(actor, { dataSourceId: sourceId, connectionId: connection, grant })
    const sent = await bound.dispatchOperation(actor, sourceId, {
      operationKind: 'line',
      partId: 'part-1',
      bomLineId: lineId,
      clientKey: 'client-key-json-text',
      patch: {
        refdes: longRef,
        uom: '',
        find_num: component,
        quantity,
        token: 'yuw_should-not-leave',
        grant,
        nested: { password: 'secret-no' },
      },
    })
    expect(sent.bomLineId).toBe(lineId)
    expect(sent.native).toEqual({ ok: true, bom_line_id: lineId })
    expect(http.patches).toHaveLength(1)
    expect(http.patches[0].body).toBe(wireBody)
    expect(http.patches[0].url).toContain(`/lines/${lineId}`)
    const rows = await intentRows(opened.pool)
    expect(rows).toHaveLength(1)
    expect(rows[0].request_body).toBe(requestBody)
    expect(rows[0].bom_line_id).toBe(lineId)
    expect(rows[0].confirmed_response).toBe(`{"bom_line_id":"${lineId}","ok":true}`)
    expect(rows[0].outcome).toBe('accepted')
    const docs = await opened.pool.query('SELECT to_jsonb(i) AS doc FROM plm_personal_bom_write_intents i')
    const blob = JSON.stringify(docs.rows)
    expect(blob).toContain(component)
    expect(blob).toContain(lineId)
    expect(blob).toContain(longRef)
    expect(blob).toContain(quantity)
    expect(blob).not.toContain(grant)
    expect(blob).not.toContain('client-key-')
    expect(blob).not.toContain('yuw_should-not-leave')
    expect(blob).not.toContain('secret-no')
  }, 20000)

  it('source owner update waits on the phase-1 source lock and the replay sends nothing', async () => {
    await authorityRace('source')
  }, 20000)

  it('user deactivation waits on the phase-1 share lock and the replay sends nothing', async () => {
    await authorityRace('user')
  }, 20000)

  it('membership revocation waits on the phase-1 share lock and the replay sends nothing', async () => {
    await authorityRace('member')
  }, 20000)

  it('keeps the frozen intent when the outcome commit is lost and the next instance resends its key', async () => {
    const opened = await openSchema()
    let releaseLine = () => {}
    const lineHeld = new Promise<void>((resolve) => { releaseLine = resolve })
    let enteredLine = () => {}
    const lineStarted = new Promise<void>((resolve) => { enteredLine = resolve })
    const http = httpState()
    http.holdLine = true
    http.enteredLine = enteredLine
    http.lineHeld = lineHeld
    installFetch(http)
    const adapter = adapterFor(opened.config)
    await new PlmPersonalBomWriteBindingService(opened.pool, () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('a'),
    })
    const commits = { n: 0 }
    const dispatchPid = { pid: 0 }
    let observer: PoolClient | undefined
    let observerReleased = false
    let dispatchSettled = false
    const releaseObserver = () => {
      if (!observer || observerReleased) return
      observerReleased = true
      observer.release()
    }
    leftovers.push(async () => {
      releaseLine()
      const deadline = Date.now() + 3000
      while (!dispatchSettled && Date.now() < deadline) await delay(20)
      releaseObserver()
    })
    const service = new PlmPersonalBomWriteBindingService(commitLossPool(opened.pool, dispatchPid, commits), () => adapter)
    const dispatchWork = service.dispatchOperation(actor, sourceId, lineInput).finally(() => { dispatchSettled = true })
    await Promise.race([
      lineStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('line barrier not reached')), 5000)),
    ])
    expect(commits.n).toBe(1)
    expect(dispatchPid.pid).toBeGreaterThan(0)
    const visible = await intentRows(opened.pool)
    expect(visible).toHaveLength(1)
    expect(visible[0].outcome).toBe('frozen')
    expect(visible[0].confirmed_response).toBeNull()
    expect(visible[0].provider_idempotency_key).toBe(http.patches[0].key)
    observer = await opened.pool.connect()
    let waiterDone = false
    const waiter = observer.query('SELECT id FROM plm_personal_bom_write_intents FOR UPDATE').finally(() => {
      waiterDone = true
    })
    expect(await blocked(opened.pool, () => observer!.processID, dispatchPid.pid)).toBe(true)
    expect(waiterDone).toBe(false)
    releaseLine()
    await expect(dispatchWork).rejects.toThrow('outcome commit lost')
    await waiter
    releaseObserver()
    const stuck = await intentRows(opened.pool)
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatchObject({
      id: visible[0].id,
      outcome: 'frozen',
      confirmed_response: null,
      saw_unknown: false,
      provider_idempotency_key: visible[0].provider_idempotency_key,
    })
    expect(http.patches).toHaveLength(1)
    const restarted = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    const sent = await restarted.dispatchOperation(actor, sourceId, lineInput)
    expect(sent.intentId).toBe(stuck[0].id)
    expect(sent.providerIdempotencyKey).toBe(stuck[0].provider_idempotency_key)
    expect(http.patches).toHaveLength(2)
    expect(http.patches[1].key).toBe(http.patches[0].key)
    const done = await intentRows(opened.pool)
    expect(done).toHaveLength(1)
    expect(done[0].outcome).toBe('accepted')
    expect(done[0].id).toBe(sent.intentId)
    const docs = await opened.pool.query('SELECT to_jsonb(i) AS doc FROM plm_personal_bom_write_intents i')
    expect(JSON.stringify(docs.rows)).not.toContain('yuw_')
    expect(JSON.stringify(docs.rows)).not.toContain('client-key-')
    expect(http.origins).not.toContain('https://stale-native.invalid')
  }, 20000)

  it('source transfer waits on the phase-2 provider lock and the next dispatch sends nothing', async () => {
    await phase2Denial('source')
  }, 20000)

  it('user deactivation waits on the phase-2 provider lock and the next dispatch sends nothing', async () => {
    await phase2Denial('user')
  }, 20000)

  it('membership revocation waits on the phase-2 provider lock and the next dispatch sends nothing', async () => {
    await phase2Denial('member')
  }, 20000)

  it('unbind waits on the phase-2 provider lock and the next dispatch sends nothing', async () => {
    await phase2Denial('unbind')
  }, 20000)

  it('same-person grant rotation waits on the phase-2 provider lock and the retry keeps the stored key', async () => {
    const opened = await openSchema()
    const http = httpState()
    const held = holdProvider(http)
    installFetch(http)
    const adapter = adapterFor(opened.config)
    await new PlmPersonalBomWriteBindingService(opened.pool, () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('a'),
    })
    const dispatchPid = { pid: 0 }
    const rotatePid = { pid: 0 }
    let dispatchWork: Promise<unknown> = Promise.resolve()
    let rotation: Promise<unknown> = Promise.resolve()
    leftovers.push(async () => {
      held.release()
      await dispatchWork.catch(() => undefined)
      await rotation.catch(() => undefined)
    })
    const service = new PlmPersonalBomWriteBindingService(queryPidPool(opened.pool, dispatchPid), () => adapter)
    dispatchWork = service.dispatchOperation(actor, sourceId, lineInput)
    await Promise.race([
      held.started,
      new Promise((_, reject) => setTimeout(() => reject(new Error('phase-2 provider barrier not reached')), 5000)),
    ])
    expect(http.patches).toHaveLength(1)
    expect(dispatchPid.pid).toBeGreaterThan(0)
    let rotated = false
    rotation = new PlmPersonalBomWriteBindingService(connectPidPool(opened.pool, rotatePid), () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('b'),
    }).finally(() => { rotated = true })
    expect(await blocked(opened.pool, () => rotatePid.pid, dispatchPid.pid)).toBe(true)
    expect(rotated).toBe(false)
    expect(http.patches).toHaveLength(1)
    held.release()
    const first = await dispatchWork
    await rotation
    expect(http.patches).toHaveLength(1)
    expect(http.revokes).toBe(1)
    const retried = await service.dispatchOperation(actor, sourceId, lineInput)
    expect(retried.intentId).toBe((first as { intentId: string }).intentId)
    expect(retried.providerIdempotencyKey).toBe((first as { providerIdempotencyKey: string }).providerIdempotencyKey)
    expect(http.patches).toHaveLength(2)
    expect(http.patches[1].key).toBe(http.patches[0].key)
    expect(http.patches[0].authorization).toBe(`Bearer ${token('a')}`)
    expect(http.patches[1].authorization).toBe(`Bearer ${token('b')}`)
    const rows = await intentRows(opened.pool)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider_idempotency_key).toBe(http.patches[0].key)
    expect(rows[0].subject_id).toBe('42')
    expect(rows[0].outcome).toBe('accepted')
  }, 20000)

  it('keeps the phase-1 row when the commit acknowledgement is lost and the restart sends the stored key', async () => {
    const opened = await openSchema()
    const http = httpState()
    installFetch(http)
    const adapter = adapterFor(opened.config)
    await new PlmPersonalBomWriteBindingService(opened.pool, () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('a'),
    })
    const loss = new PlmPersonalBomWriteBindingService(commitAckLossPool(opened.pool, 1), () => adapter)
    await expect(loss.dispatchOperation(actor, sourceId, lineInput)).rejects.toThrow('commit ack lost')
    expect(http.patches).toEqual([])
    const frozen = await intentRows(opened.pool)
    expect(frozen).toHaveLength(1)
    expect(frozen[0]).toMatchObject({ outcome: 'frozen', confirmed_response: null, saw_unknown: false })
    const restarted = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    const sent = await restarted.dispatchOperation(actor, sourceId, lineInput)
    expect(sent.intentId).toBe(frozen[0].id)
    expect(sent.providerIdempotencyKey).toBe(frozen[0].provider_idempotency_key)
    expect(http.patches).toHaveLength(1)
    expect(http.patches[0].key).toBe(frozen[0].provider_idempotency_key)
    expect(http.patches[0].authorization).toBe(`Bearer ${token('a')}`)
    const done = await intentRows(opened.pool)
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({
      id: sent.intentId,
      outcome: 'accepted',
      confirmed_response: '{"bom_line_id":"line-1","ok":true}',
      provider_idempotency_key: frozen[0].provider_idempotency_key,
    })
  }, 20000)

  it('keeps the accepted confirmation when the phase-2 commit acknowledgement is lost and the restart replays', async () => {
    const opened = await openSchema()
    const http = httpState()
    installFetch(http)
    const adapter = adapterFor(opened.config)
    await new PlmPersonalBomWriteBindingService(opened.pool, () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('a'),
    })
    const loss = new PlmPersonalBomWriteBindingService(commitAckLossPool(opened.pool, 2), () => adapter)
    await expect(loss.dispatchOperation(actor, sourceId, lineInput)).rejects.toThrow('commit ack lost')
    expect(http.patches).toHaveLength(1)
    const stored = await intentRows(opened.pool)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      outcome: 'accepted',
      confirmed_response: '{"bom_line_id":"line-1","ok":true}',
      provider_idempotency_key: http.patches[0].key,
    })
    const restarted = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    const sent = await restarted.dispatchOperation(actor, sourceId, lineInput)
    expect(sent.intentId).toBe(stored[0].id)
    expect(sent.providerIdempotencyKey).toBe(stored[0].provider_idempotency_key)
    expect(http.patches).toHaveLength(2)
    expect(http.patches[1].key).toBe(http.patches[0].key)
    expect(http.patches[1].authorization).toBe(`Bearer ${token('a')}`)
    const done = await intentRows(opened.pool)
    expect(done[0].confirmed_response).toBe(stored[0].confirmed_response)
    expect(done[0].outcome).toBe('accepted')
    expect(done[0].provider_idempotency_key).toBe(stored[0].provider_idempotency_key)
  }, 20000)

  it('stores an absent eco body when the phase-2 acknowledgement is lost and the restart replays it', async () => {
    const opened = await openSchema()
    const http = httpState()
    installFetch(http)
    const adapter = adapterFor(opened.config)
    const ecoInput = { operationKind: 'eco-intent' as const, partId: 'part-1', clientKey: 'client-key-eco' }
    const confirmed = '{"attached":false,"eco_id":"eco-1","source_version_id":null,"state":"open","target_version_id":null}'
    await new PlmPersonalBomWriteBindingService(opened.pool, () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('a'),
    })
    const loss = new PlmPersonalBomWriteBindingService(commitAckLossPool(opened.pool, 2), () => adapter)
    await expect(loss.dispatchOperation(actor, sourceId, ecoInput)).rejects.toThrow('commit ack lost')
    expect(http.patches).toEqual([])
    expect(http.ecos).toHaveLength(1)
    expect(http.ecos[0].body).toBeUndefined()
    expect(http.ecos[0].ifMatch).toBeUndefined()
    expect(http.ecos[0].url).toContain('/api/v1/bom/multitable/part-1/eco-intent')
    const stored = await intentRows(opened.pool)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      operation_kind: 'eco-intent',
      request_body: 'null',
      bom_line_id: null,
      if_match: null,
      part_id: 'part-1',
      outcome: 'accepted',
      confirmed_response: confirmed,
      provider_idempotency_key: http.ecos[0].key,
    })
    const restarted = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    const sent = await restarted.dispatchOperation(actor, sourceId, ecoInput)
    expect(sent.intentId).toBe(stored[0].id)
    expect(sent.providerIdempotencyKey).toBe(stored[0].provider_idempotency_key)
    expect(sent.bomLineId).toBeNull()
    expect(http.ecos).toHaveLength(2)
    expect(http.ecos[1].body).toBeUndefined()
    expect(http.ecos[1].key).toBe(http.ecos[0].key)
    expect(http.ecos[1].authorization).toBe(`Bearer ${token('a')}`)
    expect(http.patches).toEqual([])
    const done = await intentRows(opened.pool)
    expect(done[0].request_body).toBe('null')
    expect(done[0].confirmed_response).toBe(confirmed)
    expect(done[0].provider_idempotency_key).toBe(stored[0].provider_idempotency_key)
  }, 20000)

  it('drops an empty intent table, refuses populated evidence, and refuses an active writer without waiting', async () => {
    const opened = await openSchema()
    await downIntents(opened.db)
    await expect(opened.pool.query('SELECT 1 FROM plm_personal_bom_write_intents')).rejects.toMatchObject({ code: '42P01' })
    await opened.pool.query('SELECT 1 FROM plm_personal_bom_write_bindings')
    await upIntents(opened.db)
    const http = httpState()
    http.patchStatus = 403
    installFetch(http)
    const adapter = adapterFor(opened.config)
    const bound = new PlmPersonalBomWriteBindingService(opened.pool, () => adapter)
    await bound.bind(actor, { dataSourceId: sourceId, connectionId: connection, grant: token('a') })
    await expect(bound.dispatchOperation(actor, sourceId, lineInput)).rejects.toMatchObject({
      status: 403,
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })
    const refused = await intentRows(opened.pool)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ outcome: 'denied', confirmed_response: null, saw_unknown: false })
    await expect(downIntents(opened.db)).rejects.toThrow(/plm_personal_bom_write_intent_evidence_present/)
    expect(await intentRows(opened.pool)).toEqual(refused)
    const writer = await opened.pool.connect()
    let writerReleased = false
    const releaseWriter = async () => {
      if (writerReleased) return
      writerReleased = true
      try { await writer.query('ROLLBACK') } catch { /* already idle */ }
      writer.release()
    }
    leftovers.push(releaseWriter)
    await writer.query('BEGIN')
    await writer.query('UPDATE plm_personal_bom_write_intents SET updated_at=now()')
    const raced = await Promise.race([
      downIntents(opened.db).then(() => 'dropped', (error: unknown) => error),
      delay(2000).then(() => 'waited'),
    ])
    expect(raced).not.toBe('waited')
    expect(errorText(raced)).toContain('55P03')
    const held = await writer.query('SELECT outcome, confirmed_response FROM plm_personal_bom_write_intents')
    expect(held.rows).toEqual([{ outcome: 'denied', confirmed_response: null }])
    await releaseWriter()
    const still = await intentRows(opened.pool)
    expect(still).toHaveLength(1)
    expect(still[0]).toMatchObject({ id: refused[0].id, outcome: 'denied', confirmed_response: null })
    await expect(opened.pool.query('SELECT 1 FROM plm_personal_bom_write_intents')).resolves.toBeTruthy()
  }, 20000)

  async function phase2Denial(kind: 'source' | 'user' | 'member' | 'unbind'): Promise<void> {
    const opened = await openSchema()
    const http = httpState()
    const held = holdProvider(http)
    installFetch(http)
    const adapter = adapterFor(opened.config)
    const bound = await new PlmPersonalBomWriteBindingService(opened.pool, () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('a'),
    })
    const dispatchPid = { pid: 0 }
    const waiterPid = { pid: 0 }
    let dispatchWork: Promise<unknown> = Promise.resolve()
    let follow: Promise<unknown> = Promise.resolve()
    leftovers.push(async () => {
      held.release()
      await dispatchWork.catch(() => undefined)
      await follow.catch(() => undefined)
    })
    const service = new PlmPersonalBomWriteBindingService(queryPidPool(opened.pool, dispatchPid), () => adapter)
    dispatchWork = service.dispatchOperation(actor, sourceId, lineInput)
    await Promise.race([
      held.started,
      new Promise((_, reject) => setTimeout(() => reject(new Error('phase-2 provider barrier not reached')), 5000)),
    ])
    expect(http.patches).toHaveLength(1)
    expect(dispatchPid.pid).toBeGreaterThan(0)
    let followed = false
    follow = (kind === 'unbind'
      ? new PlmPersonalBomWriteBindingService(connectPidPool(opened.pool, waiterPid), () => adapter).unbind(owner, bound.id)
      : rawMutation(opened.pool, kind, waiterPid)
    ).finally(() => { followed = true })
    expect(await blocked(opened.pool, () => waiterPid.pid, dispatchPid.pid)).toBe(true)
    expect(followed).toBe(false)
    expect(http.patches).toHaveLength(1)
    held.release()
    await expect(dispatchWork).resolves.toMatchObject({ outcome: 'accepted', bomLineId: 'line-1' })
    await follow
    expect(http.patches).toHaveLength(1)
    if (kind === 'unbind') expect(http.revokes).toBe(1)
    await expect(service.dispatchOperation(actor, sourceId, lineInput)).rejects.toMatchObject(
      kind === 'user'
        ? { status: 401, code: 'PLM_BOM_WRITE_UNAUTHORIZED' }
        : kind === 'unbind'
          ? { status: 409, code: 'PLM_BOM_WRITE_CONFLICT' }
          : { status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' },
    )
    expect(http.patches).toHaveLength(1)
    expect(http.methods.filter((method) => method === 'PATCH')).toHaveLength(1)
  }

  async function authorityRace(kind: 'source' | 'user' | 'member'): Promise<void> {
    const opened = await openSchema()
    const http = httpState()
    installFetch(http)
    const adapter = adapterFor(opened.config)
    await new PlmPersonalBomWriteBindingService(opened.pool, () => adapter).bind(actor, {
      dataSourceId: sourceId,
      connectionId: connection,
      grant: token('a'),
    })
    let releaseGate = () => {}
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let releaseHeld = () => {}
    const held = new Promise<void>((resolve) => { releaseHeld = resolve })
    let resolveMutation = () => {}
    const mutationDone = new Promise<void>((resolve) => { resolveMutation = resolve })
    let revoker: PoolClient | undefined
    let revokerReleased = false
    let updateSettled = false
    let dispatchWork: Promise<unknown> = Promise.resolve()
    const releaseRevoker = () => {
      if (!revoker || revokerReleased) return
      revokerReleased = true
      revoker.release()
    }
    leftovers.push(async () => {
      releaseGate()
      resolveMutation()
      const deadline = Date.now() + 3000
      while (!updateSettled && Date.now() < deadline) await delay(20)
      await dispatchWork.catch(() => undefined)
      releaseRevoker()
    })
    const holder = { pid: 0 }
    const service = new PlmPersonalBomWriteBindingService(
      dispatchGate(opened.pool, holder, (sql) => lockMatch(kind, sql), releaseHeld, gate, mutationDone),
      () => adapter,
    )
    dispatchWork = service.dispatchOperation(actor, sourceId, lineInput)
    await Promise.race([
      held,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${kind} barrier not reached`)), 5000)),
    ])
    expect(holder.pid).toBeGreaterThan(0)
    revoker = await opened.pool.connect()
    let updateFinished = false
    const update = revoker.query(mutationSql(kind), mutationParams(kind)).finally(() => {
      updateFinished = true
      updateSettled = true
      resolveMutation()
    })
    expect(await blocked(opened.pool, () => revoker!.processID, holder.pid)).toBe(true)
    expect(updateFinished).toBe(false)
    releaseGate()
    await update
    releaseRevoker()
    await expect(dispatchWork).rejects.toMatchObject(kind === 'user'
      ? { status: 401, code: 'PLM_BOM_WRITE_UNAUTHORIZED' }
      : { status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(http.patches).toEqual([])
    expect(http.methods.filter((method) => method === 'POST')).toEqual(['POST'])
    const rows = await intentRows(opened.pool)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('frozen')
    expect(rows[0].saw_unknown).toBe(false)
    expect(rows[0].confirmed_response).toBeNull()
    expect(rows[0].provider_idempotency_key).toMatch(/^[0-9a-f]{64}$/)
    expect(http.origins).not.toContain('https://stale-native.invalid')
  }

  async function openSchema(): Promise<{ pool: Pool; db: Kysely<unknown>; config: { id: string; name: string; type: string; connection: { url: string; headers: Record<string, string> }; options: { apiMode: string; tenantId: string; orgId: string } } }> {
    if (!rawUrl) throw new Error('owned socket required')
    process.env.NODE_ENV = 'test'
    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
    process.env.ENCRYPTION_KEY ||= 'synthetic-pg-intent-key'
    process.env.ENCRYPTION_SALT ||= 'synthetic-pg-intent-salt'
    const schema = `plm_bom_intent_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: rawUrl, max: 1 })
    let pool: Pool | undefined
    let db: Kysely<unknown> | undefined
    leftovers.push(async () => {
      if (db) await db.destroy()
      else if (pool) await pool.end()
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: searchPathUrl(rawUrl, schema), max: 6 })
    const ready = pool
    db = new Kysely({ dialect: new PostgresDialect({ pool: ready }) })
    await ready.query(
      `CREATE TABLE users(id text PRIMARY KEY, is_active boolean NOT NULL);
       CREATE TABLE user_orgs(
         user_id text NOT NULL,
         org_id text NOT NULL,
         is_active boolean NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, org_id)
       );
       CREATE TABLE data_sources(
         id text PRIMARY KEY, owner_id text, workspace_id text, tenant_id text,
         scope_kind text, type text, config jsonb, is_active boolean, deleted_at timestamptz
       )`,
    )
    await upBindings(db)
    await upIntents(db)
    const config = {
      id: sourceId,
      name: 'Source',
      type: 'plm',
      connection: { url: 'https://native.invalid', headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1' } },
      options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
    }
    await ready.query('INSERT INTO users VALUES($1,true)', [owner])
    await ready.query('INSERT INTO user_orgs(user_id, org_id, is_active) VALUES($1,$2,true)', [owner, 'meta-a'])
    await ready.query(
      "INSERT INTO data_sources VALUES($1,$2,'workspace-1','meta-a','private','plm',$3,true,NULL)",
      [sourceId, owner, JSON.stringify({ connection: config.connection, options: config.options })],
    )
    return { pool: ready, db, config }
  }
})

function httpState(): HttpState {
  return {
    origins: [],
    methods: [],
    patches: [],
    ecos: [],
    revokes: 0,
    patchStatus: null,
    holdLine: false,
    enteredLine: () => undefined,
    lineHeld: Promise.resolve(),
  }
}

function lockMatch(kind: 'source' | 'user' | 'member', sql: string): boolean {
  if (kind === 'source') return sql.includes('FROM data_sources') && sql.includes('FOR UPDATE')
  if (kind === 'user') return sql.includes('FROM users') && sql.includes('FOR SHARE')
  return sql.includes('FROM user_orgs') && sql.includes('FOR SHARE')
}

function mutationSql(kind: 'source' | 'user' | 'member'): string {
  if (kind === 'source') return 'UPDATE data_sources SET owner_id=$2 WHERE id=$1'
  if (kind === 'user') return 'UPDATE users SET is_active=false WHERE id=$1'
  return 'UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2'
}

function mutationParams(kind: 'source' | 'user' | 'member'): unknown[] {
  if (kind === 'source') return [sourceId, 'other-owner']
  if (kind === 'user') return [owner]
  return [owner, 'meta-a']
}

function dispatchGate(
  pool: Pool,
  pid: { pid: number },
  match: (sql: string) => boolean,
  releaseHeld: () => void,
  gate: Promise<void>,
  mutationDone: Promise<void>,
): Pick<Pool, 'connect'> {
  let phase = 0
  let waited = false
  return {
    async connect() {
      const client = await pool.connect()
      pid.pid = client.processID
      return {
        release: () => client.release(),
        async query(sql: string, params?: unknown[]) {
          const text = String(sql)
          if (phase >= 1 && !waited) {
            waited = true
            await mutationDone
          }
          const out = await client.query(text, params)
          if (phase === 0 && match(text)) {
            releaseHeld()
            await gate
          }
          if (text === 'COMMIT') phase += 1
          return out
        },
      } as PoolClient
    },
  }
}

function holdProvider(state: HttpState): { started: Promise<void>; release: () => void } {
  let release = () => {}
  const lineHeld = new Promise<void>((resolve) => { release = resolve })
  let entered = () => {}
  const started = new Promise<void>((resolve) => { entered = resolve })
  state.holdLine = true
  state.enteredLine = entered
  state.lineHeld = lineHeld
  return { started, release }
}

function queryPidPool(pool: Pool, slot: { pid: number }): Pick<Pool, 'connect'> {
  return {
    async connect() {
      const client = await pool.connect()
      const pid = client.processID
      return {
        release: () => client.release(),
        async query(sql: string, params?: unknown[]) {
          slot.pid = pid
          return client.query(String(sql), params)
        },
      } as PoolClient
    },
  }
}

function connectPidPool(pool: Pool, slot: { pid: number }): Pick<Pool, 'connect'> {
  return {
    async connect() {
      const client = await pool.connect()
      slot.pid = client.processID
      return client
    },
  }
}

/** The server COMMIT finishes, then the client loses the acknowledgement. */
function commitAckLossPool(pool: Pool, lose: 1 | 2): Pick<Pool, 'connect'> {
  let seen = 0
  return {
    async connect() {
      const client = await pool.connect()
      return {
        release: () => client.release(),
        async query(sql: string, params?: unknown[]) {
          const text = String(sql)
          if (text === 'COMMIT') {
            seen += 1
            const result = await client.query(text, params)
            if (seen === lose) throw new Error('commit ack lost')
            return result
          }
          return client.query(text, params)
        },
      } as PoolClient
    },
  }
}

async function rawMutation(
  pool: Pool,
  kind: 'source' | 'user' | 'member',
  slot: { pid: number },
): Promise<unknown> {
  const client = await pool.connect()
  slot.pid = client.processID
  try {
    return await client.query(mutationSql(kind), mutationParams(kind))
  } finally {
    client.release()
  }
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const item = error as { code?: string; message?: string; cause?: unknown }
  return `${item.code ?? ''} ${item.message ?? ''} ${item.cause ? errorText(item.cause) : ''}`
}

function commitLossPool(pool: Pool, pid: { pid: number }, commits: { n: number }): Pick<Pool, 'connect'> {
  return {
    async connect() {
      const client = await pool.connect()
      pid.pid = client.processID
      return {
        release: () => client.release(),
        async query(sql: string, params?: unknown[]) {
          const text = String(sql)
          if (text === 'COMMIT') {
            commits.n += 1
            if (commits.n === 2) throw new Error('outcome commit lost')
          }
          return client.query(text, params)
        },
      } as PoolClient
    },
  }
}

async function intentRows(pool: Pool) {
  const found = await pool.query<{
    id: string
    outcome: string
    saw_unknown: boolean
    confirmed_response: string | null
    request_body: string
    if_match: string | null
    provider_idempotency_key: string
    client_key_sha256: string
    binding_id: string
    operation_kind: string
    part_id: string
    bom_line_id: string | null
    actor_meta_tenant_id: string | null
    source_meta_tenant_id: string | null
    workspace_id: string | null
    scope_kind: string
    target_origin: string
    subject_id: string
  }>(
    `SELECT id, outcome, saw_unknown, confirmed_response, request_body, if_match, provider_idempotency_key,
            client_key_sha256, binding_id, operation_kind, part_id, bom_line_id, actor_meta_tenant_id,
            source_meta_tenant_id, workspace_id, scope_kind, target_origin, subject_id
     FROM plm_personal_bom_write_intents ORDER BY created_at, id`,
  )
  return found.rows
}

async function blocked(pool: Pool, waiter: () => number, holder: number): Promise<boolean> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const waiterPid = waiter()
    if (waiterPid) {
      const found = await pool.query('SELECT pg_blocking_pids($1) AS blockers', [waiterPid])
      const blockers = found.rows[0].blockers as Array<number | string>
      if (blockers.map(Number).includes(holder)) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}
