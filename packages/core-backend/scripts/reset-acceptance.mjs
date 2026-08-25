#!/usr/bin/env node
/**
 * T8-2 Reset-to-T — staging acceptance harness (one-click error-code + behavior evidence).
 *
 * Reset is DESTRUCTIVE: it reverts surviving records to their state at the anchor AND soft-deletes
 * records created after the anchor (into the recycle bin / meta_records_trash — recoverable, NOT a
 * normal Revert). This harness proves, against a real environment, that the flag gate + error codes +
 * delete behavior are correct BEFORE the flag is enabled for any real scope. See
 * docs/development/multitable-t8-2-reset-acceptance-runbook-20260625.md.
 *
 * EXACT-ANCHOR CONTRACT (2026-08-24 migration off free wall-clock `asOf`): every recovery route
 * (`packages/core-backend/src/multitable/exact-anchor-recovery-route.ts`, `parseRecoveryAnchorRequest`)
 * now accepts exactly one of `historyBatchId` / `anchorOperationId` on PREVIEW, and refuses ANY nonblank
 * `asOf` (even alongside a valid id) with `exact-anchor-required` — before any DB access, before the D2
 * sheet-admin gate. EXECUTE is TOKEN-ONLY: it accepts `previewIdentity` (+ `confirm` for reset) and
 * REJECTS a body carrying `historyBatchId` / `anchorOperationId` / `mode` / a nonblank `asOf` with 400
 * VALIDATION_ERROR / EXACT_ANCHOR_REQUIRED. This harness therefore:
 *   - discovers a REAL, resolvable `historyBatchId` at setup time via
 *     `GET /sheets/:sheetId/records/:recordId/history` (the `batchId` on record B's `create` entry —
 *     record B is the LATER of the two pre-anchor writes, so its batchId is the correct "reset to just
 *     after A,B were created" boundary), instead of a free wall-clock timestamp;
 *   - sends `{ historyBatchId }` on every preview call, never `asOf`;
 *   - sends `{ previewIdentity, confirm? }` ONLY on every execute call — no anchor id, ever.
 * `buildResetPreviewBody` / `buildResetExecuteBody` below are exported so a hermetic unit test can pin
 * these exact shapes against the route's own `parseRecoveryAnchorRequest` (see
 * `packages/core-backend/tests/unit/reset-acceptance-request-shape.test.ts`) — the harness can then never
 * silently drift from the live contract again.
 *
 * FULL TRUST SUBSTRATE (also 2026-08-24-current, beyond the historical "just flip PIT_RESET" story):
 * `previewExactAnchorRecovery` additionally requires `MULTITABLE_ENABLE_WRITER_FENCE=true` AND
 * `MULTITABLE_HISTORY_CONTIGUITY_STRICT=true` (env-only trust substrate — 409 `RECOVERY_TRUST_REQUIRED`
 * otherwise), AND an ACTIVE trust checkpoint covering the anchor on THIS sheet (409
 * `NO_COVERING_CHECKPOINT` otherwise — see `POST /sheets/:sheetId/trust-checkpoint-activate` and
 * `scripts/ops/multitable-o2-canary-drill.md` §3 "L2-C"). This harness does NOT flip flags or mint a
 * checkpoint itself (it is a pure HTTP client with no host access and no opinion on ladder rung
 * authorization) — it DETECTS an unready trust substrate on its first flag-ON preview and exits 2
 * (config/setup error) with the exact remediation, rather than reporting seven confusing scenario FAILs.
 *
 * Usage:
 *   BASE_URL=https://staging.example ADMIN_TOKEN=<jwt> [EDITOR_TOKEN=<jwt>] [RESET_MAX_RECORDS=<n>] \
 *     node packages/core-backend/scripts/reset-acceptance.mjs
 *
 *   ADMIN_TOKEN  — a sheet-admin (canManageSheetAccess / multitable:share). REQUIRED.
 *   EDITOR_TOKEN — a normal record editor (multitable:write, NOT share). Optional; scenario (b) skips if absent.
 *   RESET_MAX_RECORDS — if set to the env's MULTITABLE_SHEET_REVERT_MAX_RECORDS, enables the (f) 413 ceiling test.
 *
 * Flag handling: run ONCE with the flag OFF (proves (a) — Reset is inert), then enable
 * MULTITABLE_ENABLE_PIT_RESET (AND MULTITABLE_ENABLE_WRITER_FENCE AND
 * MULTITABLE_HISTORY_CONTIGUITY_STRICT, AND provision a trust checkpoint on the target sheet — see
 * above) and run AGAIN (runs (b)-(g)). The harness auto-detects the flag state and runs the matching
 * scenarios.
 *
 * Exit: 0 = all run scenarios passed; 1 = a scenario failed; 2 = config/setup error (including an unready
 * trust substrate on the flag-ON run).
 */

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '')
const ADMIN = process.env.ADMIN_TOKEN
const EDITOR = process.env.EDITOR_TOKEN || null
const MAXREC = process.env.RESET_MAX_RECORDS ? Number(process.env.RESET_MAX_RECORDS) : null
const MOUNT = process.env.RESET_API_MOUNT || '/api/multitable'

