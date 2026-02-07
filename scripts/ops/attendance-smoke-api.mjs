const apiBase = (process.env.API_BASE || '').replace(/\/+$/, '')
const token = process.env.AUTH_TOKEN || ''
const orgId = process.env.ORG_ID || 'default'
const defaultTimezone = process.env.TIMEZONE || 'Asia/Shanghai'
const expectProductModeRaw = process.env.EXPECT_PRODUCT_MODE || ''

function normalizeProductMode(value) {
  if (value === 'attendance' || value === 'attendance-focused') return 'attendance'
  if (value === 'platform') return 'platform'
  return ''
}

function die(message) {
  console.error(`[attendance-smoke-api] ERROR: ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[attendance-smoke-api] ${message}`)
}

async function apiFetch(path, init = {}) {
  const url = `${apiBase}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const raw = await res.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  return { url, res, raw, body }
}

function assertOk({ res, raw, body }, label) {
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} ${raw.slice(0, 200)}`)
  }
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(`${label}: ${JSON.stringify(body).slice(0, 200)}`)
  }
  if (body && typeof body === 'object' && body.success === false) {
    throw new Error(`${label}: ${JSON.stringify(body).slice(0, 200)}`)
  }
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function makeGroupName() {
  const suffix = Date.now().toString(36)
  return `Smoke Group ${suffix}`
}

function makeCsv(workDate, userId, groupName) {
  // Align with the UI/Playwright script default mapping.
  return [
    '日期,UserId,考勤组,上班1打卡时间,下班1打卡时间,考勤结果',
    `${workDate},${userId},${groupName},09:00,18:00,正常`,
  ].join('\n')
}

async function run() {
  if (!apiBase) die('API_BASE is required (example: http://142.171.239.56:8081/api)')
  if (!token) die('AUTH_TOKEN is required')

  log(`API_BASE=${apiBase}`)

  // 1) auth/me
  const me = await apiFetch('/auth/me', { method: 'GET' })
  assertOk(me, 'GET /auth/me')
  const meData = me.body?.data ?? {}
  const user = meData?.user ?? {}
  const features = meData?.features ?? {}
  const userId = user?.userId || user?.id || user?.user_id
  if (!userId) die('GET /auth/me did not return user.id')
  if (features?.attendance !== true) die('features.attendance is not true (attendance plugin not available)')
  const expectProductMode = normalizeProductMode(expectProductModeRaw)
  if (expectProductMode) {
    const actualMode = normalizeProductMode(features?.mode)
    if (!actualMode) die(`features.mode missing (expected '${expectProductMode}')`)
    if (actualMode !== expectProductMode) {
      die(`features.mode expected '${expectProductMode}', got '${actualMode}'`)
    }
    log(`product mode ok: mode=${actualMode}`)
  }
  log(`auth/me ok: userId=${userId} role=${String(user?.role || '')}`)

  // 2) plugins active
  const plugins = await apiFetch('/plugins', { method: 'GET' })
  assertOk(plugins, 'GET /plugins')
  const list = Array.isArray(plugins.body) ? plugins.body : Array.isArray(plugins.body?.list) ? plugins.body.list : []
  const active = list.filter((p) => p?.status === 'active')
  const names = active.map((p) => String(p?.name || '').toLowerCase())
  const hasAttendance = names.some((n) => n === 'plugin-attendance' || n.endsWith('/plugin-attendance'))
  if (!hasAttendance) die('plugin-attendance is not active')
  log(`plugins ok: active=${active.length}`)

  // 3) prepare token (preview)
  const prepare1 = await apiFetch('/attendance/import/prepare', { method: 'POST', body: '{}' })
  assertOk(prepare1, 'POST /attendance/import/prepare (preview)')
  const token1 = prepare1.body?.data?.commitToken
  if (!token1) die('prepare did not return commitToken')

  // 4) template
  const template = await apiFetch('/attendance/import/template', { method: 'GET' })
  assertOk(template, 'GET /attendance/import/template')
  const payloadExample = template.body?.data?.payloadExample
  if (!payloadExample || typeof payloadExample !== 'object') die('template payloadExample missing')
  log('template ok')

  // 5) preview
  const workDate = toDateOnly(new Date())
  const groupName = makeGroupName()
  const csvText = makeCsv(workDate, userId, groupName)

  const previewPayload = {
    ...payloadExample,
    orgId,
    userId,
    timezone: payloadExample.timezone || defaultTimezone,
    mappingProfileId: 'dingtalk_csv_daily_summary',
    csvText,
    groupSync: {
      autoCreate: true,
      autoAssignMembers: true,
      // Intentionally omit timezone here; server must fallback safely.
    },
    commitToken: token1,
  }

  const preview = await apiFetch('/attendance/import/preview', {
    method: 'POST',
    body: JSON.stringify(previewPayload),
  })
  assertOk(preview, 'POST /attendance/import/preview')
  const items = preview.body?.data?.items
  if (!Array.isArray(items) || items.length === 0) die('preview returned 0 items')
  log(`preview ok: items=${items.length}`)

  // 6) prepare token (commit) - preview consumes tokens by design
  const prepare2 = await apiFetch('/attendance/import/prepare', { method: 'POST', body: '{}' })
  assertOk(prepare2, 'POST /attendance/import/prepare (commit)')
  const token2 = prepare2.body?.data?.commitToken
  if (!token2) die('prepare (commit) did not return commitToken')

  const commitPayload = {
    ...previewPayload,
    commitToken: token2,
  }

  const commit = await apiFetch('/attendance/import/commit', {
    method: 'POST',
    body: JSON.stringify(commitPayload),
  })
  assertOk(commit, 'POST /attendance/import/commit')
  const batchId = commit.body?.data?.batchId
  if (!batchId) die('commit did not return batchId')
  log(`commit ok: batchId=${batchId}`)

  // 7) batch items exist
  const itemsRes = await apiFetch(`/attendance/import/batches/${batchId}/items?pageSize=200`, { method: 'GET' })
  assertOk(itemsRes, 'GET /attendance/import/batches/:id/items')
  const batchItems = itemsRes.body?.data?.items
  if (!Array.isArray(batchItems) || batchItems.length === 0) die('batch items returned 0 rows')
  log(`batch items ok: rows=${batchItems.length}`)

  // 8) group exists + membership
  const groups = await apiFetch('/attendance/groups?pageSize=200', { method: 'GET' })
  assertOk(groups, 'GET /attendance/groups')
  const groupItems = groups.body?.data?.items || []
  const created = groupItems.find((g) => g && g.name === groupName)
  if (!created?.id) die('created group not found')

  const members = await apiFetch(`/attendance/groups/${created.id}/members?pageSize=200`, { method: 'GET' })
  assertOk(members, 'GET /attendance/groups/:id/members')
  const memberItems = members.body?.data?.items || []
  const hasMember = memberItems.some((m) => m && (m.userId === userId || m.user_id === userId))
  if (!hasMember) die('importing user is not a member of created group')
  log('group + membership ok')

  log('SMOKE PASS')
}

run().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`[attendance-smoke-api] Failed: ${msg}`)
  process.exit(1)
})
