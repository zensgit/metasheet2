#!/usr/bin/env node
/**
 * Config-restore tier acceptance — staging harness for the three default-off config-restore tiers that ship
 * built + real-DB-golden-tested but have NO staging acceptance harness yet:
 *
 *   1. config-uncreate       MULTITABLE_ENABLE_CONFIG_UNCREATE     — drop a created field/view (typed confirm, permanent)
 *   2. config-undelete       MULTITABLE_ENABLE_CONFIG_UNDELETE     — definition-only recreate of a deleted field/view
 *   3. permission-revert     MULTITABLE_ENABLE_PERMISSION_REVERT   — de-escalation-only permission rollback
 *
 * All three are driven through the SAME product routes (`POST /sheets/:id/config-restore-preview` +
 * `…/config-restore-execute`), branching on `revisionId`'s entity/action shape (see
 * packages/core-backend/src/multitable/config-restore.ts + the `isSupported*`/`isPermissionRevert` predicates and
 * packages/core-backend/src/routes/univer-meta.ts `config-restore-preview`/`config-restore-execute`).
 *
 * This is NOT a production enablement switch. It creates ONE throwaway base + sheet (never the operator's real
 * data), drives real config-changing routes to build the precondition history each tier needs (create/delete a
 * field, grant/re-grant a permission), then previews + executes through the real preview-identity/typed-confirm
 * machinery. See docs/development/multitable-config-tier-acceptance-runbook-20260705.md.
 *
 * Usage:
 *   BASE_URL=https://staging.example ADMIN_TOKEN=<sheet-admin-jwt> [EDITOR_TOKEN=<jwt>] \
 *     node packages/core-backend/scripts/config-tier-acceptance.mjs
 *
 *   ADMIN_TOKEN  — a sheet-admin (canManageSheetAccess / multitable:share, so it can manage fields/views/perms
 *                  on a sheet it creates). REQUIRED.
 *   EDITOR_TOKEN — any OTHER authenticated user's token. Optional; used ONLY as a safe de-escalation TARGET
 *                  subject for the permission-revert tier (never granted anything beyond the throwaway sheet).
 *                  The permission-revert tier SKIPS cleanly in full if absent — there is no safe way to pick a
 *                  grant subject without it.
 *
 * Flag handling: EACH tier independently detects its own flag state from the server's first real response (a
 * 403 <TIER>_DISABLED on the tier's own first preview routes it to the flag-off assertions; anything else runs
 * the flag-on walk + negatives). One binary run therefore covers both staging postures for all three tiers,
 * whichever combination is currently enabled.
 *
 * Exit: 0 = all run scenarios passed; 1 = a scenario failed; 2 = config/setup error.
 */

const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '')
const ADMIN = process.env.ADMIN_TOKEN
const EDITOR = process.env.EDITOR_TOKEN || null
const MOUNT = process.env.CONFIG_TIER_API_MOUNT || '/api/multitable'
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
// /api/auth/me is outside the multitable mount — used ONLY to resolve EDITOR_TOKEN's own user id (a safe,
// self-describing lookup; never touches any other account).
async function authApi(path, token) {
  let res, json = null
  try {
    res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } })
  } catch (e) { return { status: 0, body: { error: { message: String(e) } } } }
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, body: json }
}
const code = (r) => r?.body?.error?.code || ''
const data = (r) => r?.body?.data || {}

async function setup() {
  const stamp = Date.now()
  const base = await api('POST', '/bases', ADMIN, { name: `CONFIG-TIER-ACCEPT ${stamp}` })
  if (base.status !== 200 && base.status !== 201) throw new Error(`create base failed: ${base.status} ${JSON.stringify(base.body)}`)
  const baseId = base.body?.data?.id || base.body?.data?.base?.id || base.body?.id
  const sheet = await api('POST', '/sheets', ADMIN, { baseId, name: `CT ${stamp}` })
  if (sheet.status !== 200 && sheet.status !== 201) throw new Error(`create sheet failed: ${sheet.status} ${JSON.stringify(sheet.body)}`)
  const sheetId = sheet.body?.data?.id || sheet.body?.data?.sheet?.id || sheet.body?.id
  if (!baseId || !sheetId) throw new Error(`could not read baseId/sheetId from create responses (baseId=${baseId} sheetId=${sheetId})`)
  return { baseId, sheetId }
}

