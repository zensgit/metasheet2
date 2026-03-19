function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function hashString(value) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
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
  base.setUTCDate(base.getUTCDate() + (hashString(seed) % 1825))
  return toDateOnly(base)
}
