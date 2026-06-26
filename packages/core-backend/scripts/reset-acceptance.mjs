#!/usr/bin/env node
/**
 * T8-2 Reset-to-T — staging acceptance harness (one-click error-code + behavior evidence).
 *
 * Reset is DESTRUCTIVE: it reverts surviving records to their state at T AND soft-deletes records
 * created after T (into the recycle bin / meta_records_trash — recoverable, NOT a normal Revert).
 * This harness proves, against a real environment, that the flag gate + error codes + delete behavior
 * are correct BEFORE the flag is enabled for any real scope. See
 * docs/development/multitable-t8-2-reset-acceptance-runbook-20260625.md.
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
 * MULTITABLE_ENABLE_PIT_RESET and run AGAIN (runs (b)-(g)). The harness auto-detects the flag state and
 * runs the matching scenarios.
 *
 * Exit: 0 = all run scenarios passed; 1 = a scenario failed; 2 = config/setup error.
 */

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '')
const ADMIN = process.env.ADMIN_TOKEN
const EDITOR = process.env.EDITOR_TOKEN || null
const MAXREC = process.env.RESET_MAX_RECORDS ? Number(process.env.RESET_MAX_RECORDS) : null
const MOUNT = process.env.RESET_API_MOUNT || '/api/multitable'
if (!BASE || !ADMIN) { console.error('FATAL: BASE_URL and ADMIN_TOKEN are required.'); process.exit(2) }

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const code = (r) => r?.body?.error?.code || ''

// ---- setup (HTTP self-provision; any step without a clean API is documented in the runbook, not faked) ----
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
  // pre-T records A,B
  const A = await mkRec(salaryId ? { [salaryId]: 100 } : { name: 'a' })
  const B = await mkRec(salaryId ? { [salaryId]: 200 } : { name: 'b' })
  await sleep(1200)
  const T = new Date().toISOString() // asOf — strictly after A,B, strictly before C,D + the A change
  await sleep(1200)
  // post-T: change A (to test revert), create C,D (the delete-set)
  if (salaryId && A) await api('PATCH', `/records/${A}`, ADMIN, { sheetId, data: { [salaryId]: 999 } })
  const C = await mkRec(salaryId ? { [salaryId]: 300 } : { name: 'c' })
  // D is the lock-target scenario. When EDITOR_TOKEN is available, create it as the editor so an admin Reset is blocked
  // by a lock held by another actor. If D is admin-created/admin-locked, current lock semantics allow the creator/locker
  // to proceed, which would be a harness false negative rather than a Reset bug.
  const D = await mkRec(salaryId ? { [salaryId]: 400 } : { name: 'd' }, EDITOR || ADMIN)
  return { baseId, sheetId, salaryId, A, B, C, D, T, dLockedByEditor: Boolean(EDITOR) }
}

