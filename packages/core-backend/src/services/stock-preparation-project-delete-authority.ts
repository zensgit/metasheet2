import { prepareProjectDeleteSheetWrites, type ProjectDeleteSheetSelection } from './stock-preparation-project-delete-sheet-writes'
import { assertPlatformActorAuthority, lockSharedAccessSubjects, PlatformActorAuthorityLost } from '../admin/platform-actor-authority'
import type { AccessGraphTransactionClient } from '../directory/access-graph-mutex'

type RowTransaction = {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
}

export async function authorizeStockPreparationProjectDeleteWithin(
  tx: RowTransaction,
  { actor, tenantId, projectNo }: { actor: string; tenantId: string; projectNo?: string },
) {
  const client: AccessGraphTransactionClient = {
    query: async (sql, params) => ({ rows: await tx.query(sql, params) }),
  }
  try {
    const subjects = await lockSharedAccessSubjects(client, [actor], { lockOnly: true })
    const user = subjects.get(actor)
    if (user?.role === 'disabled') throw new PlatformActorAuthorityLost()
    await assertPlatformActorAuthority(client, user)
    const membership = await tx.query(
      'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE FOR SHARE',
      [actor, tenantId],
    )
    if (!membership.length) throw new PlatformActorAuthorityLost()
    if (projectNo) return (selection: ProjectDeleteSheetSelection) => prepareProjectDeleteSheetWrites(tx, tenantId, projectNo, selection)
  } catch (error) {
    if (error instanceof PlatformActorAuthorityLost) throw Object.assign(error, { status: 403 })
    throw error
  }
}
