import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pg'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { __resetDingTalkAppAccessTokenCacheForTests } from '../../src/integrations/dingtalk/client'

/**
 * DT-OPS-04 — work-notification credentials come from the recipient's own integration.
 *
 * A DingTalk userid only means anything inside its own corp. Before this, the executor asked
 * `readDingTalkMessageConfigFromRuntime()` with no argument, and the stored-config path fell
 * back to "whichever integration sorts first as latest active" — so corp B's employee was
 * notified with corp A's credentials.
 *
 * The unit tests that were meant to guard this set `DINGTALK_APP_KEY` and friends, and
 * `readDingTalkMessageConfigFromRuntime` returns env config BEFORE it ever looks at the
 * `integrationId` argument (`work-notification-settings.ts:188-195`). The scoping was
 * therefore invisible: deleting it, or corrupting it to a wrong integration id, left the
 * suite green.
 *
 * So this test sets NO DingTalk env vars and stores two real integrations with two different
 * appKeys. The appKey travels in the `/gettoken` query string, so which corp's credentials
 * were used for which recipient is directly observable in the fetch calls.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const CORP_A = { name: `ops04-a-${TS}`, corpId: `ops04-corp-a-${TS}`, appKey: `appkey-A-${TS}` }
const CORP_B = { name: `ops04-b-${TS}`, corpId: `ops04-corp-b-${TS}`, appKey: `appkey-B-${TS}` }
const USER_A = `ops04-ua-${TS}`
const USER_B = `ops04-ub-${TS}`

/**
 * Real Postgres for everything this test is about — the recipient lookup that must carry
 * `integration_id`, and (inside `readDingTalkMessageConfigFromRuntime`, via the module-level
 * `db/pg` query, which no dependency injection can reach) the stored per-corp credentials.
 *
 * The single exception is the `meta_sheets` base lookup that the cross-base write-gate does
 * for every rule. Seeding a whole base/sheet would add nothing: it is not what is under test,
 * and the gate fail-closes on a missing sheet. A uniform base keeps trigger and target
 * same-base so no gate fires.
 */
const queryFn = async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> => {
  if (/FROM meta_sheets/i.test(text)) return { rows: [{ base_id: 'base_ops04' }], rowCount: 1 }
  const result = await query(text, params)
  return { rows: result.rows, rowCount: result.rowCount }
}

/** Every appKey the executor asked DingTalk for a token with, in call order. */
function tokenRequestAppKeys(fetchFn: ReturnType<typeof vi.fn>): string[] {
  return fetchFn.mock.calls
    .map((call) => String(call[0] ?? ''))
    .filter((url) => url.includes('/gettoken'))
    .map((url) => new URL(url).searchParams.get('appkey') ?? '')
}

/** Each asyncsend call's (bearer token, recipient userids). */
function sendCalls(fetchFn: ReturnType<typeof vi.fn>): Array<{ token: string; userIds: string[] }> {
  return fetchFn.mock.calls
    .filter((call) => String(call[0] ?? '').includes('asyncsend'))
    .map((call) => {
      const url = String(call[0] ?? '')
      const init = (call[1] ?? {}) as RequestInit
      const body = JSON.parse(String(init.body ?? '{}')) as { userid_list?: string }
      const token = new URL(url).searchParams.get('access_token')
        ?? String((init.headers as Record<string, string> | undefined)?.['x-acs-dingtalk-access-token'] ?? '')
      return { token, userIds: String(body.userid_list ?? '').split(',').filter(Boolean) }
    })
}