async function run() {
  log(`\nT8-2 Reset acceptance — ${BASE}${MOUNT}\n`)
  // ---- flag-state probe ----
  const ctx = await setup()
  const probe = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, { asOf: ctx.T })
  const flagOff = probe.status === 403 && code(probe) === 'RESET_DISABLED'

  if (flagOff) {
    log('Flag state: OFF (MULTITABLE_ENABLE_PIT_RESET not set). Running scenario (a) only.\n')
    ok('(a) flag-OFF reset-preview → 403 RESET_DISABLED', probe.status === 403 && code(probe) === 'RESET_DISABLED', `got ${probe.status}/${code(probe)}`)
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, { asOf: ctx.T, previewIdentity: 'x', confirm: 'reset' })
    ok('(a) flag-OFF reset-execute → 403 RESET_DISABLED', ex.status === 403 && code(ex) === 'RESET_DISABLED', `got ${ex.status}/${code(ex)}`)
    log('\n→ (a) covers the inert/off state. ENABLE MULTITABLE_ENABLE_PIT_RESET and re-run for (b)–(g).')
    return finish()
  }

  log('Flag state: ON. Running scenarios (b)–(g).\n')

  // (b) editor (not sheet-admin) → 403
  if (EDITOR) {
    const r = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, EDITOR, { asOf: ctx.T })
    ok('(b) editor reset-preview → 403 (D2 sheet-admin gate)', r.status === 403, `got ${r.status}/${code(r)}`)
  } else skipped('(b) editor → 403', 'EDITOR_TOKEN not provided')

  // (c) admin, execute WITHOUT confirm:'reset' → 400 (D4)
  {
    const r = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, { asOf: ctx.T, previewIdentity: 'x' })
    ok('(c) execute without confirm:"reset" → 400 (D4 typed confirm)', r.status === 400, `got ${r.status}/${code(r)}`)
  }

  // (e) preview drift → 409 (delete-set re-enumeration); run before (d)/(g) so the sheet is still pristine
  {
    const pv = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, { asOf: ctx.T })
    const id1 = pv.body?.data?.previewIdentity
    const E = await api('POST', '/records', ADMIN, { sheetId: ctx.sheetId, data: ctx.salaryId ? { [ctx.salaryId]: 500 } : { name: 'e-drift' } })
    const Eid = E.body?.data?.id || E.body?.id
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, { asOf: ctx.T, previewIdentity: id1, confirm: 'reset' })
    ok('(e) post-preview new record → execute 409 (delete-set divergence)', ex.status === 409, `got ${ex.status}/${code(ex)}`)
    if (Eid) await api('DELETE', `/records/${Eid}`, ADMIN, { sheetId: ctx.sheetId }) // clean the drift record before re-checking
    const after = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, { asOf: ctx.T })
    const delAfter = after.body?.data?.deleteRecordIds || []
    ok('(e) nothing deleted on divergence (C,D still in the delete-set)', delAfter.includes(ctx.C) && delAfter.includes(ctx.D), `deleteRecordIds=${JSON.stringify(delAfter)}`)
  }

  // (d) locked post-T target → 409 RESET_BLOCKED + ZERO writes
  if (EDITOR && ctx.dLockedByEditor) {
    await api('POST', `/records/${ctx.D}/lock`, EDITOR, { sheetId: ctx.sheetId, locked: true })
    const pv = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, { asOf: ctx.T })
    const id = pv.body?.data?.previewIdentity
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, { asOf: ctx.T, previewIdentity: id, confirm: 'reset' })
    ok('(d) locked target → 409 RESET_BLOCKED', ex.status === 409 && /BLOCKED/.test(code(ex)), `got ${ex.status}/${code(ex)}`)
    await api('POST', `/records/${ctx.D}/lock`, EDITOR, { sheetId: ctx.sheetId, locked: false }) // unlock before re-checking + for (g)
    const after = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, { asOf: ctx.T })
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
      const pv = await api('POST', `/sheets/${csId}/reset-preview`, ADMIN, { asOf: ctx.T })
      ok('(f) above-ceiling → 413 SHEET_TOO_LARGE (on a dedicated ceiling sheet)', pv.status === 413, `got ${pv.status}/${code(pv)}`)
    }
    // NO early return — fall through to (g) on the still-clean main sheet.
  } else skipped('(f) ceiling → 413', 'set RESET_MAX_RECORDS=<small> (matching staging MULTITABLE_SHEET_REVERT_MAX_RECORDS) to enable')

  // (g) HAPPY PATH → post-T soft-deleted (trash) + survivors reverted
  {
    const pv = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, { asOf: ctx.T })
    const id = pv.body?.data?.previewIdentity
    const delIds = pv.body?.data?.deleteRecordIds || []
    const ex = await api('POST', `/sheets/${ctx.sheetId}/reset-execute`, ADMIN, { asOf: ctx.T, previewIdentity: id, confirm: 'reset' })
    ok('(g) happy-path execute → 2xx', ex.status >= 200 && ex.status < 300, `got ${ex.status}/${code(ex)}`)
    ok('(g) preview reported the post-T delete-set (C,D)', delIds.includes(ctx.C) && delIds.includes(ctx.D), `deleteRecordIds=${JSON.stringify(delIds)}`)
    const after = await api('POST', `/sheets/${ctx.sheetId}/reset-preview`, ADMIN, { asOf: ctx.T })
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
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => { console.error('\nFATAL (setup or harness error):', e.message); process.exit(2) })
