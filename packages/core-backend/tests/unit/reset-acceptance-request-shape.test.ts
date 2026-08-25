import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseRecoveryAnchorRequest } from '../../src/multitable/exact-anchor-recovery-route'
import { buildResetPreviewBody, buildResetExecuteBody } from '../../scripts/reset-acceptance.mjs'

/**
 * Pin `packages/core-backend/scripts/reset-acceptance.mjs`'s exact request-body shapes against the
 * ROUTE'S OWN `parseRecoveryAnchorRequest` — imported directly, never re-typed — so the harness can
 * never silently drift back to the pre-exact-anchor `asOf` contract without this test going red.
 *
 * Context: the route refuses ANY nonblank `asOf` (even alongside a valid id) with
 * `exact-anchor-required`, before the D2 sheet-admin gate and before any DB access
 * (`exact-anchor-recovery-route.ts`'s `parseRecoveryAnchorRequest`). EXECUTE is a SEPARATE, TOKEN-ONLY
 * surface (`univer-meta.ts`'s `handleExactAnchorExecute`, ~L10705) that never runs its body through this
 * parser at all — it rejects `historyBatchId` / `anchorOperationId` / `mode` outright and refuses any
 * nonblank `asOf` with its own inline check. Preview and execute bodies are therefore asserted with two
 * DIFFERENT criteria below, not one shared "parses ok" expectation.
 */
describe('reset-acceptance.mjs request-body shape (pinned against parseRecoveryAnchorRequest)', () => {
  it('buildResetPreviewBody(historyBatchId) parses as a valid history-batch anchor request', () => {
    const body = buildResetPreviewBody('batch-abc-123')
    expect(body).toEqual({ historyBatchId: 'batch-abc-123' })
    expect(parseRecoveryAnchorRequest(body)).toEqual({
      ok: true,
      request: { kind: 'history-batch', historyBatchId: 'batch-abc-123' },
    })
  })

  it('buildResetPreviewBody never carries asOf, anchorOperationId, or any other key', () => {
    const body = buildResetPreviewBody('batch-xyz') as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['historyBatchId'])
    expect(Object.prototype.hasOwnProperty.call(body, 'asOf')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(body, 'anchorOperationId')).toBe(false)
  })

  it('buildResetExecuteBody({previewIdentity, confirm}) carries ONLY previewIdentity + confirm — the route\'s TOKEN-ONLY execute contract rejects historyBatchId/anchorOperationId/mode/asOf outright', () => {
    const body = buildResetExecuteBody({ previewIdentity: 'tok-1', confirm: 'reset' }) as Record<string, unknown>
    expect(body).toEqual({ previewIdentity: 'tok-1', confirm: 'reset' })
    for (const forbidden of ['asOf', 'historyBatchId', 'anchorOperationId', 'mode']) {
      expect(Object.prototype.hasOwnProperty.call(body, forbidden)).toBe(false)
    }
  })

  it('buildResetExecuteBody omits confirm entirely when not supplied (scenario (c): missing-confirm 400, not a blank-string confirm)', () => {
    const body = buildResetExecuteBody({ previewIdentity: 'tok-2' }) as Record<string, unknown>
    expect(body).toEqual({ previewIdentity: 'tok-2' })
    expect(Object.prototype.hasOwnProperty.call(body, 'confirm')).toBe(false)
  })

  it('regression guard: a body carrying asOf (the pre-migration contract) is refused exact-anchor-required — reintroducing it into the harness must turn this red', () => {
    expect(parseRecoveryAnchorRequest({ asOf: '2026-01-01T00:00:00.000Z' })).toEqual({
      ok: false,
      reason: 'exact-anchor-required',
    })
    // Co-present with a valid id: asOf still wins the refusal (exact-authority only, never silently ignored).
    expect(
      parseRecoveryAnchorRequest({ asOf: '2026-01-01T00:00:00.000Z', historyBatchId: 'batch-abc-123' }),
    ).toEqual({ ok: false, reason: 'exact-anchor-required' })
  })

  it('regression guard: an empty body (no id at all) is refused exact-anchor-required, matching the flag-off probe\'s pre-parse short-circuit expectations', () => {
    expect(parseRecoveryAnchorRequest({})).toEqual({ ok: false, reason: 'exact-anchor-required' })
  })
})

