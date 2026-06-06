#!/usr/bin/env node
// S2-3 staging smoke — ② 打卡策略组 / 内外勤卡合并 (in/out merge).
//
// Validates the S2 in/out-merge runtime + admin-UI chain end-to-end on real staging:
//   S2-0 #2329 (reserved outdoor_approval source) · S2-1 #2333 (merge engine) ·
//   record-only fix #2336 · S2-2 #2344 (admin card). Completion口径 for the tracker row 🟡 → ✅.
//
// What it proves (mirrors the merged real-DB integration "positive merge" case, against staging):
//   With BOTH merge keys on, on one workDate seed an internal punch pair AND an approved-outdoor punch
//   pair, then assert the derived record picks first-in from the INTERNAL punch (internalWinsOnIn) and
//   last-out from the OUTDOOR punch (externalWinsOnOut); the four punch events are UNCHANGED (the merge
//   never rewrites attendance_events); the real read path (GET /records, /summary) FOLLOWS the recomputed
//   record. Default keys-off ≡ no change is already locked by the integration suite — not re-proven here.
//
// Seed timeline (UTC, all on WORK_DATE — a past weekday, so the /punch future-guard never fires):
//   outdoor check_in 08:50 · internal check_in 09:05 · outdoor check_out 18:30 · internal check_out 19:00
//   internalWinsOnIn → first_in_at = 09:05 ; externalWinsOnOut → last_out_at = 18:30 ; window = 565 min (work_minutes = computeMetrics over it, asserted ≤565).
//
// HOW IT TALKS TO STAGING:
//   - Drives the REAL user-facing flow over HTTP: PUT settings, create approval-flow, /punch, approve.
//   - ONE per-user admin-role token IS the subject (mirrors the comp-leave staging smokes): it punches AND
//     self-approves its own outdoor requests. Punches are attributed by the token's JWT user (getUserId reads
//     the id first; x-user-id is only a last-resort fallback), so the token's user must be the subject. The
//     token is a dev-token minted for a synthetic user, or SMOKE_TOKEN + SMOKE_USER_ID when dev-token is off.
//   - Asserts first_in/last_out + events via direct SQL (there is NO DELETE API for events/records, so a
//     staging DB connection is required for cleanup anyway; SQL is also the precise oracle the integration
//     test uses). It ADDITIONALLY asserts the HTTP read path (GET /records, /summary) follows.
//   - Cleans up its own (uniquely-named subject's) rows via SQL and restores the original settings. Residue 0.
//
// PREREQUISITES:
//   - Staging runs a main build that contains #2344 (7542d3679) — the script fails fast if punchPolicy.merge
//     does not round-trip through PUT/GET settings (= S2 not deployed).
//   - A token for the THROWAWAY subject: by default the script mints a dev-token for a fresh synthetic
//     `s2merge-…` user; if dev-token is disabled (NODE_ENV=production), pass SMOKE_TOKEN minted with the
//     STAGING JWT_SECRET for a SYNTHETIC `s2merge-…` user + SMOKE_USER_ID = that subject. The script refuses a
//     non-synthetic subject (cleanup deletes the subject's rows) unless ALLOW_NON_SYNTHETIC_SMOKE_USER=1.
//   - DATABASE_URL points at the staging postgres (read for assertions, DELETE for cleanup of the smoke user).
//   - `pg` is resolvable (run from the repo root, or set NODE_PATH).
//
// USAGE (on / tunnelled to the staging host):
//   BASE_URL=http://127.0.0.1:8082 \
//   DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
//   [SMOKE_TOKEN='<staging-admin-jwt>' SMOKE_USER_ID='<token-subject>']  # only if dev-token is disabled \
//   [ORG_ID=default] [WORK_DATE=2026-06-01] \
//   node scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs
//
// On PASS, flip the tracker row 内外勤卡合并 🟡 → ✅ with this stamp.

