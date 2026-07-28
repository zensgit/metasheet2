// W4-2 §9 metric evidence runner (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §9/§10):
// synthetic-org walk to preview-ready against a REAL MetaSheetServer + plugin-attendance on a real
// Postgres. Checked into the repo (docs/ assets — same posture as the sibling capture-harness/,
// outside every CI gate glob) so the PR's §9 ledger is REPRODUCIBLE, not prose-only.
//
// Run from the repo root (needs a migrated MetaSheet Postgres; fail-closed without one):
//   DATABASE_URL=postgresql://... pnpm --filter @metasheet/core-backend exec tsx \
//     ../../docs/development/assets/w4-2-vnext-20260722/metrics-harness/setup-metrics-walk.ts
//
// What it does (house integration posture — dev-token admin + RBAC_BYPASS, exactly like
// packages/core-backend `test:integration:attendance`):
//   provision (OUTSIDE the walk): one `directory_integrations` local anchor row for a synthetic
//   org (the org anchor `POST /api/admin/users` validates `attendanceOrgId` against; W4-PRE-1b).
//   walk 基线: GET setup-readiness ⇒ asserts previewReady=false, member count 0.
//   walk ①:  POST /api/admin/users (explicit attendanceOrgId — W4-PRE-1 canonical face)
//   walk ②a: POST /api/attendance/groups
//   walk ②b: POST /api/attendance/groups/:id/members
//   walk ③:  POST /api/attendance/shifts
//   walk ⑤:  POST /api/attendance/approval-flows
//   walk ④:  GET + PUT /api/attendance/settings (the human canonical confirm path; restored
//            byte-for-byte in cleanup)
//   walk ⑦:  GET setup-readiness ⇒ asserts the EXACT final counts + previewReady=true.
//   cleanup (OUTSIDE the walk): restore settings, delete every fixture row, then a residue
//   count over every touched table — asserts 0.
//
// MEASUREMENT SEMANTICS (honest labeling — review finding absorbed): the TOTAL printed below is
// API wall clock for the 7 admin-surface steps. It proves REACHABILITY (the synthetic org really
// arrives at preview-ready — lock §9's §3.2 closed-loop requirement) and the step count. It does
// NOT measure the charter §9 "new HR in 20 minutes" HUMAN budget, and the walk necessarily uses
// internal ids in path params (walk ②b) and JSON bodies — so it does NOT prove the charter's
// "no JSON / no internal id" property. That property belongs to the UI flow (wizard gallery →
// template prefill → canonical forms) and is held by the wizard specs, not by this runner.
//
// Output is values-free: durations, counts, and enum values only — no ids, names, or settings
// values are printed.

const dbUrl = process.env.DATABASE_URL || process.env.ATTENDANCE_TEST_DATABASE_URL
if (!dbUrl) {
  // Fail closed: no default DB, no silent skip.
  console.error('FAIL: DATABASE_URL (or ATTENDANCE_TEST_DATABASE_URL) is required.')
  process.exit(1)
}
process.env.DATABASE_URL = dbUrl
process.env.RBAC_BYPASS = 'true'
process.env.SKIP_PLUGINS = 'false'
if (!process.env.DB_QUERY_TIMEOUT) process.env.DB_QUERY_TIMEOUT = '180000'
if (!process.env.DB_STATEMENT_TIMEOUT) process.env.DB_STATEMENT_TIMEOUT = '180000'

