import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { apiFetch } from '../utils/api'

export type DirectoryRunFilter = 'all' | 'running' | 'completed' | 'failed' | 'aborted'
export type DirectoryAlertFilter = 'all' | 'pending' | 'acknowledged'
export type DirectoryObservationRun = {
  id: string; status: string; startedAt: string; finishedAt: string | null
  stats: Record<string, unknown>; errorMessage: string | null
}
export type DirectoryObservationAlert = {
  id: string; integrationId: string; runId: string | null
  level: 'info' | 'warning' | 'error'; code: string; message: string
  details: Record<string, unknown> | null; createdAt: string
  acknowledgedAt: string | null; acknowledgedBy: string | null
}

function totalFrom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

export function useDirectorySyncObservability(integrationId: Ref<string>, reportError: (message: string) => void) {
  const runs = ref<DirectoryObservationRun[]>([])
  const alerts = ref<DirectoryObservationAlert[]>([])
  const runPage = ref(1)
  const alertPage = ref(1)
  const runTotal = ref(0)
  const alertTotal = ref(0)
  const runStatus = ref<DirectoryRunFilter>('all')
  const alertFilter = ref<DirectoryAlertFilter>('all')
  const alertCounts = ref({ all: 0, pending: 0, acknowledged: 0 })
  const loadingRuns = ref(false)
  const loadingAlerts = ref(false)
  const runPages = computed(() => Math.max(1, Math.ceil(runTotal.value / 10)))
  const alertPages = computed(() => Math.max(1, Math.ceil(alertTotal.value / 20)))
  let runRequest = 0
  let alertRequest = 0
  let context = 0
  let disposed = false

  function reset() {
    context++; runRequest++; alertRequest++
    runs.value = []; alerts.value = []
    runPage.value = 1; alertPage.value = 1
    runTotal.value = 0; alertTotal.value = 0
    runStatus.value = 'all'; alertFilter.value = 'all'
    alertCounts.value = { all: 0, pending: 0, acknowledged: 0 }
    loadingRuns.value = false; loadingAlerts.value = false
  }
  watch(integrationId, reset, { flush: 'sync' })
  onScopeDispose(() => { reset(); disposed = true })

  async function loadRuns(id: string) {
    if (disposed || !id || id !== integrationId.value) return
    const request = ++runRequest
    const stale = () => disposed || request !== runRequest || id !== integrationId.value
    const params = new URLSearchParams({ page: String(runPage.value), pageSize: '10' })
    if (runStatus.value !== 'all') params.set('status', runStatus.value)
    loadingRuns.value = true; runs.value = []
    try {
      const response = await apiFetch('/api/admin/directory/integrations/' + encodeURIComponent(id) + '/runs?' + params)
      if (stale()) return
      const body = await response.json()
      if (stale()) return
      if (!response.ok) throw new Error('observation_request_failed')
      const items = Array.isArray(body?.data?.items) ? body.data.items : []
      runTotal.value = totalFrom(body?.data?.total, items.length)
      if (runPage.value > runPages.value) {
        runPage.value = runPages.value
        if (runTotal.value > 0) { await loadRuns(id); return }
      }
      runs.value = items
    } catch {
      if (stale()) return
      runs.value = []; runTotal.value = 0; runPage.value = 1
      reportError('加载同步记录失败')
    } finally {
      if (!stale()) loadingRuns.value = false
    }
  }

  async function loadAlerts(id: string): Promise<boolean> {
    if (disposed || !id || id !== integrationId.value) return false
    const request = ++alertRequest
    const stale = () => disposed || request !== alertRequest || id !== integrationId.value
    const params = new URLSearchParams({ page: String(alertPage.value), pageSize: '20', filter: alertFilter.value })
    loadingAlerts.value = true; alerts.value = []
    try {
      const response = await apiFetch('/api/admin/directory/integrations/' + encodeURIComponent(id) + '/alerts?' + params)
      if (stale()) return false
      const body = await response.json()
      if (stale()) return false
      if (!response.ok) throw new Error('observation_request_failed')
      const items = Array.isArray(body?.data?.items) ? body.data.items : []
      alertTotal.value = totalFrom(body?.data?.total, items.length)
      // Counts are integration-global server aggregates, never a recount of this page.
      alertCounts.value = {
        all: totalFrom(body?.data?.counts?.total, 0),
        pending: totalFrom(body?.data?.counts?.pending, 0),
        acknowledged: totalFrom(body?.data?.counts?.acknowledged, 0),
      }
      if (alertPage.value > alertPages.value) {
        alertPage.value = alertPages.value
        if (alertTotal.value > 0) return await loadAlerts(id)
      }
      alerts.value = items
      return true
    } catch {
      if (stale()) return false
      alerts.value = []; alertTotal.value = 0; alertPage.value = 1
      alertCounts.value = { all: 0, pending: 0, acknowledged: 0 }
      reportError('加载最近告警失败')
      return false
    } finally {
      if (!stale()) loadingAlerts.value = false
    }
  }

  async function changeRunPage(page: number) {
    if (!Number.isInteger(page) || page < 1 || page > runPages.value || page === runPage.value) return
    runPage.value = page; await loadRuns(integrationId.value)
  }
  async function changeAlertPage(page: number) {
    if (!Number.isInteger(page) || page < 1 || page > alertPages.value || page === alertPage.value) return
    alertPage.value = page; await loadAlerts(integrationId.value)
  }
  async function updateRunStatus(value: DirectoryRunFilter) {
    runStatus.value = value; runPage.value = 1; await loadRuns(integrationId.value)
  }
  async function updateAlertFilter(value: DirectoryAlertFilter) {
    alertFilter.value = value; alertPage.value = 1; await loadAlerts(integrationId.value)
  }
  function runPollVersion(): number | null {
    return disposed || !integrationId.value || loadingRuns.value || runPage.value !== 1 || runStatus.value !== 'all'
      ? null : runRequest
  }
  function applyFirstPageRunPoll(
    version: number | null, id: string, items: DirectoryObservationRun[], total: unknown,
  ): boolean {
    if (version === null || version !== runPollVersion() || id !== integrationId.value) return false
    runRequest++
    runs.value = items
    runTotal.value = totalFrom(total, items.length)
    return true
  }
  return {
    runs, alerts, runPage, alertPage, runTotal, alertTotal, runStatus, alertFilter,
    alertCounts, loadingRuns, loadingAlerts, runPages, alertPages,
    loadRuns, loadAlerts, changeRunPage, changeAlertPage, updateRunStatus, updateAlertFilter,
    reset, contextVersion: () => context, runPollVersion, applyFirstPageRunPoll,
  }
}