import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://u@127.0.0.1:5432/metasheet [SMOKE_TOKEN=<jwt> SMOKE_USER_ID=<subject>] node <script>')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `s2-merge-${SUFFIX}`
// ONE per-user admin-role token IS the smoke subject (mirrors the comp-leave staging smokes). Punches are
// attributed by the TOKEN's own user — getUserId() reads the JWT id FIRST and the x-user-id header is only a
// last-resort fallback, so we cannot punch as a third party with an admin token; instead the token's user IS
// the subject, and that one token also self-approves its own outdoor requests (proven by the comp-leave c4
// smoke). dev-token is the primary mint; SMOKE_TOKEN + SMOKE_USER_ID is the fallback when staging disables it
// (NODE_ENV=production → dev-token 404). The subject is synthetic, so the SQL cleanup (DELETE WHERE user_id)
// is scoped to smoke rows only.
let token = process.env.SMOKE_TOKEN || process.env.TOKEN || ''
const USER = process.env.SMOKE_USER_ID || process.env.TOKEN_USER_ID || `s2merge-${SUFFIX}`

// WORK_DATE: a PAST weekday so /punch never hits FUTURE_PUNCH_NOT_ALLOWED. Default = 7 days before today (UTC).
function defaultWorkDate() {
  const d = new Date(Date.now() - 7 * 86400_000)
  // nudge off Sat/Sun so a workday-calendar staging may mark it is_workday (best-effort; summary is asserted
  // against the record's actual work_minutes either way).
  const dow = d.getUTCDay()
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2)
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
const WORK_DATE = process.env.WORK_DATE || defaultWorkDate()

const outdoorInAt = `${WORK_DATE}T08:50:00.000Z`
const internalInAt = `${WORK_DATE}T09:05:00.000Z`
const outdoorOutAt = `${WORK_DATE}T18:30:00.000Z`
const internalOutAt = `${WORK_DATE}T19:00:00.000Z`
const EXPECTED_WORK_MINUTES = 565 // 09:05 → 18:30