/**
 * ---------------------------------------------------------------------------------------------------
 * OWNER-DESIGNATED CANARY TARGET (L2-C reuse) — behaviour, not text.
 * ---------------------------------------------------------------------------------------------------
 * The L2-C trust checkpoint the reset path requires is minted ONCE by an owner on a NAMED canary sheet
 * (`scripts/ops/multitable-o2-canary-drill.md` §3), and L5 must NOT re-provision one. A harness that
 * mints a fresh base+sheet every run therefore tests a sheet that can never carry a covering checkpoint:
 * `reset-preview` returns `NO_COVERING_CHECKPOINT` structurally and the L5 rung is unrunnable.
 *
 * These cases drive the REAL `setup()` / `run()` exported by the harness (fresh module instance per
 * case, so the module-level BASE/ADMIN/counters are re-read) against a stubbed `globalThis.fetch`, and
 * assert the two halves of the fix:
 *   1. canary env SET   → setup() issues NO `POST /bases` and NO `POST /sheets`; the designated ids are
 *                         the ids every subsequent call uses. POSITIVE CONTROL: the SAME matcher fires
 *                         (one base + one sheet created) when the env is unset — so a typo in the
 *                         matcher cannot make both halves green.
 *   2. canary env UNSET → the flag-ON run SKIPS (d)/(e)/(g) with a stated reason and exits 2; it never
 *                         reports a (g) pass. POSITIVE CONTROL: with the canary set and a checkpoint-
 *                         ready substrate the same run executes (g) and exits 0.
 */

interface RecordedCall {
  method: string
  path: string
  token: string | null
  body: Record<string, unknown> | undefined
}

const HARNESS_BASE_URL = 'http://harness.invalid'
const HARNESS_MOUNT = '/api/multitable'
const CANARY_BASE_ID = 'canary-base-L2C'
const CANARY_SHEET_ID = 'canary-sheet-L2C'

/**
 * Stub `globalThis.fetch` with a small stateful fake of the multitable API, recording every call.
 *
 * `substrate: 'checkpoint-ready'` answers every admin `reset-preview` with an executable 200 (the
 * designated-canary world). `substrate: 'no-covering-checkpoint'` answers them 409 NO_COVERING_CHECKPOINT
 * — exactly what a self-minted sheet gets, forever.
 */
function installFakeApi(substrate: 'checkpoint-ready' | 'no-covering-checkpoint') {
  const calls: RecordedCall[] = []
  let recordSeq = 0
  let sheetSeq = 0
  let adminPreviewSeq = 0
  let executeSeq = 0
  const reply = (status: number, body: unknown) => ({ status, json: async () => body })

  const impl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = init?.method ?? 'GET'
    const path = String(url).slice((HARNESS_BASE_URL + HARNESS_MOUNT).length)
    const auth = init?.headers?.authorization ?? null
    const token = auth ? auth.replace(/^Bearer /, '') : null
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path, token, body })

    if (method === 'POST' && path === '/bases') return reply(200, { data: { id: 'minted-base' } })
    if (method === 'POST' && path === '/sheets') return reply(200, { data: { id: `minted-sheet-${++sheetSeq}` } })
    if (method === 'POST' && path === '/fields') return reply(200, { data: { id: 'fld-salary' } })
    if (method === 'POST' && path === '/records') return reply(200, { data: { id: `rec-${++recordSeq}` } })
    if (method === 'DELETE' && path.startsWith('/records/')) return reply(200, { data: { ok: true } })
    if (method === 'PATCH' && path.startsWith('/records/')) return reply(200, { data: { ok: true } })
    if (method === 'POST' && /^\/records\/[^/]+\/lock$/.test(path)) return reply(200, { data: { ok: true } })
    if (method === 'GET' && /\/records\/[^/]+\/history$/.test(path)) {
      return reply(200, { data: { items: [{ action: 'create', batchId: 'batch-anchor-1' }] } })
    }
    if (method === 'POST' && path.endsWith('/reset-preview')) {
      // (b): the editor actor is refused by the D2 sheet-admin floor BEFORE the trust/checkpoint gates,
      // so it never advances the admin-preview sequence below.
      if (token === 'editor-jwt') return reply(403, { error: { code: 'FORBIDDEN', message: 'x' } })
      // (f): the dedicated ceiling sheet (the SECOND sheet a self-provisioning run creates) is over
      // the live-sheet ceiling, which the route enforces BEFORE anchor resolution — so it answers 413
      // in BOTH substrate worlds, exactly as the harness docblock claims.
      if (path.startsWith('/sheets/minted-sheet-2/')) return reply(413, { error: { code: 'SHEET_TOO_LARGE', message: 'x' } })
      if (substrate === 'no-covering-checkpoint') {
        return reply(409, { error: { code: 'NO_COVERING_CHECKPOINT', message: 'x' } })
      }
      const n = ++adminPreviewSeq
      // #1 flag probe, #2 substrate probe, #3/#4 (e), #5/#6 (d), #7 (g) preview, #8 (g) post-reset.
      const deleteRecordIds = n >= 8 ? [] : ['rec-3', 'rec-4']
      return reply(200, {
        data: { previewIdentity: `tok-${n}`, deleteRecordIds, summary: { visibleRevertCount: 0 } },
      })
    }
    if (method === 'POST' && path.endsWith('/reset-execute')) {
      const n = ++executeSeq
      if (n === 1) return reply(400, { error: { code: 'RESET_CONFIRM_REQUIRED', message: 'x' } })
      if (n === 2) return reply(409, { error: { code: 'RESET_PREVIEW_DRIFT', message: 'x' } })
      if (n === 3) return reply(409, { error: { code: 'RESET_BLOCKED', message: 'x' } })
      return reply(200, { data: { applied: true } })
    }
    return reply(404, { error: { code: 'NOT_FOUND', message: path } })
  }

  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch)
  return calls
}