interface LedgerRow {
  label: string
  seconds: number
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERT ${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function main(): Promise<void> {
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '../../../../..')

  // Import server code only AFTER env is set — the DB pool initializes at module import.
  const { MetaSheetServer } = await import('../../../../../packages/core-backend/src/index')
  const { query } = await import('../../../../../packages/core-backend/src/db/pg')

  const server = new MetaSheetServer({
    port: 0,
    host: '127.0.0.1',
    pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
  })
  await server.start()
  const address = server.getAddress()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not expose a TCP address')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`

  const runId = Date.now().toString(36)
  const orgId = `w42-metrics-${runId}`
  const username = `w42metrics${runId}`

  const tokenRes = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=w42-metrics-admin-${runId}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`,
  )
  const token = ((await tokenRes.json()) as { token?: string }).token
  if (!token) throw new Error('dev-token unavailable (NODE_ENV=production?)')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  async function call(method: string, url: string, body?: unknown): Promise<any> {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => undefined)) as any
    if (!res.ok || (json && json.ok === false)) {
      throw new Error(`${method} ${url} -> HTTP ${res.status} code=${json?.error?.code ?? 'unknown'}`)
    }
    return json
  }

  const ledger: LedgerRow[] = []
  async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint()
    const value = await fn()
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    ledger.push({ label, seconds })
    return value
  }

  let anchorId = ''
  let provisionSeconds = 0
  let userId = ''
  let groupId = ''
  let originalSettings: unknown = null

  try {
    // --- provision (outside the walk): the org anchor row -----------------------------------
    // corp_id shape is schema-enforced for local providers: local_integration_corp_id_shape
    // CHECK (provider <> 'local' OR corp_id = 'local:' || org_id).
    const provisionStart = process.hrtime.bigint()
    const anchor = await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, sync_enabled)
       VALUES ($1, 'local', $2, 'active', $3, false)
       RETURNING id`,
      [orgId, `w42-metrics-anchor-${runId}`, `local:${orgId}`],
    )
    anchorId = anchor.rows[0].id
    provisionSeconds = Number(process.hrtime.bigint() - provisionStart) / 1e9

    await step('walk 基线: GET setup-readiness (previewReady=false, members=0)', async () => {
      const res = await call('GET', `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(orgId)}`)
      assertEqual(res.data.previewReady, false, 'baseline previewReady')
      assertEqual(res.data.orgActiveMemberCount, 0, 'baseline orgActiveMemberCount')
      assertEqual(res.data.groupCount, 0, 'baseline groupCount')
    })

    await step('walk ①: POST /api/admin/users (explicit attendanceOrgId)', async () => {
      const res = await call('POST', '/api/admin/users', {
        name: 'Metrics Walk User',
        username,
        attendanceOrgId: orgId,
      })
      userId = String(res.data?.user?.id ?? '')
      if (!userId) throw new Error('walk ①: create-user response carried no user id')
    })

    await step('walk ②a: POST /api/attendance/groups', async () => {
      const res = await call('POST', '/api/attendance/groups', {
        orgId,
        name: 'Metrics office group',
        timezone: 'Asia/Shanghai',
        attendanceType: 'fixed_shift',
      })
      groupId = String(res.data?.id ?? '')
      if (!groupId) throw new Error('walk ②a: create-group response carried no id')
    })

    await step('walk ②b: POST /api/attendance/groups/:id/members', async () => {
      await call('POST', `/api/attendance/groups/${groupId}/members`, { orgId, userId })
    })

    await step('walk ③: POST /api/attendance/shifts', async () => {
      await call('POST', '/api/attendance/shifts', {
        orgId,
        name: 'Metrics day shift',
        timezone: 'Asia/Shanghai',
        workStartTime: '09:00',
        workEndTime: '18:00',
        lateGraceMinutes: 10,
        earlyGraceMinutes: 10,
        roundingMinutes: 5,
        workingDays: [1, 2, 3, 4, 5],
      })
    })

    await step('walk ⑤: POST /api/attendance/approval-flows', async () => {
      await call('POST', '/api/attendance/approval-flows', {
        orgId,
        name: `Metrics leave flow ${runId}`,
        requestType: 'leave',
        steps: [{ name: 'Manager', approverUserIds: [userId] }],
        isActive: true,
      })
    })

    await step('walk ④: GET + PUT /api/attendance/settings (human canonical confirm; restored in cleanup)', async () => {
      const current = await call('GET', '/api/attendance/settings')
      // Customize ONE §3.1 closed-set key (minPunchIntervalMinutes, default 1) so ④'s posture is
      // provably `customized`; record only that key for a targeted restore — a whole-object PUT
      // restore can trip the write schema's stricter enums on pre-existing deployment values.
      const currentInterval = Number(current.data?.minPunchIntervalMinutes ?? 1)
      originalSettings = { minPunchIntervalMinutes: currentInterval }
      await call('PUT', '/api/attendance/settings', {
        minPunchIntervalMinutes: currentInterval === 7 ? 8 : 7,
      })
    })