let pass = 0
const failures = []
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`) }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, body: json }
}
const punch = (eventType, occurredAt, extra) =>
  api('/api/attendance/punch', { method: 'POST', body: { eventType, occurredAt, timezone: 'UTC', location: { lat: 0, lng: 0 }, ...extra } })

// Decode (NOT verify) a JWT's subject claim, to confirm a supplied SMOKE_TOKEN actually punches as USER —
// otherwise the SQL cleanup (DELETE WHERE user_id = USER) would target a user the token never wrote to.
function jwtSubject(jwt) {
  try {
    const seg = String(jwt).split('.')[1]
    if (!seg) return null
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
    return payload.id ?? payload.sub ?? payload.userId ?? null
  } catch { return null }
}
const approve = (id) => api(`/api/attendance/requests/${id}/approve`, { method: 'POST', body: { comment: `${STAMP} approve` } })

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const q = (text, params) => pool.query(text, params).then((r) => r.rows)
const iso = (v) => new Date(v).toISOString()

let originalSettings = null
let flowId = null
// Gates the destructive cleanup. The top-level finally ALWAYS runs cleanup(), so a guard that only throws in
// main() would still hit the blanket DELETE WHERE user_id = USER. cleanup() must DELETE only once this is true,
// i.e. only after the synthetic-subject + token-subject safety checks have passed for THIS USER.
let cleanupAllowed = false

async function main() {
  console.log(`S2-3 in/out-merge staging smoke @ ${BASE_URL}  (user ${USER}, workDate ${WORK_DATE}, stamp ${STAMP})`)

  // 0a) SAFETY — cleanup blanket-deletes WHERE user_id = USER, so the subject MUST be a throwaway. Refuse a
  //     non-synthetic id unless an explicit dangerous override is set.
  if (!/^s2merge-/.test(USER) && process.env.ALLOW_NON_SYNTHETIC_SMOKE_USER !== '1') {
    throw new Error(`refusing to run: subject "${USER}" is not a synthetic s2merge- id. The SQL cleanup deletes ALL of this user's attendance events/records/requests — pointing it at a real user would destroy their data. Use a synthetic SMOKE_USER_ID (or omit it to auto-mint one), or set ALLOW_NON_SYNTHETIC_SMOKE_USER=1 to override (dangerous).`)
  }

  // 0b) resolve the per-user smoke token (dev-token unless a SMOKE_TOKEN was supplied). The token's user IS
  //     the subject, so a supplied token's JWT subject MUST equal USER — else punches go to the token's user
  //     while assertions + cleanup target USER (split-brain: false failures AND a wrong-user delete).
  if (!token) {
    const t = await api(`/api/auth/dev-token?userId=${encodeURIComponent(USER)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`)
    token = t.body?.token || ''
    if (!token) throw new Error(`could not mint dev-token (status ${t.status}) — set SMOKE_TOKEN + SMOKE_USER_ID for a staging that disables dev-token (NODE_ENV=production)`)
    console.log('  minted dev-token for the smoke subject')
  } else {
    const subject = jwtSubject(token)
    if (subject == null) throw new Error('could not decode SMOKE_TOKEN subject — supply a valid JWT (and set SMOKE_USER_ID to its subject), or omit SMOKE_TOKEN to auto-mint a dev-token.')
    if (String(subject) !== USER) throw new Error(`SMOKE_TOKEN subject "${subject}" != subject "${USER}". Punches would be attributed to "${subject}" while assertions and the SQL cleanup target "${USER}". Set SMOKE_USER_ID to the token's subject ("${subject}").`)
    console.log(`  using supplied SMOKE_TOKEN (subject ${subject})`)
  }
  // Both safety gates passed (subject is a synthetic/overridden throwaway AND the token punches as exactly this
  // USER). ONLY now may cleanup() run its DELETE WHERE user_id = USER. If main() threw before this line, no
  // settings were mutated and nothing was created, so the finally skips all destructive work.
  cleanupAllowed = true

  // 0b) auth + capture original settings
  const got = await api('/api/attendance/settings')
  ok(got.status === 200, `auth: GET settings 200 (got ${got.status})`)
  if (got.status !== 200) throw new Error('cannot authenticate to staging — check TOKEN/JWT_SECRET')
  originalSettings = got.body?.data ?? {}

  // 0c) confirm S2 is deployed: punchPolicy.merge must round-trip (else this build predates #2333/#2344)
  const probe = await api('/api/attendance/settings', { method: 'PUT', body: { punchPolicy: { merge: { internalWinsOnIn: true, externalWinsOnOut: false } } } })
  const rt = await api('/api/attendance/settings')
  const rtMerge = rt.body?.data?.punchPolicy?.merge
  ok(probe.status === 200 && rtMerge?.internalWinsOnIn === true && rtMerge?.externalWinsOnOut === false,
    'S2 deployed: punchPolicy.merge round-trips through PUT/GET', rtMerge)
  if (!(rtMerge?.internalWinsOnIn === true)) throw new Error('punchPolicy.merge not honored — staging likely lacks #2333/#2344')

  // 1) create an active outdoor_punch approval flow (admin approves directly; steps:[] mirrors the integration test)
  const flowRes = await api('/api/attendance/approval-flows', { method: 'POST', body: { name: `s2-merge-outdoor-${SUFFIX}`, requestType: 'outdoor_punch', isActive: true, steps: [] } })
  flowId = flowRes.body?.data?.id
  ok((flowRes.status === 200 || flowRes.status === 201) && !!flowId, `create outdoor approval flow (status ${flowRes.status})`, flowRes.body)
  if (!flowId) throw new Error('outdoor approval flow not created')

  // 2) enable BOTH merge keys + outdoor approval (no geoFence → outdoor is triggered purely by meta.outdoor)
  const enable = await api('/api/attendance/settings', { method: 'PUT', body: {
    geoFence: null,
    punchPolicy: {
      merge: { internalWinsOnIn: true, externalWinsOnOut: true },
      outdoor: { requireApproval: true, requireNote: false, approvalFlowId: flowId },
    },
  } })
  ok(enable.status === 200, `enable merge keys + outdoor approval (status ${enable.status})`)

  // 3) seed the day (mirror the integration "positive merge" order): outdoor in/out (pending), internal in/out, then approve
  const oIn = await punch('check_in', outdoorInAt, { source: 'mobile', meta: { outdoor: true, note: `${STAMP} field am` } })
  const oOut = await punch('check_out', outdoorOutAt, { source: 'mobile', meta: { outdoor: true, note: `${STAMP} field pm` } })
  ok(oIn.status === 202 && oOut.status === 202, `outdoor punches → pending requests (in ${oIn.status}, out ${oOut.status})`, { oIn: oIn.body, oOut: oOut.body })
  const reqIn = oIn.body?.data?.request?.id
  const reqOut = oOut.body?.data?.request?.id
  ok(!!reqIn && !!reqOut, 'outdoor punches returned request ids', { reqIn, reqOut })

  const iIn = await punch('check_in', internalInAt, { source: 'mobile' })
  const iOut = await punch('check_out', internalOutAt, { source: 'mobile' })
  ok(iIn.status === 200 && iOut.status === 200, `internal punches recorded (in ${iIn.status}, out ${iOut.status})`, { iIn: iIn.body, iOut: iOut.body })

  const aIn = await approve(reqIn)
  const aOut = await approve(reqOut)
  ok(aIn.status === 200 && aOut.status === 200, `approve both outdoor requests (in ${aIn.status}, out ${aOut.status})`, { aIn: aIn.body, aOut: aOut.body })

  // 4) ASSERT the derived record (SQL oracle) — internal wins on in, outdoor wins on out
  const rec = (await q(
    `SELECT first_in_at, last_out_at, work_minutes, is_workday, status FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3 LIMIT 1`,
    [USER, WORK_DATE, ORG_ID],
  ))[0]
  ok(!!rec, 'record exists for the smoke user/day')
  if (rec) {
    ok(iso(rec.first_in_at) === internalInAt, `first_in_at = internal 09:05 (internalWinsOnIn)`, iso(rec.first_in_at))
    ok(iso(rec.last_out_at) === outdoorOutAt, `last_out_at = outdoor 18:30 (externalWinsOnOut)`, iso(rec.last_out_at))
    // The merge WINDOW (09:05→18:30) is already proven exactly by first_in/last_out above. work_minutes is
    // computeMetrics over that window (≤ 565; a staging org-default break rule may deduct), so assert it both
    // shrank below the un-merged 610 (08:50→19:00) AND is counted — not an exact 565 that a break would sink.
    ok(Number(rec.work_minutes) > 0 && Number(rec.work_minutes) <= EXPECTED_WORK_MINUTES,
      `work_minutes counted from the merged window (got ${rec.work_minutes}; ≤565, un-merged would be 610)`, rec.work_minutes)
  }

  // 5) ASSERT events UNCHANGED — exactly the 4 punched events, merge never rewrote attendance_events
  const events = await q(
    `SELECT event_type, source, occurred_at FROM attendance_events WHERE user_id = $1 AND work_date = $2 AND org_id = $3 ORDER BY occurred_at ASC, event_type ASC`,
    [USER, WORK_DATE, ORG_ID],
  )
  const eventKey = events.map((e) => `${e.event_type}:${e.source}:${iso(e.occurred_at)}`)
  ok(JSON.stringify(eventKey) === JSON.stringify([
    `check_in:outdoor_approval:${outdoorInAt}`,
    `check_in:mobile:${internalInAt}`,
    `check_out:outdoor_approval:${outdoorOutAt}`,
    `check_out:mobile:${internalOutAt}`,
  ]), 'attendance_events are exactly the 4 punched events (no rewrite by the merge)', eventKey)

  // 6) ASSERT the REAL read path follows — GET /records, /punch/events, /summary
  const recHttp = await api(`/api/attendance/records?userId=${encodeURIComponent(USER)}&from=${WORK_DATE}&to=${WORK_DATE}`)
  const recItem = recHttp.body?.data?.items?.[0]
  // /records currently returns the full record shape (snake_case DB columns), while /anomalies maps to
  // camelCase. Accept both so this smoke follows the deployed route contract instead of one handler's lens.
  const recHttpFirstIn = recItem?.firstInAt ?? recItem?.first_in_at
  const recHttpLastOut = recItem?.lastOutAt ?? recItem?.last_out_at
  ok(recHttp.status === 200 && recItem && iso(recHttpFirstIn) === internalInAt && iso(recHttpLastOut) === outdoorOutAt,
    'GET /records read path reflects the merged record', { firstInAt: recHttpFirstIn, lastOutAt: recHttpLastOut, keys: recItem ? Object.keys(recItem).slice(0, 12) : [] })

  const evHttp = await api(`/api/attendance/punch/events?userId=${encodeURIComponent(USER)}&from=${WORK_DATE}&to=${WORK_DATE}`)
  ok(evHttp.status === 200 && (evHttp.body?.data?.items?.length ?? 0) === 4, 'GET /punch/events returns the 4 events', evHttp.body?.data?.total)

  const sumHttp = await api(`/api/attendance/summary?userId=${encodeURIComponent(USER)}&from=${WORK_DATE}&to=${WORK_DATE}`)
  const totalMinutes = Number(sumHttp.body?.data?.total_minutes ?? -1)
  // "summary follows the record" = the summary's worked minutes equal THIS record's work_minutes, not a
  // hard-coded 565 — so a break rule on the record flows through, never spuriously fails.
  const expectedSummary = Number(rec?.work_minutes ?? 0)
  ok(sumHttp.status === 200 && totalMinutes === expectedSummary,
    `GET /summary follows the record (record work_minutes=${expectedSummary})`, totalMinutes)
}

