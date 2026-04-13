import { ref } from 'vue'
import type { RecordPermissionEntry } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

export function useMultitableRecordPermissions(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const entries = ref<RecordPermissionEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadPermissions(sheetId: string, recordId: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      entries.value = await api.listRecordPermissions(sheetId, recordId)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load record permissions'
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
      error.value = e.message ?? 'Failed to grant record permission'
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
      error.value = e.message ?? 'Failed to revoke record permission'
      throw e
    }
  }

  return { entries, loading, error, loadPermissions, grantPermission, revokePermission }
}
