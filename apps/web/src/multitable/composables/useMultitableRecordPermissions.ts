import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { RecordPermissionEntry } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'
import { permissionLabel } from '../utils/meta-permission-labels'

export function useMultitableRecordPermissions(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const { isZh } = useLocale()
  const fallback = (key: Parameters<typeof permissionLabel>[0]) => permissionLabel(key, isZh.value)
  const entries = ref<RecordPermissionEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadPermissions(sheetId: string, recordId: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      entries.value = await api.listRecordPermissions(sheetId, recordId)
    } catch (e: any) {
      error.value = e.message ?? fallback('record.error.loadPermissions')
    } finally {
      loading.value = false
    }
  }

  async function grantPermission(
    sheetId: string,
    recordId: string,
    subjectType: string,
    subjectId: string,
    accessLevel: string,
  ): Promise<void> {
    error.value = null
    try {
      await api.updateRecordPermission(sheetId, recordId, subjectType, subjectId, accessLevel)
      await loadPermissions(sheetId, recordId)
    } catch (e: any) {
      error.value = e.message ?? fallback('record.error.grant')
      throw e
    }
  }

  async function revokePermission(
    sheetId: string,
    recordId: string,
    permissionId: string,
  ): Promise<void> {
    error.value = null
    try {
      await api.deleteRecordPermission(sheetId, recordId, permissionId)
      entries.value = entries.value.filter((entry) => entry.id !== permissionId)
    } catch (e: any) {
      error.value = e.message ?? fallback('record.error.remove')
      throw e
    }
  }

  return { entries, loading, error, loadPermissions, grantPermission, revokePermission }
}
