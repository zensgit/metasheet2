function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

const SMOKE_WORK_DATE_POOL_DAYS = 36524

function hashString(value) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

export function isBlockingTimeCorrectionRequest(item) {
  const requestType = String(item?.requestType || item?.request_type || '')
  const status = String(item?.status || '').toLowerCase()
  return (
    requestType === 'time_correction' &&
    (status === 'pending' || status === 'approved')
  )
}

export async function scanBlockingTimeCorrectionRequests(
  workDate,
  options = {},
) {
  const {
    fetchPage,
    pageSize = 200,
    maxPages = 20,
  } = options
  if (typeof fetchPage !== 'function') {
    throw new TypeError('fetchPage must be a function')
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage({ workDate, page, pageSize })
    const items = result?.items
    if (!Array.isArray(items)) {
      throw new Error(
        `Attendance request availability page ${page} for ${workDate} is missing items`,
      )
    }
    if (items.some(isBlockingTimeCorrectionRequest)) return true

    const total = Number(result?.total)
    if (
      items.length < pageSize ||
      (Number.isFinite(total) && page * pageSize >= total)
    ) {
      return false
    }
  }

  throw new Error(
    `Attendance request availability exceeded ${maxPages} pages for ${workDate}`,
  )
}

export function resolveSmokeWorkDate(env = process.env) {
  const override = String(env.SMOKE_WORK_DATE || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(override)) return override

  // Keep the work date stable within a specific gate sub-run so retries are
  // deterministic, but spread sub-runs across many dates to avoid duplicate
  // request collisions on shared long-lived environments.
  const seedParts = [
    String(env.SMOKE_WORK_DATE_SEED || '').trim(),
    String(env.GITHUB_RUN_ID || '').trim(),
    String(env.GITHUB_RUN_ATTEMPT || '').trim(),
    String(env.GITHUB_RUN_NUMBER || '').trim(),
  ].filter(Boolean)
  const seed = seedParts.length > 0
    ? seedParts.join(':')
    : `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`

  const base = new Date(Date.UTC(2025, 0, 1))
  base.setUTCDate(base.getUTCDate() + (hashString(seed) % SMOKE_WORK_DATE_POOL_DAYS))
  return toDateOnly(base)
}

export function resolveSmokeWorkDateCandidates(
  env = process.env,
  maxCandidates = 32,
) {
  const first = resolveSmokeWorkDate(env)
  const override = String(env.SMOKE_WORK_DATE || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(override)) return [first]

  // Long-lived environments eventually reuse the bounded seed hash. Keep the
  // first date reproducible, then expose deterministic adjacent fallbacks.
  const requestedCount = Number(maxCandidates)
  const count = Number.isFinite(requestedCount)
    ? Math.min(90, Math.max(1, Math.floor(requestedCount)))
    : 32
  const base = new Date(`${first}T00:00:00.000Z`)

  return Array.from({ length: count }, (_value, offset) => {
    const candidate = new Date(base)
    candidate.setUTCDate(candidate.getUTCDate() + offset)
    return toDateOnly(candidate)
  })
}

export async function selectAvailableSmokeWorkDate(
  env = process.env,
  options = {},
) {
  const {
    maxCandidates = 32,
    hasBlockingRequest,
    onCollision = () => {},
  } = options
  if (typeof hasBlockingRequest !== 'function') {
    throw new TypeError('hasBlockingRequest must be a function')
  }

  const candidates = resolveSmokeWorkDateCandidates(env, maxCandidates)
  for (const candidate of candidates) {
    if (!(await hasBlockingRequest(candidate))) return candidate
    onCollision(candidate)
  }

  throw new Error(
    `No available smoke work date found across ${candidates.length} deterministic candidate(s)`,
  )
}