/** Load a FRESH instance of the real harness module with `env` applied (module-level consts re-read). */
async function loadHarness(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '')
    else vi.stubEnv(k, v)
  }
  // vi.stubEnv('' ) sets an empty string, which the harness treats as unset for every one of these keys
  // (`||`-defaulted / `.trim()`-checked); delete outright so `?? ''` paths see genuinely-absent vars.
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
  vi.resetModules()
  return (await import('../../scripts/reset-acceptance.mjs')) as {
    setup: (canary?: unknown) => Promise<Record<string, unknown>>
    run: () => Promise<{ pass: number; fail: number; skip: number; exitCode: number }>
    resolveCanaryTarget: (env?: NodeJS.ProcessEnv) => { kind: string; baseId?: string; sheetId?: string; reason?: string }
  }
}

const BASE_ENV = { BASE_URL: HARNESS_BASE_URL, ADMIN_TOKEN: 'admin-jwt', EDITOR_TOKEN: 'editor-jwt', RESET_MAX_RECORDS: undefined }
const CANARY_ENV = { RESET_CANARY_BASE_ID: CANARY_BASE_ID, RESET_CANARY_SHEET_ID: CANARY_SHEET_ID }
const NO_CANARY_ENV = { RESET_CANARY_BASE_ID: undefined, RESET_CANARY_SHEET_ID: undefined }

/** The matcher under test in BOTH directions: which base/sheet CREATE calls the harness issued. */
const creationCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === 'POST' && (c.path === '/bases' || c.path === '/sheets')).map((c) => c.path)