describeIfDatabase('DT-OPS-04 person-message credentials are scoped to the recipient integration (real DB)', () => {
  const integrationIds = new Map<string, string>()
  let savedEnv: Record<string, string | undefined> = {}

  async function seedCorp(corp: typeof CORP_A, localUserId: string, dingtalkUserId: string) {
    const integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (provider, name, corp_id, status, config)
       VALUES ('dingtalk', $1, $2, 'active', $3::jsonb) RETURNING id`,
      [corp.name, corp.corpId, JSON.stringify({
        appKey: corp.appKey,
        appSecret: `secret-${corp.appKey}`,
        workNotificationAgentId: '900001',
      })],
    )).rows[0].id
    integrationIds.set(corp.appKey, integrationId)

    await query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', true)`,
      [localUserId, `${localUserId}@example.test`])

    const accountId = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active)
       VALUES ($1, $2, $3, 'Fixture', true) RETURNING id`,
      [integrationId, dingtalkUserId, `dingtalk:${dingtalkUserId}`],
    )).rows[0].id

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [accountId, localUserId],
    )
  }

  beforeAll(async () => {
    await seedCorp(CORP_A, USER_A, `dt-${USER_A}`)
    await seedCorp(CORP_B, USER_B, `dt-${USER_B}`)
  })

  beforeEach(() => {
    __resetDingTalkAppAccessTokenCacheForTests()
    // The env-first short-circuit is exactly what hid this bug. Force the stored-config path.
    savedEnv = {
      DINGTALK_APP_KEY: process.env.DINGTALK_APP_KEY,
      DINGTALK_CLIENT_ID: process.env.DINGTALK_CLIENT_ID,
      DINGTALK_APP_SECRET: process.env.DINGTALK_APP_SECRET,
      DINGTALK_CLIENT_SECRET: process.env.DINGTALK_CLIENT_SECRET,
      DINGTALK_AGENT_ID: process.env.DINGTALK_AGENT_ID,
      DINGTALK_NOTIFY_AGENT_ID: process.env.DINGTALK_NOTIFY_AGENT_ID,
    }
    for (const key of Object.keys(savedEnv)) delete process.env[key]
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  afterAll(async () => {
    for (const id of integrationIds.values()) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [id])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    }
    await query(`DELETE FROM users WHERE id = ANY($1)`, [[USER_A, USER_B]])
  })

  function buildExecutor(fetchFn: ReturnType<typeof vi.fn>) {
    const deps: AutomationDeps = {
      eventBus: new EventBus(),
      queryFn,
      fetchFn: fetchFn as unknown as typeof fetch,
    }
    return new AutomationExecutor(deps)
  }

  const okJson = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  /** A token per appKey, so the token in each send identifies the corp it was minted for. */
  function fetchStub() {
    return vi.fn(async (input: unknown) => {
      const url = String(input ?? '')
      if (url.includes('/gettoken')) {
        const appKey = new URL(url).searchParams.get('appkey') ?? ''
        return okJson({ errcode: 0, access_token: `token-for-${appKey}`, expires_in: 7200 })
      }
      if (url.includes('asyncsend')) return okJson({ errcode: 0, errmsg: 'ok', task_id: 1 })
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  const rule = (userIds: string[]): AutomationRule => ({
    id: `rule-${TS}`,
    sheetId: 'sheet_1',
    name: 'ops04',
    enabled: true,
    trigger: { type: 'record_created' },
    actions: [{ type: 'send_dingtalk_person_message', config: { userIds, titleTemplate: 'T', bodyTemplate: 'B' } }],
  } as unknown as AutomationRule)

  it('sentinel: DATABASE_URL is set and no DingTalk env credentials leak into this lane', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
    expect(process.env.DINGTALK_APP_KEY).toBeUndefined()
  })

  it('a single-corp audience is notified with that corp credentials', async () => {
    const fetchFn = fetchStub()
    const result = await buildExecutor(fetchFn).execute(rule([USER_A]), {
      recordId: 'r1', data: {}, sheetId: 'sheet_1', actorId: USER_A,
    })

    expect(result.status).toBe('success')
    expect(tokenRequestAppKeys(fetchFn)).toEqual([CORP_A.appKey])
    expect(sendCalls(fetchFn)).toEqual([{ token: `token-for-${CORP_A.appKey}`, userIds: [`dt-${USER_A}`] }])
  })

  // THE GOLDEN. Each recipient gets their own corp's token — no refusal, no cross-corp send.
  it('a two-corp audience is split: each recipient is notified with their OWN corp credentials', async () => {
    const fetchFn = fetchStub()
    const result = await buildExecutor(fetchFn).execute(rule([USER_A, USER_B]), {
      recordId: 'r1', data: {}, sheetId: 'sheet_1', actorId: USER_A,
    })

    expect(result.status).toBe('success')
    expect(tokenRequestAppKeys(fetchFn).sort()).toEqual([CORP_A.appKey, CORP_B.appKey].sort())

    const sends = sendCalls(fetchFn)
    expect(sends).toHaveLength(2)
    // Corp A's user is never addressed with corp B's token, and vice versa.
    const byUser = new Map(sends.flatMap((s) => s.userIds.map((u) => [u, s.token] as const)))
    expect(byUser.get(`dt-${USER_A}`)).toBe(`token-for-${CORP_A.appKey}`)
    expect(byUser.get(`dt-${USER_B}`)).toBe(`token-for-${CORP_B.appKey}`)
    for (const send of sends) expect(send.userIds).toHaveLength(1) // never mixed in one batch
  })

  // §7.5 asked for correct credentials, never for a refusal. A refusal would ALSO abort the
  // unrelated actions that follow this one, because `executeActions` fail-stops.
  it('does not fail the action — nor skip downstream actions — when the audience spans two corps', async () => {
    const fetchFn = fetchStub()
    // A second, unrelated action after the two-corp send. `executeActions` fail-stops, so a
    // refusal on step 1 marks step 2 `skipped` — work the rule's author never asked to cancel.
    const twoCorpThenSingleCorp = {
      ...rule([USER_A, USER_B]),
      actions: [
        { type: 'send_dingtalk_person_message', config: { userIds: [USER_A, USER_B], titleTemplate: 'T', bodyTemplate: 'B' } },
        { type: 'send_dingtalk_person_message', config: { userIds: [USER_A], titleTemplate: 'T2', bodyTemplate: 'B2' } },
      ],
    } as unknown as AutomationRule

    const result = await buildExecutor(fetchFn).execute(twoCorpThenSingleCorp, {
      recordId: 'r1', data: {}, sheetId: 'sheet_1', actorId: USER_A,
    })

    expect(result.steps.map((step) => step.status)).toEqual(['success', 'success'])
  })

  it('reuses one token per corp across that corp batches', async () => {
    const fetchFn = fetchStub()
    await buildExecutor(fetchFn).execute(rule([USER_A, USER_B, USER_A]), {
      recordId: 'r1', data: {}, sheetId: 'sheet_1', actorId: USER_A,
    })
    // Two corps → exactly two token fetches, however many sends happen.
    expect(tokenRequestAppKeys(fetchFn)).toHaveLength(2)
  })
})