let pass = 0, fail = 0, skip = 0
const log = (...a) => console.log(...a)
function ok(name, cond, detail = '') {
  if (cond) { pass++; log(`  ✓ PASS  ${name}`) }
  else { fail++; log(`  ✗ FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const skipped = (name, why) => { skip++; log(`  ⊘ SKIP  ${name} — ${why}`) }

async function api(method, path, token, body) {
  let res, json = null
  try {
    res = await fetch(`${BASE}${MOUNT}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) { return { status: 0, body: { error: { code: 'NETWORK', message: String(e) } } } }
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, body: json }
}
const code = (r) => r?.body?.error?.code || ''

// ---- exact-anchor request-body builders (PURE — no I/O) ----------------------------------------------
// Exported so a hermetic unit test can run these EXACT shapes through the route's own
// `parseRecoveryAnchorRequest` and assert the parse result, instead of re-typing a copy of the literal
// that could silently diverge from what the harness actually sends.

/** PREVIEW body: exactly one exact anchor id, never `asOf`. */
export function buildResetPreviewBody(historyBatchId) {
  return { historyBatchId }
}

/** EXECUTE body: TOKEN-ONLY authority — `previewIdentity` (+ typed `confirm` for reset) and NOTHING
 *  else. Never add `historyBatchId` / `anchorOperationId` / `mode` / `asOf` here: the route rejects the
 *  first three outright (400 VALIDATION_ERROR) and refuses any nonblank `asOf` (400
 *  EXACT_ANCHOR_REQUIRED) — either would mask whatever this call is actually meant to discriminate.
 *  `confirm` is omitted (not merely blank) when not supplied, so scenario (c) can assert the
 *  MISSING-confirm 400 for the right reason. */
export function buildResetExecuteBody({ previewIdentity, confirm } = {}) {
  const body = { previewIdentity }
  if (confirm !== undefined) body.confirm = confirm
  return body
}

// ---- setup (HTTP self-provision; any step without a clean API is documented in the runbook, not faked) ----

/** Discover a REAL, resolvable historyBatchId for a record's `create` revision via the read-only
 *  history endpoint — the only HTTP-visible way for this pure-HTTP harness to obtain an anchor id
 *  (there is no DB access here). Works regardless of MULTITABLE_ENABLE_WRITER_FENCE's state (batch_id
 *  is stamped on every revision unconditionally); whether the returned id actually RESOLVES via
 *  `resolveExactAnchor` (sealed operation_id present) depends on the fence having been on at write time
 *  — that is the environment precondition the trust-substrate probe below checks for. */
async function discoverCreateBatchId(sheetId, recordId) {
  const hist = await api('GET', `/sheets/${sheetId}/records/${recordId}/history`, ADMIN)
  const items = hist.body?.data?.items || []
  const createEntry = items.find((it) => it.action === 'create')
  const batchId = createEntry?.batchId
  if (typeof batchId !== 'string' || !batchId) {
    throw new Error(
      `could not discover a historyBatchId for record ${recordId} via GET .../records/${recordId}/history ` +
      `(status=${hist.status}, items=${items.length}) — is ADMIN_TOKEN's record-history read gate reachable?`,
    )
  }
  return batchId
}