    await step('walk ⑦: GET setup-readiness (final)', async () => {
      const res = await call('GET', `/api/attendance-admin/setup-readiness?orgId=${encodeURIComponent(orgId)}`)
      assertEqual(res.data.orgActiveMemberCount, 1, 'final orgActiveMemberCount')
      assertEqual(res.data.groupCount, 1, 'final groupCount')
      assertEqual(res.data.groupsWithMembers, 1, 'final groupsWithMembers')
      assertEqual(res.data.shiftCount, 1, 'final shiftCount')
      assertEqual(res.data.scheduledShiftGroupCount, 0, 'final scheduledShiftGroupCount')
      assertEqual(res.data.approvalFlowCount, 1, 'final approvalFlowCount')
      assertEqual(res.data.punchPolicyPosture, 'customized', 'final punchPolicyPosture')
      assertEqual(res.data.previewReady, true, 'final previewReady (§3.2 closed loop)')
    })

    // --- ledger ------------------------------------------------------------------------------
    const total = ledger.reduce((sum, row) => sum + row.seconds, 0)
    console.log('')
    console.log('=== W4-2 §9 synthetic-org walk ledger (API wall clock, values-free) ===')
    console.log(`provision: 合成 org 锚点（fixture SQL，walk 外） — ${provisionSeconds.toFixed(2)}s`)
    for (const row of ledger) {
      console.log(`${row.label} — ${row.seconds.toFixed(2)}s`)
    }
    console.log(`TOTAL wall clock: ${total.toFixed(2)}s (7 admin-surface steps)`)
    console.log('')
    console.log('Measurement semantics: TOTAL proves REACHABILITY + step count (synthetic org truly')
    console.log('reaches preview-ready; ④⑥ advisory did not block). It is NOT the charter\'s 20-minute')
    console.log('HUMAN budget, and this API walk uses internal ids (walk ②b) — the "no JSON / no')
    console.log('internal id" property is a UI-flow property held by the wizard specs, not proven here.')
  } finally {
    // --- cleanup (outside the walk): restore settings, delete fixtures, count residue --------
    try {
      if (originalSettings) {
        await call('PUT', '/api/attendance/settings', originalSettings)
      }
      if (anchorId) {
        await query('DELETE FROM attendance_group_members WHERE org_id = $1', [orgId])
        await query('DELETE FROM attendance_groups WHERE org_id = $1', [orgId])
        await query('DELETE FROM attendance_shifts WHERE org_id = $1', [orgId])
        await query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgId])
        await query('DELETE FROM user_orgs WHERE org_id = $1', [orgId])
        if (userId) {
          await query('DELETE FROM user_roles WHERE user_id = $1', [userId])
          await query('DELETE FROM users WHERE id = $1', [userId])
        }
        await query('DELETE FROM directory_integrations WHERE id = $1', [anchorId])
        const residue = await query<{ total: string }>(
          `SELECT (
             (SELECT COUNT(*) FROM attendance_group_members WHERE org_id = $1)
           + (SELECT COUNT(*) FROM attendance_groups WHERE org_id = $1)
           + (SELECT COUNT(*) FROM attendance_shifts WHERE org_id = $1)
           + (SELECT COUNT(*) FROM attendance_approval_flows WHERE org_id = $1)
           + (SELECT COUNT(*) FROM user_orgs WHERE org_id = $1)
           + (SELECT COUNT(*) FROM directory_integrations WHERE org_id = $1)
           + (SELECT COUNT(*) FROM users WHERE id = $2)
           )::int AS total`,
          [orgId, userId || anchorId],
        )
        const residueCount = Number(residue.rows[0]?.total ?? -1)
        console.log(`cleanup residue across touched tables: ${residueCount} (settings restored)`)
        if (residueCount !== 0) {
          process.exitCode = 1
          console.error('FAIL: cleanup residue is not 0')
        }
      }
    } finally {
      await server.stop()
    }
  }
}

main().then(
  () => {
    // MetaSheetServer leaves non-unref'd scheduler intervals behind even after stop() — exit
    // explicitly so the runner terminates deterministically once cleanup has completed.
    process.exit(process.exitCode ?? 0)
  },
  (error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