async function createField(sheetId, name, opts = {}) {
  const r = await api('POST', '/fields', ADMIN, { sheetId, name, type: 'string', ...opts })
  const id = r.body?.data?.field?.id || r.body?.data?.id || r.body?.id
  if (r.status !== 200 && r.status !== 201) throw new Error(`create field '${name}' failed: ${r.status} ${JSON.stringify(r.body)}`)
  return { id, row: r.body?.data?.field }
}

async function listFields(sheetId) {
  const r = await api('GET', `/fields?sheetId=${encodeURIComponent(sheetId)}`, ADMIN)
  return r.body?.data?.fields || []
}

// Find a config-history revision by entityId+action (entityType='field'). The list is small for a throwaway
// sheet, so the default page (50, DESC by created_at) is always sufficient — no pagination needed.
async function findFieldRevision(sheetId, entityId, action) {
  const r = await api('GET', `/sheets/${sheetId}/config-history?entityType=field&limit=50`, ADMIN)
  const items = r.body?.data?.items || []
  const hit = items.find((it) => it.entityId === entityId && it.action === action)
  if (!hit) throw new Error(`could not find a '${action}' config-history revision for field ${entityId} (items=${items.length})`)
  return hit.id
}

async function preview(sheetId, revisionId) {
  return api('POST', `/sheets/${sheetId}/config-restore-preview`, ADMIN, { revisionId })
}
async function execute(sheetId, revisionId, previewToken, confirm) {
  const body = { revisionId, previewToken }
  if (confirm !== undefined) body.confirm = confirm
  return api('POST', `/sheets/${sheetId}/config-restore-execute`, ADMIN, body)
}