async function setup() {
  const stamp = Date.now()
  const base = await api('POST', '/bases', ADMIN, { name: `RESET-ACCEPT ${stamp}` })
  if (base.status !== 200 && base.status !== 201) throw new Error(`create base failed: ${base.status} ${JSON.stringify(base.body)}`)
  const baseId = base.body?.data?.id || base.body?.data?.base?.id || base.body?.id
  const sheet = await api('POST', '/sheets', ADMIN, { baseId, name: `RS ${stamp}` })
  if (sheet.status !== 200 && sheet.status !== 201) throw new Error(`create sheet failed: ${sheet.status} ${JSON.stringify(sheet.body)}`)
  const sheetId = sheet.body?.data?.id || sheet.body?.data?.sheet?.id || sheet.body?.id
  if (!baseId || !sheetId) throw new Error(`could not read baseId/sheetId from create responses (baseId=${baseId} sheetId=${sheetId})`)
  // fields (best-effort; the revert assertion in (g) needs at least one editable field)
  const f = await api('POST', '/fields', ADMIN, { sheetId, name: 'Salary', type: 'number' })
  const salaryId = f.body?.data?.id || f.body?.data?.field?.id || f.body?.id || null
  const mkRec = async (data, token = ADMIN) => {
    const r = await api('POST', '/records', token, { sheetId, data })
    return r.body?.data?.id || r.body?.data?.record?.id || r.body?.id || null
  }
  // pre-anchor records A,B
  const A = await mkRec(salaryId ? { [salaryId]: 100 } : { name: 'a' })
  const B = await mkRec(salaryId ? { [salaryId]: 200 } : { name: 'b' })
  // The anchor is B's OWN creation write (the LATER of the two pre-anchor writes) — strictly after A,B,
  // strictly before A's change + C,D below. Discovered via HTTP (no DB access from this harness); see
  // `discoverCreateBatchId` above.
  const anchorBatchId = await discoverCreateBatchId(sheetId, B)
  // post-anchor: change A (to test revert), create C,D (the delete-set)
  if (salaryId && A) await api('PATCH', `/records/${A}`, ADMIN, { sheetId, data: { [salaryId]: 999 } })
  const C = await mkRec(salaryId ? { [salaryId]: 300 } : { name: 'c' })
  // D is the lock-target scenario. When EDITOR_TOKEN is available, create it as the editor so an admin Reset is blocked
  // by a lock held by another actor. If D is admin-created/admin-locked, current lock semantics allow the creator/locker
  // to proceed, which would be a harness false negative rather than a Reset bug.
  const D = await mkRec(salaryId ? { [salaryId]: 400 } : { name: 'd' }, EDITOR || ADMIN)
  return { baseId, sheetId, salaryId, A, B, C, D, anchorBatchId, dLockedByEditor: Boolean(EDITOR) }
}