describe('reset-acceptance.mjs owner-designated canary target (L2-C reuse)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    // The harness sets process.exitCode by contract; never let that leak into vitest's own exit status.
    process.exitCode = 0
  })

  it('resolveCanaryTarget: both ids → designated; neither → none; one alone → invalid (no silent half-reuse)', async () => {
    const { resolveCanaryTarget } = await loadHarness({ ...BASE_ENV, ...NO_CANARY_ENV })
    expect(resolveCanaryTarget({ RESET_CANARY_BASE_ID: ' b1 ', RESET_CANARY_SHEET_ID: 's1' } as NodeJS.ProcessEnv)).toEqual({
      kind: 'designated',
      baseId: 'b1',
      sheetId: 's1',
    })
    expect(resolveCanaryTarget({} as NodeJS.ProcessEnv)).toEqual({ kind: 'none' })
    expect(resolveCanaryTarget({ RESET_CANARY_SHEET_ID: 's1' } as NodeJS.ProcessEnv).kind).toBe('invalid')
    expect(resolveCanaryTarget({ RESET_CANARY_BASE_ID: 'b1' } as NodeJS.ProcessEnv).kind).toBe('invalid')
  })

  it('canary SET: setup() creates NO base and NO sheet — the designated ids are what every later call uses', async () => {
    const calls = installFakeApi('checkpoint-ready')
    const { setup } = await loadHarness({ ...BASE_ENV, ...CANARY_ENV })
    const ctx = await setup()

    // The load-bearing assertion: the create-sheet (and create-base) call is NOT made.
    expect(creationCalls(calls)).toEqual([])
    // …and the reused ids actually flow through, rather than the harness silently going nowhere.
    expect(ctx.baseId).toBe(CANARY_BASE_ID)
    expect(ctx.sheetId).toBe(CANARY_SHEET_ID)
    expect(ctx.canaryDesignated).toBe(true)
    expect(ctx.anchorBatchId).toBe('batch-anchor-1')
    // Every sheet-scoped call targeted the DESIGNATED sheet (fixtures were still provisioned on it).
    const fieldCall = calls.find((c) => c.path === '/fields')
    expect(fieldCall?.body?.sheetId).toBe(CANARY_SHEET_ID)
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/records')).toHaveLength(4)
    for (const c of calls.filter((c) => c.method === 'POST' && c.path === '/records')) {
      expect(c.body?.sheetId).toBe(CANARY_SHEET_ID)
    }
    expect(calls.some((c) => c.method === 'GET' && c.path.startsWith(`/sheets/${CANARY_SHEET_ID}/records/`))).toBe(true)
    // And no trust checkpoint is minted by the harness — L5 consumes the one L2-C already made.
    expect(calls.some((c) => c.path.includes('trust-checkpoint-activate'))).toBe(false)
  })

  it('POSITIVE CONTROL for the create-call matcher: with the canary UNSET the very same matcher fires (one base + one sheet)', async () => {
    const calls = installFakeApi('checkpoint-ready')
    const { setup } = await loadHarness({ ...BASE_ENV, ...NO_CANARY_ENV })
    const ctx = await setup()

    expect(creationCalls(calls)).toEqual(['/bases', '/sheets'])
    expect(ctx.baseId).toBe('minted-base')
    expect(ctx.sheetId).toBe('minted-sheet-1')
    expect(ctx.canaryDesignated).toBe(false)
  })

  it('canary UNSET, flag ON: (d)/(e)/(g) SKIP with a stated reason and the run exits 2 — L5 is never a green pass on a self-made sheet', async () => {
    installFakeApi('no-covering-checkpoint')
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const { run } = await loadHarness({ ...BASE_ENV, ...NO_CANARY_ENV })
    const summary = await run()

    expect(summary.exitCode).toBe(2)
    expect(process.exitCode).toBe(2)
    expect(summary.fail).toBe(0)
    // (b) + (c) still ran — they refuse UPSTREAM of the covering-checkpoint gate, so they stay honest
    // evidence on a self-provisioned sheet.
    expect(summary.pass).toBe(2)
    // (d), (e), (g) skipped, plus (f) for its own (RESET_MAX_RECORDS) reason.
    expect(summary.skip).toBe(4)
    for (const tag of ['(d)', '(e)', '(g)']) {
      const skipLine = lines.find((l) => l.includes('⊘ SKIP') && l.includes(tag))
      expect(skipLine, `expected an explicit SKIP line for ${tag}`).toBeDefined()
      expect(skipLine).toContain('RESET_CANARY_BASE_ID / RESET_CANARY_SHEET_ID unset')
    }
    // Nothing about the reset BEHAVIOUR was reported as passing.
    expect(lines.some((l) => l.includes('✓ PASS') && l.includes('(g)'))).toBe(false)
    expect(lines.some((l) => l.includes('L5 NOT ACCEPTED'))).toBe(true)
  })

  it('POSITIVE CONTROL for the SKIP branch: canary SET + checkpoint-ready substrate → (g) actually executes and the run exits 0', async () => {
    installFakeApi('checkpoint-ready')
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const { run } = await loadHarness({ ...BASE_ENV, ...CANARY_ENV })
    const summary = await run()

    expect(summary.exitCode).toBe(0)
    expect(summary.fail).toBe(0)
    expect(lines.some((l) => l.includes('✓ PASS') && l.includes('(g) happy-path execute'))).toBe(true)
    expect(lines.some((l) => l.includes('⊘ SKIP') && l.includes('RESET_CANARY_BASE_ID / RESET_CANARY_SHEET_ID unset'))).toBe(false)
    expect(lines.some((l) => l.includes('L5 NOT ACCEPTED'))).toBe(false)
  })

  it('canary UNSET, flag ON: the UPSTREAM-of-the-checkpoint scenario (f) still executes — the ceiling 413 is enforced before anchor resolution, so a self-provisioned sheet is honest evidence for it', async () => {
    installFakeApi('no-covering-checkpoint')
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const { run } = await loadHarness({ ...BASE_ENV, ...NO_CANARY_ENV, RESET_MAX_RECORDS: '3' })
    const summary = await run()

    // (b) + (c) + (f) ran and passed; only the reset-BEHAVIOUR trio is unreachable.
    expect(lines.some((l) => l.includes('✓ PASS') && l.includes('(f) above-ceiling → 413'))).toBe(true)
    expect(summary.pass).toBe(3)
    expect(summary.skip).toBe(3)
    expect(summary.fail).toBe(0)
    // The run is STILL not green: L5 itself was never executed.
    expect(summary.exitCode).toBe(2)
  })

  it('half-set canary pair is a config error (exit 2) — never a silent half-reuse of a self-minted sheet', async () => {
    const calls = installFakeApi('checkpoint-ready')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { run } = await loadHarness({ ...BASE_ENV, RESET_CANARY_BASE_ID: undefined, RESET_CANARY_SHEET_ID: CANARY_SHEET_ID })
    const summary = await run()

    expect(summary.exitCode).toBe(2)
    // It aborted before touching the API at all.
    expect(calls).toEqual([])
  })
})