// ── Tier 1: config-uncreate (MULTITABLE_ENABLE_CONFIG_UNCREATE) ──────────────────────────────────────────────
// Route: univer-meta.ts config-restore-preview `isSupportedUncreate(rev)` branch (~8105) / config-restore-execute
// `isSupportedUncreate(rev)` branch (~8254). Predicate: config-restore.ts `isSupportedUncreate` (create action,
// field|view entity_type).
async function runUncreateTier(ctx) {
  log('\n── Tier: config-uncreate (MULTITABLE_ENABLE_CONFIG_UNCREATE) ──\n')
  const happy = await createField(ctx.sheetId, `CU-Happy-${Date.now()}`)
  const revHappy = await findFieldRevision(ctx.sheetId, happy.id, 'create')

  const probe = await preview(ctx.sheetId, revHappy)
  const flagOff = probe.status === 403 && code(probe) === 'CONFIG_UNCREATE_DISABLED'

  if (flagOff) {
    log('Flag state: OFF (MULTITABLE_ENABLE_CONFIG_UNCREATE not set).\n')
    ok('(uncreate/i) flag-OFF preview → 403 CONFIG_UNCREATE_DISABLED', flagOff, `got ${probe.status}/${code(probe)}`)
    const ex = await execute(ctx.sheetId, revHappy, 'x', 'uncreate')
    ok('(uncreate/i) flag-OFF execute → 403 CONFIG_UNCREATE_DISABLED', ex.status === 403 && code(ex) === 'CONFIG_UNCREATE_DISABLED', `got ${ex.status}/${code(ex)}`)
    skipped('(uncreate/ii) flag-on happy walk', 'MULTITABLE_ENABLE_CONFIG_UNCREATE is off')
    skipped('(uncreate/iii) key negatives', 'MULTITABLE_ENABLE_CONFIG_UNCREATE is off')
    return
  }

  log('Flag state: ON.\n')

  // (ii) flag-on happy walk
  {
    const pv = await preview(ctx.sheetId, revHappy)
    ok('(uncreate/ii) preview → 200', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    const u = data(pv).uncreate || {}
    ok('(uncreate/ii) preview names the entity (masked diff, no counts/plan fields)', u.entityType === 'field' && u.entityId === happy.id && typeof u.note === 'string' && !('plan' in u) && !('cascadeViewIds' in u) && !('columnDataPresent' in u), JSON.stringify(u))
    const token = data(pv).previewToken
    ok('(uncreate/ii) preview returns a previewToken', typeof token === 'string' && token.length > 20, 'missing previewToken')

    const noConfirm = await execute(ctx.sheetId, revHappy, token)
    ok('(uncreate/iii) execute without confirm → 400 CONFIRM_REQUIRED', noConfirm.status === 400 && code(noConfirm) === 'CONFIRM_REQUIRED', `got ${noConfirm.status}/${code(noConfirm)}`)
    const wrongConfirm = await execute(ctx.sheetId, revHappy, token, 'yes')
    ok('(uncreate/iii) execute with wrong confirm → 400 CONFIRM_REQUIRED', wrongConfirm.status === 400 && code(wrongConfirm) === 'CONFIRM_REQUIRED', `got ${wrongConfirm.status}/${code(wrongConfirm)}`)

    const ex = await execute(ctx.sheetId, revHappy, token, 'uncreate')
    ok('(uncreate/ii) execute with confirm:"uncreate" → 200', ex.status === 200, `got ${ex.status}/${code(ex)}`)
    ok('(uncreate/ii) execute reports the dropped entity', data(ex).uncreated?.entityType === 'field' && data(ex).uncreated?.entityId === happy.id, JSON.stringify(data(ex).uncreated || {}))
    const fieldsAfter = await listFields(ctx.sheetId)
    ok('(uncreate/ii) follow-up read: field is gone', !fieldsAfter.some((f) => f.id === happy.id), `fields=${JSON.stringify(fieldsAfter.map((f) => f.id))}`)
  }

  // (iii) key negative: PLAN_DRIFT (a stale token — the preview's blast-radius plan changed before execute).
  // computeUncreatePlan's `columnDataPresent` flips true once ANY record carries a non-null value under the
  // field's key (univer-meta.ts ~6054) — driving it does not require deleting/touching the happy-path field.
  {
    const neg = await createField(ctx.sheetId, `CU-Neg-${Date.now()}`)
    const revNeg = await findFieldRevision(ctx.sheetId, neg.id, 'create')
    const pv = await preview(ctx.sheetId, revNeg)
    ok('(uncreate/iii) negative-fixture preview → 200', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    const staleToken = data(pv).previewToken
    await api('POST', '/records', ADMIN, { sheetId: ctx.sheetId, data: { [neg.id]: 'drift' } })
    const ex = await execute(ctx.sheetId, revNeg, staleToken, 'uncreate')
    ok('(uncreate/iii) stale token after blast-radius drift → 409 PLAN_DRIFT', ex.status === 409 && code(ex) === 'PLAN_DRIFT', `got ${ex.status}/${code(ex)}`)
    const fieldsAfter = await listFields(ctx.sheetId)
    ok('(uncreate/iii) zero writes on drift — field still present', fieldsAfter.some((f) => f.id === neg.id), `fields=${JSON.stringify(fieldsAfter.map((f) => f.id))}`)
  }
}

// ── Tier 2: config-undelete (MULTITABLE_ENABLE_CONFIG_UNDELETE) ──────────────────────────────────────────────
// Route: univer-meta.ts config-restore-preview `isSupportedUndelete(rev)` branch (~8123) / config-restore-execute
// `isSupportedUndelete(rev)` branch (~8308). Predicate: config-restore.ts `isSupportedUndelete` (delete action,
// field|view entity_type).
async function runUndeleteTier(ctx) {
  log('\n── Tier: config-undelete (MULTITABLE_ENABLE_CONFIG_UNDELETE) ──\n')
  const happy = await createField(ctx.sheetId, `CD-Happy-${Date.now()}`)
  await api('DELETE', `/fields/${happy.id}`, ADMIN)
  const revHappy = await findFieldRevision(ctx.sheetId, happy.id, 'delete')

  const probe = await preview(ctx.sheetId, revHappy)
  const flagOff = probe.status === 403 && code(probe) === 'CONFIG_UNDELETE_DISABLED'

  if (flagOff) {
    log('Flag state: OFF (MULTITABLE_ENABLE_CONFIG_UNDELETE not set).\n')
    ok('(undelete/i) flag-OFF preview → 403 CONFIG_UNDELETE_DISABLED', flagOff, `got ${probe.status}/${code(probe)}`)
    const ex = await execute(ctx.sheetId, revHappy, 'x', 'undelete')
    ok('(undelete/i) flag-OFF execute → 403 CONFIG_UNDELETE_DISABLED', ex.status === 403 && code(ex) === 'CONFIG_UNDELETE_DISABLED', `got ${ex.status}/${code(ex)}`)
    skipped('(undelete/ii) flag-on happy walk', 'MULTITABLE_ENABLE_CONFIG_UNDELETE is off')
    skipped('(undelete/iii) key negatives', 'MULTITABLE_ENABLE_CONFIG_UNDELETE is off')
    return
  }

  log('Flag state: ON.\n')

  // (ii) flag-on happy walk
  {
    const pv = await preview(ctx.sheetId, revHappy)
    ok('(undelete/ii) preview → 200', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    const u = data(pv).undelete || {}
    ok('(undelete/ii) preview names the entity + idCollision flag (masked, no plan fields)', u.entityType === 'field' && u.entityId === happy.id && typeof u.note === 'string' && u.idCollision === false && !('insertOrder' in u) && !('trailingShiftIds' in u), JSON.stringify(u))
    const token = data(pv).previewToken
    ok('(undelete/ii) preview returns a previewToken', typeof token === 'string' && token.length > 20, 'missing previewToken')

    const noConfirm = await execute(ctx.sheetId, revHappy, token)
    ok('(undelete/iii) execute without confirm → 400 CONFIRM_REQUIRED', noConfirm.status === 400 && code(noConfirm) === 'CONFIRM_REQUIRED', `got ${noConfirm.status}/${code(noConfirm)}`)
    const wrongConfirm = await execute(ctx.sheetId, revHappy, token, 'yes')
    ok('(undelete/iii) execute with wrong confirm → 400 CONFIRM_REQUIRED', wrongConfirm.status === 400 && code(wrongConfirm) === 'CONFIRM_REQUIRED', `got ${wrongConfirm.status}/${code(wrongConfirm)}`)

    const ex = await execute(ctx.sheetId, revHappy, token, 'undelete')
    ok('(undelete/ii) execute with confirm:"undelete" → 200', ex.status === 200, `got ${ex.status}/${code(ex)}`)
    ok('(undelete/ii) execute reports the recreated entity', data(ex).undeleted?.entityType === 'field' && data(ex).undeleted?.entityId === happy.id, JSON.stringify(data(ex).undeleted || {}))
    const fieldsAfter = await listFields(ctx.sheetId)
    const recreated = fieldsAfter.find((f) => f.id === happy.id)
    ok('(undelete/ii) follow-up read: field definition is back (name/type)', recreated?.type === 'string', JSON.stringify(recreated || null))
  }

  // (iii) key negative 1: ID_COLLISION (a "foreign" occupant of the same id — the deleted field's id is taken
  // before the undelete lands). Checked FIRST in execute, before the plan-hash verify (univer-meta.ts ~8321).
  {
    const neg = await createField(ctx.sheetId, `CD-Neg-${Date.now()}`)
    await api('DELETE', `/fields/${neg.id}`, ADMIN)
    const revNeg = await findFieldRevision(ctx.sheetId, neg.id, 'delete')
    const pv = await preview(ctx.sheetId, revNeg)
    ok('(undelete/iii) collision-fixture preview → 200', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    const token = data(pv).previewToken
    await api('POST', '/fields', ADMIN, { sheetId: ctx.sheetId, id: neg.id, name: 'squatter', type: 'string' })
    const ex = await execute(ctx.sheetId, revNeg, token, 'undelete')
    ok('(undelete/iii) id occupied by a foreign entity → 409 ID_COLLISION', ex.status === 409 && code(ex) === 'ID_COLLISION', `got ${ex.status}/${code(ex)}`)
  }

  // (iii) key negative 2: PLAN_DRIFT (a genuinely stale token — the recreate plan's trailing order-shift set
  // changed since preview, computeUndeletePlan ~6075). The id stays FREE here (distinct from the collision case
  // above), so this exercises the plan-hash verify itself, not the earlier occupied-id short-circuit.
  {
    const drift = await createField(ctx.sheetId, `CD-Drift-${Date.now()}`)
    const insertOrder = Number(drift.row?.order ?? 0)
    await api('DELETE', `/fields/${drift.id}`, ADMIN)
    const revDrift = await findFieldRevision(ctx.sheetId, drift.id, 'delete')
    const pv = await preview(ctx.sheetId, revDrift)
    ok('(undelete/iii) drift-fixture preview → 200', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    const token = data(pv).previewToken
    // Insert a filler field back at the SAME order — it lands in the trailing order-shift set the recreate plan
    // depends on, so the plan hash no longer matches what the token was minted against.
    await createField(ctx.sheetId, `CD-Filler-${Date.now()}`, { order: insertOrder })
    const ex = await execute(ctx.sheetId, revDrift, token, 'undelete')
    ok('(undelete/iii) stale token after order-shift drift → 409 PLAN_DRIFT', ex.status === 409 && code(ex) === 'PLAN_DRIFT', `got ${ex.status}/${code(ex)}`)
  }
}

// ── Tier 3: permission-revert (MULTITABLE_ENABLE_PERMISSION_REVERT) ──────────────────────────────────────────
// Route: univer-meta.ts config-restore-preview `isPermissionRevert(rev)` branch (~8142) / config-restore-execute
// `isPermissionRevert(rev)` branch (~8355). Automates the 5 smoke points in
// docs/development/multitable-permission-revert-flagon-smoke-runbook-20260630.md.
async function runPermissionRevertTier(ctx) {
  log('\n── Tier: permission-revert (MULTITABLE_ENABLE_PERMISSION_REVERT) ──\n')
  if (!EDITOR) {
    skipped('(perm-revert/i) flag-OFF contract', 'EDITOR_TOKEN not provided — no safe de-escalation subject to grant')
    skipped('(perm-revert/ii) flag-on de-escalation walk', 'EDITOR_TOKEN not provided')
    skipped('(perm-revert/iii) key negatives (confirm/drift/escalation)', 'EDITOR_TOKEN not provided')
    return
  }
  const me = await authApi('/api/auth/me', EDITOR)
  const subjectId = me.body?.data?.user?.id
  if (me.status !== 200 || !subjectId) {
    skipped('(perm-revert) whole tier', `could not resolve EDITOR_TOKEN's own user id via GET /api/auth/me (status=${me.status})`)
    return
  }

  const grant = (accessLevel) => api('PUT', `/sheets/${ctx.sheetId}/permissions/user/${subjectId}`, ADMIN, { accessLevel })
  const permissions = async () => (await api('GET', `/sheets/${ctx.sheetId}/permissions`, ADMIN)).body?.data?.items || []
  const findPermRevision = async (action) => {
    const r = await api('GET', `/sheets/${ctx.sheetId}/config-history?entityType=permission&limit=50`, ADMIN)
    const items = (r.body?.data?.items || []).filter((it) => it.entityId?.startsWith('sheet:') && it.entityId?.includes(subjectId))
    const hit = items.find((it) => it.action === action)
    if (!hit) throw new Error(`could not find a permission config-history revision (action=${action}, items=${items.length})`)
    return hit.id
  }

  // Grant 'read' — the create-permission revision (before=null, after=read) is itself already a de-escalatable
  // change: relative to a LOWER live grant its `before` (null/no-access) reverts DOWN. Used for the flag probe +
  // the happy path.
  const g1 = await grant('read')
  ok('(perm-revert/setup) grant EDITOR read on the throwaway sheet → 200', g1.status === 200, `got ${g1.status}/${code(g1)}`)
  const revHappy = await findPermRevision('create')

  const probe = await preview(ctx.sheetId, revHappy)
  const flagOff = probe.status === 403 && code(probe) === 'PERMISSION_REVERT_DISABLED'

  if (flagOff) {
    log('Flag state: OFF (MULTITABLE_ENABLE_PERMISSION_REVERT not set).\n')
    ok('(perm-revert/i) flag-OFF preview → 403 PERMISSION_REVERT_DISABLED', flagOff, `got ${probe.status}/${code(probe)}`)
    const ex = await execute(ctx.sheetId, revHappy, 'x', 'revert-permission')
    ok('(perm-revert/i) flag-OFF execute → 403 PERMISSION_REVERT_DISABLED', ex.status === 403 && code(ex) === 'PERMISSION_REVERT_DISABLED', `got ${ex.status}/${code(ex)}`)
    skipped('(perm-revert/ii) flag-on de-escalation walk', 'MULTITABLE_ENABLE_PERMISSION_REVERT is off')
    skipped('(perm-revert/iii) key negatives', 'MULTITABLE_ENABLE_PERMISSION_REVERT is off')
    return
  }

  log('Flag state: ON.\n')

  // (ii) flag-on happy walk: de-escalation null→read reverted back to none (a full revoke).
  {
    const pv = await preview(ctx.sheetId, revHappy)
    ok('(perm-revert/ii) preview → 200', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    const pr = data(pv).permissionRevert || {}
    ok('(perm-revert/ii) direction=de-escalation, supported=true, masked (no raw grant)', pr.scope === 'sheet' && pr.direction === 'de-escalation' && pr.supported === true && typeof pr.note === 'string' && !('before' in pr) && !('after' in pr) && !('accessLevel' in pr), JSON.stringify(pr))
    const token = data(pv).previewToken

    const noConfirm = await execute(ctx.sheetId, revHappy, token)
    ok('(perm-revert/iii) execute without confirm → 400 CONFIRM_REQUIRED', noConfirm.status === 400 && code(noConfirm) === 'CONFIRM_REQUIRED', `got ${noConfirm.status}/${code(noConfirm)}`)
    const wrongConfirm = await execute(ctx.sheetId, revHappy, token, 'revert')
    ok('(perm-revert/iii) execute with wrong confirm → 400 CONFIRM_REQUIRED', wrongConfirm.status === 400 && code(wrongConfirm) === 'CONFIRM_REQUIRED', `got ${wrongConfirm.status}/${code(wrongConfirm)}`)

    const ex = await execute(ctx.sheetId, revHappy, token, 'revert-permission')
    ok('(perm-revert/ii) execute with confirm:"revert-permission" → 200', ex.status === 200, `got ${ex.status}/${code(ex)}`)
    ok('(perm-revert/ii) execute reports the reverted subject', data(ex).permissionReverted?.scope === 'sheet' && data(ex).permissionReverted?.entityId?.includes(subjectId), JSON.stringify(data(ex).permissionReverted || {}))
    const after = await permissions()
    ok('(perm-revert/ii) follow-up read: grant fully revoked (no entry)', !after.some((e) => e.subjectType === 'user' && e.subjectId === subjectId), JSON.stringify(after))
  }

  // (iii) key negative: escalation attempt → 422 RESTORE_NOT_SUPPORTED (never-escalate, checked against the LIVE
  // grant). Build a revision whose `before` is HIGHER than the current live grant: write→read, with live now read.
  {
    const gw = await grant('write') // live: none → write (create revision; not used directly)
    ok('(perm-revert/iii) escalation-fixture: grant write → 200', gw.status === 200, `got ${gw.status}/${code(gw)}`)
    const gr = await grant('read') // live: write → read (update revision: before=write, after=read)
    ok('(perm-revert/iii) escalation-fixture: grant read (down from write) → 200', gr.status === 200, `got ${gr.status}/${code(gr)}`)
    const revEsc = await findPermRevision('update')
    const pv = await preview(ctx.sheetId, revEsc)
    ok('(perm-revert/iii) escalation preview → 200', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    const pr = data(pv).permissionRevert || {}
    ok('(perm-revert/iii) direction=escalation, supported=false (before=write > live=read)', pr.direction === 'escalation' && pr.supported === false, JSON.stringify(pr))
    const token = data(pv).previewToken
    const ex = await execute(ctx.sheetId, revEsc, token, 'revert-permission')
    ok('(perm-revert/iii) escalation execute → 422 RESTORE_NOT_SUPPORTED', ex.status === 422 && code(ex) === 'RESTORE_NOT_SUPPORTED', `got ${ex.status}/${code(ex)}`)
    const afterEsc = await permissions()
    const entry = afterEsc.find((e) => e.subjectType === 'user' && e.subjectId === subjectId)
    ok('(perm-revert/iii) grant unchanged after refused escalation (still read)', entry?.accessLevel === 'read', JSON.stringify(entry || null))

    // (iii) key negative: GRANT_DRIFT (a stale token — the live grant changed between preview and execute).
    const pv2 = await preview(ctx.sheetId, revEsc)
    ok('(perm-revert/iii) drift-fixture preview → 200', pv2.status === 200, `got ${pv2.status}/${code(pv2)}`)
    const token2 = data(pv2).previewToken
    const gd = await grant('write') // live moves again after the preview token was minted
    ok('(perm-revert/iii) drift-fixture: grant write (post-preview change) → 200', gd.status === 200, `got ${gd.status}/${code(gd)}`)
    const ex2 = await execute(ctx.sheetId, revEsc, token2, 'revert-permission')
    ok('(perm-revert/iii) stale token after grant drift → 409 GRANT_DRIFT', ex2.status === 409 && code(ex2) === 'GRANT_DRIFT', `got ${ex2.status}/${code(ex2)}`)
  }
}

async function cleanup(ctx) {
  if (!ctx?.sheetId) return
  const del = await api('DELETE', `/sheets/${ctx.sheetId}`, ADMIN)
  log(`\nCleanup: DELETE throwaway sheet ${ctx.sheetId} → ${del.status}${del.status !== 200 ? ` ${JSON.stringify(del.body)}` : ''}`)
  log(`(The throwaway base ${ctx.baseId} is left in place — no DELETE /bases route exists; it is inert metadata, matching the pattern of the existing reset-acceptance/pit-undelete-acceptance harnesses.)`)
}

async function run() {
  log(`\nConfig-tier acceptance — ${BASE}${MOUNT}\n`)
  const ctx = await setup()
  log(`Throwaway base: ${ctx.baseId}`)
  log(`Throwaway sheet: ${ctx.sheetId}\n`)
  try {
    await runUncreateTier(ctx)
    await runUndeleteTier(ctx)
    await runPermissionRevertTier(ctx)
  } finally {
    await cleanup(ctx)
  }
}

function finish() {
  log(`\n── summary: ${pass} passed, ${fail} failed, ${skip} skipped ──`)
  process.exit(fail > 0 ? 1 : 0)
}

run().then(finish).catch((e) => { console.error('\nFATAL (setup or harness error):', e.message); process.exit(2) })
