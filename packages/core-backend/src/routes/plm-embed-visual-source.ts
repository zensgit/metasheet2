import { embedDataSourceId } from '../auth/embed-config'
import { getDataSourceManager } from './data-sources'

export async function isCurrentVisualSource(adapter: unknown, tenantId: string): Promise<boolean> {
  try {
    const id = embedDataSourceId()
    if (!id) return false
    const manager = getDataSourceManager()
    return await manager.isVisualReviewSourceCurrent(id, tenantId, adapter ?? manager.getDataSource(id))
  } catch { return false }
}