async function run() {
  log(`\nT8-2 Reset acceptance — ${BASE}${MOUNT}\n`)
  // ---- flag-state probe ----
  const ctx = await setup()
  const probe = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
  const flagOff = probe.status === 403 && code(probe) === 'RESET_DISABLED'

  if (flagOff) {
    log('Flag state: OFF (MULTITABLE_ENABLE_PIT_RESET not set). Running scenario (a) only.\n')
    ok('(a) flag-OFF reset-preview → 403 RESET_DISABLED', probe.status === 403 && code(probe) === 'RESET_DISABLED', `got ${probe.status}/${code(probe)}`)
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, buildResetExecuteBody({ previewIdentity: 'x', confirm: 'reset' }))
    ok('(a) flag-OFF reset-execute → 403 RESET_DISABLED', ex.status === 403 && code(ex) === 'RESET_DISABLED', `got ${ex.status}/${code(ex)}`)
    log('\n→ (a) covers the inert/off state. ENABLE MULTITABLE_ENABLE_PIT_RESET (+ MULTITABLE_ENABLE_WRITER_FENCE')
    log('  + MULTITABLE_HISTORY_CONTIGUITY_STRICT + a trust checkpoint on the target sheet) and re-run for (b)–(g).')
    return finish()
  }

  log('Flag state: ON. Running scenarios (b)–(g).\n')

  // ---- trust-substrate / covering-checkpoint precondition probe (config/setup, NOT a scenario) ----
  // detect, don't provision: this harness never flips a flag or mints a checkpoint on its own. A miss
  // here means every scenario below would fail for the SAME environmental reason, not seven distinct
  // bugs — report it once, precisely, and stop before manufacturing confusing noise.
  const substrateProbe = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
  const substrateCode = code(substrateProbe)
  if (substrateProbe.status === 409 && (substrateCode === 'RECOVERY_TRUST_REQUIRED' || substrateCode === 'NO_COVERING_CHECKPOINT')) {
    console.error(`\nFATAL (config/setup): reset-preview refused ${substrateCode} — the exact-anchor trust substrate is not ready on this environment.`)
    console.error('Remediation:')
    console.error('  - MULTITABLE_ENABLE_WRITER_FENCE=true and MULTITABLE_HISTORY_CONTIGUITY_STRICT=true must both')
    console.error('    be set on the target host (in addition to MULTITABLE_ENABLE_PIT_RESET).')
    if (substrateCode === 'NO_COVERING_CHECKPOINT') {
      console.error('  - a trust checkpoint must be activated for THIS sheet first: OWNER-GATED')
      console.error('    POST /sheets/:sheetId/trust-checkpoint-activate — see scripts/ops/multitable-o2-canary-drill.md')
      console.error('    §3 "L2-C" for the exact prerequisites and expected refusals.')
    }
    process.exitCode = 2
    return
  }
  if (substrateProbe.status !== 200) {
    console.error(`\nFATAL (config/setup): baseline reset-preview for the discovered anchor did not return 200 (got ${substrateProbe.status}/${substrateCode}).`)
    console.error('This usually means the discovered historyBatchId did not resolve — verify MULTITABLE_ENABLE_WRITER_FENCE')
    console.error('was already ON when this run\'s setup() created its records, and that no other environment issue is present.')
    console.error(`Response: ${JSON.stringify(substrateProbe.body)}`)
    process.exitCode = 2
    return
  }

  // (b) editor (not sheet-admin) → 403
  if (EDITOR) {
    const r = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, EDITOR, buildResetPreviewBody(ctx.anchorBatchId))
    ok('(b) editor reset-preview → 403 (D2 sheet-admin gate)', r.status === 403, `got ${r.status}/${code(r)}`)
  } else skipped('(b) editor → 403', 'EDITOR_TOKEN not provided')

  // (c) admin, execute WITHOUT confirm:'reset' → 400 (D4)
  {
    const r = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, buildResetExecuteBody({ previewIdentity: 'x' }))
    ok('(c) execute without confirm:"reset" → 400 RESET_CONFIRM_REQUIRED (D4 typed confirm)', r.status === 400 && code(r) === 'RESET_CONFIRM_REQUIRED', `got ${r.status}/${code(r)}`)
  }

  // (e) preview drift → 409 (delete-set re-enumeration); run before (d)/(g) so the sheet is still pristine
  {
    const pv = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
    const id1 = pv.body?.data?.previewIdentity
    const E = await api('POST', '/records', ADMIN, { sheetId: ctx.sheetId, data: ctx.salaryId ? { [ctx.salaryId]: 500 } : { name: 'e-drift' } })
    const Eid = E.body?.data?.id || E.body?.id
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, buildResetExecuteBody({ previewIdentity: id1, confirm: 'reset' }))
    ok('(e) post-preview new record → execute 409 (delete-set divergence)', ex.status === 409, `got ${ex.status}/${code(ex)}`)
    if (Eid) await api('DELETE', `/records/${Eid}`, ADMIN, { sheetId: ctx.sheetId }) // clean the drift record before re-checking
    const after = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
    const delAfter = after.body?.data?.deleteRecordIds || []
    ok('(e) nothing deleted on divergence (C,D still in the delete-set)', delAfter.includes(ctx.C) && delAfter.includes(ctx.D), `deleteRecordIds=${JSON.stringify(delAfter)}`)
  }

  // (d) locked post-T target → 409 RESET_BLOCKED + ZERO writes
  if (EDITOR && ctx.dLockedByEditor) {
    await api('POST', `/records/${ctx.D}/lock`, EDITOR, { sheetId: ctx.sheetId, locked: true })
    const pv = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
    const id = pv.body?.data?.previewIdentity
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, buildResetExecuteBody({ previewIdentity: id, confirm: 'reset' }))
    ok('(d) locked target → 409 RESET_BLOCKED', ex.status === 409 && /BLOCKED/.test(code(ex)), `got ${ex.status}/${code(ex)}`)
    await api('POST', `/records/${ctx.D}/lock`, EDITOR, { sheetId: ctx.sheetId, locked: false }) // unlock before re-checking + for (g)
    const after = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
    const delAfter = after.body?.data?.deleteRecordIds || []
    ok('(d) ZERO writes — C,D still live (in the delete-set)', delAfter.includes(ctx.C) && delAfter.includes(ctx.D), `deleteRecordIds=${JSON.stringify(delAfter)}`)
  } else skipped('(d) locked target → 409 RESET_BLOCKED', 'EDITOR_TOKEN not provided; admin-created/admin-locked records are editable by the locker/creator')

  // (f) ceiling → 413 — provisioned on a SEPARATE throwaway sheet so it NEVER pollutes the main sheet over-ceiling;
  // (g) then still runs on the clean main sheet → one flag-on run truly covers (b)–(g). (env-dependent on RESET_MAX_RECORDS.)
  if (MAXREC && MAXREC > 0 && MAXREC < 200) {
    const cs = await api('POST', '/sheets', ADMIN, { baseId: ctx.baseId, name: `RS-CEIL ${Date.now()}` })
    const csId = cs.body?.data?.id || cs.body?.data?.sheet?.id || cs.body?.id
    const cf = await api('POST', '/fields', ADMIN, { sheetId: csId, name: 'N', type: 'number' })
    const cfId = cf.body?.data?.id || cf.body?.data?.field?.id || cf.body?.id || null
    if (!csId) ok('(f) above-ceiling → 413 SHEET_TOO_LARGE', false, 'could not provision a separate ceiling sheet')
    else {
      for (let i = 0; i <= MAXREC; i++) await api('POST', '/records', ADMIN, { sheetId: csId, data: cfId ? { [cfId]: i } : { name: `big${i}` } })
      // ctx.anchorBatchId belongs to the MAIN sheet, not csId, and is never expected to RESOLVE here —
      // that's fine: enforceSheetRecoverySizeCeiling (the primary ceiling) runs BEFORE anchor resolution
      // in handleExactAnchorPreview, so only the request SHAPE needs to be valid (a non-blank
      // historyBatchId, no asOf) for this 413 assertion to exercise the intended discriminator.
      const pv = await api('POST', `/sheets/${csId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
      ok('(f) above-ceiling → 413 SHEET_TOO_LARGE (on a dedicated ceiling sheet)', pv.status === 413, `got ${pv.status}/${code(pv)}`)
    }
    // NO early return — fall through to (g) on the still-clean main sheet.
  } else skipped('(f) ceiling → 413', 'set RESET_MAX_RECORDS=<small> (matching staging MULTITABLE_SHEET_REVERT_MAX_RECORDS) to enable')

  // (g) HAPPY PATH → post-T soft-deleted (trash) + survivors reverted
  {
    const pv = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
    const id = pv.body?.data?.previewIdentity
    const delIds = pv.body?.data?.deleteRecordIds || []
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, buildResetExecuteBody({ previewIdentity: id, confirm: 'reset' }))
    ok('(g) happy-path execute → 2xx', ex.status >= 200 && ex.status < 300, `got ${ex.status}/${code(ex)}`)
    ok('(g) preview reported the post-T delete-set (C,D)', delIds.includes(ctx.C) && delIds.includes(ctx.D), `deleteRecordIds=${JSON.stringify(delIds)}`)
    const after = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, buildResetPreviewBody(ctx.anchorBatchId))
    const delAfter = after.body?.data?.deleteRecordIds || []
    const revertAfter = after.body?.data?.summary?.visibleRevertCount ?? -1
    ok('(g) post-T C,D soft-deleted (no longer in the delete-set after reset)', !delAfter.includes(ctx.C) && !delAfter.includes(ctx.D), `deleteRecordIds=${JSON.stringify(delAfter)}`)
    ok('(g) survivors reverted (no pending reverts at T after reset)', revertAfter === 0, `visibleRevertCount=${revertAfter}`)
    log('\n  NOTE: (g) asserts the LIVE effect only (post-T left the live delete-set + survivors reverted). Two things are')
    log('  covered by backend goldens, not re-asserted here: the `source=restore` revision write, and that C/D land in the')
    log('  recycle bin (`meta_records_trash`) — confirm the trash side once by hand; recoverable, not hard-deleted.')
  }
  return finish()
}

function finish() {
  log(`\n── summary: ${pass} passed, ${fail} failed, ${skip} skipped ──`)
  process.exitCode = fail > 0 ? 1 : 0
}

async function main() {
  if (!BASE || !ADMIN) { console.error('FATAL: BASE_URL and ADMIN_TOKEN are required.'); process.exitCode = 2; return }
  await run()
}

// Guard the entrypoint (same pattern as scripts/ops/multitable-recovery-schema-containment.mjs): importing
// this module for its exported pure body-builders (unit tests) must never execute the harness or exit the
// host process.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\nFATAL (setup or harness error):', e.message); process.exitCode = 2 })
}
