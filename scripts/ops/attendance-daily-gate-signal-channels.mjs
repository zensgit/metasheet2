function toRunList(value) {
  return Array.isArray(value) ? value : []
}

function pickLatestCompletedRun(list, { excludeConclusions = [] } = {}) {
  const completed = toRunList(list).filter((run) => run?.status === 'completed')
  if (completed.length === 0) return null
  const excluded = new Set(
    (Array.isArray(excludeConclusions) ? excludeConclusions : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  )
  if (excluded.size === 0) return completed[0]
  const preferred = completed.find((run) => !excluded.has(String(run?.conclusion || '').trim().toLowerCase()))
  return preferred || completed[0]
}

function formatRun(run) {
  if (!run) return null
  return {
    id: run.id ?? null,
    status: String(run.status || 'unknown'),
    conclusion: String(run.conclusion || ''),
    event: String(run.event || ''),
    createdAt: run.created_at || null,
    updatedAt: run.updated_at || null,
    url: run.html_url || null,
  }
}

function updatedAtValue(run) {
  const iso = run?.updated_at || null
  if (!iso) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

export function buildSignalChannels({
  list,
  excludeConclusions = [],
  manualEvent = 'workflow_dispatch',
  scheduledEvent = 'schedule',
} = {}) {
  const normalized = toRunList(list)
  const latestScheduledCompleted = pickLatestCompletedRun(
    normalized.filter((run) => String(run?.event || '').trim() === scheduledEvent),
    { excludeConclusions },
  )
  const latestManualCompleted = pickLatestCompletedRun(
    normalized.filter((run) => String(run?.event || '').trim() === manualEvent),
    { excludeConclusions },
  )

  const manualRecovery = Boolean(
    latestScheduledCompleted
      && latestManualCompleted
      && String(latestScheduledCompleted?.conclusion || '').trim().toLowerCase() !== 'success'
      && String(latestManualCompleted?.conclusion || '').trim().toLowerCase() === 'success'
      && updatedAtValue(latestManualCompleted) > updatedAtValue(latestScheduledCompleted),
  )

  return {
    latestScheduledCompleted: formatRun(latestScheduledCompleted),
    latestManualCompleted: formatRun(latestManualCompleted),
    manualRecovery,
  }
}