async function cleanup() {
  console.log('\n--- restore + cleanup ---')
  // SAFETY: never DELETE WHERE user_id = USER unless the safety gates confirmed USER is a throwaway and the
  // token punches as exactly this USER. A pre-gate abort (e.g. non-synthetic subject without override) mutated
  // nothing, so there is nothing to restore or delete — skip all destructive work rather than run it on a real user.
  if (!cleanupAllowed) {
    console.log('  cleanup SKIPPED — safety gate not satisfied (no settings were changed and nothing was created for this subject).')
    return
  }
  try { if (originalSettings) await api('/api/attendance/settings', { method: 'PUT', body: originalSettings }); console.log('  settings restored') }
  catch (e) { console.error('  settings restore FAILED:', e.message) }
  // No DELETE API for events/records → remove the smoke user's rows directly (unique user id = safe scope).
  await q(`DELETE FROM approval_instances WHERE business_key IN (SELECT 'attendance-request:' || id FROM attendance_requests WHERE user_id = $1)`, [USER]).catch(() => {})
  await q(`DELETE FROM attendance_requests WHERE user_id = $1`, [USER]).catch(() => {})
  await q(`DELETE FROM attendance_events WHERE user_id = $1`, [USER]).catch(() => {})
  await q(`DELETE FROM attendance_records WHERE user_id = $1`, [USER]).catch(() => {})
  if (flowId) await q(`DELETE FROM attendance_approval_flows WHERE id = $1 AND org_id = $2`, [flowId, ORG_ID]).catch(() => {})
  const residue = await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_events WHERE user_id = $1) AS events,
       (SELECT count(*)::int FROM attendance_records WHERE user_id = $1) AS records,
       (SELECT count(*)::int FROM attendance_requests WHERE user_id = $1) AS requests`,
    [USER],
  ).catch(() => [{ events: -1, records: -1, requests: -1 }])
  const r = residue[0] ?? {}
  ok(r.events === 0 && r.records === 0 && r.requests === 0, `cleanup residue = 0 (events ${r.events}, records ${r.records}, requests ${r.requests})`, r)
}

main()
  .catch((e) => { failures.push(`ABORTED: ${e.message}`); console.error(`\nABORTED: ${e.message}`) })
  .finally(async () => {
    await cleanup().catch((e) => { failures.push(`cleanup error: ${e.message}`) })
    await pool.end().catch(() => {})
    const failed = failures.length
    console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${failed} failed${failed ? ` (${failures.join('; ')})` : ''} ===  stamp ${STAMP}`)
    process.exit(failed === 0 ? 0 : 1)
  })
