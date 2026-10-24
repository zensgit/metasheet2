export type DirectoryRunFilter = 'all' | 'running' | 'completed' | 'failed' | 'aborted'
export type DirectoryAlertFilter = 'all' | 'pending' | 'acknowledged'

export function readDirectoryRunFilter(value: unknown): DirectoryRunFilter | null {
  if (value === undefined) return 'all'
  switch (value) {
    case 'all': case 'running': case 'completed': case 'failed': case 'aborted': return value
    default: return null
  }
}

export function readDirectoryAlertFilter(value: unknown): DirectoryAlertFilter | null {
  if (value === undefined) return 'all'
  switch (value) {
    case 'all': case 'pending': case 'acknowledged': return value
    default: return null
  }
}
